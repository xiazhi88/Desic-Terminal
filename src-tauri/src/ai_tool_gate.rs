//! AI 工具执行闸门：只读并发闸门（全局 + 按域上限）与写工具独占锁。
//!
//! 背景（根因取证见 `tsk_5c0a58bb` / `tsk_36b8f5eb`）：`requestedAt → executionStartedAt`
//! 的排队中位 2ms、p99 3.9s、max 52.9s；排队不产生任何信息，是纯浪费。
//! 只读工具本身允许并发（`ai_tool_allows_concurrent_execution`），但此前全局只有
//! `Semaphore::new(4)`，主 Agent 与并行专家同时取数时会被压在 4 路上。
//!
//! 三条硬约束（董事会授权原文）：
//! 1. **写工具语义不变**：写工具仍走独占写锁串行，不参与只读并发；
//! 2. **不允许无保护地提并发**：只读提并发会直接压到上游（OKX 公共 REST 频率限制、
//!    外部情报接口、本地 SQLite），因此除全局闸门外每个域另有上限；上游既有的
//!    限流层（`OKX_PUBLIC_REST_SEMAPHORE` + 按路径最小间隔）保持原样、继续生效；
//! 3. **每 turn 一个闸门**：闸门与许可都随 turn 结束释放，不跨 turn 泄漏许可。
//!
//! 锁序（唯一的获取顺序，不会成环）：全局许可 → 域许可 → 读写锁读锁。
//! 写路径只取写锁，从不等待上面两个信号量，因此不存在交叉等待。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{OwnedRwLockWriteGuard, OwnedSemaphorePermit, RwLock, Semaphore};

/// 全局只读并发缺省值。董事会建议 12；取证依据见模块测试与交付说明：
/// 09-18/09-19 的并行多 Agent 运行里执行窗口并发峰值恰好顶到 4（旧闸门上限），
/// 峰值需求 ≥ 5 才有排队，12 足以覆盖 1 主 Agent + 4 专家 + 余量。
pub const AI_TOOL_READ_CONCURRENCY_DEFAULT: usize = 12;
/// 全局只读并发的可配置范围（防止配置写错把闸门关死或开到 0）。
pub const AI_TOOL_READ_CONCURRENCY_MIN: usize = 1;
/// 上限取 64：再多也不会比上游限流层允许的更快，只是把压力推给上游。
pub const AI_TOOL_READ_CONCURRENCY_MAX: usize = 64;
/// 单域上限的允许范围。
pub const AI_TOOL_DOMAIN_READ_CONCURRENCY_MIN: usize = 1;
pub const AI_TOOL_DOMAIN_READ_CONCURRENCY_MAX: usize = 32;

/// 域上限的缺省值。选择依据（全部来自现有上游保护，不新增放水）：
/// - `market`：OKX 行情。上游 `OKX_PUBLIC_REST_SEMAPHORE`=4 + 按路径最小间隔
///   （公共 80ms / 蜡烛 60ms / 历史蜡烛 120ms）继续生效，本域上限只约束工具层扇出；
/// - `intelligence`：OKX 公共接口 + 外部情报接口，且 `IntelligenceRuntime` 刷新槽位=3；
/// - `account`：私有账户快照（本地缓存 + 后台同步），不是每次工具调用都打私有 REST；
/// - `radar`：市场雷达聚合（本地 + 公共行情）；
/// - `strategy`：回测/优化属重计算，`SystematicRuntime` 自带 worker 容量；
/// - `local`：纯本地读（SQLite / 文件），给到与全局缺省同量级。
pub const AI_TOOL_DOMAIN_READ_CONCURRENCY_DEFAULTS: [(&str, usize); 6] = [
    ("market", 6),
    ("intelligence", 4),
    ("account", 4),
    ("radar", 4),
    ("strategy", 4),
    ("local", 12),
];

/// 只读工具按域归类。只用于"给并发上限"，不参与任何权限判定。
pub fn ai_tool_read_domain(name: &str) -> &'static str {
    if name.starts_with("market.") {
        "market"
    } else if name.starts_with("intelligence.") {
        "intelligence"
    } else if name.starts_with("account.") {
        "account"
    } else if name.starts_with("radar.") {
        "radar"
    } else if name.starts_with("strategy.") {
        "strategy"
    } else {
        "local"
    }
}

/// 一个 turn 生效的只读并发配置。缺字段（老配置/未配置）时用代码缺省值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiToolConcurrencyLimits {
    read: usize,
    domains: Vec<(&'static str, usize)>,
}

impl Default for AiToolConcurrencyLimits {
    fn default() -> Self {
        Self {
            read: AI_TOOL_READ_CONCURRENCY_DEFAULT,
            domains: AI_TOOL_DOMAIN_READ_CONCURRENCY_DEFAULTS.to_vec(),
        }
    }
}

impl AiToolConcurrencyLimits {
    /// 从 AI 配置读取：`toolReadConcurrency` / `toolDomainConcurrency` 均可选，
    /// 非法值（0、超大、超范围）一律夹到合法区间而不是让闸门失效。
    pub fn from_config(
        read_concurrency: Option<u32>,
        domain_concurrency: Option<&HashMap<String, u32>>,
    ) -> Self {
        let mut limits = Self::default();
        if let Some(value) = read_concurrency {
            limits.read = clamp_limit(
                value as usize,
                AI_TOOL_READ_CONCURRENCY_MIN,
                AI_TOOL_READ_CONCURRENCY_MAX,
            );
        }
        for (domain, fallback) in limits.domains.iter_mut() {
            if let Some(value) = domain_concurrency.and_then(|map| map.get(*domain)) {
                *fallback = clamp_limit(
                    *value as usize,
                    AI_TOOL_DOMAIN_READ_CONCURRENCY_MIN,
                    AI_TOOL_DOMAIN_READ_CONCURRENCY_MAX,
                );
            }
        }
        limits
    }

    pub fn read(&self) -> usize {
        self.read
    }

    pub fn domain(&self, domain: &str) -> usize {
        self.domains
            .iter()
            .find(|(name, _)| *name == domain)
            .map(|(_, limit)| *limit)
            .unwrap_or(self.read)
    }

    pub fn domains(&self) -> &[(&'static str, usize)] {
        &self.domains
    }
}

fn clamp_limit(value: usize, min: usize, max: usize) -> usize {
    value.clamp(min, max)
}

/// 只读许可集合：全局许可 + 该域许可，随任务结束一起释放。
#[derive(Debug)]
pub struct AiToolReadPermits {
    _global: OwnedSemaphorePermit,
    _domain: Option<OwnedSemaphorePermit>,
}

/// 每 turn 一个的工具执行闸门（生命周期与旧 `tool_read_semaphore` 完全一致）。
#[derive(Debug)]
pub struct AiToolExecutionGate {
    limits: AiToolConcurrencyLimits,
    read: Arc<Semaphore>,
    domains: Vec<(&'static str, Arc<Semaphore>)>,
    write: Arc<RwLock<()>>,
}

impl AiToolExecutionGate {
    pub fn new(limits: AiToolConcurrencyLimits) -> Self {
        let domains = limits
            .domains()
            .iter()
            .map(|(name, _)| (*name, Arc::new(Semaphore::new(limits.domain(name)))))
            .collect();
        let read = Arc::new(Semaphore::new(limits.read()));
        Self {
            limits,
            read,
            domains,
            write: Arc::new(RwLock::new(())),
        }
    }

    pub fn limits(&self) -> AiToolConcurrencyLimits {
        self.limits.clone()
    }

    /// 取只读许可：全局 → 域。域上限只约束该域的扇出，不改变工具语义。
    pub async fn acquire_read(&self, tool_name: &str) -> Result<AiToolReadPermits, String> {
        let global = self
            .read
            .clone()
            .acquire_owned()
            .await
            .map_err(|err| err.to_string())?;
        let domain = ai_tool_read_domain(tool_name);
        let domain_permit = match self.domains.iter().find(|(name, _)| *name == domain) {
            Some((_, semaphore)) => Some(
                semaphore
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|err| err.to_string())?,
            ),
            None => None,
        };
        Ok(AiToolReadPermits {
            _global: global,
            _domain: domain_permit,
        })
    }

    /// 写工具：独占写锁串行（语义与旧实现一致，仅把锁搬进闸门）。
    pub async fn acquire_write(&self) -> OwnedRwLockWriteGuard<()> {
        self.write.clone().write_owned().await
    }

    /// 只读工具之间的共享读锁。
    pub async fn read(&self) -> tokio::sync::OwnedRwLockReadGuard<()> {
        self.write.clone().read_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::time::{sleep, Duration};

    #[test]
    fn defaults_are_the_authorized_values() {
        let limits = AiToolConcurrencyLimits::default();
        assert_eq!(limits.read(), 12, "全局只读并发缺省值必须是董事会确认的 12");
        assert_eq!(limits.domain("market"), 6);
        assert_eq!(limits.domain("intelligence"), 4);
        assert_eq!(limits.domain("account"), 4);
        assert_eq!(limits.domain("radar"), 4);
        assert_eq!(limits.domain("strategy"), 4);
        assert_eq!(limits.domain("local"), 12);
    }

    #[test]
    fn config_overrides_are_clamped_instead_of_disabling_the_gate() {
        let mut overrides = HashMap::new();
        overrides.insert("market".to_string(), 9);
        overrides.insert("local".to_string(), 0);
        overrides.insert("radar".to_string(), 9_999);
        let limits = AiToolConcurrencyLimits::from_config(Some(4), Some(&overrides));
        assert_eq!(limits.read(), 4, "显式配置优先");
        assert_eq!(limits.domain("market"), 9, "域覆盖生效");
        assert_eq!(limits.domain("local"), 1, "0 夹到下限而不是关死闸门");
        assert_eq!(
            limits.domain("radar"),
            AI_TOOL_DOMAIN_READ_CONCURRENCY_MAX,
            "超大值夹到上限"
        );
        assert_eq!(limits.domain("account"), 4, "未覆盖的域保持缺省");
        assert_eq!(
            AiToolConcurrencyLimits::from_config(Some(0), None).read(),
            1
        );
        assert_eq!(
            AiToolConcurrencyLimits::from_config(Some(4096), None).read(),
            AI_TOOL_READ_CONCURRENCY_MAX
        );
    }

    #[test]
    fn read_tool_domains_cover_the_concurrent_tool_families() {
        assert_eq!(ai_tool_read_domain("market.readTicker"), "market");
        assert_eq!(ai_tool_read_domain("market.readDecisionContext"), "market");
        assert_eq!(ai_tool_read_domain("intelligence.news.list"), "intelligence");
        assert_eq!(ai_tool_read_domain("account.readRisk"), "account");
        assert_eq!(ai_tool_read_domain("radar.readOverview"), "radar");
        assert_eq!(ai_tool_read_domain("strategy.getBacktestResult"), "strategy");
        // 只读但不在上述域：本地读取（技能、机会列表、脚本列表…）
        assert_eq!(ai_tool_read_domain("skills"), "local");
        assert_eq!(ai_tool_read_domain("tradeOpportunity.list"), "local");
        assert_eq!(ai_tool_read_domain("script.list"), "local");
        assert_eq!(ai_tool_read_domain("alert.listPriceAlerts"), "local");
        assert_eq!(ai_tool_read_domain("trade.precheck"), "local");
    }

    async fn observed_max_concurrency(
        gate: &Arc<AiToolExecutionGate>,
        tool: &str,
        tasks: usize,
    ) -> usize {
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..tasks {
            let gate = gate.clone();
            let live = live.clone();
            let peak = peak.clone();
            let tool = tool.to_string();
            handles.push(tokio::spawn(async move {
                let _permits = gate.acquire_read(&tool).await.expect("read permits");
                let _read = gate.read().await;
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                sleep(Duration::from_millis(20)).await;
                live.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for handle in handles {
            handle.await.expect("task");
        }
        peak.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn global_limit_caps_read_parallelism() {
        let gate = Arc::new(AiToolExecutionGate::new(AiToolConcurrencyLimits::from_config(
            Some(4),
            None,
        )));
        assert_eq!(observed_max_concurrency(&gate, "skills", 10).await, 4);
        let gate = Arc::new(AiToolExecutionGate::new(AiToolConcurrencyLimits::default()));
        assert_eq!(
            observed_max_concurrency(&gate, "skills", 10).await,
            10,
            "12 路闸门下 10 个本地只读可全并发"
        );
    }

    #[tokio::test]
    async fn domain_limit_caps_fanout_before_the_global_limit() {
        let mut overrides = HashMap::new();
        overrides.insert("market".to_string(), 2);
        let gate = Arc::new(AiToolExecutionGate::new(AiToolConcurrencyLimits::from_config(
            Some(12),
            Some(&overrides),
        )));
        assert_eq!(
            observed_max_concurrency(&gate, "market.readTicker", 8).await,
            2
        );
        // 其它域不受 market 上限影响
        assert_eq!(observed_max_concurrency(&gate, "skills", 8).await, 8);
    }

    /// 机制级 A/B：8 个只读任务（各 25ms 服务时间）在旧闸门（4）下必然排队，在新闸门（12）下零排队。
    #[tokio::test]
    async fn raising_the_limit_removes_queueing_when_fanout_exceeds_four() {
        async fn total_queue_ms(gate: Arc<AiToolExecutionGate>, tasks: usize) -> u128 {
            let mut handles = Vec::new();
            for _ in 0..tasks {
                let gate = gate.clone();
                handles.push(tokio::spawn(async move {
                    let queued_at = std::time::Instant::now();
                    let _permits = gate.acquire_read("skills").await.expect("read permits");
                    let queue_ms = queued_at.elapsed().as_millis();
                    sleep(Duration::from_millis(25)).await;
                    queue_ms
                }));
            }
            let mut total = 0u128;
            for handle in handles {
                total += handle.await.expect("task");
            }
            total
        }

        let old_gate = Arc::new(AiToolExecutionGate::new(AiToolConcurrencyLimits::from_config(
            Some(4),
            None,
        )));
        let waits_at_four = total_queue_ms(old_gate, 8).await;
        assert!(
            waits_at_four >= 60,
            "4 路闸门下 8 个 25ms 任务应出现排队，实测 {waits_at_four}ms"
        );

        let new_gate = Arc::new(AiToolExecutionGate::new(AiToolConcurrencyLimits::default()));
        let waits_at_twelve = total_queue_ms(new_gate, 8).await;
        assert_eq!(waits_at_twelve, 0, "12 路闸门下 8 个任务不应排队");
    }

    /// 写工具语义回归：写锁独占，写期间没有任何只读能进、两个写不会重叠。
    #[tokio::test]
    async fn write_tools_stay_exclusive_and_block_reads() {
        let gate = Arc::new(AiToolExecutionGate::new(AiToolConcurrencyLimits::default()));
        let write_guard = gate.acquire_write().await;

        let read_started = Arc::new(AtomicUsize::new(0));
        let read_task = {
            let gate = gate.clone();
            let read_started = read_started.clone();
            tokio::spawn(async move {
                let _permits = gate.acquire_read("market.readTicker").await.expect("read");
                let _read = gate.read().await;
                read_started.store(1, Ordering::SeqCst);
            })
        };

        sleep(Duration::from_millis(30)).await;
        assert_eq!(
            read_started.load(Ordering::SeqCst),
            0,
            "写锁持有时只读不得进入（写工具仍是串行独占语义）"
        );

        let second_write_started = Arc::new(AtomicUsize::new(0));
        let second_write = {
            let gate = gate.clone();
            let flag = second_write_started.clone();
            tokio::spawn(async move {
                let _guard = gate.acquire_write().await;
                flag.store(1, Ordering::SeqCst);
            })
        };
        sleep(Duration::from_millis(30)).await;
        assert_eq!(
            second_write_started.load(Ordering::SeqCst),
            0,
            "两个写工具不得并发"
        );

        drop(write_guard);
        read_task.await.expect("read task");
        second_write.await.expect("write task");
        assert_eq!(read_started.load(Ordering::SeqCst), 1);
        assert_eq!(second_write_started.load(Ordering::SeqCst), 1);
    }

    /// 只读之间不互相阻塞（旧实现靠共享读锁，本闸门保留该性质）。
    #[tokio::test]
    async fn read_tools_share_the_gate_without_serializing_each_other() {
        let gate = Arc::new(AiToolExecutionGate::new(AiToolConcurrencyLimits::default()));
        let first = gate.read().await;
        let second = tokio::time::timeout(Duration::from_millis(200), gate.read())
            .await
            .expect("第二个只读不应被第一个只读挡住");
        drop(first);
        drop(second);
    }
}
