// C29 快判模式（fastlane）侧车实现：一轮 = ① Jev 秒级判定 ② 窄调用 LLM 写参数/写下一轮观察条件。
// 设计依据：docs/agent-fastlane-design.md + 契约 C29（尤其 C29.3 / C29.7）。
//
// 三条纪律（实测所得，写死在代码里）：
//   1. 窄调用**必须关思考**（`reasoning_effort: "none"`）：开思考时 8.1s 且输出为空；
//   2. 一轮只有两次模型调用，**侧车自己不取数、不调工具**（快照由 Rust 备好）；
//   3. 快判轮里唯一的"动作"出口是 `createOpportunity`（既有「创建机会」工具的转发通道），
//      降险动作走同一条链路，不存在旁路。
//
// 安全：`typesafeApiKey` 只用于请求头，绝不进事件/日志/报告；调用方还会把 key 登记进
// 侧车的诊断脱敏表（`rememberDiagnosticSecret`）作为第二道保险。

export const FASTLANE_DEFAULTS = Object.freeze({
  jevBaseUrl: "https://api.typesafe.ai",
  jevModel: "jev-latest",
  jevTimeoutMs: 1_500,
  llmTimeoutMs: 3_000,
  llmReasoningEffort: "none",
  llmTemperature: 0.2,
  llmMaxTokens: 800,
  /**
   * **入场质量门（几何 R:R 底线）默认值 1.2**（名字/clamp/三处同源纪律沿用，**语义在 C29.18 变了**）。
   *
   * **C29.18（2026-09-21）语义变更：从「读 Jev `quality` 分」改成「纯代码判据的几何 R:R 底线」。**
   * 依据 `artifacts/fastlane-quality-rephrase/report-20260921-081256.md` §0/§1/§2/§6：
   *   - `quality` 这一问的**门槛 1.2 落在它自己的支撑集 [1.31, 2.19] 之外 ⇒ 这道门等于没拦**
   *     （门槛 1.2 下放行 116/116 = 100%，TPR 100% / FPR 100%）；最优分辨点 1.6 也只有
   *     TPR 46.3%（31/67）/ FPR 12.2%（6/49）；
   *   - 换问法三种（具体动作锚点 / 拆两问 / 0–2 档+赔率优先）**都比现状差**
   *     （AUC 0.466 / 0.5612 / 0.5065 vs 现状 0.6806；ΔAUC 配对 bootstrap 2.5% 分位全部 < 0）
   *     ⇒ 结论：**换问法没用，这道门不该再问模型**。
   *   - 报告 §6 最小清单 ①②③④ 就是本条的改动清单（纯代码判据 + 门槛常量语义改为几何 R:R 底线 +
   *     `quality` 降级为观察量）。
   *
   * 语义（**唯一实现 = 本文件 [`fastlaneEntryQuality`]**，Rust 只读结果）：
   *   `几何 R:R = |目标位 − entry| / |entry − discipline_stop| ≥ 本值`，
   *   其中目标位 = 「**能付得起这份风险的最近合理结构位**」（与 C29.15 修正后的「第一目标」**同一取数**、
   *   门槛参数化，见 [`fastlaneFirstTarget`]）。
   *
   * **默认 1.2（宽起步，用户拍板）**：先取宽值上线，1.2 / 1.6 两档对照由
   * `artifacts/fastlane-code-quality-gate/` 的验收产物给（1.6 = C29.16 实测的现状最佳分辨点）。
   * 值本身仍 clamp 到 **0.5–3.0**（[`FASTLANE_QUALITY_FLOOR_MIN`] / `MAX`）——低于 0.5 等于对任何
   * 几何都不拦（R:R < 0.5 的单子在纪律里本来就不成立），高于 3.0 在本批数据上结构性打不中。
   *
   * 注意：**只影响缺省值**——已有 Profile 落盘的 `fastlaneQualityFloor` 不会自动变，
   * 需要用户在快判配置窗口里手动改（见 docs/agent-library-contract.md 同一处说明）。
   *
   * **三处同源**：本常量 / Rust `FASTLANE_DEFAULT_QUALITY_FLOOR` /
   * UI `FASTLANE_DEFAULTS.qualityFloor`（有源码级防漂移断言）。
   * **只作用于开仓**：降险豁免（C29.10/C29.14）不动；降险臂压根没有方向 → 本门对它**不适用**。
   */
  qualityFloor: 1.2,
  /**
   * **入场分门槛**默认值 **1.5**（2026-09-21 用户裁决：改用双打分 + 代码侧阈值，默认取保守值）。
   *
   * 依据：`artifacts/fastlane-jev-rephrase-probe/report-20260921-070600.md` §1/§2（真实调用 Jev，
   * 1280 次里换问法那一批 408 次）——把「该做什么？」（含观望的选择题）换成两个 `score`
   * （`long_score` / `short_score`：**现在做多/做空这一个具体动作**有多该做）之后，同一份
   * byte 级相同的 state 上，「给方向率」从 **0.0%（0/318）** 变成阈值 1.0 时 **80.5%（256/318）**、
   * 阈值 1.5 时 16.0%（51/318，方向准确率 100%）；阈值 2/2.5/3 结构性打不中（0%）。
   *
   * ⚠️ **尺度警告（必读）**：`score` 是 **0–4 分布上的期望值**（实测 |score − Σk·P(k)| 中位误差 0.01，
   * 取值连续、集中 0.2–1.9），**不是档位**。所以门槛必须落在期望值尺度上：照直觉取 2/2.5/3
   * 会得到 0% 给方向率（本轮已量化）。
   *
   * 裁决口径：默认 **1.5（保守）**——只放行「分数明显高」的那一小批（本轮 16.0%），
   * 用户可在快判配置窗口下调到 1.0（80.5%）/ 0.5（99.1%）。阈值只决定**方向判定**，
   * 不替代质量门/置信度门，也不放宽任何风控。
   *
   * **三处同源**：本常量 / `src-tauri/src/fastlane.rs::FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR`
   * / UI `src/ui/fastlane/fastlaneDefaults.ts` 的 `FASTLANE_DEFAULTS.entryScoreFloor`
   * （有防漂移断言钉死；Rust `normalized()` 里 clamp 到 0.5–3.0）。
   */
  entryScoreFloor: 1.5,
  /**
   * **降险分门槛**默认值 **1.5**（C29.17，2026-09-21）—— 与入场分门槛**解耦**后的独立旋钮。
   *
   * 背景：C29.14 让降险臂**复用** `entryScoreFloor`，记录里 `reduceScoreFloor` 与
   * `entryScoreFloor` 恒同值（22/22 核对过）—— 那时"想把降险放宽一点"只能连带放宽开仓，
   * 而两类动作的取向本来就不同：开仓要**挑**（宁缺毋滥，代价是错过），降险要**快**
   * （宁可多减一点，代价是少赚）——同一条线同时服务两种取向是妥协，不是裁决。
   *
   * ⚠️ **默认值仍是 1.5，行为与解耦前逐字一致**（同一个门槛值，只是现在能分别调）：
   * 这不是一次"放宽风控"的改动，而是**把旋钮交出来**。侧车/UI/Rust 三处同源（防漂移断言钉死）。
   *
   * 依据（为什么降险比开仓更适合放宽）：`artifacts/fastlane-risk-reduction/`（C29.14 端到端验收）
   * 里降险样本的 `reduce_score` 与"事后确实该减"一致率高于开仓臂；且降险**只作用于既有持仓**
   * （`reducePositionFact !== "held"` 一律不动手），放宽它不产生新仓位、不放大暴露 ——
   * 与开仓臂"放宽 = 多开仓"的风险性质不同。
   *
   * **三处同源**：本常量 / `src-tauri/src/fastlane.rs::FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR`
   * / UI `src/ui/fastlane/fastlaneDefaults.ts` 的 `FASTLANE_DEFAULTS.reduceScoreFloor`
   * （有防漂移断言钉死；Rust `normalized()` 里 clamp 到 0.5–3.0，与入场门槛同规则）。
   */
  reduceScoreFloor: 1.5,
  confidenceFloor: 0.6,
  riskPerTradePct: 0.5,
  maxSlippageBps: 5,
  minRewardRisk: 1.5
});

/// 入场分门槛的可配区间（**与 Rust `FastlaneConfig::normalized()` 的 clamp 同源**）。
export const FASTLANE_ENTRY_SCORE_FLOOR_MIN = 0.5;
export const FASTLANE_ENTRY_SCORE_FLOOR_MAX = 3.0;

/// 降险分门槛的可配区间（C29.17）—— **与入场门槛同规则**（同一个 0–4 期望分尺度，
/// 所以边界也一样：低于 0.5 等于对任何打分都放行，高于 3.0 结构性打不中）。
export const FASTLANE_REDUCE_SCORE_FLOOR_MIN = 0.5;
export const FASTLANE_REDUCE_SCORE_FLOOR_MAX = 3.0;

/// **入场质量门（几何 R:R 底线）**的可配区间（C29.18）—— 与 Rust `FastlaneConfig::normalized()`
/// 和 UI `normalizeFastlaneConfig` **三处同源**（有防漂移断言钉死）。
///   下界 0.5：几何 R:R < 0.5 的单子在纪律里本来就不成立（`validateFastlaneAction` 的盈亏比门槛
///   是 1.5），再往下降只是把这道门关掉 —— 要关就显式取 0.5；
///   上界 3.0：C29.16 好行情臂 116 条的实测几何 R:R 上界远低于 3.0（结构目标位本身很少能给 >3R
///   的最近合理位）→ 3.0 之上结构性打不中，等于把模式卡成只会观望（旧 2.5 的教训）。
export const FASTLANE_QUALITY_FLOOR_MIN = 0.5;
export const FASTLANE_QUALITY_FLOOR_MAX = 3.0;

/**
 * **入场质量门的三条代码判据**（C29.18，2026-09-21）—— 阈值全部写在这里，注释给依据。
 *
 * 取数口径（三条共用，**与 C29.15 §1.3 几何复算 / `hardConstraints`「第一目标」候选逐字同源**）：
 *   `state.structure` 的 `tf_15m` / `tf_1h` / `tf_4h` 里的 `last_swing_high` / `last_swing_low` /
 *   `window_high` / `window_low`；entry = `state.price.last`；ATR = `state.volatility.atr14_1h`。
 * 纪律止损（`hardConstraints` 原文，一字未改）：
 *   做多 `stop = max(最近结构位, entry − 1.5×ATR14_1h)`；做空 `stop = min(最近结构位, entry + 1.5×ATR14_1h)`。
 *   其中「最近结构位」= entry **不利一侧**最近的结构位（做多取 entry 下方最近的低点）。
 */
export const FASTLANE_ENTRY_QUALITY = Object.freeze({
  /**
   * `structure_ok`：结构位**可辨**且处于**可用距离**。
   *   - 结构位缺失（`state.structure` 读不到 / 三个周期一个候选位都没有）→ 不可辨 → 拦；
   *   - 现价**两侧都**要有结构位（做多需要在下方有参考位、上方有目标位）→ 任一侧为空 → 拦；
   *   - 最近结构位（两侧取最近）距离 > `maxStructureAtr × ATR14_1h` → 离得太远、不构成"近端结构"→ 拦。
   *
   * **依据（本仓实测，不拍脑袋）**：C29.16 好行情臂 300 个 state × (标注方向优先，无标注两侧各算)
   *   实测「最近结构位距离 / ATR14_1h」= p50 0.436 / p75 0.821 / p90 1.200 / p95 1.444 / **max 2.499**
   *   —— 也就是说真实 state 里最近结构位**从没超过 2.5×ATR**。所以 3.0 是一条**不触发的护栏**：
   *   它拦住的是"结构整块缺失/被拉得极远"的异常 state（例如只有窗口高低点之外的极远参考位），
   *   而不是把正常回踩位判死。**同时这条也是 `atr14_1h` 缺失时的落点**（没有 ATR 就算不出可用距离
   *   → 按"结构不可辨"处理，与数据门同向：宁可不做，不许瞎做）。
   */
  maxStructureAtr: 3.0,
  /**
   * `stop_placeable` 下界（**过近**）：纪律止损距离 `|entry − stop| / ATR14_1h` 必须 ≥ 本值，
   * 否则止损贴在现价上、落在单根 K 线的噪声里（会被扫）。
   *
   * **依据（本仓实测）**：本批 `atr14_5m / atr14_1h` 实测 p10 0.150 / **p50 0.245** / p90 0.404
   *   → **0.25 ≈ 1×ATR14_5m**（"止损必须在单根 5m K 线的平均振幅之外"这一条噪声口径的可判定化）。
   *   同批实测纪律止损距离 = p10 0.099 / **p25 0.239** / p50 0.705 → 0.25 正好切掉"止损贴在现价上"
   *   的最低四分位，不会把正常回踩单判死。
   */
  minStopAtr: 0.25,
  /**
   * `stop_placeable` 上界（**过远**）：**结构止损锚**距 entry 的 ATR 倍数必须 ≤ 本值。
   *
   * ⚠️ 为什么上界量的是**结构锚**而不是纪律止损：纪律的 `max/min` 让止损距离天然封顶在
   *   `1.5×ATR14_1h`（做多：`entry − 1.5×ATR` 是**更靠近** entry 的那个候选，`max` 取它）——
   *   所以"止损距离 > 1.5×ATR"在任何输入下都不可能发生，拿它当上界等于没拦。真正会发生的失效是：
   *   **最近结构位离得太远**（> 1.5×ATR）⇒ 纪律止损退化成**纯 ATR 距离**（与这笔单的结构失效位无关）
   *   ⇒ 风险不再由结构承载 = "风险超标"。这一条拦的就是它。
   *
   * **依据**：阈值就是纪律自身的 ATR 缓冲（`hardConstraints` 原文的 1.5）——**不新造数字**。
   *   本批实测结构锚距离 = p50 0.705 / p75 1.465 / p90 2.449 → 1.5 恰好压在 p75 上，
   *   24.2% 的 (state, 方向) 对落在"结构位比纪律缓冲还远"这一侧。
   */
  maxAnchorAtr: 1.5,
  /// 纪律止损里的 ATR 缓冲系数（**与 `hardConstraints` 原文逐字一致**；写在这里只为让判据自解释）。
  atrStopBuffer: 1.5,
  /// 「能付得起这份风险」的默认门槛（1R）：目标位取「距 entry ≥ 1×R 的最近合理结构位」。
  /// C29.15 的硬约束用的是 1.5R（那一条的盈亏比门槛就是 1.5）——同一函数、同一取数、只换门槛。
  targetBarR: 1.0
});

/**
 * **入场质量门的三条代码判据的观望码**（C29.18）—— 与 `low_entry_score` / `reduce_*` 同性质：
 * **代码判的，不是模型说的**。三条各自独立，记录里必须能分清是哪一条不过：
 *   - `structure_unclear`：结构位缺失 / 只有单侧 / 离现价太远（或 ATR 缺失，算不出可用距离）；
 *   - `stop_not_placeable`：纪律止损**放不下** —— 过近（< 0.25×ATR，会被扫）或过远（结构锚 >
 *     1.5×ATR，止损退化成纯 ATR 距离）；
 *   - `rr_below_floor`：几何 R:R < `qualityFloor`（没有能付得起这份风险的最近合理结构位）。
 *
 * **三处同源**：本常量 / Rust `FASTLANE_WATCH_REASONS` / UI `FASTLANE_WATCH_REASONS`
 * （UI 按码渲染 `fastlaneWatchReason_*` 文案，缺一码会退化成英文原码；i18n en+zh 都要有）。
 */
export const FASTLANE_ENTRY_QUALITY_WATCH_REASONS = Object.freeze({
  structure: "structure_unclear",
  stop: "stop_not_placeable",
  rr: "rr_below_floor"
});

/// 结构位取数的两个冻结清单（**与 `hardConstraints` 的「第一目标」候选逐字同源**）。
export const FASTLANE_STRUCTURE_FRAMES = Object.freeze(["tf_15m", "tf_1h", "tf_4h"]);
export const FASTLANE_STRUCTURE_KEYS = Object.freeze(["last_swing_high", "last_swing_low", "window_high", "window_low"]);

/**
 * 打分臂**观望**的两个原因码（代码判的，不是模型说的）。
 *
 * 为什么要单独两个码：用户必须一眼看出"这一轮没动手"是**代码按分数判的**，而不是"模型说观望"。
 *   - `low_entry_score`：`max(long, short) < 门槛`（分数不足）；
 *   - `entry_score_tie`：两分并列 → 保守观望（分数可能够，但方向不唯一）。
 *
 * **三处同源**：本常量 / Rust `FASTLANE_WATCH_REASONS` / UI `FASTLANE_WATCH_REASONS`
 * （UI 按码渲染 `fastlaneWatchReason_*` 文案，缺一码会退化成英文原码）。
 */
export const JEV_ENTRY_SCORE_WATCH_REASONS = Object.freeze({
  belowFloor: "low_entry_score",
  tie: "entry_score_tie"
});

/**
 * 降险臂**观望**的两个原因码（C29.14，2026-09-21）—— 与上一条同性质：**代码判的**，不是模型说的。
 *
 * C29.13 的回归：问题面里没有"该不该减仓/平仓"这一问 → Jev 再也没法表达降险（22 条历史降险样本
 * 从 C29.10 的 21/22 掉到 0/22）。本轮补 `reduce_score` 问法恢复该能力，并用这两个码把
 * "**打分器认为该降险，但这轮没得减**"与"模型说观望"彻底分开：
 *   - `reduce_without_position`：`reduce_score ≥ 门槛`，但本品种**当前无持仓**（没有可减的仓位）
 *     → 不得凭空产生降险动作 → 观望；
 *   - `reduce_position_unknown`：`reduce_score ≥ 门槛`，但**持仓事实缺失**
 *     （`state.account.positions` 不是数组 / 读不到）→ 无法确认可减仓位 → 观望。
 *
 * 两码分开的理由：前者是**正常状态**（没仓位当然没得减），后者是**数据异常**（该看见持仓却看不见），
 * 用户要能一眼区分（UI 按码渲染 `fastlaneWatchReason_*`）。
 *
 * **三处同源**：本常量 / Rust `FASTLANE_WATCH_REASONS` / UI `FASTLANE_WATCH_REASONS`
 * （缺一码会退化成英文原码）。
 */
export const JEV_REDUCE_SCORE_WATCH_REASONS = Object.freeze({
  noPosition: "reduce_without_position",
  positionUnknown: "reduce_position_unknown"
});

/**
 * **降险动作**（Jev 自判的减仓/平仓）—— 2026-09-21 变更 A 的唯一判据。
 *
 * 依据（`artifacts/fastlane-jev-sweep/report-20260921-043231.md`）：400 样本 / 580 次 Jev 调用里
 * `open_long/open_short = 0`，动手的 22 条**全是减仓(21)/平仓(1)**，其 `confidence` 只有 0.26–0.47
 * （全在 `confidence_floor=0.6` 之下）→ 旧口径下 0/400 能进动作分支，等于**用机会质量门否决止损**。
 *
 * 变更 A 的口径：质量门 / 置信度门 **只作用于开新仓**；降险（降暴露）不受这两道门约束，
 * 只过参数与风控校验（参数口径见 [`validateFastlaneAction`] 的 `isRiskReducing` 分支，
 * 与 Rust `validate_round` 的 `is_reduce` 同源：`src-tauri/src/fastlane.rs:1457`）。
 */
export const JEV_RISK_REDUCING_ACTIONS = Object.freeze(["reduce", "close"]);

/// Jev 归一化动作是否属于**降险**（`reduce` 减仓 / `close` 平仓）。
export function isRiskReducingJevAction(action) {
  return JEV_RISK_REDUCING_ACTIONS.includes(String(action ?? "").trim().toLowerCase());
}

/// `exit_kind` 的取值域 —— 与 Rust `trade_commands.rs:10577-10586` 逐字同源。
export const FASTLANE_EXIT_KINDS = Object.freeze(["take_profit", "stop_loss", "strategy_exit", "emergency"]);
/// 降险轮缺省 `exit_kind`（Rust `opportunity_input_from_plan` 的兜底值，fastlane.rs:3383-3388）。
export const FASTLANE_DEFAULT_EXIT_KIND = "strategy_exit";

/**
 * 降险轮的动作体 **intent 口径归一**（形状对齐，不改语义）。
 *
 * Rust `action_intent`（`fastlane.rs:2949-2955`）只认 `open|close|cancel|amend`，且
 * `plan_from_opportunity`（`fastlane.rs:3167-3177`）把 `close/cancel/amend` 折叠成降险 order_type。
 * 也就是说：**模型写 `intent:"reduce"`（Rust 不认识）会被回落成开仓口径校验 → 降险参数被拒**。
 * 这里做两件**可留痕**的事（都不改"要不要降险"这个语义）：
 *   1. `intent ∈ {reduce, close}` → `close`（Rust 认的降险入口）；
 *   2. `intent` 缺失 → 补 `close`（Rust 在停机轮里也是这么兜的；在普通轮里它会兜成 `open`，
 *      那会把降险参数按开仓口径拒掉）。
 * `intent:"open"` **一律不改写**（模型若真给开仓意图，按开仓口径交给 Rust 校验，如实留痕）。
 */
export function normalizeRiskReductionIntent(order = {}, notes = []) {
  if (!order || typeof order !== "object" || Array.isArray(order)) return order;
  const raw = String(order.intent ?? "").trim().toLowerCase();
  if (raw === "close") return { ...order, intent: "close" };
  if (raw === "reduce") {
    notes.push("intent_reduce_folded_to_close: 模型写 intent=reduce，Rust `action_intent` 只认 open|close|cancel|amend → 折叠成 close（降险口径不变）");
    return { ...order, intent: "close" };
  }
  if (raw === "") {
    notes.push("intent_defaulted_to_close: 降险轮模型没写 intent，按 Rust 停机轮同口径补 close");
    return { ...order, intent: "close" };
  }
  return order;
}

const JEV_RETRY_STATUSES = new Set([429, 529]);
/// 鉴权类状态码：真机那次 `Jev HTTP 403`（盘上 `typesafeApiKey` 为空）就是这一类 ——
/// 用户看到的信息必须能直接定位到"去哪儿补 key"，而不是一句无法行动的汇总。
const JEV_AUTH_STATUSES = new Set([401, 403]);

/// 鉴权失败的**出路**（用户能照着做的那一步）：设置 → AI。
/// 全仓唯一一处出路文案：HTTP 401/403 与"空 key 预检"共用它，避免两处文案漂移。
export const JEV_KEY_SETTINGS_HINT = "请在 设置 → AI 填写/更新 TypeSafe API Key";

/// 空 key 预检文案：**零往返**（没有请求就没有状态码，也不许把 status 伪造成 401/403）。
export const JEV_MISSING_KEY_ERROR = `Jev 未配置 API Key（未发起请求）：${JEV_KEY_SETTINGS_HINT}`;

/// 失败分类（机器可读，供 Rust 侧挑用户可见文案；事件里新增字段是纯增量）。
export const JEV_FAILURE_KINDS = Object.freeze({
  auth: "auth",
  throttle: "throttle",
  timeout: "timeout",
  network: "network",
  http: "http",
  parse: "parse"
});

/// HTTP 失败 → 可操作 / 可诊断文案（**绝不**包含任何 key 片段，也没有拼接 key 的机会）：
///   - 401/403（鉴权）：带状态码 + 出路；`hasApiKey:false` 是兜底（正常路径已被空 key 预检挡在请求之前）；
///   - 429/529（限流/过载，退避重试已耗尽）：带状态码 + 如实重试次数；
///   - 其它状态：仍带状态码（不吞状态码），不改写语义。
export function describeJevHttpFailure({ status, attempts = 1, hasApiKey = true } = {}) {
  const code = Number(status);
  const known = Number.isFinite(code) ? code : null;
  if (known !== null && JEV_AUTH_STATUSES.has(known)) {
    const missing = hasApiKey ? "" : "，当前未配置 TypeSafe API Key";
    return `Jev 鉴权失败（HTTP ${known}${missing}）：${JEV_KEY_SETTINGS_HINT}`;
  }
  if (known !== null && JEV_RETRY_STATUSES.has(known)) {
    return `Jev 限流/过载（HTTP ${known}，已重试 ${Math.max(0, Number(attempts) - 1)} 次）`;
  }
  return known === null ? "Jev 请求失败：服务返回了无法识别的状态码" : `Jev 判定失败（HTTP ${known}）`;
}

/// 网络/超时失败 → `{label}：{原因}`（原因先过调用方注入的脱敏函数）。
export function describeNetworkFailure(label, error, redact = (value) => String(value ?? "")) {
  const reason = redact(String(error?.message || error || "未知错误")).replace(/\s+/g, " ").trim() || "未知错误";
  return /timeout|abort/i.test(reason) ? `${label}：请求超时（${reason}）` : `${label}：${reason}`;
}

/// Jev 的网络/超时失败（`Jev 请求失败：{原因}`）。
export function describeJevNetworkFailure(error, redact = (value) => String(value ?? "")) {
  return describeNetworkFailure("Jev 请求失败", error, redact);
}

/// 失败分类：事件里给 Rust 侧一个稳定的判据（`auth` 时 `hint` 是一句可直接展示的出路）。
export function classifyJevFailure(errorText, { status = null } = {}) {
  const code = Number(status);
  if (Number.isFinite(code) && JEV_AUTH_STATUSES.has(code)) return JEV_FAILURE_KINDS.auth;
  if (Number.isFinite(code) && JEV_RETRY_STATUSES.has(code)) return JEV_FAILURE_KINDS.throttle;
  const text = String(errorText ?? "");
  // 空 key 预检（零往返、status=null）：文本判据也要认得它，否则调用方会把它归到 http。
  if (/未配置 API Key|未发起请求/.test(text)) return JEV_FAILURE_KINDS.auth;
  if (/请求超时|timeout|abort/i.test(text)) return JEV_FAILURE_KINDS.timeout;
  if (/不是 JSON/.test(text)) return JEV_FAILURE_KINDS.parse;
  if (/请求失败/.test(text)) return JEV_FAILURE_KINDS.network;
  return JEV_FAILURE_KINDS.http;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/// C29.7：`fastlaneConfig` 归一（缺省一律取契约默认值；旧类型不读这些字段）。
export function normalizeFastlaneConfig(rawConfig = {}) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const effort = String(source.fastlane_llm_reasoning_effort ?? source.llmReasoningEffort ?? "")
    .trim()
    .toLowerCase();
  return {
    jevBaseUrl: String(source.fastlane_jev_base_url || FASTLANE_DEFAULTS.jevBaseUrl).trim().replace(/\/+$/, ""),
    jevModel: String(source.fastlane_jev_model || FASTLANE_DEFAULTS.jevModel).trim(),
    jevTimeoutMs: positiveNumber(source.fastlane_jev_timeout_ms ?? source.jevTimeoutMs, FASTLANE_DEFAULTS.jevTimeoutMs),
    llmTimeoutMs: positiveNumber(source.fastlane_llm_timeout_ms ?? source.llmTimeoutMs, FASTLANE_DEFAULTS.llmTimeoutMs),
    llmModel: String(source.fastlane_llm_model || source.llmModel || "").trim(),
    // 关思考是硬要求；配置里写了别的值也不放开（只允许显式 null 表示"不带该参数"的旧端点）
    llmReasoningEffort: effort === "none" || effort === "" ? "none" : FASTLANE_DEFAULTS.llmReasoningEffort,
    llmTemperature: FASTLANE_DEFAULTS.llmTemperature,
    llmMaxTokens: FASTLANE_DEFAULTS.llmMaxTokens,
    qualityFloor: finiteNumber(source.fastlane_quality_floor) ?? FASTLANE_DEFAULTS.qualityFloor,
    // 入场分门槛（打分臂）：只从 `fastlane_entry_score_floor`（Rust 下发的 snake_case）读取。
    // 不做 clamp：归一化的钳制是 Rust `FastlaneConfig::normalized()`（0.5–3.0）与 UI 的职责，
    // 侧车**不静默改用户填的数**（与 qualityFloor 同一口径；越界值在 UI/Rust 侧已被钳住）。
    entryScoreFloor: finiteNumber(source.fastlane_entry_score_floor) ?? FASTLANE_DEFAULTS.entryScoreFloor,
    // 降险分门槛（降险臂，C29.17）：只从 `fastlane_reduce_score_floor`（Rust 下发的 snake_case）读取。
    // 与 `entryScoreFloor` **各自独立**（默认同值 1.5 → 解耦前后行为一致）；同样不做 clamp
    // （钳制是 Rust `normalized()` 与 UI 的职责，侧车不静默改用户填的数）。
    reduceScoreFloor: finiteNumber(source.fastlane_reduce_score_floor) ?? FASTLANE_DEFAULTS.reduceScoreFloor,
    confidenceFloor: finiteNumber(source.fastlane_confidence_floor) ?? FASTLANE_DEFAULTS.confidenceFloor,
    riskPerTradePct: finiteNumber(source.fastlane_risk_per_trade_pct) ?? FASTLANE_DEFAULTS.riskPerTradePct,
    maxSlippageBps: finiteNumber(source.fastlane_max_slippage_bps) ?? FASTLANE_DEFAULTS.maxSlippageBps,
    style: String(source.fastlane_style || "").trim(),
    stylePreset: String(source.fastlane_style_preset || "").trim() || "long_pullback",
    eventBlackoutMinutes: finiteNumber(source.fastlane_event_blackout_minutes) ?? 30
  };
}

/// C29.3：Jev 的问题面。
///
/// **2026-09-21 变更 B（用户裁决，实验结论改生产）**：`action`（choice，含"观望"）**删除**，
/// 换成两个 `score` 问题 `long_score` / `short_score`（各 0–4 档锚点）；`setup_valid` 保持原文不动。
/// 判定不再由模型选标签，而是**代码侧**：`max(long, short) ≥ entryScoreFloor`
/// 且不并列 → 方向 = argmax；否则观望（见 [`decideEntryFromScores`]）。
///
/// **2026-09-21 C29.14（修变更 B 的回归）**：再加一问 `reduce_score`（0–4，问"现在该减仓/平仓
/// 有多该做"，针对现存持仓、无持仓给 0）—— 变更 B 删掉 `action` 后 Jev 失去了表达降险的唯一通道
/// （22 条降险样本 21/22 → 0/22）。降险在代码侧**优先于开仓**，且**永不映射成开仓**。
///
/// **2026-09-21 C29.18：`quality` 这一问删除。** 依据
/// `artifacts/fastlane-quality-rephrase/report-20260921-081256.md`：① 门槛 1.2 落在 `quality` 自己的
/// 支撑集 [1.31, 2.19] 之外 ⇒ 这道门**等于没拦**；② 三种换问法（具体动作锚点 / 拆两问 / 0–2 档+
/// 赔率优先）的判别力**全部低于现状**（AUC 0.466 / 0.5612 / 0.5065 vs 0.6806，ΔAUC 配对 bootstrap
/// 2.5% 分位全部 < 0）⇒ **这道门不该再问模型**。入场质量改由**纯代码判据**承担
/// （[`fastlaneEntryQuality`]：结构可辨 / 止损可放 / 几何 R:R 达线，三条各有独立原因码）。
/// 老侧车 / 老记录里带 `quality` 的响应：**只观察、不参与任何判定**（[`normalizeJevVerdict`] 照旧读它）。
///
/// 依据：`artifacts/fastlane-jev-rephrase-probe/report-20260921-070600.md`
/// （同一份 byte 级相同的 state，仅换问题面：给方向率 0.0% → 阈值 1.0 时 80.5%、
/// 阈值 1.5 时 16.0%；说明"观望"是**选项结构造成的标签偏差**，不是它没有方向偏好）。
///
/// ⚠️ `long_score` / `short_score` 两段的 `instructions` / `criteria` 与实验臂 B **逐字相同** ——
/// 换一个字就等于换了一个未实测的问题面，实验结论（阈值与给方向率）不再适用。要改措辞必须同时重跑
/// `scripts/experiments/fastlane-jev-rephrase-probe.mjs`。`reduce_score` 是 C29.14 新增（实验中
/// **没有**这一问），它的验收必须走 `artifacts/fastlane-reduce-score/` 的端到端产物。
///
/// ⚠️ `score` 是 **0–4 分布上的期望值**（连续、实测集中 0.2–1.9），不是"档位"：
/// `criteria` 的 5 条是**分布锚点**（0…4 档各自的含义），不是"档位选择"。
///
/// **没有 `need_llm`**：不确定一律观望，由窄调用 LLM 写下下一轮观察条件。
export function buildJevQuestions(snapshot = {}) {
  const instrument = snapshot?.inst_id || snapshot?.instrument_id || "该品种";
  const scoreInstructions = (word) =>
    `就在此刻、对这个 state 里的 ${instrument}，**${word}这一个具体动作**有多该做？`
    + `（问的是「现在${word}」该不该做、有多该做；不是「这个品种好不好」，也不是「方向偏多还是偏空」）`;
  return {
    long_score: {
      type: "score",
      instructions: scoreInstructions("做多"),
      criteria: [
        "0 完全不该做：此刻做多没有任何依据（结构向下 / 明显追高 / 结构不清 / 数据不可用）",
        "1 偏弱：有一点做多的理由，但入场位置或结构不到位，现在不该进",
        "2 一般：做多有可接受的理由，但位置或赔率只算中性",
        "3 好：做多的入场位置、结构与赔率都到位，可以现在进",
        "4 很好：做多的教科书级机会，此刻就该进"
      ]
    },
    short_score: {
      type: "score",
      instructions: scoreInstructions("做空"),
      criteria: [
        "0 完全不该做：此刻做空没有任何依据（结构向上 / 明显追杀 / 结构不清 / 数据不可用）",
        "1 偏弱：有一点做空的理由，但入场位置或结构不到位，现在不该进",
        "2 一般：做空有可接受的理由，但位置或赔率只算中性",
        "3 好：做空的入场位置、结构与赔率都到位，可以现在进",
        "4 很好：做空的教科书级机会，此刻就该进"
      ]
    },
    /**
     * **C29.14（2026-09-21）新增：降险问法** —— C29.13 把 `action`（含"减仓/平仓"）换成双打分后，
     * Jev **再也没法表达"该减仓/平仓"**（验收：22 条历史降险样本从 C29.10 的 21/22 掉到 0/22）。
     * 用户裁决「降险不能被拦、不能走旁路」→ 本问恢复该能力，**问题面仍是打分风格**（不回旧 choice）。
     *
     * ⚠️ 与 `long_score` / `short_score` 的区别（必须诚实）：那两个是**实验臂 B 逐字测过的**问题面，
     * 这一问是**本轮新造**的（换问法实验没测过降险面）→ 只能靠本轮端到端验收（22 条降险样本）
     * 证明它真能表达降险，不能引用实验里的给方向率数字。
     *
     * ⚠️ 尺度口径**沿用本轮实验**：`score` 是 **0–4 分布上的期望值**（实测集中 0.2–1.9，连续），
     * 不是"档位选择"；下面 5 条是分布锚点，不是"选一档"。
     *
     * ⚠️ 无持仓时必须给 0：降险是**针对现存持仓**的动作，没有仓位就没有可降的风险
     * （代码侧还有 `reduce_without_position` 兜底，但那不是让模型随便给分的理由）。
     */
    reduce_score: {
      type: "score",
      instructions:
        `就在此刻、对这个 state 里的 ${instrument}，**减仓/平仓（降低风险）这一个具体动作**有多该做？`
        + `（问的是「现在**针对 state.account.positions 里该品种的现存持仓**，该不该减仓或平仓来降低风险、有多该做」；`
        + `**没有持仓时给 0**；不是「该不该开仓」，也不是「这个品种好不好」，也不是「方向偏多还是偏空」）`,
      criteria: [
        "0 完全不该做：现在没有任何降险的理由（趋势与持仓同向、风险与浮亏都在计划内、离止损还远）；**或当前没有持仓**（没有可减的仓位 → 给 0）",
        "1 偏弱：风险略有积累（浮亏扩大 / 结构开始走坏），但还不值得现在动手",
        "2 一般：已经有明确的降险理由（结构转为逆持仓 / 浮盈在回吐 / 逼近止损），现在减与不减都说得过去",
        "3 好：该降险（持仓明显逆风 / 到了预设的减仓区 / 风险已超计划），现在减一部分是合理的",
        "4 很好：教科书级的降险时机（止损被击穿 / 结构彻底反转 / 风险已失控），此刻就该减仓或平仓"
      ]
    },
    setup_valid: {
      type: "noul",
      instructions: "这次入场在语义上算不算到位（回踩到位、非追高、结构健康）？"
    }
  };
}

/// C29.7：Jev 请求（`POST {baseUrl}/v1/systemone`，头里带 Bearer key，body 只有 model/state/questions）。
export function buildJevRequest({ snapshot = {}, config = {} } = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  return {
    url: `${fastlane.jevBaseUrl}/v1/systemone`,
    body: {
      model: fastlane.jevModel,
      state: snapshot,
      questions: buildJevQuestions(snapshot)
    }
  };
}

function hardConstraints({ snapshot = {}, config = {}, intent = "round" } = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  const structure = snapshot?.structure || {};
  const tf1h = structure.tf_1h || {};
  const atr14_1h = finiteNumber(snapshot?.volatility?.atr14_1h);
  const riskPct = fastlane.riskPerTradePct;
  // **降险分支（2026-09-21 变更 A）**：Jev 自判的减仓/平仓只过参数与风控校验，
  // 开仓专属约束（止损公式 / 盈亏比 ≥1.5 / 风格 preset / 市价滑点）在这一支**全部不适用**：
  // 它们会诱导模型返回 abort（"达不到盈亏比"→不降险），正是变更 A 要修掉的失效。
  if (intent === "reduce") return riskReductionConstraints({ snapshot, config });
  const constraints = [
    "只做多或只做空按风格描述；观望也是合法答案。",
    // C29.15：止损口径**原本就已经是精确的**（`max/min`），但实测模型会把它读反 —— 直接拿
    // "最近结构位"当止损（而不是取 max/min 的**结果**），风险被放大 → 盈亏比被算低 → 假阴。
    // 例（好行情臂 `BTC-USDT-SWAP|1787892600000`）：入场 79597.3、结构位 78561.2；
    // 硬约束口径 `max(78561.2, 79597.3−1.5×ATR)` = **78835.7** → R:R 2.52 ≥ 1.5，
    // 而模型取了 78561.2 → R:R 1.42 → abort。所以这里只把"取谁"写死，**公式与乘数一字未改**。
    `止损必须是**可实现口径**：做多 stop = max(最近结构位, entry − 1.5×ATR14_1h)，做空 stop = min(最近结构位, entry + 1.5×ATR14_1h)。` +
      `**取的是这个 max/min 的运算结果**（不是"最近结构位"本身，也不是 ATR 那一项本身）——把两个候选都算出来，` +
      `做多取更大的那个、做空取更小的那个，写进 stop_px。` +
      `（最近结构位：做多取 ${JSON.stringify(tf1h.last_swing_low ?? null)} 或区间下沿，做空取 ${JSON.stringify(tf1h.last_swing_high ?? null)} 或区间上沿；ATR14_1h=${JSON.stringify(atr14_1h)}）`,
    `单笔风险 ≤ ${riskPct}% 账户权益（用 size.risk_pct 表达，代码会复核）。`,
    // C29.15：「第一目标」原本**没有定义** —— 这是盈亏比这条约束真正的口径缺陷（不是它太严）。
    // 口径不定义 → 模型自己挑目标位：同一份 state 里挑近的结构位就得 abort、挑远的就能过，
    // 于是这条约束在实测里变成噪声（C29.13 那 19 条 rr abort 里 **15 条**真实几何 R:R ≥ 1.5）。
    //
    // ⚠️ **本条的措辞被自己的一次 A/B 打过回票（诚实记录）**：第一版写成"第一目标 = entry 之外
    // **最近**的结构位"，结果模型老老实实拿最近的那个**近位**当止盈 → 盈亏比反而被压到 0.36–0.56，
    // 22 条"产出参数但被校验拒"里 **12 条**在 state 里其实有能给出 ≥1.5R 的结构位（有的能给 4–5R）。
    // 也就是说"最近"这个定义**制造**了假阴，方向与要修的问题相反。正确的口径必须与执行侧同源：
    // Rust `validate_round`（`fastlane.rs:1595-1622`）算盈亏比取的是**你给的 tp 里对方向最有利的那一个**
    // （`is_long ? max : min`）—— 所以"第一目标"应当是**能付得起这份风险的最近结构位**，而不是最近的结构位。
    // 门槛 1.5 与止损公式**一字未改**；改的只是"拿哪个结构位当第一目标"。
    `盈亏比（到**第一目标**）≥ 1.5；达不到就 abort。` +
      `**第一目标有唯一定义（按顺序算）**：① 风险 R = |entry − stop_px|；` +
      `② 候选 = state.structure 的 tf_15m / tf_1h / tf_4h 里 window_high / window_low / last_swing_high / last_swing_low 的全部取值中，位于 entry **有利一侧**的（做多取 entry 上方、做空取 entry 下方）；` +
      `③ 第一目标 = 候选里**离 entry 至少 1.5R** 的那一些中**最近**的一个（做多取满足 value ≥ entry + 1.5R 的最小者，做空取满足 value ≤ entry − 1.5R 的最大者）；` +
      `把它的价格写进 tp[0].px。` +
      `代码复核时取你给的 tp 里**对方向最有利的那一个**（做多取最大、做空取最小）算盈亏比，与执行侧 Rust validate_round 同口径。` +
      `**只有**当候选里**没有任何一个**能满足 1.5R 时，才是"几何上确实达不到"，这时才 abort。` +
      `（常见错误：拿最近的那个近端结构位当止盈 —— 那不是第一目标，会把本来能过的单子自己判死。）`,
    "contracts 必须 ≥ min_size 且为 lot_size 的整数倍；leverage ≤ instrument.max_leverage 且 ≤ limits.target_leverage；margin_mode 用 cross。",
    `滑点上限 ${fastlane.maxSlippageBps}bps **只约束市价单**：order_type="market" 时 entry_px 与 state.price.last 的距离必须 ≤ ${fastlane.maxSlippageBps}bps。` +
      `**限价回踩单（order_type="limit"）不受该上限约束**——挂低于市价的买价（或高于市价的卖价）本来就应离最新价很远，那是回踩的设计，不是滑点；` +
      `但限价单仍必须给出真实的 entry_px，并满足盈亏比与止损约束。`,
    "必需数据（ticker、candles_1m_closed、derivatives、account）在调用你之前已由后端校验；若你**仍然**看到它们缺失或过期（异常情况），返回 {\"abort\":true,\"why\":\"必需数据不可用：…\"}。",
    // C29.15：`derivatives` 被列进"必需数据"，但 Rust `normalize_derivatives_block`
    // （`fastlane.rs:3010-3041`）**无条件**把 markPx / idxPx / basisPct / oiUsd / oiChange1hPct
    // 写成 null（那几条公开 WS 通道本应用未订阅，C29 明令不得自造 REST 端点）。于是**每一轮生产**
    // 的 derivatives 都是"2 个有值 + 5 个 null" —— 与"必需数据已由后端校验"直接冲突，
    // 是一个常驻的 abort 诱因。这里只说清**哪两个字段才是权威**，不改任何风险规则。
    "**derivatives 的权威字段只有 `funding_rate` 与 `funding_next_ms`**（这两个一定有值）：" +
      "`mark_price` / `index_price` / `basis_pct` / `oi_usd` / `oi_change_1h_pct` 在**生产里恒为 null**" +
      "（公开 WS 通道未订阅，不是这一轮取不到），**不得**作为 abort 或不动手的理由。",
    "**可选数据**（orderbook 与 micro.*，即 state 里为 null 的盘口 / 点差 / 失衡 / 深度 / 主动买卖比）缺失**不构成不动手的理由**：照常给出动作，但应在 reason_tags 里标注“微观数据缺失”，并相应降低 confidence。",
    // C29.15：`ref` 与 `now` 的关系原本完全没说 —— 模型只好自己挑参考时钟
    // （实测：同一 state 上模型自称的"距 now"与 `as_of` 的真实时差对不上，最远差到 2.5 小时）。
    // 这里把**唯一参考时钟**与**真实字段路径**写死，并把"算窗口"这件事交给代码
    // （`validateFastlaneAction` → `eventBlackoutReasons`，与 Rust `event_blackout_active` 同源）。
    `事件黑名单：**以 \`state.as_of\` 为唯一参考时钟**（不是 【now】、不是你的系统时间），` +
      `看 **\`state.events\`**（数组，不是 \`state.events.news_high_impact_6h\`）：` +
      `若存在 \`importance\` ∈ {high, important, urgent, 重要, 高}（或为空串）的条目，且 \`|as_of − at| ≤ ${fastlane.eventBlackoutMinutes} 分钟\`，不要开新仓。` +
      `**这条闸门由代码复核**（口径与上式逐字一致）：\`at\` 距 \`as_of\` **超过** ${fastlane.eventBlackoutMinutes} 分钟的条目**一律不算**，` +
      `不得因为"events 里有更早的高影响事件"或"今天/今晚还有某场数据要公布"就 abort。`,
    // C29.15：实测模型会拿**约束之外**的理由 abort（"止损过近/可实现性差/结构位过近/方向分置信度低"）。
    // 这些不是硬约束，却把 19 条 rr abort 里 15 条真实几何达标的样本挡在门外 —— 明确"约束之外不得 abort"。
    "**只有上面这些硬约束能让你 abort**：满足全部硬约束就必须给出参数。" +
      "「止损过近 / 距离小于 tick 可实现性差 / 结构位过近 / 结构冲突 / 方向置信度低 / 15m 是区间」这些都是**观察**，" +
      "写进 reason_tags 或 summary 即可，**不得**作为 abort 理由。"
  ];
  if (fastlane.style) constraints.push(`风格约束（用户设定）：${fastlane.style}`);
  return constraints;
}

/**
 * **降险口径**的硬约束（`intent="reduce"`：Jev 自判减仓/平仓）。
 *
 * 与 Rust `validate_round` 的 `is_reduce` 分支逐条同源（`src-tauri/src/fastlane.rs:1440-1450 / 1457`）：
 * 降险只受"手数上限（可平数量）、保证金模式合规"约束；**不查**止损/失效位、单笔风险、盈亏比、
 * 最小手数、杠杆、入场价与滑点、事件黑名单。风格约束是**开仓**约束，降险轮一律不给。
 */
function riskReductionConstraints({ snapshot = {}, config = {} } = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  return [
    "本轮是**降险**（减少暴露），不是开仓：不要挑方向、不要等结构、不要套 preset 风格。",
    "`size.contracts` = **要减少的张数**（权威字段，正数）；能减多少只能依据 state.account.positions 里该品种的持仓张数，不得超过它。",
    "`order_type` 只是执行形态：`market` = 立即降险；`limit` = 反抽/回踩到 `entry_px` 再减（此时必须给真实 `entry_px`）。",
    "`direction` 取**持仓方向**（long/short），不是你想开的方向。",
    `杠杆不是降险参数：若写 leverage，必须等于 Profile 目标杠杆（${JSON.stringify(snapshot?.limits?.target_leverage ?? null)}），执行杠杆恒取 Profile。`,
    "降险**不需要**止盈止损与失效位：不要写 take_profit / stop_px / invalidationPrice。",
    "必需数据（ticker、candles_1m_closed、derivatives、account）缺失由后端负责；**只有**账户/持仓事实缺失（state.account.positions 为空或没有该品种持仓）才返回 {\"abort\":true,\"why\":\"…\"}。",
    "**可选数据**（orderbook 与 micro.*）缺失不构成不降险的理由：照常给参数，并在 reason_tags 里标注“微观数据缺失”。",
    `单笔风险上限（${fastlane.riskPerTradePct}%）与盈亏比、滑点上限都**不适用于降险**：不得因为它们不满足而 abort。`
  ];
}

const SHARED_LLM_SYSTEM = [
  "你是 Desic Terminal 快判模式的 JSON 编译器。只输出一个 JSON 对象：不要解释、不要 markdown、不要调用任何工具、不要输出多余文本。",
  "输入里的行情、账户与限额事实已经由代码取好并带时间戳；不得假设、不得补充、不得引用外部知识。",
  "state 各字段互相自洽；若发现自相矛盾或关键数据缺失，按硬约束要求返回 {\"abort\":true,\"why\":\"…\"}。",
  "state 里为 null 的字段表示**该项数据不可用/未知**（例如未拿到实时盘口、K 线样本不足）：不得把 null 当作 0、不得据其推断；遇到关键结构字段为 null（结构位、ATR、账户可用余额）时必须按\"数据不足\"处理——观望分支在 reason 里用 data；动作分支返回 {\"abort\":true,\"why\":\"关键字段不可用：…\"}。"
].join("\n");

/// 观察条件规范（watch / action 共用**单一定义**）。
///
/// **不硬编码条件类型清单**：类型与每类必填字段的唯一权威是 Rust 随载荷下发的
/// `wakeConditionSchema`（真机踩过两次：模型猜类型、必填字段缺失——定时类条件缺 `atMs`/`intervalMinutes`）。
/// 这里只写"结构 + 数量/时间纪律 + instId 纪律"，schema 原样注入（见 [`buildWakePlanSpec`]）；
/// schema 缺失（老 Rust / 未下发）→ 退化为下面的基础文案，**不报错、不阻塞**。
/// `instId` 纪律：**只写清"相关时请带上"，不新增强制字段** —— 省略 instId 由后端回填本轮品种
///（缺省即回填是既定裁决），模型侧不得因此被当成非法输出；真机踩过 `missing field 'instId'`。
///
/// 抽成具名常量是因为 **AI Profile 链路要与快判共用同一句**（见 [`buildWakeConditionSchemaSpec`]）：
/// 一句话只能有一个定义，否则两条链路的措辞会各自漂移。
const WAKE_CONDITION_INST_ID_RULE = "params 里与品种相关的条件类型请带上 instId（用 state 里的 inst_id）；与品种无关的类型（如时间/定时类条件）可省略——省略 instId 不算错误，后端会回填本轮品种。";

const WAKE_PLAN_SPEC_BASE = [
  "nextWakePlan 每轮都必须给（无论观望还是动作），它驱动下一轮快判：",
  '{"mode":"any|all","conditions":[{"type":"<后端认可的条件类型>","params":{…}}],"expiresAtMs":<13 位毫秒>}',
  "conditions 至少 1 条、最多 8 条；expiresAtMs 必须是 13 位 Unix 毫秒；优先能在一个 watcher 节拍（2–5 秒）内触发的类型。",
  "conditions[].type 必须是后端认可的类型：下发了类型 schema 时只能用 schema 里列出的类型；没下发时，优先沿用【current_wake_conditions】里已经出现过的类型。",
  WAKE_CONDITION_INST_ID_RULE
];

/// `expiresAtMs` 的纪律：**每轮重新算**，绝不照抄。
///
/// 真机（2026-09-21）：`wake_conditions_payload` 把每条活跃条件的 `expiresAt` 原样喂进
/// 【current_wake_conditions】，模型于是把它**照抄**成新一轮的 `expiresAtMs` —— 计划的到期时间
/// 永远停在第一轮算出的那一刻，时间一到整份 plan 被判"过期"。所以这里**显式给出当前时间**
/// （模型自己不知道现在几点），并明确禁止照抄。
function wakeExpirySpec(nowMs) {
  const now = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
  return [
    `【now】当前时间 = ${now}（13 位 Unix 毫秒，本轮参考时间）。`,
    "expiresAtMs 必须**基于上面这个 now 重新算**（建议 now + 30–60 分钟），必须大于 now；",
    "**不要照抄【current_wake_conditions】里任何 expiresAt 值** —— 那是上一轮算出来的，照抄会让这份计划立刻过期、这一轮的观察条件全部写不进去（后端最多只按「无到期」保留，闭环会白跑）。"
  ].join("\n");
}

/// schema 在场时的纪律句（"只能使用下面列出的条件类型"必须**在 schema 之前**）。
const WAKE_CONDITION_SCHEMA_RULE = "**只能使用下面列出的条件类型**；每类的必填字段必须齐备（单位/取值范围见 notes）。缺必填字段或使用未列出的类型，那条条件会被丢弃（其它合法条件仍会保留）。";

/// 把 Rust 下发的 `wakeConditionSchema` 归一成可注入的文本：字符串原样、对象 JSON 缩进；
/// 空值 / 空对象 / `"null"` → 空串（→ 退化为基础文案）。
function wakeConditionSchemaText(schema) {
  if (schema === null || schema === undefined) return "";
  const text = typeof schema === "string" ? schema.trim() : JSON.stringify(schema, null, 1) || "";
  const trimmed = String(text).trim();
  return ["", "{}", "null", '""', "[]"].includes(trimmed) ? "" : trimmed;
}

/// 观察条件规范（导出供测试与审计）：`schema` 缺失 → 只有基础文案（逐字老口径）。
/// `nowMs` = 本轮参考时间（默认取本地时钟；测试可注入固定值）。
export function buildWakePlanSpec(schema = null, nowMs = null) {
  const text = wakeConditionSchemaText(schema);
  const expiry = wakeExpirySpec(nowMs ?? Date.now());
  if (!text) return [...WAKE_PLAN_SPEC_BASE, expiry].join("\n");
  return [
    ...WAKE_PLAN_SPEC_BASE,
    expiry,
    "",
    "【wake_condition_schema（后端下发，原样使用；不要改写字段名与单位）】",
    WAKE_CONDITION_SCHEMA_RULE,
    text
  ].join("\n");
}

/// AI Profile 链路（`background.finishRun`）的观察条件**类型规范**：与快判**同一套措辞 + 同一份
/// 注入规则**（[`WAKE_CONDITION_SCHEMA_RULE`] + `instId` 纪律），只是落点不同 ——
/// 快判注入 prompt 的 `nextWakePlan` 段，AI 链路追加到 `background.finishRun` 的**工具描述**。
///
/// 为什么必须有：C33 真机事故 —— 类型规范只做在"已撤下的快判链路"里，AI 链路没有任何权威清单，
/// 模型只能**猜**类型（写出 `{"type":"price","direction":"cross",…}`，该写 `price_cross`）→
/// 整份计划被拒、0 条写库、卡片标红。schema 由 Rust `wake_condition_schema()` 唯一生成并按 Profile
/// 白名单过滤后下发，侧车**只原样注入**、不维护第二份类型清单。
///
/// **不写**数量/到期纪律：AI 链路的条数上限与 `expiresAt` 由它自己的工具 schema 与描述承担。
/// `schema` 缺失（老 Rust / 交互会话 / 简报与复盘）→ `""`（不注入、描述逐字不变、不报错）。
export function buildWakeConditionSchemaSpec(schema = null) {
  const text = wakeConditionSchemaText(schema);
  if (!text) return "";
  return [
    "【wake_condition_schema（后端下发，原样使用；不要改写字段名与单位）】",
    WAKE_CONDITION_SCHEMA_RULE,
    WAKE_CONDITION_INST_ID_RULE,
    text
  ].join("\n");
}

/// C29 §6.1：Jev 判「观望」→ 只写一句话结论 + 下一轮观察条件 + 原因枚举。
/// `wakeConditionSchema` 由 Rust 随载荷下发（原样注入）；缺失则不注入、不报错。
export function buildWatchPrompt({ snapshot = {}, jev = {}, config = {}, wakeConditions = [], wakeConditionSchema = null } = {}) {
  /**
   * **变更 B（2026-09-21）**：打分臂下"观望"是**代码**按门槛判的（Jev 只给两个 0–4 期望分），
   * 必须在 prompt 里说清，否则模型会在 summary 里把它写成"Jev 认为该观望"——那是口径漂移。
   * 只在打分臂观望时追加这一句；旧形状（`legacy_action` / 无分数）**逐字不变**。
   *
   * **C29.14**：降险臂的两个观望码各有**分层措辞** —— "没有可减的仓位"是正常状态，
   * "持仓事实缺失"是数据异常，模型写 summary 与下一轮观察条件时必须区分（不能都写成"没机会"）。
   */
  const scoreDecision = jev?.answers && typeof jev.answers === "object" ? String(jev.answers.entryScoreDecision ?? "") : "";
  const scoreArmLine = ["below_floor", "tie", "score_missing"].includes(scoreDecision)
    ? "（注意：本轮走**打分臂**——Jev 只给 `long_score` / `short_score` 两个 0–4 期望分，\"观望\"是**代码**按 `entry_score_floor` 判的，见 jev_decision 的 `entry_score_decision`；summary 里不要把观望说成模型的选择。）"
    : scoreDecision === "reduce_without_position"
      ? "（注意：本轮走**降险判定**——Jev 的 `reduce_score` 达到门槛（该降险），但**当前没有可减的仓位**（本品种无持仓）→ **代码**判观望；summary 里必须写清\"没有可减的仓位\"，不要写成\"没机会\"，也不要把观望说成模型的选择。）"
      : scoreDecision === "reduce_position_unknown"
        ? "（注意：本轮走**降险判定**——Jev 的 `reduce_score` 达到门槛（该降险），但**持仓事实缺失**（读不到持仓）→ **代码**判观望（不猜）；summary 里必须写清\"持仓事实缺失、无法确认可减仓位\"，不要写成\"没机会\"，也不要把观望说成模型的选择。）"
        : "";
  const system = [
    SHARED_LLM_SYSTEM,
    "本轮 Jev 判定为**观望**：你的唯一任务是写出一句话结论与下一轮观察条件，不得给出交易参数。" + scoreArmLine
  ].join("\n");
  const user = [
    "【state】",
    JSON.stringify(snapshot, null, 1),
    "",
    "【jev_decision】",
    JSON.stringify(jev.answers ?? null, null, 1),
    "",
    "【current_wake_conditions】",
    JSON.stringify(wakeConditions, null, 1),
    "",
    "【data_layers】",
    "必需数据（ticker、candles_1m_closed、derivatives、account）在调用你之前已由后端校验；reason=data 只保留给**必需数据**确实缺失或过期的情况。",
    "可选数据（orderbook 与 micro.*，即 state 里为 null 的盘口 / 点差 / 失衡 / 深度 / 主动买卖比）缺失**不得**单独作为 reason=data 的理由——请改用 low_confidence / no_setup，并在 summary 里说明微观数据缺失。",
    "",
    "【limits】",
    JSON.stringify({ task_timeout_ms: normalizeFastlaneConfig(config).llmTimeoutMs }, null, 1),
    "",
    "【output（单个 JSON，字段齐全，不要额外字段）】",
    '{"summary":"<一句话结论，≤160 显示宽度>","nextWakePlan":{…见下…},"reason":"data|anomaly|conflict|low_confidence|no_setup"}',
    buildWakePlanSpec(wakeConditionSchema),
    "",
    // C29.18：入场质量（结构 / 止损 / 赔率）由**代码**判，模型不再有 `quality` 这一问可引用 ——
    // 它自己报的原因只应落在上面五个码里；代码侧的三个码会覆盖在 `action.reason` 上（记录可见）。
    "纪律：不要复述 state、不要给操作建议、不要写风险提示；reason 只能取上面五个枚举之一。"
  ].join("\n");
  return { system, user };
}

/// C29 §6.2：Jev 判「开多/开空/减仓/平仓」→ 先写参数，再由侧车调用「创建机会」工具。
/// 降险动作（减仓/平仓）与开仓同链路：同样返回 order 参数，不得旁路。
///
/// `intent` 三态（2026-09-21 变更 A）：
///   - `round`  ：普通快判轮（Jev 判开多/开空）—— **逐字保持原样**，风格约束照旧注入；
///   - `close`  ：停机平仓轮（用户显式命令）—— 沿用既有降险措辞，**逐字保持原样**；
///   - `reduce` ：Jev 自判的减仓/平仓 —— 降险口径：**不给风格约束、不给开仓专属硬约束**，
///                并把 Rust 侧降险契约（`intent=close` + `exit_kind` + `size` 语义）写清楚。
export function buildActionPrompt({ snapshot = {}, jev = {}, config = {}, wakeConditions = [], intent = "round", wakeConditionSchema = null } = {}) {
  const intentKey = String(intent || "").trim().toLowerCase();
  const closeIntent = intentKey === "close";
  const riskReduction = intentKey === "reduce";
  const system = [
    SHARED_LLM_SYSTEM,
    closeIntent
      ? "**这是用户显式发起的减仓/平仓轮（停机命令）**：不需要再评估该不该动手，你的唯一任务是把平仓/减仓参数写完整（entry 用市价口径、size 用要减少的数量/张数），不要返回观望；只有在账户/仓位事实缺失时才返回 {\"abort\":true,\"why\":\"…\"}。"
      : riskReduction
        ? "**这是 Jev 判定的降险动作（减仓/平仓）**：不再评估该不该动手，你的唯一任务是把降险参数写完整（entry 用市价口径、size 用要减少的数量/张数），不要返回观望；只有在账户/仓位事实缺失时才返回 {\"abort\":true,\"why\":\"…\"}。"
        : "你的唯一任务：按 Jev 判定与硬约束给出**可直接下单的参数**；不满足任何一条硬约束就返回 {\"abort\":true,\"why\":\"<一句话原因>\"}，不要勉强给参数。",
    "降险动作（减仓/平仓）同样要给完整参数（entry 用市价口径、size 用要减少的数量），不得跳过。"
  ].join("\n");
  const user = [
    "【state】",
    JSON.stringify(snapshot, null, 1),
    "",
    "【jev_decision】",
    JSON.stringify(jev.answers ?? null, null, 1),
    "",
    "【current_wake_conditions】",
    JSON.stringify(wakeConditions, null, 1),
    "",
    "【hard_constraints】",
    ...hardConstraints({ snapshot, config, intent: riskReduction ? "reduce" : "round" }).map((line, index) => `${index + 1}) ${line}`),
    "",
    "【output（单个 JSON，以下两种之一，字段齐全）】",
    riskReduction
      ? 'A. 执行：{"abort":false,"order":{"intent":"close","direction":"long|short","order_type":"market|limit","entry_px":<number|null>,"size":{"contracts":<要减少的张数>},"exit_kind":"strategy_exit|stop_loss|emergency","confidence":<0-1>,"reason_tags":["…"]},"nextWakePlan":{…},"summary":"<一句话>"}（`order` 里可以再给一份同样的 `opportunity`，但**至少给 `order`**）'
      : 'A. 执行：{"abort":false,"opportunity":{"intent":"open|close|cancel|amend","direction":"long|short","order_type":"limit|market","entry_px":<number>,"stop_px":<number>,"tp":[{"px":<number>,"portion":<0-1>}],"size":{"contracts":<number>,"risk_pct":<number>},"leverage":<number>,"margin_mode":"cross","invalidation":["…"],"reason_tags":["…"],"confidence":<0-1>},"order":{"side":"long|short","order_type":"limit|market","entry_px":<number>,"stop_px":<number>,"tp":[{"px":<number>,"portion":<0-1>}],"size":{"contracts":<number>,"risk_pct":<number>},"leverage":<number>,"margin_mode":"cross","invalidation":["…"],"reason_tags":["…"],"confidence":<0-1>},"nextWakePlan":{…},"summary":"<一句话>"}',
    'B. 放弃：{"abort":true,"why":"<一句话原因>"}',
    ...(riskReduction ? ["", ...riskReductionContract({ snapshot })] : []),
    buildWakePlanSpec(wakeConditionSchema),
    "",
    "纪律：不要复述 state、不要写风险提示、不要给建议；缺字段视为 abort。"
  ].join("\n");
  return { system, user };
}

/**
 * 降险分支的**输出契约**（写进 prompt 的文本，不是校验器）。
 *
 * 每一条都对应 Rust 侧一个真实入口，写错了降险参数会在适配层被拒（改动等于白做）：
 *   - `intent="close"` ← `action_intent`（`src-tauri/src/fastlane.rs:2949-2955`）只认
 *     `open|close|cancel|amend`；写 `reduce` 会被当成"没有意图"→ 回落成开仓口径；
 *   - `exit_kind` ← `intent=close` 的机会在 `trade_commands`（`trade_commands.rs:10587`）是必填；
 *   - `order_type` 会被折叠成降险 order_type（`plan_from_opportunity`，`fastlane.rs:3167-3177`）；
 *   - `size.contracts` 是权威张数字段（`resolve_size_contracts`）。
 */
function riskReductionContract({ snapshot = {} } = {}) {
  const positions = Array.isArray(snapshot?.account?.positions) ? snapshot.account.positions : [];
  const held = positions
    .map((item) => ({
      inst_id: item?.instId ?? item?.inst_id ?? null,
      side: item?.side ?? item?.posSide ?? item?.pos_side ?? null,
      // 生产 state 用 `pos`（`normalize_position`，fastlane.rs:2849）；回放镜像里可能叫 `size`/`contracts`。
      contracts: item?.pos ?? item?.contracts ?? item?.size ?? null
    }))
    .filter((item) => item.inst_id || item.contracts !== null);
  return [
    "【降险契约（Rust 侧真实入口，字段写错这一轮就白做）】",
    '1) `intent` 必须写 `"close"`：Rust `action_intent` 只认 open|close|cancel|amend（写 `reduce` 会被当成"没有意图"，回落成开仓口径校验 → 降险参数被拒）。',
    '2) 必须给 `exit_kind`（`strategy_exit` 策略降险 / `stop_loss` 止损退出 / `emergency` 紧急退出）：intent=close 的机会缺它会直接被拒。',
    "3) `size.contracts` 是**要减少的张数**（权威）；`order_type` 只是执行形态，Rust 会把它折叠成降险 order_type（`market` 与 `limit` 都合法）。",
    "4) 平仓/减仓机会不要带 take_profit / stopLoss 附加保护字段（退出价就是 price / entry_px）。",
    `5) 本品种当前持仓事实（state.account.positions）：${JSON.stringify(held)} —— 要减少的张数不得超过它；它为空就没有可降险的仓位，此时才 abort。`
  ];
}

function extractJsonObject(text) {
  const source = String(text ?? "").trim();
  if (!source) return null;
  const candidates = [source];
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = String(match[1] || "").trim();
    if (fenced) candidates.push(fenced);
  }
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1).trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * 观望原因枚举（解析窄调用 LLM 的 `reason` 时用来判合法性；不在表里的一律回落 `no_setup`）。
 *
 * C29.18：表里**同时**收两类码 ——
 *   ① **模型可报的**：`data` / `anomaly` / `conflict` / `low_confidence` / `no_setup`（prompt 里的枚举）；
 *   ② **代码判的**：`low_entry_score` / `entry_score_tie` / `reduce_without_position` /
 *      `reduce_position_unknown` / [`FASTLANE_ENTRY_QUALITY_WATCH_REASONS`] 三个码（结构 / 止损 / 赔率）。
 *      `low_quality` **保留**：它是冻结枚举里的老码（老记录 / 老侧车仍可能出现，`low_quality` 侧车
 *      自己也可能被上游回灌），但 **C29.18 起代码侧不再产生它**（不再读 `jev.quality`）。
 */
const WATCH_REASONS = new Set([
  "data",
  "anomaly",
  "conflict",
  "low_confidence",
  "low_quality",
  "no_setup",
  ...Object.values(FASTLANE_ENTRY_QUALITY_WATCH_REASONS)
]);

function normalizeWakePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const conditions = Array.isArray(plan.conditions) ? plan.conditions.filter((item) => item && typeof item === "object") : [];
  const expiresAtMs = finiteNumber(plan.expiresAtMs);
  if (conditions.length === 0 || expiresAtMs === null || expiresAtMs < 1e12) return null;
  return {
    mode: String(plan.mode || "any").toLowerCase() === "all" ? "all" : "any",
    conditions,
    expiresAtMs
  };
}

/// C29 §6：解析窄调用的 JSON 输出。三种结果：abort / watch / action；解析不出或不合法 = invalid。
/// `nextWakePlan` 原样透传（不裁剪、不改写字段），因为下一轮由它驱动。
export function parseFastlaneLlmOutput(text, { branch = "watch" } = {}) {
  const parsed = extractJsonObject(text);
  if (!parsed) return { ok: false, kind: "invalid", error: "窄调用未返回可解析的 JSON 对象", payload: null };
  if (parsed.abort === true) {
    return { ok: true, kind: "abort", why: String(parsed.why || "模型判定不满足硬约束"), payload: parsed, nextWakePlan: normalizeWakePlan(parsed.nextWakePlan) };
  }
  const nextWakePlan = normalizeWakePlan(parsed.nextWakePlan);
  if (branch === "watch") {
    if (!nextWakePlan) return { ok: false, kind: "invalid", error: "观望分支缺少合法的 nextWakePlan（条件或 expiresAtMs）", payload: parsed };
    const reason = String(parsed.reason || "").trim();
    return {
      ok: true,
      kind: "watch",
      payload: parsed,
      summary: String(parsed.summary || "").trim(),
      reason: WATCH_REASONS.has(reason) ? reason : "no_setup",
      nextWakePlan
    };
  }
  const order = parsed.order && typeof parsed.order === "object" ? parsed.order : parsed.opportunity;
  if (!order || typeof order !== "object") {
    return { ok: false, kind: "invalid", error: "动作分支缺少 order/opportunity 参数对象", payload: parsed };
  }
  if (!nextWakePlan) return { ok: false, kind: "invalid", error: "动作分支缺少合法的 nextWakePlan", payload: parsed };
  return {
    ok: true,
    kind: "action",
    payload: parsed,
    summary: String(parsed.summary || "").trim(),
    order: parsed.order && typeof parsed.order === "object" ? parsed.order : null,
    opportunity: parsed.opportunity && typeof parsed.opportunity === "object" ? parsed.opportunity : null,
    nextWakePlan
  };
}

/// **事件黑名单窗口**（C29.15）：与 Rust [`event_blackout_active`]（`fastlane.rs:3077-3091`）**逐条同源**。
///
/// 🔴 **修掉的真实缺陷（不是放宽风控）**：本函数的前身有**两处独立缺陷叠在一起**，两者都让它
/// 在生产形状下成为**死代码** —— 30 分钟窗口实际上**只有模型在判**：
///   1. **读错路径**：读 `snapshot.events.news_high_impact_6h`，而 state 里 `events` 是**数组**
///      （`StateEvent[]`），那个键**在生产形状下从来不存在**；
///   2. **时间解析错**：`Date.parse(String(state.as_of))` —— 生产 `as_of` 是**13 位毫秒字符串**
///      （例如 `"1787932800000"`），`Date.parse` 对它返回 **NaN** → 被 `Number.isFinite` 早退吃掉。
///      （Rust 侧拿的是 `i64` 毫秒整数，所以 Rust 那条一直是活的 —— 这也是"两边不同源"的根因。）
/// 后果（C29.15 实测，门槛 1.0 的好行情臂 78 条进分支）：模型报了 **36** 条黑名单 abort，
/// 其中 **18 条**在 `as_of` 前 30 分钟内**根本没有** `importance=high` 事件（最近一条中位 1813s、
/// 最远 9096s）→ 假阳率 **50%**，全是"路径+时钟都不给、模型只好自己猜"造成的口径噪声。
///
/// 口径与 Rust 完全一致（**含"importance 为空也算 blocking"**，不许比 Rust 更松）：
///   - `importance` trim + 小写后 ∈ {空, high, important, urgent, 重要, 高}；
///   - `at > 0` 且 `|as_of − at| ≤ blackoutMinutes × 60_000`；
///   - `blackoutMinutes === 0` → 关掉这道闸（与 Rust 同一处早退）。
///
/// **只作用于开仓**：降险（`intent=close|reduce`）不查窗口（Rust `is_reduce` 同一口径）。
export function eventBlackoutReasons(snapshot = {}, config = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  const minutes = finiteNumber(fastlane.eventBlackoutMinutes);
  if (minutes === null || minutes <= 0) return [];
  const asOf = fastlaneAsOfMs(snapshot);
  if (asOf === null) return [];
  const window = minutes * 60_000;
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const reasons = [];
  for (const item of events) {
    const at = finiteNumber(item?.at);
    if (at === null || at <= 0) continue;
    const importance = String(item?.importance ?? "").trim().toLowerCase();
    const blocking = importance === "" || JEV_BLOCKING_IMPORTANCE.has(importance);
    if (!blocking) continue;
    if (Math.abs(asOf - at) <= window) reasons.push(`高影响事件窗口内（${item?.title || "未命名事件"}）不得开新仓`);
  }
  return reasons;
}

/// `state.as_of` → **毫秒整数**（生产形状是 13 位毫秒字符串；ISO 串也接受）。
///
/// 这是一个**独立于判定的纯函数**，因为踩过两次：`Date.parse("1787932800000") === NaN`
/// （V8 不认裸毫秒串），于是任何 `Date.parse(String(as_of))` 的写法在生产上恒为 NaN。
/// 解析不出来时返回 `null`（**不猜时钟**：宁可不管这道闸，也不静默用一个错的参考时间）。
export function fastlaneAsOfMs(snapshot = {}) {
  const raw = snapshot?.as_of;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
  const text = String(raw ?? "").trim();
  if (!text) return null;
  // 13 位（或 1–13 位）纯数字 → 直接当毫秒；生产 `as_of` 就长这样。
  if (/^\d{1,13}$/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/// 与 Rust `event_blackout_active` 的 `matches!` 白名单**逐字一致**（C29.15）。
const JEV_BLOCKING_IMPORTANCE = new Set(["high", "important", "urgent", "重要", "高"]);

/// C29 §8.1：代码校验（LLM 之后必须再过一遍）。用 state 里已有事实做确定性检查；
/// 任一不过 → 当轮不创建机会，改记观望 `validation_failed`。
export function validateFastlaneAction({ action = {}, snapshot = {}, config = {}, riskReducing = false } = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  const reasons = [];
  const order = action.order || action.opportunity || {};
  const intentValue = String(order.intent || "").trim().toLowerCase();
  // 降险口径（停机平仓轮 / Jev 自判减仓）：intent=close/reduce 时不因数据新鲜度、事件窗口或
  // "入场是否合理"被拦——用户已显式决定平仓或 Jev 已判降险，判定层不得再表态（C29.7 停机语义）。
  // **变更 A（2026-09-21）**：`riskReducing: true` 由调用方在"Jev 判减仓/平仓"时显式传入；
  // 这里仍然与 Rust `validate_round` 的 `is_reduce` 逐条同源（fastlane.rs:1457）：
  // 降险**不查**止损/失效位、单笔风险、盈亏比、最小手数、杠杆、入场价与滑点、事件黑名单。
  const isRiskReducing = riskReducing === true || intentValue === "close" || intentValue === "reduce";
  const side = String(order.side || order.direction || "").trim().toLowerCase();
  const entry = finiteNumber(order.entry_px ?? order.entryPx);
  const stop = finiteNumber(order.stop_px ?? order.stopPx);
  const contracts = finiteNumber(order?.size?.contracts);
  const riskPct = finiteNumber(order?.size?.risk_pct);
  const leverage = finiteNumber(order.leverage);
  const targets = Array.isArray(order.tp) ? order.tp.map((item) => finiteNumber(item?.px)).filter((value) => value !== null) : [];
  const instrument = snapshot?.instrument || {};
  const limits = snapshot?.limits || {};
  const minSize = finiteNumber(instrument.min_size);
  const lotSize = finiteNumber(instrument.lot_size);
  const maxLeverage = finiteNumber(instrument.max_leverage);
  const age = snapshot?.data_age_ms || {};

  if (!["long", "short"].includes(side)) reasons.push("side 必须是 long 或 short");
  const isOpen = String(order.intent || "open").toLowerCase() === "open";
  if (isOpen && (entry === null || stop === null || contracts === null)) reasons.push("开仓缺少 entry_px / stop_px / size.contracts");
  if (isOpen && side === "long" && entry !== null && stop !== null && stop >= entry) reasons.push("做多止损必须低于入场价");
  if (isOpen && side === "short" && entry !== null && stop !== null && stop <= entry) reasons.push("做空止损必须高于入场价");
  if (riskPct !== null && riskPct > fastlane.riskPerTradePct) reasons.push(`单笔风险 ${riskPct}% 超过上限 ${fastlane.riskPerTradePct}%`);
  // 最小手数是**开仓**准入条件（Rust fastlane.rs:1541 `!is_reduce && size_contracts < min_size`）：
  // 降险不受它约束——"已经持有的仓位必须能减、能平"（否则最小手数会反过来阻止降险）。
  if (!isRiskReducing && contracts !== null && minSize !== null && contracts < minSize) reasons.push(`contracts ${contracts} 小于 min_size ${minSize}`);
  // 同理：lot_size 整数倍在 Rust `validate_round` 里**不是**降险的准入条件；开仓仍查。
  if (!isRiskReducing && contracts !== null && lotSize !== null && lotSize > 0 && Math.abs((contracts / lotSize) - Math.round(contracts / lotSize)) > 1e-9) {
    reasons.push(`contracts ${contracts} 不是 lot_size ${lotSize} 的整数倍`);
  }
  if (leverage !== null && maxLeverage !== null && leverage > maxLeverage) reasons.push(`leverage ${leverage} 超过合约上限 ${maxLeverage}`);
  if (leverage !== null && finiteNumber(limits.target_leverage) !== null && leverage > Number(limits.target_leverage)) {
    reasons.push(`leverage ${leverage} 超过 Profile 目标杠杆 ${limits.target_leverage}`);
  }
  // 降险契约字段：`exit_kind` 的取值域与 Rust 完全一致（`trade_commands.rs:10577-10586`）。
  // **不因缺省而拦**（Rust 自己会补 `strategy_exit`，fastlane.rs:3383-3388）：只拦非法取值。
  if (isRiskReducing) {
    const exitKind = String(order.exit_kind ?? order.exitKind ?? "").trim().toLowerCase();
    if (exitKind && !FASTLANE_EXIT_KINDS.includes(exitKind)) {
      reasons.push(`exit_kind 只能是 ${FASTLANE_EXIT_KINDS.join(" / ")}（收到 ${exitKind}）`);
    }
  }
  // 盈亏比 ≥ 1.5 —— **口径与 Rust `validate_round`（`fastlane.rs:1595-1622`）逐条同源**。
  //
  // 🔴 C29.15 修掉的第三处同源缺陷（**不是放宽风控**：1.5 的底线与 ATR 乘数一字未改）：
  //   1. **取哪个止盈**：旧侧车取 `targets[0]`（数组第一个），Rust 取**最优的那一个**
  //      （`is_long ? max : min`，即"对方向最有利的止盈"）。模型给多个 tp 时两边结论不同
  //      → 侧车**比 Rust 更严**，会把 Rust 会接受的参数判死（同一类缺陷 C29.9 已在滑点上记录过一次）。
  //   2. **缺止盈**：旧侧车 `targets.length > 0` 才查 → 没给 tp 就**跳过**这道检查；
  //      Rust 是 `(None, _) => missing_take_profit` → **必须拒**。这一半侧车**比 Rust 更松**，
  //      属于"放过了执行侧一定会拒的参数"（方向与第 1 点相反，两边都要对齐才是同源）。
  // 顺带：Rust 的 `stop_distance > 0.0` 分支在 `stop_distance == 0` 时**既不判也不拒**（`(Some(tp), false)` 无匹配臂）
  // —— 侧车保持同一行为：`risk > 0` 才判，不额外加码。
  if (isOpen && !isRiskReducing && entry !== null && stop !== null) {
    const bestTarget = targets.length === 0
      ? null
      : targets.reduce((left, right) => (side === "long" ? Math.max(left, right) : Math.min(left, right)));
    const risk = Math.abs(entry - stop);
    if (bestTarget === null) {
      reasons.push("missing_take_profit: 缺少止盈目标");
    } else if (risk > 0) {
      const reward = Math.abs(bestTarget - entry);
      const ratio = reward / risk;
      if (ratio < FASTLANE_DEFAULTS.minRewardRisk) {
        reasons.push(`reward_risk_below_floor: 盈亏比 ${ratio.toFixed(2)} < ${FASTLANE_DEFAULTS.minRewardRisk}`);
      }
    }
  }
  // 滑点只约束**市价单**（2026-09-21 裁决，对齐 Rust `validate_round` fastlane.rs:1550-1558）：
  // Rust 那条是 `else if !is_reduce && matches!(plan.order_type.as_str(), "market") && inputs.last_price > 0.0`
  // —— 只有 `order_type == "market"` 才查滑点；`limit`/`trigger` 一律不查（挂低于市价的限价回踩单
  // 天然离最新价很远，用滑点上限去量它是把"回踩"判成"滑点超限"，与 C29 §8.1 第 5 条
  // "入场价在合理区间（或市价时滑点 ≤ 上限）"的本意相反）。
  // 缺省/未知取值按 Rust 同口径处理：Rust 的 `adapt_plan`（fastlane.rs:3130-3150）**更早**就把
  // 缺失/非 `limit|market|trigger` 的 orderType 判成 `field_missing`/`field_invalid` 拒绝，
  // 根本到不了 `validate_round`；这里不重复那道适配器检查，只保证**判定口径**一致：
  // 非 "market"（含缺失/未知）→ **不查滑点**，绝不比 Rust 更严。
  const orderTypeNormalized = String(order.order_type ?? order.orderType ?? "").trim().toLowerCase();
  if (isOpen && !isRiskReducing && orderTypeNormalized === "market" && entry !== null && finiteNumber(snapshot?.price?.last) !== null) {
    const last = Number(snapshot.price.last);
    const slipBps = last > 0 ? Math.abs(entry - last) / last * 10_000 : 0;
    if (slipBps > fastlane.maxSlippageBps) reasons.push(`市价入场价偏离最新价 ${slipBps.toFixed(1)}bps 超过上限 ${fastlane.maxSlippageBps}bps`);
  }
  // 数据门分层（2026-09-21 裁决）：必需块缺失/过期会由后端**在调用本函数之前**拦下该轮，
  // 这里只做兜底；**可选块（orderbook / micro.*）缺失不构成不动手的理由**——Rust 会把
  // data_age_ms.orderbook 写成 i64::MAX 并在 state 里显式 null，绝不能因此拦掉动作。
  if (!isRiskReducing) {
    for (const [key, limit] of [["ticker", 60_000], ["candles_1m_closed", 300_000], ["derivatives", 300_000], ["account", 300_000]]) {
      const value = finiteNumber(age[key]);
      if (value !== null && value > limit) reasons.push(`${key} 必需数据不可用或过期（${value}ms）`);
    }
  }
  // 事件黑名单：口径与参考时钟都**由代码定**（C29.15；详见 `eventBlackoutReasons` 的注释）。
  // 修掉的是"读一个不存在的键 → 死代码 → 只剩模型自己猜窗口"的真实缺陷；**规则本身一字未改**
  // （窗口仍是 `eventBlackoutMinutes`，importance 白名单与 Rust 逐字一致，降险仍不查）。
  if (isOpen && !isRiskReducing) {
    reasons.push(...eventBlackoutReasons(snapshot, config));
  }
  // 降险的**数量口径**：要减少的张数不得超过该品种**可减的持仓**（2026-09-21 验收实测：
  // ETH 那两条降险判决里模型给出的张数超过持仓 0.04 → 0.1（`run-1786982929909979000` /
  // `run-1786985434902135000`），那是"减仓变反向开仓"的风险；后续重跑没再复现，
  // 因此这条闸门由单测 `size_over_position` 钉住，而不是靠某一次采样的运气）。
  // 判定纪律与 C29 一致：**只有拿到持仓事实才比对**（没有持仓事实 → 不设上限，降险不得因缺数据被挡）。
  if (isRiskReducing && contracts !== null) {
    const held = positionCapacity(snapshot, order);
    if (held > 0 && contracts > held * (1 + 1e-9)) {
      reasons.push(`size_over_position: 要减少的 ${contracts} 张超过当前持仓 ${held} 张`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/// 该品种**可减的持仓张数**（`state.account.positions`）。返回 0 = 没有持仓事实（不设上限）。
///
/// 与 Rust `position_capacity`（`fastlane.rs`，`fastlane_round_facts` 里算 `held`）同一口径：
/// 只累加**同品种**、**同向**（`net` 单向持仓无 side 时全算）、数量为正的持仓。
export function positionCapacity(snapshot = {}, order = {}) {
  const positions = Array.isArray(snapshot?.account?.positions) ? snapshot.account.positions : [];
  const instId = String(snapshot?.inst_id ?? snapshot?.instId ?? "").trim();
  const side = String(order?.side || order?.direction || "").trim().toLowerCase();
  let total = 0;
  for (const item of positions) {
    const id = String(item?.instId ?? item?.inst_id ?? "").trim();
    if (instId && id && id !== instId) continue;
    const size = finiteNumber(item?.pos ?? item?.contracts ?? item?.size);
    if (size === null || size <= 0) continue;
    const itemSide = String(item?.side ?? item?.posSide ?? item?.pos_side ?? "").trim().toLowerCase();
    if (side && itemSide && itemSide !== "net" && itemSide !== side) continue;
    total += Math.abs(size);
  }
  return total;
}

/// 结构位取数（**与 `hardConstraints` 的「第一目标」候选 / C29.15 §1.3 几何复算逐字同源**）：
/// `state.structure` 的 tf_15m / tf_1h / tf_4h 各自的 `last_swing_high` / `last_swing_low` /
/// `window_high` / `window_low`。非有限值一律丢弃（不补 0、不猜）。
export function fastlaneStructureLevels(snapshot = {}) {
  const levels = [];
  const structure = snapshot?.structure;
  if (!structure || typeof structure !== "object") return levels;
  for (const tf of FASTLANE_STRUCTURE_FRAMES) {
    const block = structure[tf];
    if (!block || typeof block !== "object") continue;
    for (const key of FASTLANE_STRUCTURE_KEYS) {
      const value = finiteNumber(block[key]);
      if (value !== null) levels.push({ tf, key, value });
    }
  }
  return levels;
}

/// entry **不利一侧**最近的结构位（做多取 entry 下方最近的低点；做空取上方最近的高点）——
/// 纪律止损公式里的「最近结构位」。没有 → `null`（不猜、不用别的位顶替）。
export function fastlaneStopAnchorLevel({ levels = [], entry = null, direction = "" } = {}) {
  if (entry === null || (direction !== "long" && direction !== "short")) return null;
  const long = direction === "long";
  const side = levels.filter((item) => (long ? item.value < entry : item.value > entry));
  if (side.length === 0) return null;
  return side.sort((a, b) => (long ? b.value - a.value : a.value - b.value))[0];
}

/// entry **有利一侧**最近的结构位（做多取上方最近、做空取下方最近）——只作诊断读数（不参与判定）。
export function fastlaneNearestFavorableLevel({ levels = [], entry = null, direction = "" } = {}) {
  if (entry === null || (direction !== "long" && direction !== "short")) return null;
  const long = direction === "long";
  const side = levels.filter((item) => (long ? item.value > entry : item.value < entry));
  if (side.length === 0) return null;
  return side.sort((a, b) => (long ? a.value - b.value : b.value - a.value))[0];
}

/**
 * 「**能付得起这份风险的最近合理结构位**」—— C29.15 修正后的「第一目标」口径（**门槛参数化**）：
 *   ① 候选 = 结构位里位于 entry **有利一侧**的（做多取 entry 上方、做空取 entry 下方）；
 *   ② 合格 = 距 entry **至少 `barR × risk`**（`barR = 1` 就是"能付得起这份风险"）；
 *   ③ 目标 = 合格里**离 entry 最近**的一个（做多取满足条件的最小者、做空取最大者）；
 *   ④ 一个合格的都没有 → `null`（= 几何上确实达不到，不是"挑错了位"）。
 *
 * `hardConstraints` 给窄调用的「第一目标」用的就是本函数（`barR = 1.5`，因为那一条的盈亏比门槛是
 * 1.5）——**同一取数，只换门槛**，生产里不存在第二套目标位定义。
 */
export function fastlaneFirstTarget({ levels = [], entry = null, direction = "", risk = null, barR = FASTLANE_ENTRY_QUALITY.targetBarR } = {}) {
  const bar = finiteNumber(barR);
  if (entry === null || risk === null || !(risk > 0) || (direction !== "long" && direction !== "short") || bar === null) return null;
  const long = direction === "long";
  const needed = bar * risk;
  const qualifying = levels.filter((item) => (long ? item.value - entry >= needed : entry - item.value >= needed));
  if (qualifying.length === 0) return null;
  return qualifying.sort((a, b) => (long ? a.value - b.value : b.value - a.value))[0];
}

/**
 * **入场质量门（纯代码判据）** —— C29.18 的**唯一实现**（Rust 只读结果，不重算）。
 *
 * 三条判据、三个独立原因码（[`FASTLANE_ENTRY_QUALITY_WATCH_REASONS`]）：
 *   ① `structure_ok`：结构位可辨且处于可用距离（见 `FASTLANE_ENTRY_QUALITY.maxStructureAtr` 的依据）；
 *   ② `stop_placeable`：纪律止损**放得下** —— 距离 ∈ [`minStopAtr`, …]×ATR 且**结构锚**不超过
 *      `maxAnchorAtr`×ATR（过近会被扫 / 过远止损退化成纯 ATR 距离，见常量注释里的证明）；
 *   ③ `rr_ok`：`|目标位 − entry| / R ≥ qualityFloor`，目标位 = [`fastlaneFirstTarget`]（barR = 1）。
 *
 * ⚠️ **不适用就是真的不适用**（不是"偷偷放行"）：
 *   - 没有方向（`action` 不是 `open_long` / `open_short`：观望、降险、停机轮）→ `applicable:false`
 *     （`skipReason: "no_direction"`）→ 不产生任何原因码 —— **降险轮压根没有方向，本门对它不适用**
 *     （C29.10/C29.14 的豁免更强：不是"门过了"，而是"门不参与"）；
 *   - 调用方没给 `snapshot`（老实验脚本的直接调用）→ `applicable:false`（`skipReason: "no_snapshot"`）
 *     → 不产生原因码，且**显式留痕**（`applicable:false` 会落进记录 / UI），绝不伪装成"门过了"。
 *   生产路径（`runFastlaneRound`）永远给 snapshot → 这两条只是容缺，不是绕过。
 *
 * ⚠️ 与 `jev.quality` **零关系**：本函数**不读** `quality`（连观察都不读）。`quality` 自 C29.18 起
 * 只是记录里的观察量，**绝不**作为不动手 / abort 的理由（否则又回到 C29.15 的"分位数线"问题）。
 */
export function fastlaneEntryQuality({ snapshot = null, config = {}, jev = {} } = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  const floor = finiteNumber(fastlane.qualityFloor);
  const rrFloor = floor === null ? FASTLANE_DEFAULTS.qualityFloor : floor;
  const action = String(jev?.action ?? "").trim().toLowerCase();
  const direction = action === "open_long" ? "long" : action === "open_short" ? "short" : null;
  const hasSnapshot = snapshot !== null && typeof snapshot === "object" && Object.keys(snapshot).length > 0;
  const base = {
    // 三条判据（`null` = 不适用 / 算不出：见 skipReason，**不是** false）
    structure_ok: null,
    stop_placeable: null,
    rr_ok: null,
    applicable: direction !== null && hasSnapshot,
    skipReason: direction === null ? "no_direction" : (hasSnapshot ? null : "no_snapshot"),
    direction,
    rr_floor: rrFloor,
    // 纪律参数（写进记录，方便复盘"这一轮用的是哪套阈值"）
    min_stop_atr: FASTLANE_ENTRY_QUALITY.minStopAtr,
    max_anchor_atr: FASTLANE_ENTRY_QUALITY.maxAnchorAtr,
    max_structure_atr: FASTLANE_ENTRY_QUALITY.maxStructureAtr,
    atr_stop_buffer: FASTLANE_ENTRY_QUALITY.atrStopBuffer,
    entry: null,
    atr14_1h: null,
    levels_count: 0,
    stop_side_count: 0,
    target_side_count: 0,
    nearest_structure: null,
    nearest_structure_atr: null,
    stop_anchor: null,
    stop_anchor_atr: null,
    stop: null,
    stop_distance: null,
    stop_distance_atr: null,
    target: null,
    rr: null,
    rr_nearest: null,
    /// 三条判据里**不过的那些码**（按 结构 → 止损 → 赔率 顺序；空数组 = 全过或不适用）。
    reasons: []
  };
  if (!base.applicable) return base;
  const levels = fastlaneStructureLevels(snapshot);
  const entry = finiteNumber(snapshot?.price?.last);
  const atr = finiteNumber(snapshot?.volatility?.atr14_1h);
  const long = direction === "long";
  const out = { ...base, entry, atr14_1h: atr, levels_count: levels.length };
  if (entry === null || atr === null || atr <= 0) {
    // 现价 / ATR 读不到 → 结构"可用距离"与止损距离都算不出来 → 按**结构不可辨**处理（宁可不做）。
    out.structure_ok = false;
    out.reasons = [FASTLANE_ENTRY_QUALITY_WATCH_REASONS.structure];
    return out;
  }
  const stopSide = levels.filter((item) => (long ? item.value < entry : item.value > entry));
  const targetSide = levels.filter((item) => (long ? item.value > entry : item.value < entry));
  const nearest = levels.length > 0
    ? levels.map((item) => ({ ...item, distance: Math.abs(item.value - entry) })).sort((a, b) => a.distance - b.distance)[0]
    : null;
  out.stop_side_count = stopSide.length;
  out.target_side_count = targetSide.length;
  out.nearest_structure = nearest ? { tf: nearest.tf, key: nearest.key, value: nearest.value, distance: nearest.distance } : null;
  out.nearest_structure_atr = nearest ? nearest.distance / atr : null;
  // ① structure_ok：结构位缺失 / 只有单侧 / 离现价太远 → 拦。
  out.structure_ok = levels.length > 0
    && stopSide.length > 0
    && targetSide.length > 0
    && out.nearest_structure_atr !== null
    && out.nearest_structure_atr <= FASTLANE_ENTRY_QUALITY.maxStructureAtr;
  if (!out.structure_ok) {
    out.reasons = [FASTLANE_ENTRY_QUALITY_WATCH_REASONS.structure];
    return out;
  }
  // ② stop_placeable：纪律止损（原文公式）的距离必须落在可接受区间。
  const anchor = fastlaneStopAnchorLevel({ levels, entry, direction });
  const atrStop = long ? entry - FASTLANE_ENTRY_QUALITY.atrStopBuffer * atr : entry + FASTLANE_ENTRY_QUALITY.atrStopBuffer * atr;
  const stop = anchor === null
    ? atrStop
    : (long ? Math.max(anchor.value, atrStop) : Math.min(anchor.value, atrStop));
  out.stop_anchor = anchor ? { tf: anchor.tf, key: anchor.key, value: anchor.value } : null;
  out.stop_anchor_atr = anchor === null ? null : Math.abs(entry - anchor.value) / atr;
  out.stop = stop;
  out.stop_distance = Math.abs(entry - stop);
  out.stop_distance_atr = out.stop_distance / atr;
  out.stop_placeable = out.stop_distance_atr >= FASTLANE_ENTRY_QUALITY.minStopAtr
    && out.stop_anchor_atr !== null
    && out.stop_anchor_atr <= FASTLANE_ENTRY_QUALITY.maxAnchorAtr + 1e-9;
  if (!out.stop_placeable) {
    out.reasons = [FASTLANE_ENTRY_QUALITY_WATCH_REASONS.stop];
    return out;
  }
  // ③ rr_ok：几何 R:R ≥ 门槛（目标位 = 能付得起这份风险的最近合理结构位）。
  const risk = out.stop_distance;
  const target = fastlaneFirstTarget({ levels, entry, direction, risk, barR: FASTLANE_ENTRY_QUALITY.targetBarR });
  const nearestFavorable = fastlaneNearestFavorableLevel({ levels, entry, direction });
  out.target = target ? { tf: target.tf, key: target.key, value: target.value, distance: Math.abs(target.value - entry) } : null;
  out.rr = target ? Math.abs(target.value - entry) / risk : null;
  out.rr_nearest = nearestFavorable ? Math.abs(nearestFavorable.value - entry) / risk : null;
  out.rr_ok = out.rr !== null && out.rr >= rrFloor - 1e-9;
  out.reasons = out.rr_ok ? [] : [FASTLANE_ENTRY_QUALITY_WATCH_REASONS.rr];
  return out;
}

/**
 * C29 §8.1 的**入场质量 + 置信度**门槛（代码判定，不交给模型）。
 *
 * **C29.18（2026-09-21）语义变更**：`low_quality` **不再由 `jev.quality` 产生** —— 质量门改成
 * 纯代码判据 [`fastlaneEntryQuality`]（结构可辨 / 止损可放 / 几何 R:R 达线），三条各有独立原因码
 * （`structure_unclear` / `stop_not_placeable` / `rr_below_floor`，可同时出现，顺序即判据顺序）。
 * `jev.quality` 降级为**观察量**：本函数**不读它**，记录/UI 照旧显示（缺失显示 `--`）。
 *
 * 置信度门**一字未动**：`confidence !== null && < confidenceFloor` → `low_confidence`；
 * 打分臂没有 action 节点 → `confidence === null` → 该门**不适用**（既有口径）。
 *
 * 返回值：`{ ok, reasons, confidenceFloor, entryQuality }` —— `entryQuality` 是侧车给出的
 * **判定依据读数**（Rust 只读透传，不重算）。
 */
export function fastlaneDecisionGate({ jev = {}, config = {}, snapshot = null } = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  const confidence = finiteNumber(jev.confidence ?? jev.action?.confidence);
  // ⚠️ 传**原始 config**（不是上面归一后的对象）：`normalizeFastlaneConfig` 只认 snake_case 的
  // `fastlane_quality_floor`，把归一结果再归一一次会把门槛悄悄丢回默认值（已踩：R:R 门槛失效）。
  const entryQuality = fastlaneEntryQuality({ snapshot, config, jev });
  const reasons = [...entryQuality.reasons];
  if (confidence !== null && confidence < fastlane.confidenceFloor) reasons.push("low_confidence");
  return { ok: reasons.length === 0, reasons, confidenceFloor: fastlane.confidenceFloor, entryQuality };
}

const JEV_ACTION_ALIASES = new Map([
  ["观望", "watch"], ["watch", "watch"], ["wait", "watch"],
  ["开多", "open_long"], ["open_long", "open_long"], ["long", "open_long"],
  ["开空", "open_short"], ["open_short", "open_short"], ["short", "open_short"],
  ["减仓", "reduce"], ["reduce", "reduce"],
  ["平仓", "close"], ["close", "close"]
]);

/**
 * 打分臂的 `score` 节点 → 代码侧判定（**唯一的决策逻辑**）。
 *
 * 规则（2026-09-21 用户裁决，逐字对齐实验 §0.2）：
 *   `max(long, short) ≥ floor` 且不并列 → 方向 = argmax（long 大 = 做多）；
 *   低于 floor / **两分并列** / 分数缺失 → `watch`（保守）。
 *
 * **C29.14（2026-09-21）新增降险臂，优先级最高**（既有裁决"降风险动作优先级高于开仓"）：
 *   1. `reduce_score ≥ reduceFloor` → 判**降险动作**（`action: "reduce"`，走 C29.10 那条已验证链路），
 *      **不再看开仓臂**；
 *   2. 否则再按 `max(long, short) ≥ floor` 走开仓臂；
 *   3. 仍不足 → 观望。
 *
 * 三条硬约束（测试逐条钉住）：
 *   - **`reduce_score` 永远不得映射成开仓**（只可能产出 `reduce` 或 `watch`）；
 *   - **降险不越权**：`reduce_score < reduceFloor` 时开仓臂照旧独立判定（低降险分不影响开仓）；
 *   - **没有可减的仓位就不降险**：`positionFact !== "held"` 时 `reduce_score` 再高也是观望
 *     （`held` 之外两种状态各有自己的观望码：无持仓 / 持仓事实缺失）。
 *
 * ⚠️ **两条门槛已解耦（C29.17，2026-09-21）**：开仓臂用 `floor`（生产 =
 * `fastlane_entry_score_floor`，默认 1.5），降险臂用 `reduceFloor`（生产 =
 * `fastlane_reduce_score_floor`，**默认同为 1.5**）—— 默认值等价于 C29.14 的"复用同一门槛"，
 * 所以**行为零变化**；但两个旋钮现在可以分别调（降险比开仓更适合放宽：降险只作用于既有持仓，
 * 放宽不产生新仓位、不放大暴露）。记录里 `reduceFloor` 落**生效的降险门槛**，不再与 `floor` 强制同值。
 *
 * ⚠️ 刻意**不**用模型给的标签、也**不**用 `quality` 分代替方向：`quality` 自 **C29.18** 起只是
 * **观察量**（连质量门都不再读它，见 [`fastlaneDecisionGate`]），不参与"做多还是做空"，
 * 也不参与"该不该动手"（实验 §7 两条路都要求这一点）。
 * ⚠️ 并列用**精确相等**判定（与实验 `bDecision` 同口径）：分数是连续期望值，近似相等
 * 不当作并列 —— 改这条口径等于改一个未实测的判定面。
 *
 * 返回值里：`decision` 恒为**开仓臂自己的**口径（`direction` / `below_floor` / `tie` / `score_missing`，
 * 即使被降险顶掉也算出来，便于复盘"降险优先时开仓臂本来会怎么判"）；`reduceDecision` 是降险臂
 * 自己的口径（`reduce` / `reduce_without_position` / `reduce_position_unknown` / `below_floor` / `null`）。
 */
export function decideEntryFromScores({
  longScore = null,
  shortScore = null,
  reduceScore = null,
  floor = FASTLANE_DEFAULTS.entryScoreFloor,
  /// **降险臂自己的门槛**（C29.17 起独立；生产 = `fastlane_reduce_score_floor`，默认 1.5）。
  /// 与 `floor` 各自独立：改开仓门槛不影响降险，反之亦然。
  reduceFloor = FASTLANE_DEFAULTS.reduceScoreFloor,
  /// 持仓事实：`held`（有可减仓位）/ `flat`（无持仓）/ `unknown`（持仓事实缺失）。
  /// 缺省 `null` 按 `unknown` 处理 —— **拿不到持仓事实就不许降险**（不猜）。
  positionFact = null
} = {}) {
  // ⚠️ 分数缺失必须严格判：`Number(null) === 0` 会把"没答这一问"读成"0 分"，
  // 然后被 `max` 拿去跟另一侧比 —— 那是**编造**一个分数（0 分是一个真实打分，缺答不是）。
  const readScore = (value) => (value === null || value === undefined || value === "" ? null : finiteNumber(value));
  const long = readScore(longScore);
  const short = readScore(shortScore);
  const reduce = readScore(reduceScore);
  const parsedFloor = finiteNumber(floor);
  const gateFloor = parsedFloor === null ? FASTLANE_DEFAULTS.entryScoreFloor : parsedFloor;
  const parsedReduceFloor = finiteNumber(reduceFloor);
  const reduceGateFloor = parsedReduceFloor === null ? FASTLANE_DEFAULTS.reduceScoreFloor : parsedReduceFloor;
  const fact = reduce === null ? null : normalizeReducePositionFact(positionFact);
  const base = {
    longScore: long,
    shortScore: short,
    reduceScore: reduce,
    // 开仓臂的门槛（`entry_score_floor`）。
    floor: gateFloor,
    // 降险臂的**独立**门槛（`reduce_score_floor`，C29.17）：记录里显式落**生效值**，
    // 便于复盘核对（默认与 `floor` 同值，但两者可分别调 → 不再强制相等）。
    reduceFloor: reduceGateFloor,
    positionFact: fact
  };
  // ① 开仓臂先算（规则一字未改）：降险只是"优先"，不改开仓臂本身的判定口径。
  const entry = (() => {
    if (long === null || short === null) {
      return { action: "watch", decision: "score_missing", watchReason: null, maxScore: null };
    }
    const maxScore = Math.max(long, short);
    if (long === short) {
      return { action: "watch", decision: "tie", watchReason: JEV_ENTRY_SCORE_WATCH_REASONS.tie, maxScore };
    }
    if (!(maxScore >= gateFloor)) {
      return { action: "watch", decision: "below_floor", watchReason: JEV_ENTRY_SCORE_WATCH_REASONS.belowFloor, maxScore };
    }
    return { action: long > short ? "open_long" : "open_short", decision: "direction", watchReason: null, maxScore };
  })();
  // ② 降险臂（最高优先）：够**降险门槛**（`reduceFloor`，与开仓门槛独立）→ 判降险；
  //    没有可减的仓位 → 观望（**不回落到开仓**）。
  if (reduce !== null && reduce >= reduceGateFloor) {
    if (fact === "held") {
      return { action: "reduce", decision: entry.decision, reduceDecision: "reduce", watchReason: null, maxScore: entry.maxScore, ...base };
    }
    const watchReason = fact === "flat"
      ? JEV_REDUCE_SCORE_WATCH_REASONS.noPosition
      : JEV_REDUCE_SCORE_WATCH_REASONS.positionUnknown;
    return { action: "watch", decision: entry.decision, reduceDecision: watchReason, watchReason, maxScore: entry.maxScore, ...base };
  }
  // ③ 降险未达门槛（或没答这一问）→ 开仓臂照旧（**降险不越权**）。
  return {
    action: entry.action,
    decision: entry.decision,
    reduceDecision: reduce === null ? null : "below_floor",
    watchReason: entry.watchReason,
    maxScore: entry.maxScore,
    ...base
  };
}

/// 持仓事实归一：只认三个值（`held` / `flat` / `unknown`）；其余（含 `null` / 未知串）一律 `unknown`。
function normalizeReducePositionFact(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "held" || text === "flat" ? text : "unknown";
}

/**
 * 降险臂要的**持仓事实**（`state.account.positions`）：`{ fact, capacity }`。
 *
 *   - `held`（capacity > 0）：本品种当前有持仓 → 有可减的仓位；
 *   - `flat`（positions 是数组但没有本品种的正持仓）：**无持仓** → 没有可减的仓位；
 *   - `unknown`（`positions` 不是数组）：**持仓事实缺失** → 不猜（不得降险）。
 *
 * 与 [`positionCapacity`] 同一取数口径（同品种、同向、数量为正），只是**保守**：不把
 * "读不到"当"没有"（那会把数据异常说成"你本来就没仓位"）。
 */
export function positionFactForReduce(snapshot = {}) {
  const positions = snapshot?.account?.positions;
  if (!Array.isArray(positions)) return { fact: "unknown", capacity: 0 };
  const instId = String(snapshot?.inst_id ?? snapshot?.instId ?? "").trim();
  let total = 0;
  for (const item of positions) {
    const id = String(item?.instId ?? item?.inst_id ?? "").trim();
    if (instId && id && id !== instId) continue;
    const size = finiteNumber(item?.pos ?? item?.contracts ?? item?.size);
    if (size === null || size <= 0) continue;
    total += Math.abs(size);
  }
  return total > 0 ? { fact: "held", capacity: total } : { fact: "flat", capacity: 0 };
}

/// 打分臂节点的取值（容错：`{score: n}` 或裸数字；`long_score` / `longScore` 两种键名）。
function jevScoreNodeValue(answers, key, camelKey) {
  const node = answers?.[key] ?? answers?.[camelKey];
  if (node === null || node === undefined) return null;
  if (typeof node === "number") return finiteNumber(node);
  if (typeof node === "object") return finiteNumber(node.score ?? node.value);
  return null;
}

/// `score` 节点的自报置信度（**仅诊断留痕**：不喂给开仓口径的置信度门，理由见 `normalizeJevVerdict`）。
function jevScoreNodeConfidence(answers, key, camelKey) {
  const node = answers?.[key] ?? answers?.[camelKey];
  if (!node || typeof node !== "object") return null;
  return finiteNumber(node.confidence);
}

/// Jev 返回体 → 归一化判定（action 归一 + 概率 + 置信度 + 质量分）。
///
/// **形状容错（向后兼容，不许把老响应解释成开仓）**：
///   - **旧形状优先**：只要 `answers.action`（choice）能被别名表认出（观望/开多/开空/减仓/平仓），
///     就走**改动前那条路径**，行为逐字不变；
///   - 认不出动作标签（打分臂没有 `action` 节点 → `actionValue` 为空）**且**任一 `score` 节点
///     （`long_score` / `short_score` / `reduce_score`）可用 → 走**打分臂**：代码侧
///     [`decideEntryFromScores`] 给 `action ∈ {reduce, open_long, open_short, watch}`；
///   - 两者都没有 → `watch`（旧兜底），**不崩、不静默开仓**、不编造分数。
///
/// `snapshot`（C29.14）：**只用来看"有没有可减的仓位"**（降险臂的前置条件，[`positionFactForReduce`]）——
/// 不参与开仓臂的任何判定（那一支仍然只看两个分数与门槛）。
///
/// `confidenceSource`：`action_node`（旧形状，生产门读的就是它）/ `none`（打分臂没有 action 节点）。
/// 打分臂**不代填** action 置信度 —— 实测 `long_score` / `short_score` 节点置信度集中在 0.13–0.65
/// （给方向的 58 条里 min 中位数仅 0.35），与 action 节点的 0.9+ **不是同一个尺度**；
/// 用它顶替等于把置信度门偷偷收紧到"整臂全拦"。门本身语义不动：`confidence === null` 时该门不参与，
/// 这个事实通过 `confidenceSource: "none"` 显式留痕（记录 / UI 都看得见），不是静默绕过。
export function normalizeJevVerdict(raw = {}, { latencyMs = 0, config = {}, snapshot = null } = {}) {
  const answers = raw?.answers && typeof raw.answers === "object" ? raw.answers : raw;
  const actionNode = answers?.action && typeof answers.action === "object" ? answers.action : {};
  const actionValue = typeof answers?.action === "string" ? answers.action : (actionNode.choice ?? answers?.action_choice ?? "");
  const qualityNode = answers?.quality && typeof answers.quality === "object" ? answers.quality : {};
  const qualityValue = finiteNumber(qualityNode.score ?? answers?.quality);
  const probabilities = actionNode.probabilities && typeof actionNode.probabilities === "object" ? actionNode.probabilities : {};
  const legacyAction = JEV_ACTION_ALIASES.get(String(actionValue || "").trim().toLowerCase()) || null;
  const longScore = jevScoreNodeValue(answers, "long_score", "longScore");
  const shortScore = jevScoreNodeValue(answers, "short_score", "shortScore");
  const reduceScore = jevScoreNodeValue(answers, "reduce_score", "reduceScore");
  const scored = longScore !== null && shortScore !== null;
  const fastlane = normalizeFastlaneConfig(config);
  // 打分臂只在**旧形状认不出动作**时生效（旧形状永远优先 —— 向后兼容）。
  const scoreDecision = legacyAction === null && (longScore !== null || shortScore !== null || reduceScore !== null)
    ? decideEntryFromScores({
      longScore,
      shortScore,
      reduceScore,
      floor: fastlane.entryScoreFloor,
      // 降险臂的**独立**门槛（C29.17）：默认与入场门槛同值 1.5，但可分别调。
      reduceFloor: fastlane.reduceScoreFloor,
      // 持仓事实：降险臂的唯一前置条件（开仓臂不看它）。
      positionFact: reduceScore === null ? null : positionFactForReduce(snapshot).fact
    })
    : null;
  const action = legacyAction ?? (scoreDecision?.action ?? "watch");
  const actionConfidence = finiteNumber(actionNode.confidence ?? answers?.confidence);
  /**
   * 记录里的**判定依据**只落一个码（UI 一张 chip 一眼看懂），口径：
   *   - 降险臂接管（判降险 / 因仓位不可降险而观望）→ 落**降险臂的码**
   *     （`reduce` / `reduce_without_position` / `reduce_position_unknown`）；
   *   - 否则落**开仓臂的码**（`direction` / `below_floor` / `tie` / `score_missing`）。
   * 降险臂接管时开仓臂"本来会怎么判"不进记录字段（那是另一个口径），只进 `validation.reasons` 的
   * `entry_score:` 诊断句（人可读，不占机器字段）。
   */
  const reduceGoverns = scoreDecision !== null
    && (scoreDecision.action === "reduce"
      || scoreDecision.reduceDecision === JEV_REDUCE_SCORE_WATCH_REASONS.noPosition
      || scoreDecision.reduceDecision === JEV_REDUCE_SCORE_WATCH_REASONS.positionUnknown);
  const entryScoreDecision = scoreDecision
    ? (reduceGoverns ? (scoreDecision.action === "reduce" ? "reduce" : scoreDecision.reduceDecision) : scoreDecision.decision)
    : (scored || reduceScore !== null ? "legacy_action" : null);
  const scoreFloorValue = scoreDecision ? scoreDecision.floor : fastlane.entryScoreFloor;
  // 降险臂**生效的**门槛（C29.17）：判定给出的 `reduceFloor` 优先；没有判定（旧形状）时回落配置值。
  const reduceFloorValue = scoreDecision ? scoreDecision.reduceFloor : fastlane.reduceScoreFloor;
  return {
    action,
    actionRaw: String(actionValue || ""),
    probabilities,
    confidence: actionConfidence,
    quality: qualityValue,
    qualityProbabilities: qualityNode.probabilities && typeof qualityNode.probabilities === "object" ? qualityNode.probabilities : {},
    setupValid: answers?.setup_valid && typeof answers.setup_valid === "object" ? answers.setup_valid : null,
    latencyMs,
    // —— 打分臂留痕（纯增量；旧形状下 `decision` 为 `legacy_action`，便于复盘口径）——
    longScore: scored ? longScore : null,
    shortScore: scored ? shortScore : null,
    /// 降险分（C29.14）：缺答 → `null`（不是 0 分）。
    reduceScore: scoreDecision ? reduceScore : null,
    longScoreConfidence: jevScoreNodeConfidence(answers, "long_score", "longScore"),
    shortScoreConfidence: jevScoreNodeConfidence(answers, "short_score", "shortScore"),
    entryScoreFloor: scored || scoreDecision ? scoreFloorValue : null,
    entryScoreDecision,
    /// 本轮**降险臂**的口径（C29.14）：`reduce` / `reduce_without_position` /
    /// `reduce_position_unknown` / `below_floor`（没到门槛）；没答这一问 → `null`。
    reduceDecision: scoreDecision?.reduceDecision ?? null,
    /// 降险臂**自己的**门槛（C29.17 起独立字段 `fastlane_reduce_score_floor`；默认与入场门槛
    /// 同值 1.5）：落**生效值**，不再与 `entryScoreFloor` 强制同值 —— 复盘不必靠推断。
    reduceScoreFloor: scored || scoreDecision ? reduceFloorValue : null,
    /// 降险臂看到的持仓事实：`held` / `flat` / `unknown`；没答 reduce_score → `null`。
    reducePositionFact: scoreDecision?.positionFact ?? null,
    /// 本轮的观望码（只在打分臂判定为观望时非 null）：
    /// `low_entry_score` / `entry_score_tie` / `reduce_without_position` / `reduce_position_unknown`。
    entryScoreWatchReason: scoreDecision?.watchReason ?? null,
    confidenceSource: actionConfidence !== null ? "action_node" : "none"
  };
}

function retryAfterMs(response, attempt) {
  const header = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1_000, 2_000);
  return attempt === 1 ? 250 : 500;
}

/// ① Jev 调用：`POST {baseUrl}/v1/systemone`，Bearer key 只在请求头里；429/529 退避重试最多 1 次。
/// 失败一律带 HTTP 状态码；`redact`（调用方注入，侧车传 `sanitizeDiagnosticText`）作用于
/// 错误原文与响应体 —— 即使上游把可疑内容塞进 body/异常，也不会原样进事件。
export async function callJev({
  snapshot = {},
  config = {},
  apiKey = "",
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  redact = (value) => String(value ?? "")
} = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  const request = buildJevRequest({ snapshot, config });
  const startedAt = now();
  // 空 key 预检（2026-09-21 裁决）：盘上 `typesafeApiKey` 为空时**零往返**立即返回 ——
  // 省掉一次注定失败的无用往返（真机实测 770ms），且**不伪造状态码**：没有请求就没有 HTTP 状态，
  // `status: null` / `attempts: 0` 如实上报，`failureKind: "auth"` 让调用方照常给出路文案。
  const trimmedKey = String(apiKey ?? "").trim();
  if (!trimmedKey) {
    return {
      ok: false,
      status: null,
      failureKind: JEV_FAILURE_KINDS.auth,
      latencyMs: 0,
      attempts: 0,
      error: JEV_MISSING_KEY_ERROR,
      raw: "",
      request
    };
  }
  let attempts = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attempts = attempt;
    try {
      const response = await fetchImpl(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(fastlane.jevTimeoutMs)
      });
      const text = await response.text();
      if (!response.ok) {
        const status = Number(response.status);
        if (JEV_RETRY_STATUSES.has(status) && attempt === 1) {
          await sleep(retryAfterMs(response, attempt));
          continue;
        }
        // 文本在这里一次性定稿：429/529 的"已重试 N 次"按整轮实测 attempts 如实上报。
        lastError = describeJevHttpFailure({ status, attempts, hasApiKey: Boolean(apiKey) });
        return { ok: false, status, failureKind: classifyJevFailure(lastError, { status }), latencyMs: now() - startedAt, attempts, error: lastError, raw: redact(text), request };
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: Number(response.status),
          failureKind: JEV_FAILURE_KINDS.parse,
          latencyMs: now() - startedAt,
          attempts,
          error: `Jev 返回不是 JSON（HTTP ${Number(response.status)}）`,
          raw: redact(text),
          request
        };
      }
      return {
        ok: true,
        latencyMs: now() - startedAt,
        attempts,
        raw: text,
        request,
        // `snapshot` 只喂给降险臂的持仓事实判定（C29.14）；开仓臂不看它。
        verdict: normalizeJevVerdict(parsed, { latencyMs: now() - startedAt, config, snapshot }),
        tokens: { in: finiteNumber(parsed?.usage?.input_tokens ?? parsed?.usage?.prompt_tokens), out: finiteNumber(parsed?.usage?.output_tokens ?? parsed?.usage?.completion_tokens) }
      };
    } catch (error) {
      const cause = String(error?.message || error);
      lastError = describeJevNetworkFailure(error, redact);
      if (attempt === 1 && /timeout|abort/i.test(cause)) {
        await sleep(retryAfterMs(null, attempt));
        continue;
      }
      return {
        ok: false,
        status: null,
        failureKind: /timeout|abort/i.test(cause) ? JEV_FAILURE_KINDS.timeout : JEV_FAILURE_KINDS.network,
        latencyMs: now() - startedAt,
        attempts,
        error: attempts > 1 ? `${lastError}（已重试 ${attempts - 1} 次）` : lastError,
        raw: "",
        request
      };
    }
  }
  return { ok: false, status: null, failureKind: JEV_FAILURE_KINDS.network, latencyMs: now() - startedAt, attempts, error: lastError || "Jev 请求失败：调用未完成", raw: "", request };
}

/// 应用内部模型 id 的形状（真机那次 Rust 把 `profile.model` 直接当 API 的 `model` 传下来，
/// provider 认的是 provider 模型名 → `窄调用 HTTP 400`）。
const INTERNAL_MODEL_ID_PATTERN = /^model-\d+$/;

/// 是否形如应用内部模型 id（`model-1784742123978`）。
export function isInternalModelId(value) {
  return INTERNAL_MODEL_ID_PATTERN.test(String(value ?? "").trim());
}

/// 内部 id → **provider 模型名**：按 `config.models[]` 的 `id` 精确命中，取该条目的 `model`。
///
/// **Rust 侧已做解析（`ai_automation::fastlane_llm_model`），这里是二道保险** ——
/// 只在"形似内部 id 且按 id 命中"时替换：
///   - 未命中 / 名字为空 / 不形似 → **原样透传**（不吞用户设置、不猜 provider 名）；
///   - 也接受 `models` 是 `{ "model-…": {model} }` / `{ "model-…": "name" }` 的映射形状。
export function resolveNarrowLlmModel(chosen, config = {}) {
  const value = String(chosen ?? "").trim();
  if (!value || !isInternalModelId(value)) return value;
  const models = config?.models;
  const entry = Array.isArray(models)
    ? models.find((item) => item && typeof item === "object" && String(item.id ?? "").trim() === value)
    : (models && typeof models === "object" ? models[value] : null);
  const resolved = typeof entry === "string" ? entry : (entry && typeof entry === "object" ? entry.model : "");
  return String(resolved ?? "").trim() || value;
}

function collapseDiagnosticText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/// 截断到 `limit` 字符以内（超长时末尾留一个 `…`，长度仍 ≤ limit）。
function truncateDiagnosticText(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/// 从 provider 的错误响应里挑出人可读的那一句（脱敏 + 折叠空白）：
/// `{"error":{"message":"model not found"}}` → `model not found`；非 JSON 用原文。
export function extractProviderErrorMessage(rawBody, redact = (value) => String(value ?? "")) {
  const raw = String(rawBody ?? "");
  let message = "";
  try {
    const parsed = JSON.parse(raw);
    const candidate = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail ?? parsed?.msg;
    message = typeof candidate === "string" ? candidate : (candidate ? JSON.stringify(candidate) : "");
  } catch {
    message = raw;
  }
  return collapseDiagnosticText(redact(message || raw));
}

/// 窄调用非 2xx 的错误文案：`窄调用 HTTP 400：model not found`（带状态码 + provider 正文，
/// 整体**截断到 200 字符以内**，正文先过 `redact`）。
///
/// 同时给出 `detail`（正文诊断位）：与 `error` 冒号后那段**逐字一致** ——
/// `error === \`窄调用 HTTP ${status}：${detail}\`` 可直接断言，二者不会各截各的。
export const NARROW_LLM_ERROR_LIMIT = 200;
export function narrowLlmHttpFailure({ status, rawBody = "", redact = (value) => String(value ?? "") } = {}) {
  const prefix = `窄调用 HTTP ${status}`;
  const snippet = extractProviderErrorMessage(rawBody, redact);
  if (!snippet) return { message: prefix, detail: null };
  const message = truncateDiagnosticText(`${prefix}：${snippet}`, NARROW_LLM_ERROR_LIMIT);
  return { message, detail: message.slice(prefix.length + 1) };
}

export function describeNarrowLlmHttpFailure({ status, rawBody = "", redact = (value) => String(value ?? "") } = {}) {
  return narrowLlmHttpFailure({ status, rawBody, redact }).message;
}

/// 非 JSON 正文（网关 HTML 等）的诊断位：脱敏 + 折叠空白 + 截断 ≤200；空正文 → null。
export function narrowLlmBodyDetail(rawBody, redact = (value) => String(value ?? "")) {
  const detail = truncateDiagnosticText(collapseDiagnosticText(redact(String(rawBody ?? ""))), NARROW_LLM_ERROR_LIMIT);
  return detail || null;
}

/// ② 窄调用 LLM：一次性、无工具、关思考、temperature 0.2、max_tokens 800，要求只输出一个 JSON。
/// 不重试（4xx 客户端错误重试没有意义）：任何真实发出的请求 `attempts` 恒为 1。
export async function callNarrowLlm({
  prompt = {},
  config = {},
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  redact = (value) => String(value ?? "")
} = {}) {
  const fastlane = normalizeFastlaneConfig(config);
  const requestedModel = String(fastlane.llmModel || config?.model || "").trim();
  // 内部 id 兜底（Rust 已做解析，这里是二道保险）；命中不了就原样透传。
  const model = resolveNarrowLlmModel(requestedModel, config);
  const modelSource = model === requestedModel ? "passthrough" : "internal-id";
  const baseUrl = String(config?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!model) return { ok: false, status: null, attempts: 0, model: "", modelSource, latencyMs: 0, error: "窄调用缺少模型配置（config.model / fastlane_llm_model）", detail: null };
  if (!baseUrl) return { ok: false, status: null, attempts: 0, model, modelSource, latencyMs: 0, error: "窄调用缺少 baseUrl", detail: null };
  const startedAt = now();
  const body = {
    model,
    temperature: fastlane.llmTemperature,
    max_tokens: fastlane.llmMaxTokens,
    // 硬要求：关思考（开思考时 8.1s 且输出为空）
    reasoning_effort: fastlane.llmReasoningEffort,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ]
  };
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config?.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(fastlane.llmTimeoutMs)
    });
    const raw = await response.text();
    if (!response.ok) {
      // 400/422 这类客户端错误如实带上 provider 的错误正文（脱敏 + ≤200 字符），不吞状态码。
      // `detail` 与 `error` 冒号后那段逐字一致（同一份截断与脱敏），事件里再带一份不会各截各的。
      const failure = narrowLlmHttpFailure({ status: response.status, rawBody: raw, redact });
      return {
        ok: false,
        status: Number(response.status),
        attempts: 1,
        model,
        modelSource,
        latencyMs: now() - startedAt,
        error: failure.message,
        detail: failure.detail,
        raw: redact(raw),
        requestBody: body
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        status: Number(response.status),
        attempts: 1,
        model,
        modelSource,
        latencyMs: now() - startedAt,
        error: "窄调用返回不是 JSON",
        detail: narrowLlmBodyDetail(raw, redact),
        raw: redact(raw),
        requestBody: body
      };
    }
    const choice = parsed?.choices?.[0] || {};
    const content = String(choice?.message?.content ?? "");
    return {
      ok: true,
      status: Number(response.status),
      attempts: 1,
      model,
      modelSource,
      latencyMs: now() - startedAt,
      detail: null,
      content,
      finishReason: choice?.finish_reason ?? null,
      requestBody: body,
      tokens: {
        in: finiteNumber(parsed?.usage?.prompt_tokens),
        out: finiteNumber(parsed?.usage?.completion_tokens)
      }
    };
  } catch (error) {
    return { ok: false, status: null, attempts: 1, model, modelSource, latencyMs: now() - startedAt, error: describeNetworkFailure("窄调用请求失败", error, redact), detail: null, requestBody: body };
  }
}

/// 一轮快判的编排：快照（Rust 备好）→ Jev → 窄调用 LLM → 代码校验 → 交给 `createOpportunity`。
/// `createOpportunity(params, meta)` 由侧车注入（内部转发既有「创建机会」工具）；侧车在这一轮
/// **不调用任何其它工具**、不取数。
export async function runFastlaneRound({
  sessionId = "",
  snapshot = {},
  config = {},
  typesafeApiKey = "",
  wakeConditions = [],
  // Rust 下发的"类型 → 必填字段/单位" schema：**原样注入** prompt；缺失则退化（不报错、不阻塞）。
  wakeConditionSchema = null,
  createOpportunity = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep,
  emit = () => {},
  // `fastlaneIntent`：`round`（默认，正常快判轮）| `close`（停机平仓轮）。
  // 停机语义（C29.7）：用户已显式决定平仓 → **跳过 Jev**，不让判定层再表态。
  intent = "round",
  // 脱敏函数（侧车注入 `sanitizeDiagnosticText`）：失败原文进事件前再洗一遍。
  redact = (value) => String(value ?? ""),
  callJevImpl = callJev,
  callNarrowLlmImpl = callNarrowLlm
} = {}) {
  const startedAt = now();
  const fastlane = normalizeFastlaneConfig(config);
  const closeIntent = String(intent ?? "").trim().toLowerCase() === "close";
  const result = {
    ok: false,
    trigger: null,
    gate: null,
    jev: null,
    llm: null,
    action: { kind: "watch", reason: null },
    // 本轮**动作分支的 intent 口径**（记录里用来区分"停机平仓轮"与"Jev 自判减仓"）：
    //   `round`（开仓口径）/ `close`（停机平仓轮，fastlaneIntent=close）/ `reduce`（Jev 判减仓/平仓）。
    //   未定（Jev 失败等）时为 null，不伪造。
    intent: null,
    timing: { jevMs: null, llmMs: null },
    tokens: { jevIn: null, jevOut: null, llmIn: null, llmOut: null }
  };

  let jev = null;
  let gate = { ok: true };
  if (closeIntent) {
    // 停机平仓轮：不构造 Jev 请求、不消耗 Jev 预算、不发 Jev 相关事件；如实标为未执行。
    result.timing.jevMs = 0;
    result.jev = { skipped: true, reason: "intent_close" };
    result.gate = { ok: true };
  } else {
    jev = await callJevImpl({ snapshot, config, apiKey: typesafeApiKey, fetchImpl, now, redact, ...(sleep ? { sleep } : {}) });
    result.timing.jevMs = jev.latencyMs;
    if (!jev.ok) {
      result.gate = { ok: false, anomaly: true };
      // 失败原文一律带 HTTP 状态码（`describeJevHttpFailure`）；`failureKind` 供 Rust 侧挑文案，
      // `hint` 只在鉴权失败时给出可直接展示的出路（否则 null，不缺省编造建议）。
      const failureKind = jev.failureKind || classifyJevFailure(jev.error, { status: jev.status ?? null });
      // `null` 是"没有状态码"（网络层失败），不能被 `Number(null) === 0` 折算成 0。
      const jevStatus = jev.status === null || jev.status === undefined || jev.status === "" ? null : Number(jev.status);
      result.jev = {
        action: null,
        error: jev.error,
        latencyMs: jev.latencyMs,
        attempts: jev.attempts,
        status: Number.isFinite(jevStatus) ? jevStatus : null,
        failureKind,
        hint: failureKind === JEV_FAILURE_KINDS.auth ? JEV_KEY_SETTINGS_HINT : null
      };
      result.action = { kind: "watch", reason: "anomaly" };
      emit({ type: "fastlaneResult", sessionId, ...result });
      return result;
    }
    result.tokens.jevIn = jev.tokens?.in ?? null;
    result.tokens.jevOut = jev.tokens?.out ?? null;
    result.jev = {
      action: jev.verdict.action,
      actionRaw: jev.verdict.actionRaw,
      probabilities: jev.verdict.probabilities,
      confidence: jev.verdict.confidence,
      quality: jev.verdict.quality,
      latencyMs: jev.latencyMs,
      attempts: jev.attempts,
      raw: jev.raw,
      // —— 打分臂（2026-09-21 变更 B）：两个分数 + 门槛 + 判定依据，全部落 `fastlane_json.jev` ——
      // 这是"观望是因为分数不够"而不是"模型说观望"的唯一凭据（UI 直接渲染这几个字段）。
      longScore: jev.verdict.longScore,
      shortScore: jev.verdict.shortScore,
      entryScoreFloor: jev.verdict.entryScoreFloor,
      entryScoreDecision: jev.verdict.entryScoreDecision,
      // —— 降险臂（C29.14，2026-09-21）：降险分 + **降险自己的门槛** + 降险口径 + 看到的持仓事实 ——
      // 降险"该不该做"由 `reduce_score` 表达；"能不能做"由 `reducePositionFact` 表达
      // （无持仓 / 持仓事实缺失时不许降险，两个码各有文案）。
      reduceScore: jev.verdict.reduceScore,
      reduceScoreFloor: jev.verdict.reduceScoreFloor,
      reduceScoreDecision: jev.verdict.reduceDecision,
      reducePositionFact: jev.verdict.reducePositionFact,
      // 置信度门的**值来源**：`action_node`（旧形状）/ `none`（打分臂没有 action 节点）。
      // 门语义不动，但"这道门这轮到底参没参与"必须看得见（不许静默绕过）。
      confidenceSource: jev.verdict.confidenceSource
    };
    result.gate = { ok: true };
    // 入场质量门（**纯代码判据**，C29.18）：结构可辨 / 止损可放 / 几何 R:R 达线 —— 不过则走观望分支，
    // 让 LLM 写下一轮观察条件（闭环不丢）。`jev.quality` 只是观察量，**不参与**这里任何一条判据。
    gate = fastlaneDecisionGate({ jev: jev.verdict, config, snapshot });
  }
  /**
   * **变更 A（2026-09-21）**：质量门 / 置信度门**只作用于开新仓**。
   *
   * 依据：`artifacts/fastlane-jev-sweep/report-20260921-043231.md` —— 400 样本里 Jev 判开多/开空 = 0，
   * 动手的 22 条**全是减仓(21)/平仓(1)**，`confidence` 只有 0.26–0.47（全在 0.6 之下）→ 旧口径
   * 0/400 能进动作分支 = "用机会质量门否决止损"。降险（降暴露）**不受这两道门约束**，
   * 只过参数与风控校验（`validateFastlaneAction` 的降险分支，与 Rust `validate_round` 的
   * `is_reduce` 同源）。
   *
   * 三条纪律：
   *   1. **开新仓路径逐字不变**：`open_long/open_short` + `!gate.ok` → 仍然 watch；
   *   2. **门的结果照旧上报、不静默、不伪造**：`result.gate.ok` 保持门自己的结论（**不许改成 true**），
   *      只额外标注这道门的作用域与豁免（`appliedTo: "open"` / `bypassedFor: "risk_reduction"`）；
   *   3. `closeIntent`（停机平仓轮）语义不变：它本来就跳过 Jev、直接走降险动作分支。
   */
  const jevRiskReduction = !closeIntent && isRiskReducingJevAction(jev.verdict.action);
  const gateBlocksBranch = !gate.ok && !jevRiskReduction;
  // 门的**判定依据读数**（C29.18）：入场质量三条判据的取数 / 阈值 / 结果一次性落进记录
  // （Rust `SidecarGateOutcome.entry_quality` **只读透传**，UI 直接渲染）——
  // 这是"这一轮为什么没进动作分支"可复核的唯一凭据（不是靠猜门槛）。
  const gateEntryQuality = gate.entryQuality ?? null;
  // 降险轮：门的结果照实上报 + 豁免标注（`ok` 绝不改写）。
  if (jevRiskReduction) {
    result.gate = {
      ok: gate.ok,
      reasons: [...gate.reasons],
      appliedTo: "open",
      bypassedFor: gate.ok ? null : "risk_reduction",
      ...(gateEntryQuality ? { entryQuality: gateEntryQuality } : {})
    };
  } else if (!closeIntent) {
    // 非降险轮的 Jev 判定成功：门同样照实上报（旧代码只写 `{ok:true}`，把门的结果吞掉了）。
    result.gate = {
      ok: gate.ok,
      reasons: [...gate.reasons],
      appliedTo: "open",
      bypassedFor: null,
      ...(gateEntryQuality ? { entryQuality: gateEntryQuality } : {})
    };
  }
  const branch = closeIntent ? "action" : (jev.verdict.action === "watch" || gateBlocksBranch ? "watch" : "action");
  /**
   * **变更 B（2026-09-21）**：打分臂里"代码判的观望"优先于模型自述的观望原因。
   *
   * `low_entry_score`（分数不足）/ `entry_score_tie`（两分并列）都是**代码**按
   * `max(long, short)` 与门槛算出来的（[`decideEntryFromScores`]），必须占 `action.reason` 位；
   * 模型写的观望原因照旧保留在 `llm.params.reason` 里，两者不互相吞掉。
   * 注意：只有**动作分支被分数判定为观望**时才顶掉 —— 若分数给了方向、是质量门/置信度门
   * 或模型自己 abort，reason 仍按原口径（门原因 / `no_setup` / 模型原因）。
   */
  const jevScoreWatchReason = closeIntent ? null : (jev.verdict.entryScoreWatchReason ?? null);
  const jevAnswers = closeIntent ? null : jev.verdict;
  // 降险分支的 prompt 走**降险口径**（`intent="reduce"`：无风格约束、无开仓专属硬约束）：
  // 与停机平仓轮（`intent="close"`）用同一套降险措辞，但在记录里是**两个不同的 intent 值**。
  const promptIntent = closeIntent ? "close" : (jevRiskReduction ? "reduce" : "round");
  result.intent = promptIntent;
  const prompt = branch === "watch"
    ? buildWatchPrompt({ snapshot, jev: { answers: jevAnswers }, config, wakeConditions, wakeConditionSchema })
    : buildActionPrompt({ snapshot, jev: { answers: jevAnswers }, config, wakeConditions, intent: promptIntent, wakeConditionSchema });
  const llm = await callNarrowLlmImpl({ prompt, config, fetchImpl, now, redact });
  result.timing.llmMs = llm.latencyMs;
  result.tokens.llmIn = llm.tokens?.in ?? null;
  result.tokens.llmOut = llm.tokens?.out ?? null;
  // 诊断位（与 Rust `SidecarLlm` 对齐，全部容缺）：`null` 是"没有状态码"（网络层失败），
  // 不能被 `Number(null) === 0` 折算成 0；`model` 记**实际发出的**模型名（真机 400 靠它定位）。
  const llmStatus = llm.status === null || llm.status === undefined || llm.status === "" ? null : Number(llm.status);
  const llmModelLabel = String(llm.model ?? "").trim()
    || String(fastlane.llmModel ?? "").trim()
    || String(config?.model ?? "").trim()
    || null;
  if (!llm.ok) {
    result.llm = {
      latencyMs: llm.latencyMs,
      error: llm.error,
      status: Number.isFinite(llmStatus) ? llmStatus : null,
      // `detail` = `error` 冒号后那段（脱敏 + ≤200 截断的同一份），非 2xx 时是 provider 正文。
      detail: typeof llm.detail === "string" ? llm.detail : null,
      model: llmModelLabel,
      attempts: llm.attempts ?? 1,
      wakeConditions: 0
    };
    result.action = { kind: "watch", reason: "anomaly" };
    emit({ type: "fastlaneResult", sessionId, ...result });
    return result;
  }
  const parsed = parseFastlaneLlmOutput(llm.content, { branch });
  const validationReasons = [];
  // 降险轮的**形状归一**（intent → Rust 认的 `close`）与全部诊断（不参与 ok 判定，只留痕）。
  const diagnosticNotes = [];
  // 打分臂记账（**诊断位复用**：UI 已有的 `validation.reasons` 渲染位直接可见）；
  // 两个分数 / 门槛 / 判定同时落 `jev` 组（结构化），这里给一句人能读的口径。
  if (!closeIntent && jev.verdict.longScore !== null && jev.verdict.shortScore !== null) {
    const scores = `long=${Number(jev.verdict.longScore).toFixed(2)} / short=${Number(jev.verdict.shortScore).toFixed(2)}`;
    const floor = jev.verdict.entryScoreFloor === null ? "—" : Number(jev.verdict.entryScoreFloor).toFixed(2);
    if (jev.verdict.entryScoreDecision === "direction") {
      diagnosticNotes.push(`entry_score: ${scores}（门槛 ${floor}）→ 代码判方向 ${jev.verdict.action}（max ≥ 门槛且不并列）`);
    } else if (jev.verdict.entryScoreDecision === "below_floor") {
      diagnosticNotes.push(`entry_score: ${scores}（门槛 ${floor}）→ 代码判**分数不足**：max < 门槛 → 观望（不是模型说观望）`);
    } else if (jev.verdict.entryScoreDecision === "tie") {
      diagnosticNotes.push(`entry_score: ${scores}（门槛 ${floor}）→ 两分并列 → 保守观望（方向不唯一）`);
    } else if (jev.verdict.entryScoreDecision === "score_missing") {
      diagnosticNotes.push(`entry_score: 分数缺失（long=${jev.verdict.longScore} / short=${jev.verdict.shortScore}）→ 观望（不猜方向）`);
    } else if (jev.verdict.entryScoreDecision === "legacy_action") {
      diagnosticNotes.push(`entry_score: ${scores}（旧形状 action 优先，未参与判定）`);
    } else if (jev.verdict.entryScoreDecision === "reduce") {
      // 降险优先：开仓臂"本来会怎么判"只在这里出现（人可读），不占机器字段。
      diagnosticNotes.push(`entry_score: ${scores}（门槛 ${floor}）→ **降险优先**：本轮按降险动作走（开仓臂不参与这次判定）`);
    } else if (jev.verdict.entryScoreDecision === "reduce_without_position"
      || jev.verdict.entryScoreDecision === "reduce_position_unknown") {
      diagnosticNotes.push(`entry_score: ${scores}（门槛 ${floor}）→ 开仓臂这次未判（被降险优先级挡在后面，见下条）`);
    }
  }
  /**
   * **降险臂记账（C29.14）**：`reduce_score` / 门槛 / 持仓事实三层各自说清 —— 用户必须一眼看出
   * "这一轮为什么没降险"是**哪一层**的问题：**分数没到门槛**（不是该降险）、
   * **没有可减的仓位**（该降险但没得减）、还是**持仓事实缺失**（读不到，不猜）。
   */
  if (!closeIntent && jev.verdict.reduceScore !== null) {
    const reduceScore = Number(jev.verdict.reduceScore).toFixed(2);
    // 门槛行文必须**点名降险自己的键**（C29.17 起降险门槛已与开仓门槛解耦；默认同为 1.5，
    // 但两者可分别调）—— 写"同一门槛"会把两条线读成一条，复盘时看不出哪条门槛生效。
    // `?? entryScoreFloor` 只是空值兜底（本分支里 `reduceScore !== null` ⇒ 判定存在 ⇒ 门槛非空）。
    const reduceFloorValue = Number(jev.verdict.reduceScoreFloor ?? jev.verdict.entryScoreFloor).toFixed(2);
    // 两条线不同值时额外点明开仓门槛（否则用户会以为显示的是开仓门槛）。
    const entryFloorDiffers = Number.isFinite(Number(jev.verdict.entryScoreFloor))
      && Number(jev.verdict.entryScoreFloor).toFixed(2) !== reduceFloorValue;
    const sameFloor = `降险门槛 reduce_score_floor=${reduceFloorValue}`
      + (entryFloorDiffers ? `（开仓门槛 entry_score_floor=${Number(jev.verdict.entryScoreFloor).toFixed(2)}，两条线已解耦）` : "");
    if (jev.verdict.reduceDecision === "reduce") {
      diagnosticNotes.push(
        `reduce_score: ${reduceScore}（${sameFloor}）→ 代码判**该降险**：本轮走降险动作（降险优先级高于开仓）`
      );
    } else if (jev.verdict.reduceDecision === "reduce_without_position") {
      diagnosticNotes.push(
        `reduce_score: ${reduceScore}（${sameFloor}）→ 代码判**该降险，但当前无持仓**（state.account.positions 里本品种没有可减的仓位）→ 观望：没有仓位就没有风险可降（不凭空产生动作）`
      );
    } else if (jev.verdict.reduceDecision === "reduce_position_unknown") {
      diagnosticNotes.push(
        `reduce_score: ${reduceScore}（${sameFloor}）→ 代码判**该降险，但持仓事实缺失**（读不到 state.account.positions）→ 观望：无法确认可减仓位就不降险（不猜）`
      );
    } else if (jev.verdict.reduceDecision === "below_floor") {
      diagnosticNotes.push(
        `reduce_score: ${reduceScore}（${sameFloor}）→ 降险分**未达门槛** → 不降险；开仓臂照旧独立判定（降险不越权）`
      );
    }
  }
  /**
   * **入场质量门记账（C29.18）**：三条代码判据的**取数与结论**逐条摊开 —— 用户必须一眼看出
   * "这一轮为什么没进动作分支"是**哪一条**不过（结构不可辨 / 止损放不下 / 赔率不够），
   * 而不是一个说不清来源的分数。不适用（没有方向 / 没给 snapshot）时**明说"不适用"**，不伪装成过。
   */
  if (!closeIntent && gateEntryQuality) {
    const eq = gateEntryQuality;
    const atr = (value) => (Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}×ATR14_1h` : "—");
    const px = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "—");
    if (!eq.applicable) {
      diagnosticNotes.push(
        `entry_quality: **不适用**（${eq.skipReason === "no_direction" ? "本轮没有开仓方向（观望 / 降险 / 停机轮）" : "调用方没给 state 快照"}）→ 本门不参与判定，不产生原因码`
      );
    } else if (eq.reasons.length === 0) {
      diagnosticNotes.push(
        `entry_quality: 代码判**入场质量达标** —— 结构可辨（最近结构位 ${atr(eq.nearest_structure_atr)}）、止损可放（${atr(eq.stop_distance_atr)}，结构锚 ${atr(eq.stop_anchor_atr)}）、几何 R:R ${Number(eq.rr).toFixed(2)} ≥ 门槛 ${Number(eq.rr_floor).toFixed(2)}`
      );
    } else {
      const detail = eq.structure_ok === false
        ? `结构不可辨（候选结构位 ${eq.levels_count} 个：下方 ${eq.stop_side_count} / 上方 ${eq.target_side_count}；现价 ${px(eq.entry)}、ATR14_1h ${px(eq.atr14_1h)}）`
        : eq.stop_placeable === false
          ? `止损放不下（距离 ${atr(eq.stop_distance_atr)}，下限 ${eq.min_stop_atr}；结构锚 ${atr(eq.stop_anchor_atr)}，上限 ${eq.max_anchor_atr}）`
          : `赔率不够（几何 R:R ${Number.isFinite(Number(eq.rr)) ? Number(eq.rr).toFixed(2) : "无合格目标位"} < 门槛 ${Number(eq.rr_floor).toFixed(2)}）`;
      diagnosticNotes.push(
        `entry_quality: 代码判**入场质量不过** → ${eq.reasons.join("+")}：${detail}；入场质量门只作用于**开仓**（本门原因码与 jev.quality 无关）`
      );
    }
  }
  if (!closeIntent && Number.isFinite(Number(jev.verdict.quality))) {
    // **观察量，不是判据**（C29.18）：照实落记录，但绝不再作为不动手 / abort 的理由。
    diagnosticNotes.push(
      `jev_quality: ${Number(jev.verdict.quality).toFixed(2)}（**观察量**：C29.18 起入场质量由代码判据决定，这个分数不参与任何判定）`
    );
  }
  if (jevRiskReduction && !gate.ok) {
    // 门没过、但因为这一轮是降险而放行：必须看得见（Rust 记录 / UI 都读这段）。
    diagnosticNotes.push(
      `risk_reduction_gate_bypass: 质量/置信度门未过（${gate.reasons.join("+") || "gate"}），本轮是降险动作 → 放行；开新仓仍受该门约束`
    );
  }
  if (parsed.ok && parsed.kind !== "watch" && (closeIntent || jevRiskReduction)) {
    // 降险轮里 `opportunity` 与 `order` 都可能被模型写上（真机 payload 两份都给）：
    // 两份都归一，避免"折叠了 A 却把 B 发给 Rust"。
    for (const key of ["opportunity", "order"]) {
      if (parsed[key] && typeof parsed[key] === "object" && !Array.isArray(parsed[key])) {
        parsed[key] = normalizeRiskReductionIntent(parsed[key], diagnosticNotes);
      }
    }
  }
  if (!parsed.ok) validationReasons.push(parsed.error);
  if (parsed.ok && parsed.kind === "action") {
    const codeCheck = validateFastlaneAction({
      action: { order: parsed.order ?? parsed.opportunity },
      snapshot,
      config,
      // **降险口径**：Jev 自判减仓/平仓（或停机平仓轮）→ 只过参数与风控校验。
      riskReducing: closeIntent || jevRiskReduction
    });
    if (!codeCheck.ok) validationReasons.push(...codeCheck.reasons);
  }
  result.llm = {
    latencyMs: llm.latencyMs,
    params: parsed.payload ?? null,
    // `validation.ok` 的判据**不变**（只有真实拒绝原因才算不过）；`reasons` 是诊断位：
    // 降险豁免与 intent 折叠都写在这里，UI 已有的渲染位直接可见。
    validation: { ok: validationReasons.length === 0, reasons: [...validationReasons, ...diagnosticNotes] },
    wakeConditions: parsed.nextWakePlan?.conditions?.length ?? 0,
    // 诊断位与失败分支形状统一（成功分支没有错误正文 → `detail: null`）。
    status: Number.isFinite(llmStatus) ? llmStatus : null,
    detail: null,
    model: llmModelLabel,
    attempts: llm.attempts ?? 1
  };

  if (!parsed.ok || validationReasons.length > 0) {
    result.action = { kind: "watch", reason: "validation_failed" };
    result.ok = true;
    emit({ type: "fastlaneResult", sessionId, ...result });
    return result;
  }
  if (parsed.kind === "abort") {
    result.action = { kind: "watch", reason: "no_setup" };
    result.llm.params = { abort: true, why: parsed.why };
    result.ok = true;
    emit({ type: "fastlaneResult", sessionId, ...result });
    return result;
  }
  if (parsed.kind === "watch") {
    // 停机平仓轮里模型若仍返回观望分支：如实回传（reason 取六枚举之一），不伪造成动作。
    // 变更 B：打分臂"代码判的观望"优先（`low_entry_score` / `entry_score_tie`）——
    // 否则用户会看到模型自己的措辞，看不出"这一轮根本没到分数门槛"。
    result.action = {
      kind: "watch",
      reason: jevScoreWatchReason ?? (gate.ok ? parsed.reason : (gate.reasons[0] || "no_setup"))
    };
    // ⚠️ 上面 `|| "no_setup"` 的兜底**不可达**（`gate.ok === false` ⇒ `reasons` 非空）：写成显式兜底
    // 只为不出现 `undefined`。C29.18 起这里**不会**再回落到 `low_quality`（那道门不再读 quality）。
    result.llm.nextWakePlan = parsed.nextWakePlan;
    result.ok = true;
    emit({ type: "fastlaneResult", sessionId, ...result });
    return result;
  }

  // 动作分支：唯一出口 = 既有「创建机会」工具（降险动作同链路）。
  const opportunityParams = parsed.opportunity || parsed.order;
  let opportunityId = null;
  if (typeof createOpportunity === "function") {
    try {
      const created = await createOpportunity(opportunityParams, { snapshot, config, wakePlan: parsed.nextWakePlan });
      opportunityId = created?.id ?? created?.opportunityId ?? null;
    } catch (error) {
      result.llm.validation = { ok: false, reasons: [...validationReasons, String(error?.message || error)] };
      result.action = { kind: "watch", reason: "validation_failed" };
      result.ok = true;
      emit({ type: "fastlaneResult", sessionId, ...result });
      return result;
    }
  }
  result.action = { kind: "opportunity", opportunityId, reason: parsed.summary ? null : null };
  result.llm.nextWakePlan = parsed.nextWakePlan;
  result.llm.opportunityId = opportunityId;
  result.ok = true;
  result.totalMs = now() - startedAt;
  emit({ type: "fastlaneResult", sessionId, ...result });
  return result;
}
