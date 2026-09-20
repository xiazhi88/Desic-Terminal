//! C19 试判阶段（triage）：配置模型、阶段门与判定的**纯逻辑**。
//!
//! 这一层不碰数据库与 Tauri，只做三件事（因此可以完整单测）：
//! 1. `AiAgentTriageConfig`：Profile 级配置 + C19.1 默认值 + 归一化（旧 Profile 缺字段 = 默认）；
//! 2. `triage_allows_tool`：**试判阶段的工具面门**（授权层强制，不能只写在提示词里）；
//! 3. `evaluate_triage_escalation` / `decide_triage_outcome`：硬升级、反饥饿、抽样复检的判定。
//!
//! 关键语义（C19.2）：**试判只能加码、不能解除强制** —— 硬升级清单任一命中时，
//! `escalate:false` 一律被否决并强制升级；`shadow` 模式下 skip 不阻断深度但照记 verdict。

use serde::{Deserialize, Serialize};

pub const TRIAGE_MODE_OFF: &str = "off";
pub const TRIAGE_MODE_SHADOW: &str = "shadow";
pub const TRIAGE_MODE_ENFORCE: &str = "enforce";

/// 试判允许的只读域（C19.2 的最宽集合）。
pub const TRIAGE_TOOL_DOMAINS: [&str; 4] = ["market", "account", "intelligence", "radar"];

pub const TRIAGE_DEFAULT_MAX_SKIPS: u32 = 3;
pub const TRIAGE_DEFAULT_MAX_SILENCE_MINUTES: u32 = 120;
pub const TRIAGE_DEFAULT_SKIP_SAMPLE_RATE: f64 = 0.2;
pub const TRIAGE_DEFAULT_STOP_DISTANCE_PCT: f64 = 1.5;
/// OKX 维持保证金率：**越大越安全**，`≤100%` 触发强平。
/// 官方定义（OKX 强平规则 / 保证金率）：维持保证金率 =（全仓余额 + 全仓收益 − 挂单占用）/（维持保证金 + 强平手续费），
/// 健康账户通常是数百到数千个百分点，因此默认阈值取 150（距强平约 1.5 倍缓冲）。
pub const TRIAGE_DEFAULT_MARGIN_RATIO_PCT: f64 = 150.0;
/// 有效判定窗口：0 < mgnRatio ≤ 1000×；窗口外视为单位/数据异常（列入 unavailable）。
pub const TRIAGE_MARGIN_RATIO_MAX_PCT: f64 = 100_000.0;
/// C25-4（董事会冻结）：保证金率口径**固定**为「维持保证金率越大越安全」（OKX 口径，
/// ≤100% 进入强平区）。`marginRatioConvention` 不再是可配置项：入参仍接受该字段
/// （老配置/老前端不报错）但**一律忽略**，回显恒为本常量。
pub const MARGIN_RATIO_HIGHER_IS_SAFER: &str = "higher_is_safer";
pub const TRIAGE_DEFAULT_CONDITION_RESONANCE: u32 = 2;
pub const TRIAGE_DEFAULT_SKIP_TRIGGERS: [&str; 2] = ["intelligence_briefing", "daily_market_review"];

fn default_mode() -> String {
    TRIAGE_MODE_ENFORCE.to_string()
}

fn default_tools() -> Vec<String> {
    TRIAGE_TOOL_DOMAINS
        .iter()
        .map(|domain| (*domain).to_string())
        .collect()
}

fn default_max_skips() -> u32 {
    TRIAGE_DEFAULT_MAX_SKIPS
}

fn default_max_silence_minutes() -> u32 {
    TRIAGE_DEFAULT_MAX_SILENCE_MINUTES
}

fn default_skip_sample_rate() -> f64 {
    TRIAGE_DEFAULT_SKIP_SAMPLE_RATE
}

fn default_true() -> bool {
    true
}

fn default_stop_distance_pct() -> f64 {
    TRIAGE_DEFAULT_STOP_DISTANCE_PCT
}

fn default_margin_ratio_pct() -> f64 {
    TRIAGE_DEFAULT_MARGIN_RATIO_PCT
}

fn default_margin_ratio_convention() -> String {
    MARGIN_RATIO_HIGHER_IS_SAFER.to_string()
}

fn default_condition_resonance() -> u32 {
    TRIAGE_DEFAULT_CONDITION_RESONANCE
}

fn default_skip_triggers() -> Vec<String> {
    TRIAGE_DEFAULT_SKIP_TRIGGERS
        .iter()
        .map(|trigger| (*trigger).to_string())
        .collect()
}

/// C19.1 硬升级清单（Rust 预判，任一命中即强制深度）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentTriageEscalate {
    #[serde(default = "default_true")]
    pub position_or_order_changed: bool,
    #[serde(default = "default_stop_distance_pct")]
    pub stop_distance_pct: f64,
    /// 保证金率阈值：`mgnRatio ≤ 阈值` 即强制深度（默认 150；固定"越大越安全"口径）。
    #[serde(default = "default_margin_ratio_pct")]
    pub margin_ratio_pct: f64,
    /// **DEPRECATED（C25-4）**：口径已固定为「越大越安全」（OKX 官方口径），不再可翻转；
    /// 该字段只用于兼容老入参，见字段声明处的说明。
    /// 万一真实数据分布与文档相反，改配置即可反向（比较号与阈值语义一起翻），不必改代码。
    /// **DEPRECATED（C25-4）**：口径已固定为 [`MARGIN_RATIO_HIGHER_IS_SAFER`]。
    /// 保留该字段只为兼容老配置/老前端的入参（给了什么都不报错、一律忽略），
    /// 归一后恒等于固定值，因此回显里不会再出现第二种取值。
    #[serde(default = "default_margin_ratio_convention")]
    pub margin_ratio_convention: String,
    #[serde(default = "default_true")]
    pub confirmed_break_of_flagged_level: bool,
    #[serde(default = "default_condition_resonance")]
    pub condition_resonance: u32,
    #[serde(default = "default_true")]
    pub important_news: bool,
    #[serde(default = "default_skip_triggers")]
    pub skip_triage_triggers: Vec<String>,
}

impl Default for AiAgentTriageEscalate {
    fn default() -> Self {
        Self {
            position_or_order_changed: true,
            stop_distance_pct: TRIAGE_DEFAULT_STOP_DISTANCE_PCT,
            margin_ratio_pct: TRIAGE_DEFAULT_MARGIN_RATIO_PCT,
            margin_ratio_convention: default_margin_ratio_convention(),
            confirmed_break_of_flagged_level: true,
            condition_resonance: TRIAGE_DEFAULT_CONDITION_RESONANCE,
            important_news: true,
            skip_triage_triggers: default_skip_triggers(),
        }
    }
}

/// C19.1 Profile 级试判配置。`Default` = 董事会冻结的默认值（`enforce`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentTriageConfig {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_tools")]
    pub tools: Vec<String>,
    #[serde(default = "default_max_skips")]
    pub max_skips: u32,
    #[serde(default = "default_max_silence_minutes")]
    pub max_silence_minutes: u32,
    #[serde(default = "default_skip_sample_rate")]
    pub skip_sample_rate: f64,
    #[serde(default)]
    pub escalate: AiAgentTriageEscalate,
}

impl Default for AiAgentTriageConfig {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            tools: default_tools(),
            max_skips: TRIAGE_DEFAULT_MAX_SKIPS,
            max_silence_minutes: TRIAGE_DEFAULT_MAX_SILENCE_MINUTES,
            skip_sample_rate: TRIAGE_DEFAULT_SKIP_SAMPLE_RATE,
            escalate: AiAgentTriageEscalate::default(),
        }
    }
}

impl AiAgentTriageConfig {
    /// 归一化：未知 mode → `enforce`（默认），未知域丢弃，数值收敛到安全区间。
    /// **旧 Profile 缺字段**由 serde 默认值补成 C19.1（因此无需迁移脚本）。
    pub fn normalized(mut self) -> Self {
        self.mode = match self.mode.trim().to_ascii_lowercase().as_str() {
            TRIAGE_MODE_OFF => TRIAGE_MODE_OFF.to_string(),
            TRIAGE_MODE_SHADOW => TRIAGE_MODE_SHADOW.to_string(),
            _ => TRIAGE_MODE_ENFORCE.to_string(),
        };
        let mut tools = Vec::new();
        for tool in self.tools {
            let tool = tool.trim().to_ascii_lowercase();
            if TRIAGE_TOOL_DOMAINS.contains(&tool.as_str()) && !tools.contains(&tool) {
                tools.push(tool);
            }
        }
        // 空集合没有意义（试判将无工具可用），回落到默认最宽集合。
        self.tools = if tools.is_empty() {
            default_tools()
        } else {
            tools
        };
        self.max_skips = self.max_skips.clamp(1, 100);
        self.max_silence_minutes = self.max_silence_minutes.clamp(5, 10_080);
        self.skip_sample_rate = if self.skip_sample_rate.is_finite() {
            self.skip_sample_rate.clamp(0.0, 1.0)
        } else {
            TRIAGE_DEFAULT_SKIP_SAMPLE_RATE
        };
        self.escalate.stop_distance_pct = if self.escalate.stop_distance_pct.is_finite() {
            self.escalate.stop_distance_pct.clamp(0.01, 100.0)
        } else {
            TRIAGE_DEFAULT_STOP_DISTANCE_PCT
        };
        // C25-4：口径固定。老配置里的 `lower_is_safer`（或任何其他值）**一律忽略**、
        // 归一为固定语义，且不报错 —— 校验/分支代码不再存在。
        self.escalate.margin_ratio_convention = MARGIN_RATIO_HIGHER_IS_SAFER.to_string();
        self.escalate.margin_ratio_pct = if self.escalate.margin_ratio_pct.is_finite() {
            self.escalate
                .margin_ratio_pct
                .clamp(1.0, TRIAGE_MARGIN_RATIO_MAX_PCT)
        } else {
            TRIAGE_DEFAULT_MARGIN_RATIO_PCT
        };
        self.escalate.condition_resonance = self.escalate.condition_resonance.clamp(1, 32);
        let mut triggers = Vec::new();
        for trigger in self.escalate.skip_triage_triggers {
            let trigger = trigger.trim().to_string();
            if !trigger.is_empty() && !triggers.contains(&trigger) {
                triggers.push(trigger);
            }
        }
        self.escalate.skip_triage_triggers = triggers;
        self
    }

    pub fn is_off(&self) -> bool {
        self.mode == TRIAGE_MODE_OFF
    }

    pub fn is_enforce(&self) -> bool {
        self.mode == TRIAGE_MODE_ENFORCE
    }

    /// 该 trigger 类型是否豁免试判（简报/复盘）。
    pub fn skips_trigger(&self, trigger_type: &str) -> bool {
        self.escalate
            .skip_triage_triggers
            .iter()
            .any(|trigger| trigger == trigger_type)
    }

    /// 试判阶段允许的只读域（空 = 全部只读，但归一化不会产生空集合）。
    pub fn allows_domain(&self, domain: &str) -> bool {
        self.tools.iter().any(|tool| tool == domain)
    }
}

/// 试判阶段（一次运行内的阶段状态机）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriagePhase {
    /// 尚未提交 verdict：只允许试判只读域，禁止点名专家。
    Triage,
    /// 已放行深度（verdict=true / shadow / 抽样复检 / 强制升级）。
    Deep,
    /// enforce 下判定跳过：只允许 `background.finishRun`。
    Skipped,
}

impl TriagePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            TriagePhase::Triage => "triage",
            TriagePhase::Deep => "deep",
            TriagePhase::Skipped => "skipped",
        }
    }
}

/// 一次运行内的试判状态（`Arc<Mutex<..>>` 挂在 `BackgroundRunContext` 上，
/// 由同一次运行的所有工具调用共享）。
#[derive(Debug, Clone, PartialEq)]
pub struct RunTriageState {
    pub config: AiAgentTriageConfig,
    /// `None` = 尚未提交试判结论（仍在试判阶段）。
    pub verdict: Option<bool>,
    pub reasons: Vec<String>,
    pub evidence: Vec<AiTriageEvidence>,
    pub forced_by: Vec<String>,
    pub sampled: bool,
    /// enforce 下判定跳过（运行应以 `status: skipped` 收尾）。
    pub skipped: bool,
    /// 提交 verdict 时的下一次唤醒计划（skip 必须带）。
    pub next_wake_plan: Option<serde_json::Value>,
    /// 抽样复检的判定单元（便于测试注入确定值）。
    pub sample_unit: f64,
    /// Profile 级的连续跳过次数与上次深度完成时间（判定反饥饿用）。
    pub skip_streak: u32,
    pub last_deep_at: Option<i64>,
    /// 试判阶段的 token 用量快照（提交 verdict 时写入；深度段 = 总量 − 试判段）。
    pub triage_usage: Option<serde_json::Value>,
    pub started_at: i64,
}

impl Default for RunTriageState {
    fn default() -> Self {
        Self {
            config: AiAgentTriageConfig::default(),
            verdict: None,
            reasons: Vec::new(),
            evidence: Vec::new(),
            forced_by: Vec::new(),
            sampled: false,
            skipped: false,
            next_wake_plan: None,
            sample_unit: 1.0,
            skip_streak: 0,
            last_deep_at: None,
            triage_usage: None,
            started_at: 0,
        }
    }
}

impl RunTriageState {
    pub fn new(config: AiAgentTriageConfig, skip_streak: u32, last_deep_at: Option<i64>, now: i64) -> Self {
        Self {
            config: config.normalized(),
            skip_streak,
            last_deep_at,
            started_at: now,
            ..Default::default()
        }
    }

    /// 当前阶段。`mode=off` 时永远视为深度阶段（无试判门）。
    pub fn phase(&self) -> TriagePhase {
        if self.config.is_off() {
            return TriagePhase::Deep;
        }
        match self.verdict {
            None => TriagePhase::Triage,
            Some(false) if self.skipped => TriagePhase::Skipped,
            Some(_) => TriagePhase::Deep,
        }
    }
}

/// verdict 里的一条证据（C19.2 形状）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTriageEvidence {
    pub fact: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub at: String,
}

/// 试判硬升级判定所需的输入（由 Rust 侧采集器填；`None` = 该数据不可得）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TriageEscalationInputs {
    /// 持仓或挂单自上次深度运行以来发生变化。
    pub position_or_order_changed: Option<bool>,
    /// 当前最小止损距离（百分比，越小越危险）。
    pub min_stop_distance_pct: Option<f64>,
    /// 当前账户所有持仓的原始 `mgnRatio`（OKX 语义：越大越安全；原值保留用于分布核对）。
    pub margin_ratios: Vec<f64>,
    /// AI 标记位被**已确认** K 线突破。
    pub confirmed_break_of_flagged_level: Option<bool>,
    /// 本轮独立条件共振数量。
    pub condition_resonance: Option<u32>,
    /// 上次深度运行以来是否出现重要事件。
    pub important_news: Option<bool>,
}

/// 取"最危险"的保证金率：口径固定为"越大越安全"，因此最危险 = **最小值**。
pub fn riskiest_margin_ratio(ratios: &[f64]) -> Option<f64> {
    let mut iter = ratios.iter().copied().filter(|value| value.is_finite());
    let first = iter.next()?;
    Some(iter.fold(first, f64::min))
}

/// 命中硬升级清单的规则名（`forcedBy`）。顺序稳定，便于 UI 展示与测试断言。
pub fn evaluate_triage_escalation(
    config: &AiAgentTriageConfig,
    inputs: &TriageEscalationInputs,
    skip_streak: u32,
    minutes_since_deep: Option<i64>,
) -> Vec<String> {
    let mut forced = Vec::new();
    let escalate = &config.escalate;
    if escalate.position_or_order_changed && inputs.position_or_order_changed == Some(true) {
        forced.push("positionOrOrderChanged".to_string());
    }
    if let Some(distance) = inputs.min_stop_distance_pct {
        if distance <= escalate.stop_distance_pct {
            forced.push(format!(
                "stopDistancePct({distance:.2}% <= {:.2}%)",
                escalate.stop_distance_pct
            ));
        }
    }
    if let Some(ratio) = riskiest_margin_ratio(&inputs.margin_ratios) {
        // OKX 口径（C25-4 固定）：≤100% 强平，越小越危险 → 小于等于阈值即强制深度。
        if ratio <= escalate.margin_ratio_pct {
            forced.push(format!(
                "marginRatioPct({ratio:.2}% <= {:.2}%, {})",
                escalate.margin_ratio_pct, MARGIN_RATIO_HIGHER_IS_SAFER
            ));
        }
    }
    if escalate.confirmed_break_of_flagged_level
        && inputs.confirmed_break_of_flagged_level == Some(true)
    {
        forced.push("confirmedBreakOfFlaggedLevel".to_string());
    }
    if let Some(resonance) = inputs.condition_resonance {
        if resonance >= escalate.condition_resonance {
            forced.push(format!(
                "conditionResonance({resonance} >= {})",
                escalate.condition_resonance
            ));
        }
    }
    if escalate.important_news && inputs.important_news == Some(true) {
        forced.push("importantNews".to_string());
    }
    // 反饥饿（C19.3）：连续跳过达到上限，或静默超过上限。
    if skip_streak >= config.max_skips {
        forced.push(format!(
            "skipStreak({skip_streak} >= {})",
            config.max_skips
        ));
    }
    if let Some(minutes) = minutes_since_deep {
        if minutes > i64::from(config.max_silence_minutes) {
            forced.push(format!(
                "silenceMinutes({minutes} > {})",
                config.max_silence_minutes
            ));
        }
    }
    forced
}

/// 试判结果的最终裁定（纯函数结果）。
#[derive(Debug, Clone, PartialEq)]
pub struct TriageDecision {
    /// 硬升级命中的规则（非空 = `escalate:false` 被否决，强制深度）。
    pub forced_by: Vec<String>,
    /// 抽样复检命中（即使 verdict=false 也执行深度）。
    pub sampled: bool,
    /// enforce 下判定跳过（运行应以 `status: skipped` 收尾）。
    pub skipped: bool,
    pub phase: TriagePhase,
}

/// 裁定一次试判（C19.2/C19.3 的完整规则，纯函数）。
///
/// - `forced_by` 非空 → 强制升级（试判只能加码）；
/// - `sampled` 命中 → 深度照跑但**如实标记为抽样复检**；
/// - `shadow` → skip 不阻断深度（`skipped=false`，phase=Deep）但 verdict 照记；
/// - `enforce` 且 verdict=false 且未抽样未强制 → `skipped=true`，phase=Skipped。
pub fn decide_triage_outcome(
    config: &AiAgentTriageConfig,
    escalate: bool,
    forced_by: Vec<String>,
    sampled: bool,
) -> TriageDecision {
    let config = config.clone().normalized();
    if config.is_off() {
        return TriageDecision {
            forced_by,
            sampled,
            skipped: false,
            phase: TriagePhase::Deep,
        };
    }
    if !forced_by.is_empty() || escalate || sampled {
        return TriageDecision {
            forced_by,
            sampled,
            skipped: false,
            phase: TriagePhase::Deep,
        };
    }
    if config.is_enforce() {
        return TriageDecision {
            forced_by,
            sampled: false,
            skipped: true,
            phase: TriagePhase::Skipped,
        };
    }
    // shadow：记录 verdict，但仍执行深度。
    TriageDecision {
        forced_by,
        sampled: false,
        skipped: false,
        phase: TriagePhase::Deep,
    }
}

/// 抽样复检判定：`unit` 是 [0,1) 的判定单元（测试可注入确定值）。
pub fn sampling_hit(rate: f64, unit: f64) -> bool {
    if !rate.is_finite() || rate <= 0.0 {
        return false;
    }
    if rate >= 1.0 {
        return true;
    }
    unit.clamp(0.0, 1.0) < rate
}

/// 试判阶段的工具面门（C19.2-1/2）。返回 `Ok(())` 表示放行。
///
/// - 试判阶段：只放行配置里允许的只读域（`market.read*` / `account.read*` / `intelligence.*` / `radar.*`），
///   `account.*` 仍要求绑定账户；`consult_expert` / `consult_experts` 明确拒绝（要求先提交试判）；
/// - 跳过阶段：只放行 `background.finishRun`；
/// - 深度阶段 / `mode=off`：不额外限制（其余硬边界仍在 `authorize_ai_tool` 里照常执行）。
pub fn triage_allows_tool(
    state: &RunTriageState,
    canonical: &str,
    has_account: bool,
) -> Result<(), String> {
    match state.phase() {
        TriagePhase::Deep => Ok(()),
        TriagePhase::Skipped => {
            if canonical == "background.finishRun" || canonical == "background.reportTriage" {
                Ok(())
            } else {
                Err(
                    "本次运行已判定为跳过（试判 verdict=跳过），只允许 background.finishRun 收尾"
                        .to_string(),
                )
            }
        }
        TriagePhase::Triage => {
            if matches!(canonical, "consult_expert" | "consult_experts") {
                return Err(
                    "试判尚未提交：请先用 background.reportTriage 提交试判结论，再点名专家"
                        .to_string(),
                );
            }
            if canonical == "background.reportTriage" {
                return Ok(());
            }
            let domain = if canonical.starts_with("market.") {
                "market"
            } else if canonical.starts_with("account.") {
                "account"
            } else if canonical.starts_with("intelligence.") {
                "intelligence"
            } else if canonical.starts_with("radar.") {
                "radar"
            } else {
                return Err(format!(
                    "试判阶段只允许这些只读域：market / account / intelligence / radar（本次工具：{canonical}）"
                ));
            };
            if !state.config.allows_domain(domain) {
                return Err(format!(
                    "试判阶段未启用该只读域：{domain}（可在 Profile 的试判配置里调整）"
                ));
            }
            // 只读域门只认读类工具：`market.*`/`radar.*`/`intelligence.*` 目前全是只读；
            // `account.read*` 之外若出现写类，由 authorize_ai_tool 的既有硬边界拦截。
            if domain == "account" && !has_account {
                return Err("试判阶段缺少绑定账户，account 类证据不可用".to_string());
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_enforce() -> AiAgentTriageConfig {
        AiAgentTriageConfig::default().normalized()
    }

    #[test]
    fn margin_ratio_defaults_follow_okx_convention() {
        let config = AiAgentTriageConfig::default();
        assert_eq!(config.escalate.margin_ratio_pct, 150.0, "默认阈值 150");
        assert_eq!(
            config.escalate.margin_ratio_convention,
            MARGIN_RATIO_HIGHER_IS_SAFER,
            "OKX 口径：越大越安全"
        );
        assert_eq!(TRIAGE_MARGIN_RATIO_MAX_PCT, 100_000.0);
        // 口径白名单：未知值回落 higher_is_safer；阈值收敛到 (0, 100000]。
        let normalized = AiAgentTriageConfig {
            escalate: AiAgentTriageEscalate {
                margin_ratio_convention: "sideways".to_string(),
                margin_ratio_pct: 500_000.0,
                ..AiAgentTriageEscalate::default()
            },
            ..AiAgentTriageConfig::default()
        }
        .normalized();
        assert_eq!(
            normalized.escalate.margin_ratio_convention,
            MARGIN_RATIO_HIGHER_IS_SAFER
        );
        assert_eq!(normalized.escalate.margin_ratio_pct, 100_000.0);
    }

    #[test]
    fn margin_ratio_rule_uses_convention_and_threshold() {
        let config = config_enforce();
        // OKX 口径：120% ≤ 150% → 强制深度（离强平不足 1.5× 缓冲）。
        let low = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                margin_ratios: vec![120.0],
                ..Default::default()
            },
            0,
            None,
        );
        assert!(low.iter().any(|rule| rule.starts_with("marginRatioPct")), "{low:?}");
        // 1500% 健康 → 不强制。
        let healthy = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                margin_ratios: vec![1500.0],
                ..Default::default()
            },
            0,
            None,
        );
        assert!(healthy.is_empty(), "{healthy:?}");
        // 多持仓取最危险的那个（越大越安全 → 取最小）。
        let mixed = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                margin_ratios: vec![1500.0, 120.0, 800.0],
                ..Default::default()
            },
            0,
            None,
        );
        assert!(mixed.iter().any(|rule| rule.contains("120.00")));
        // C25-4：老配置里的反向口径（`lower_is_safer`）**被忽略并归一**为固定语义 ——
        // 1500 是健康的（越大越安全），因此**不**命中；也没有任何分支按反向比较。
        let flipped = AiAgentTriageConfig {
            escalate: AiAgentTriageEscalate {
                margin_ratio_convention: "lower_is_safer".to_string(),
                ..AiAgentTriageEscalate::default()
            },
            ..AiAgentTriageConfig::default()
        }
        .normalized();
        assert_eq!(
            flipped.escalate.margin_ratio_convention,
            MARGIN_RATIO_HIGHER_IS_SAFER,
            "口径固定，不可配置"
        );
        let flipped_hit = evaluate_triage_escalation(
            &flipped,
            &TriageEscalationInputs {
                margin_ratios: vec![1500.0],
                ..Default::default()
            },
            0,
            None,
        );
        // 1500（健康值）在固定口径下**不**命中（老的反向口径若生效就会命中，这里证明它被忽略）。
        assert!(flipped_hit.is_empty(), "{flipped_hit:?}");
        // 120 仍在强平缓冲区内 → 命中，且比较号固定是 `<=`。
        let flipped_miss = evaluate_triage_escalation(
            &flipped,
            &TriageEscalationInputs {
                margin_ratios: vec![120.0],
                ..Default::default()
            },
            0,
            None,
        );
        assert!(
            flipped_miss.iter().any(|rule| rule.contains("<=")),
            "{flipped_miss:?}"
        );
        // 0 / 负值 / 超大值不进入判定（采集器把它们列入 unavailable）。
        assert!(evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                margin_ratios: Vec::new(),
                ..Default::default()
            },
            0,
            None,
        )
        .is_empty());
        assert_eq!(riskiest_margin_ratio(&[]), None);
        // 固定"越大越安全" → 最危险 = 最小值。
        assert_eq!(riskiest_margin_ratio(&[1500.0, 120.0]), Some(120.0));
        assert_eq!(riskiest_margin_ratio(&[800.0, 1500.0]), Some(800.0));
        // 非有限值被忽略（只按有效样本判定）。
        assert_eq!(riskiest_margin_ratio(&[f64::NAN, 900.0]), Some(900.0));
    }

    #[test]
    fn defaults_match_contract_c19_1() {
        let config = AiAgentTriageConfig::default();
        assert_eq!(config.mode, "enforce", "董事会冻结默认 enforce");
        assert_eq!(
            config.tools,
            vec!["market", "account", "intelligence", "radar"]
        );
        assert_eq!(config.max_skips, 3);
        assert_eq!(config.max_silence_minutes, 120);
        assert_eq!(config.skip_sample_rate, 0.2);
        assert_eq!(config.escalate.stop_distance_pct, 1.5);
        assert_eq!(config.escalate.margin_ratio_pct, 150.0);
        assert_eq!(config.escalate.condition_resonance, 2);
        assert!(config.escalate.position_or_order_changed);
        assert!(config.escalate.confirmed_break_of_flagged_level);
        assert!(config.escalate.important_news);
        assert_eq!(
            config.escalate.skip_triage_triggers,
            vec!["intelligence_briefing", "daily_market_review"]
        );
    }

    #[test]
    fn partial_json_fills_defaults_and_normalizes_garbage() {
        // 旧 Profile：整块缺失 → 默认（serde default）。
        let missing: AiAgentTriageConfig = serde_json::from_str("{}").expect("deserialize {}");
        assert_eq!(missing, AiAgentTriageConfig::default());
        // 只给了个别字段 → 其余用默认。
        let partial: AiAgentTriageConfig =
            serde_json::from_str(r#"{ "mode": "shadow", "maxSkips": 5 }"#).expect("partial");
        assert_eq!(partial.mode, "shadow");
        assert_eq!(partial.max_skips, 5);
        assert_eq!(partial.max_silence_minutes, 120);
        assert_eq!(partial.escalate.stop_distance_pct, 1.5);
        // 垃圾值：未知 mode → enforce；未知域丢弃；负数/越界收敛。
        let garbage = AiAgentTriageConfig {
            mode: "bogus".to_string(),
            tools: vec!["market".to_string(), "shell".to_string(), "market".to_string()],
            max_skips: 0,
            max_silence_minutes: 0,
            skip_sample_rate: 9.9,
            escalate: AiAgentTriageEscalate {
                stop_distance_pct: -3.0,
                margin_ratio_pct: f64::NAN,
                condition_resonance: 0,
                ..AiAgentTriageEscalate::default()
            },
        }
        .normalized();
        assert_eq!(garbage.mode, "enforce");
        assert_eq!(garbage.tools, vec!["market"]);
        assert_eq!(garbage.max_skips, 1);
        assert_eq!(garbage.max_silence_minutes, 5);
        assert_eq!(garbage.skip_sample_rate, 1.0);
        assert_eq!(garbage.escalate.stop_distance_pct, 0.01);
        assert_eq!(garbage.escalate.margin_ratio_pct, 150.0);
        assert_eq!(garbage.escalate.condition_resonance, 1);
    }

    #[test]
    fn escalation_rules_fire_independently() {
        let config = config_enforce();
        let none = evaluate_triage_escalation(&config, &TriageEscalationInputs::default(), 0, Some(10));
        assert!(none.is_empty(), "无数据/未命中不得强制");

        let stop = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                min_stop_distance_pct: Some(1.2),
                ..Default::default()
            },
            0,
            None,
        );
        assert!(stop.iter().any(|rule| rule.starts_with("stopDistancePct")));
        assert!(
            evaluate_triage_escalation(
                &config,
                &TriageEscalationInputs {
                    min_stop_distance_pct: Some(2.5),
                    ..Default::default()
                },
                0,
                None,
            )
            .is_empty(),
            "止损距离充足不强制"
        );

        // 保证金率单独有专项用例（margin_ratio_rule_uses_convention_and_threshold）。
        let margin = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                margin_ratios: vec![120.0],
                ..Default::default()
            },
            0,
            None,
        );
        assert!(margin.iter().any(|rule| rule.starts_with("marginRatioPct")));

        let changed = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                position_or_order_changed: Some(true),
                ..Default::default()
            },
            0,
            None,
        );
        assert!(changed.iter().any(|rule| rule == "positionOrOrderChanged"));

        let resonance = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                condition_resonance: Some(2),
                ..Default::default()
            },
            0,
            None,
        );
        assert!(resonance.iter().any(|rule| rule.starts_with("conditionResonance")));

        let news = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                important_news: Some(true),
                ..Default::default()
            },
            0,
            None,
        );
        assert!(news.iter().any(|rule| rule == "importantNews"));

        let flag = evaluate_triage_escalation(
            &config,
            &TriageEscalationInputs {
                confirmed_break_of_flagged_level: Some(true),
                ..Default::default()
            },
            0,
            None,
        );
        assert!(flag.iter().any(|rule| rule == "confirmedBreakOfFlaggedLevel"));
    }

    #[test]
    fn starvation_rules_force_deep() {
        let config = config_enforce();
        let streak = evaluate_triage_escalation(&config, &TriageEscalationInputs::default(), 3, Some(10));
        assert!(streak.iter().any(|rule| rule.starts_with("skipStreak")));
        assert!(
            evaluate_triage_escalation(&config, &TriageEscalationInputs::default(), 2, Some(10)).is_empty(),
            "未达上限不强制"
        );
        let silence =
            evaluate_triage_escalation(&config, &TriageEscalationInputs::default(), 0, Some(121));
        assert!(silence.iter().any(|rule| rule.starts_with("silenceMinutes")));
        // 从未有过深度运行：用本轮启动时间兜底（采集器负责换算），这里 0 表示不触发。
        assert!(evaluate_triage_escalation(&config, &TriageEscalationInputs::default(), 0, None).is_empty());
    }

    #[test]
    fn decisions_cannot_lift_hard_escalation() {
        let config = config_enforce();
        // verdict=false + 硬升级命中 → 强制深度（试判只能加码）。
        let forced = decide_triage_outcome(&config, false, vec!["stopDistancePct".to_string()], false);
        assert!(!forced.skipped);
        assert_eq!(forced.phase, TriagePhase::Deep);
        assert!(!forced.forced_by.is_empty());
        // verdict=false 无强制无抽样 → skip。
        let skipped = decide_triage_outcome(&config, false, Vec::new(), false);
        assert!(skipped.skipped);
        assert_eq!(skipped.phase, TriagePhase::Skipped);
        // verdict=false + 抽样命中 → 深度照跑并标记。
        let sampled = decide_triage_outcome(&config, false, Vec::new(), true);
        assert!(sampled.sampled);
        assert!(!sampled.skipped);
        assert_eq!(sampled.phase, TriagePhase::Deep);
        // shadow：verdict=false 不阻断深度。
        let shadow = decide_triage_outcome(
            &AiAgentTriageConfig {
                mode: "shadow".to_string(),
                ..AiAgentTriageConfig::default()
            },
            false,
            Vec::new(),
            false,
        );
        assert!(!shadow.skipped);
        assert_eq!(shadow.phase, TriagePhase::Deep);
        // off：无门。
        let off = decide_triage_outcome(
            &AiAgentTriageConfig {
                mode: "off".to_string(),
                ..AiAgentTriageConfig::default()
            },
            false,
            Vec::new(),
            false,
        );
        assert_eq!(off.phase, TriagePhase::Deep);
    }

    #[test]
    fn sampling_rate_is_respected() {
        assert!(!sampling_hit(0.0, 0.0));
        assert!(sampling_hit(1.0, 0.99));
        assert!(sampling_hit(0.2, 0.0));
        assert!(sampling_hit(0.2, 0.199));
        assert!(!sampling_hit(0.2, 0.2));
        assert!(!sampling_hit(0.2, 0.9));
        assert!(!sampling_hit(f64::NAN, 0.0));
    }

    #[test]
    fn tool_face_gate_blocks_out_of_scope_and_jumps_the_phase_queue() {
        let state = RunTriageState::new(config_enforce(), 0, None, 0);
        assert_eq!(state.phase(), TriagePhase::Triage);
        // 试判允许的只读域。
        assert!(triage_allows_tool(&state, "market.readTicker", true).is_ok());
        assert!(triage_allows_tool(&state, "radar.readRanking", true).is_ok());
        assert!(triage_allows_tool(&state, "intelligence.news.list", true).is_ok());
        assert!(triage_allows_tool(&state, "account.readRisk", true).is_ok());
        // account 需要绑账户。
        let error = triage_allows_tool(&state, "account.readRisk", false).expect_err("no account");
        assert!(error.contains("账户"), "{error}");
        // 越范围：写类/交易类/通知/收尾都被拒。
        for tool in [
            "tradeOpportunity.create",
            "trade.placeOrder",
            "notification.feishu.send",
            "script.run",
            "background.finishRun",
            "agent.create",
        ] {
            let error = triage_allows_tool(&state, tool, true).expect_err("out of scope");
            assert!(error.contains("试判阶段只允许"), "{tool}: {error}");
        }
        // 未提交 verdict 前不得点名专家。
        for tool in ["consult_expert", "consult_experts"] {
            let error = triage_allows_tool(&state, tool, true).expect_err("verdict first");
            assert!(error.contains("reportTriage"), "{tool}: {error}");
        }
        // 试判工具本身始终可调。
        assert!(triage_allows_tool(&state, "background.reportTriage", true).is_ok());

        // 跳过阶段：只允许收尾（与（再）提交试判）。
        let mut skipped = state.clone();
        skipped.verdict = Some(false);
        skipped.skipped = true;
        assert_eq!(skipped.phase(), TriagePhase::Skipped);
        assert!(triage_allows_tool(&skipped, "background.finishRun", true).is_ok());
        let error = triage_allows_tool(&skipped, "consult_experts", true).expect_err("skipped");
        assert!(error.contains("跳过"), "{error}");
        assert!(triage_allows_tool(&skipped, "market.readTicker", true).is_err());

        // 深度阶段：不再额外限制（其余硬边界照旧）。
        let mut deep = state.clone();
        deep.verdict = Some(true);
        assert_eq!(deep.phase(), TriagePhase::Deep);
        assert!(triage_allows_tool(&deep, "consult_experts", true).is_ok());
        assert!(triage_allows_tool(&deep, "tradeOpportunity.create", true).is_ok());

        // mode=off：永远深度阶段。
        let off = RunTriageState::new(
            AiAgentTriageConfig {
                mode: "off".to_string(),
                ..AiAgentTriageConfig::default()
            },
            0,
            None,
            0,
        );
        assert_eq!(off.phase(), TriagePhase::Deep);
        assert!(triage_allows_tool(&off, "consult_experts", true).is_ok());
    }

    #[test]
    fn trigger_exemption_matches_contract_defaults() {
        let config = config_enforce();
        assert!(config.skips_trigger("intelligence_briefing"));
        assert!(config.skips_trigger("daily_market_review"));
        assert!(!config.skips_trigger("manual"));
        assert!(!config.skips_trigger("timer"));
    }
}
