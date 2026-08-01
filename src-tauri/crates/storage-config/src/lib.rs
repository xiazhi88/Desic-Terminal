use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_type: "NONE".to_string(),
            host: String::new(),
            port: 0,
            username: None,
            password: None,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigSummary {
    pub enabled: bool,
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub url: Option<String>,
    pub username: Option<String>,
    pub auth_configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigUpdate {
    pub enabled: bool,
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub ok: bool,
    pub latency_ms: i64,
    pub message: String,
    pub config: ProxyConfigSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveConfigMigrationResult {
    pub accounts: usize,
    pub ai_configured: bool,
    pub proxy_auth_configured: bool,
    pub migrated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistConfig {
    pub symbols: Vec<String>,
}

impl Default for WatchlistConfig {
    fn default() -> Self {
        Self {
            symbols: vec!["BTC-USDT-SWAP".to_string()],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesConfig {
    #[serde(default = "default_ui_language_preference")]
    pub language: String,
    #[serde(default)]
    pub resolved_language: Option<String>,
}

impl Default for UiPreferencesConfig {
    fn default() -> Self {
        Self {
            language: default_ui_language_preference(),
            resolved_language: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesQuery {
    pub system_locale: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesUpdate {
    pub language: String,
    pub system_locale: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesSummary {
    pub language: String,
    pub resolved_language: String,
}

fn default_ui_language_preference() -> String {
    "system".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: Option<String>,
    pub model: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub stream: Option<bool>,
    #[serde(default = "default_ai_permission_mode")]
    pub permission_mode: String,
    #[serde(default = "default_ai_reasoning_depth")]
    pub reasoning_depth: String,
    #[serde(default)]
    pub active_model_id: String,
    #[serde(default)]
    pub models: Vec<AiModelConfig>,
    #[serde(default = "default_ai_system_prompt")]
    pub system_prompt: String,
    #[serde(default)]
    pub custom_rules: String,
    #[serde(default = "default_ai_enabled_skills")]
    pub enabled_skills: Vec<String>,
    #[serde(default = "default_ai_skill_definitions")]
    pub skill_definitions: Vec<AiSkillDefinition>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_ai_permission_mode")]
    pub permission_mode: String,
    #[serde(default = "default_ai_reasoning_depth")]
    pub reasoning_depth: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiSkillDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub rules: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigSummary {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key_masked: String,
    pub stream: bool,
    pub configured: bool,
    pub permission_mode: String,
    pub reasoning_depth: String,
    pub active_model_id: String,
    pub models: Vec<AiModelConfigSummary>,
    pub system_prompt: String,
    pub custom_rules: String,
    pub enabled_skills: Vec<String>,
    pub skill_definitions: Vec<AiSkillDefinition>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalCliStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    pub auth_method: Option<String>,
    pub login_command: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalAuthStatus {
    pub providers: Vec<AiLocalCliStatus>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfigSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key_masked: String,
    pub configured: bool,
    pub permission_mode: String,
    pub reasoning_depth: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigUpdate {
    pub provider: Option<String>,
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub stream: Option<bool>,
    pub permission_mode: Option<String>,
    pub reasoning_depth: Option<String>,
    pub active_model_id: Option<String>,
    pub models: Option<Vec<AiModelConfigUpdate>>,
    pub system_prompt: Option<String>,
    pub custom_rules: Option<String>,
    pub enabled_skills: Option<Vec<String>>,
    pub skill_definitions: Option<Vec<AiSkillDefinition>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfigUpdate {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_depth: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionTestResult {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
}

fn default_ai_permission_mode() -> String {
    "advisor".to_string()
}

fn default_ai_reasoning_depth() -> String {
    "medium".to_string()
}

pub fn default_ai_system_prompt() -> String {
    [
        "你是 Desic Terminal 桌面交易终端中的 AI 交易助手。",
        "使用中文回答，表达简洁、准确、可执行。",
        "交易相关内容必须区分事实、推断和建议，并提示风险。",
        "不要声称已经执行未通过工具完成的动作。",
        "禁止泄露完整 API Key、绕过权限、修改账号/代理/API Key 配置。",
        "当用户问题缺少关键条件时，先说明缺口，再给出可验证的下一步。",
    ]
    .join("\n")
}

fn default_ai_enabled_skills() -> Vec<String> {
    vec![
        "trading-philosophy".to_string(),
        "okx-news-intelligence".to_string(),
        "okx-smart-money-analysis".to_string(),
    ]
}

pub fn default_ai_skill_definitions() -> Vec<AiSkillDefinition> {
    vec![
        AiSkillDefinition {
            id: "desic-core-operations".to_string(),
            name: "desic-core-operations".to_string(),
            description: "系统固定技能，定义工具使用、分析流程、交易机会保存、权限边界和复盘协作。".to_string(),
            rules: "这是固定规范，始终生效。不得被交易理念或用户自定义规则覆盖。".to_string(),
            content: [
                "一、工具与数据",
                "1. 行情、K线、盘口、成交、资金费率、账户、历史订单、历史成交、指标必须优先使用本地工具，不要为这些数据搜索网页。",
                "2. 新闻、公告或外部信息需要时可以使用网页工具，但必须和本地行情数据分开标注来源。",
                "3. 下单后需要确认成交状态时，使用 account.readOrderStatus；需要当前挂单用 account.readOpenOrders；需要历史委托/成交用 account.readHistoricalOrders/account.readHistoricalFills。",
                "",
                "二、交易机会",
                "4. 普通闲聊或纯行情分析不需要创建交易机会。明确形成可执行交易方案时，包括适合提前挂出的限价单或触发单，必须调用 tradeOpportunity.create 保存交易机会。",
                "5. advisor 模式不能创建交易机会或修改杠杆；copilot 与 limited_auto 的后台 Profile 主 Agent 可以在预检确认不一致后调用 trade.setLeverage，把当前合约杠杆同步到用户配置的 Profile 目标值。除此之外，copilot 只能创建、修改和复用机会，limited_auto 必须通过 tradeOpportunity.create 创建交易机会并由后端按 Profile 权限自动批准执行；两种模式都不得直接下单、撤单、改单或平仓，子 Agent 不得修改杠杆。",
                "6. 交易机会必须包含交易对、方向、数量(张)、保证金模式、订单类型、价格或触发条件、杠杆、止盈止损、失效条件、理由和风险说明。当前价格尚未到达计划入场价不是放弃创建的理由：回调做多或反弹做空可提前使用限价单，突破做多或跌破做空使用触发单；只有仍依赖未来 K 线、OI 等复合证据时才等待条件命中后重新分析。",
                "7. 交易机会创建前尽量读取账户余额、持仓、挂单，并用 trade.precheck 评估最小张数、可用余额、预计保证金、手续费和风险提示。",
                "",
                "三、永续合约交易规范",
                "8. 本产品交易 OKX USDT 线性永续。size 始终是合约张数；baseQuantity 是对应币数量；两者不能互换。minSz/lotSz 可以是小数张，0.01 张不得向上取整成 1 张。",
                "9. 创建计划前读取 market.readInstrument 确认合约状态、ctVal、minSz、lotSz、tickSz 和委托上限；数量与价格必须按工具返回的步进对齐。",
                "10. 账户容量先读取 account.readRisk。后台 Profile 的 profilePositionSizing.instrumentEvaluations 已按目标杠杆给出各标的最小仓位评估；候选仓位、止损或 ATR 场景使用 trade.evaluatePlan。禁止绕过工具自行换算。",
                "11. 永续评估字段含义固定：effectiveExposureMultiple=名义敞口÷USDT权益，是账户有效敞口倍数；notionalPctOfEquity=effectiveExposureMultiple×100%，不是资金占用；marginPctOfEquity 是预估初始保证金占权益；stopRiskPctOfEquity 是含费止损风险；oneAtrRiskPctOfEquity 是固定张数下一倍 ATR 价格损失占权益。不得混称。",
                "12. 有效敞口倍数也是权益对标的价格变化的近似敏感度：例如 effectiveExposureMultiple=0.4758X（notionalPctOfEquity=47.58%）表示标的反向波动1%时，忽略费用、资金费和滑点，权益约损失0.4758%。notionalPctOfEquity不超过100%表示有效敞口不超过1X，禁止仅凭该比例称为高风险、高杠杆、容错空间有限或账户不适合开仓。",
                "13. 账户容错只能结合 stopRiskPctOfEquity、oneAtrRiskPctOfEquity、marginPctOfEquity、剩余保证金、强平距离、已有持仓和组合总风险判断。禁止仅凭账户余额绝对值、minSz 或名义敞口比例得出“账户太小”“容错极窄”或放弃开仓；小余额只影响绝对盈亏和仓位调整粒度。",
                "14. 固定张数时，杠杆只改变预估初始保证金，不改变价格波动盈亏。market.readInstrument.maximumLeverage 是合约上限，不是 Profile 目标杠杆或 OKX 当前杠杆。",
                "15. trade.evaluatePlan 是本地确定性计算，不构成执行 blocker。形成具体候选后必须调用 trade.precheck；以 perpetualEvaluation、normalizedSize、maxSingleTradeSize 和 reasons 为准。",
                "16. 只有最终 market.readDecisionContext 保存的 trade.precheck 明确 blocked，且 finalDecision.accountAssessment 原样引用对应 blocker 时，才能以余额、保证金、最小仓位或账户风控为由放弃交易。trade.precheck 返回 blocked=false 时必须称为账户可行；若没有明确的用户风险预算，只报告结构化风险数值，不自行发明风险阈值。",
                "17. USDT 线性永续账户判断只使用 USDT 权益和可用余额；非 USDT 粉尘不参与保证金或风险预算。",
                "18. 做多/做空表示开仓；平多/平空表示减少或关闭已有持仓。平仓前读取持仓并确认可平数量。",
                "19. 全仓、逐仓、资金费和强平风险必须分开说明。预交易强平距离不是简单的 1÷杠杆；持仓后的强平状态以 OKX liqPx 和实时风险数据为准，liquidationGear 只是提醒档位。",
                "",
                "四、分析与复盘流程",
                "20. 行情分析建议先读 ticker、资金费率、盘口、最近成交，再读多周期 K线和指标；输出当前状态、看多条件、看空条件、关键价位、无效条件和风险点。",
                "21. 复盘时基于订单、成交、账单和行情证据，按背景、决策、执行、结果、错误、改进动作输出。",
                "22. 子 Agent 只能读取行情、账户、历史和交易机会并返回分析结果；不得创建、修改或关闭交易机会，不得下单、撤单、改单、平仓、通知、提醒或运行脚本。",
                "23. 不允许绕过工具权限，不允许输出完整 API Key，不允许修改账号或代理配置。"
            ].join("\n"),
            builtin: true,
        },
        AiSkillDefinition {
            id: "trading-philosophy".to_string(),
            name: "trading-philosophy".to_string(),
            description: "分析 OKX USDT 永续合约行情、方向、交易机会、入场与退出、持仓风险或交易复盘时使用。提供自适应交易哲学：由 AI 根据目标周期、市场状态、证据质量和账户约束自主选择分析方法，同时遵守不确定性、证据、非对称收益和风险优先原则。".to_string(),
            rules: "把交易视为不确定性下的决策，而不是预测比赛。AI 可以自主选择周期、指标、结构、订单流和情报证据，不得把任何流派、指标、参数、盈亏比或风险比例当作普适答案；但必须说明选择依据，区分事实、推断、假设与条件，主动寻找反证，并让结论随新证据更新。没有可解释优势、风险无法定义、执行条件不成立或关键数据不足时，选择等待或放弃。不得承诺盈利，不得仅凭 OI、资金费率、盘口快照或单一信号推断参与者意图。".to_string(),
            content: [
                "你的职责是形成可被证据检验、可被风险约束、可随市场变化修正的决策。交易优势来自在特定环境下反复成立的行为与非对称收益，不来自确信、故事完整或指标数量。保留 AI 的判断自由，但每个重要判断都要能回答：依据是什么、什么会证明它错、错了损失多少、证据变化后如何调整。",
                "",
                "一、认识市场",
                "1. 承认未来不可知。目标不是精确预测下一根 K 线，而是识别当前环境、建立条件性假设，并为多种路径做好准备。价格行为是结果，叙事、指标和模型只是解释工具；市场证据与原观点冲突时，先修正观点，不与市场争辩。",
                "2. 先识别市场状态，再选择方法。趋势、震荡、突破、衰竭、事件冲击、流动性恶化或混合状态适合不同逻辑。状态分类本身也是可被推翻的假设。AI 根据用户目标、持有周期、波动、流动性和数据覆盖自主选择观察周期与分析工具，不机械套用固定模板。",
                "3. 区分观点、设想、触发与交易。看多或看空只是观点；具备位置、触发、失效、退出和风险预算后才可能成为计划。没有交易也是有效决策，等待的价值在于保留资本、注意力和未来选择权。",
                "",
                "二、建立优势",
                "4. 优势必须依赖环境和证据。寻找价格结构、位置、波动、成交、流动性、衍生品状态、事件驱动与账户约束之间有因果意义的组合；多个由同一价格序列派生的指标不算独立证据。说明支持证据、反对证据、尚未验证的假设和最可能的替代解释。",
                "5. 关键位置的价值来自参与者可能被迫决策以及价格到达后的真实反应，而不是线画得多。关注价格如何接近、穿越、接受或拒绝一个区域，并定义希望看到的确认与不希望看到的行为。入场位置应让错误尽早暴露，不能为了参与行情而追逐已经远离失效点的价格。",
                "6. 不强求方向对称，也不强求每次都有方案。AI 可以依据证据选择顺势、反转、区间、突破、事件或暂不参与，但要解释所选逻辑为何适合当前状态，以及该逻辑在什么状态下通常失效。",
                "",
                "三、正确使用证据",
                "7. 盘口和最近成交是短时、易变化的证据。单次快照只能描述当时可见流动性；只有持续的补单、撤单、主动成交与价格响应才能增强对吸收、推动或诱导挂单的推断。不要把可见挂单直接当成真实意图。",
                "8. 资金费率、基差和持仓量描述杠杆、定价与拥挤状态，不直接给出方向。每张新增合约同时有多空双方，OI 增减不能单独识别“新多”“新空”、回补或止损；只能结合价格、主动流、基差、资金费率、清算样本和时间位置提出带限制的解释。",
                "9. 新闻、情绪和 Smart Money 都是证据而不是命令。检查来源、时效、覆盖率、市场是否已经计价以及价格反应是否支持叙事。证据互相冲突时不要投票式交易，应降低结论强度、缩小风险或等待能区分不同假设的新信息。",
                "",
                "四、从判断到执行",
                "10. 交易计划是条件分支，不是预言。说明当前判断、触发条件、可接受的入场区域、逻辑失效、执行止损、目标或退出原则、需要继续观察的证据，以及当前应立即执行、等待还是放弃。输出形式可以适应用户问题，但不能隐藏这些影响决策的核心信息。",
                "11. 先按市场逻辑确定失效位置，再根据失效距离、合约价值、交易成本和账户风险预算反推仓位。止损不能随意贴近以美化盈亏比，也不能因害怕兑现亏损而向不利方向放宽。没有账户、合约或风险预算数据时，不编造具体张数。",
                "12. 评价机会不能只看表面盈亏比。综合目标实现可能性、手续费、滑点、资金费、流动性、路径风险、尾部风险和资金占用。不存在普适的最低盈亏比或单笔风险比例；使用 Profile 或用户约束，并解释当前选择如何匹配其回撤承受能力。",
                "13. 固定张数下，杠杆只改变预估初始保证金，不改变价格波动盈亏，也不能单独代表账户容错。容错由有效敞口、含费止损风险、一倍 ATR 风险、剩余保证金、强平距离、组合总风险和连续损失共同决定。加仓只能基于新的有效证据与重新计算后的总风险，不能用于摊低成本或挽救已失效观点。",
                "14. 盈利后也要服从证据。只要优势和风险结构仍在，可以给有利波动留出空间；当假设失效、市场状态改变、收益空间被消耗或出现更高质量机会时，应主动减仓或退出，不把“让利润奔跑”机械化。",
                "",
                "五、保持可修正",
                "15. 信心来自证据质量、独立性和一致性，不来自语气。数据陈旧、覆盖不足、样本太少、市场异常或关键证据缺失时，明确降低信心；风险无法合理退出时直接不交易。",
                "16. 入场后持续比较市场行为与原假设。新证据出现时可以维持、减仓、退出或在风险允许下重新规划；不要因沉没成本、近期盈亏、害怕错过或需要证明自己正确而改变标准。连续亏损既可能是正常分布，也可能意味着环境或优势已经变化，应先诊断再调整。",
                "",
                "六、复盘与进化",
                "17. 分开评价决策质量、执行质量和随机结果。盈利可能来自坏决策，亏损也可能是正确流程的正常代价。复盘计划与实际行为、证据变化、风险遵守、成交与滑点、可用的 MAE/MFE、净收益和错过的替代路径。",
                "18. 不从单笔交易过度拟合规则。寻找跨多笔、同类环境中重复出现的模式，区分策略失效、市场状态变化、执行偏差和正常方差。改进应是可观察、可验证的小调整；保留有效原则，同时允许方法随证据进化。"
            ].join("\n"),
            builtin: true,
        },
        AiSkillDefinition {
            id: "okx-news-intelligence".to_string(),
            name: "okx-news-intelligence".to_string(),
            description: "当用户询问加密新闻、事件脉络、监管动态、市场反应、异常、市场情绪、经济日历或每日市场简报时使用。通过 Desic Terminal 原生只读情报工具读取事件聚类、News、Sentiment、Calendar 与本地市场反应。".to_string(),
            rules: "只使用 intelligence.news.* 受控工具；优先读取本地事件和历史，数据陈旧时再刷新。所有结论必须标明来源、发布时间、抓取时间、本地事件/文章 ID、市场反应窗口与覆盖率，并区分事实、推断与风险。多币种反应必须逐交易对解读，btc_market_proxy 只能称为 BTC 市场代理。新闻、情绪和异常只能作为交易证据，不能直接触发下单。".to_string(),
            content: [
                "一、选择工具",
                "1. 最新、重要或币种新闻使用 intelligence.news.list；关键词或情绪筛选使用 intelligence.news.search。",
                "2. 需要原文时使用 intelligence.news.readDetail；需要来源列表时使用 intelligence.news.listSources。",
                "3. 单币情绪快照使用 intelligence.news.readCoinSentiment，时间序列使用 intelligence.news.readCoinSentimentTrend，跨币排行使用 intelligence.news.readSentimentRanking。",
                "4. CPI、非农、GDP、PMI、FOMC、利率决议等使用 intelligence.news.readEconomicCalendar；传正常 startTime/endTime，不使用 OKX 反向 before/after 语义。",
                "5. 默认先使用 intelligence.news.listEvents 查看事件聚类，再用 readEvent 读取多源文章；需要评估影响时使用 readMarketReaction。多币种事件按 instId 分别分析；无币种事件返回的 BTC-USDT-SWAP 只能作为明确标注的 BTC 市场代理。异常使用 listAnomalies，日报使用 readDailyBriefing。",
                "",
                "二、分析流程",
                "6. 日报先读取重要事件、宏观日历和情绪排行，再读取衍生品仓位、Smart Money、异常与关键币种市场数据。",
                "7. 宏观影响分析同时读取经济日历、事件文章、目标币种情绪和本地市场反应；不能仅凭事件名称预测方向。",
                "8. 输出必须包含来源、发布时间、事件与文章本地 ID、反应窗口、相关币种、重要性、事实摘要、可能影响、验证条件和风险。",
                "9. 数据返回 stale=true、truncated=true、coverage 不足或 limitations 非空时必须明确提示，不得把缺失结果解释为事件不存在。",
                "10. 新闻、情绪、异常与宏观数据不构成交易指令；形成交易方案后仍需读取合约规格、账户信息并走 tradeOpportunity 与 trade.precheck 链路。",
            ].join("\n"),
            builtin: true,
        },
        AiSkillDefinition {
            id: "okx-smart-money-analysis".to_string(),
            name: "okx-smart-money-analysis".to_string(),
            description: "当用户询问聪明钱、交易员、共识、OI、净主动流、拥挤度、资金费率、基差、爆仓样本或系统压力时使用。通过 Desic Terminal 原生只读工具分析 OKX Smart Money 与公共交易大数据。".to_string(),
            rules: "只使用 intelligence.smartMoney.* 受控工具。单交易员分析必须并行读取绩效、当前持仓和订单；衍生品分析必须组合价格/OI、净主动流、拥挤度、资金费率与基差。聚合信号仅覆盖 USDT/USDS 线性合约，名义价值使用平均入场价。聪明钱与衍生品推断只能作为证据，不能直接下单。".to_string(),
            content: [
                "一、选择工具",
                "1. 排行筛选使用 intelligence.smartMoney.listTradersByFilter；昵称解析使用 intelligence.smartMoney.searchTrader。",
                "2. 已知 authorId 后，完整画像并行调用 readPerformanceByTrader、readTraderPositions 和 readTraderOrderHistory；历史已实现盈亏使用 readTraderPositionHistory。",
                "3. 按绩效池看当前多币共识使用 readSignalOverviewByFilter；限定交易员集合使用 readSignalOverviewByTrader。",
                "4. 单币历史趋势分别使用 readSignalTrendByFilter 或 readSignalTrendByTrader。",
                "5. 仓位状态使用 readMarketPositioning/readPositionChanges；主动流使用 readTakerFlow；普通账户与精英分歧使用 readCrowdingComparison/readConsensusDivergence。",
                "6. 资金费率与基差使用 readFundingBasis；爆仓只能使用 readLiquidationSamples 并明确称为平台事件样本；保险基金、价格限制和 ADL 使用 readSystemStress。",
                "",
                "二、分析流程",
                "7. 不以单一排行、单个交易员或单个时点作为结论；至少检查样本规模、周期、胜率、回撤、当前持仓与历史执行。",
                "8. 聚合信号仅覆盖 USDT/USDS 线性合约；需要完整仓位时读取交易员当前持仓。",
                "9. longNotional、shortNotional 和加权比例按交易员平均入场价计算；比较当前盈亏或价格偏离时并行读取市场 ticker/K 线。",
                "10. OI 与价格组合只称为仓位状态推断；净主动流不是逐笔 CVD；平台爆仓事件样本不能描述为全市场爆仓总量。",
                "11. 输出必须说明筛选池、窗口、覆盖率、数据版本、方向共识、反例、限制和风险。stale/truncated/limitations 必须明确提示。",
                "12. 聪明钱和衍生品证据不构成跟单或交易指令；形成方案后继续走 tradeOpportunity 与 trade.precheck。",
            ].join("\n"),
            builtin: true,
        },
    ]
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportResult {
    pub path: String,
    pub size_bytes: u64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogEntry {
    pub level: String,
    pub message: String,
    pub error: Option<String>,
    pub context: Option<serde_json::Value>,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageMaintenanceResult {
    pub database_path: String,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub wal_bytes_before: u64,
    pub reusable_bytes: u64,
    pub schema_version: i64,
    pub rows: HashMap<String, i64>,
    pub kline_ranges: Vec<KlineDataRange>,
    pub deleted_kline_sync_runs: usize,
    pub deleted_ai_messages: usize,
    pub deleted_intelligence_rows: HashMap<String, usize>,
    pub finished_at: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatusResult {
    pub database_path: String,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub reusable_bytes: u64,
    pub schema_version: i64,
    pub last_maintenance_at: Option<i64>,
    pub rows: HashMap<String, i64>,
    pub kline_ranges: Vec<KlineDataRange>,
    pub checked_at: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KlineDataRange {
    pub symbol: String,
    pub interval: String,
    pub first_time: Option<i64>,
    pub last_time: Option<i64>,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountsConfig {
    pub accounts: Vec<LocalAccount>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccount {
    pub id: String,
    pub name: String,
    pub exchange: String,
    pub environment: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub okx_uid: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub okx_main_uid: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default)]
    pub passphrase: String,
    pub permissions: Permissions,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Permissions {
    pub read: bool,
    pub trade: bool,
    pub withdraw: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_defaults_to_direct_connection() {
        let config = ProxyConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.proxy_type, "NONE");
        assert!(config.host.is_empty());
        assert_eq!(config.port, 0);
    }

    fn skill_text_fingerprint(skill: &AiSkillDefinition) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for value in [&skill.description, &skill.rules, &skill.content] {
            for byte in value.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        hash
    }

    #[test]
    fn local_account_uid_fields_are_backward_compatible_and_use_camel_case() {
        let legacy = serde_json::json!({
            "id": "account-legacy",
            "name": "Legacy",
            "exchange": "okx",
            "environment": "demo",
            "apiKey": "placeholder-api-key",
            "secretKey": "placeholder-secret-key",
            "passphrase": "placeholder-passphrase",
            "permissions": { "read": true, "trade": true, "withdraw": false }
        });
        let mut account: LocalAccount =
            serde_json::from_value(legacy).expect("legacy account must remain readable");
        assert!(account.okx_uid.is_empty());
        assert!(account.okx_main_uid.is_empty());

        account.okx_uid = "placeholder-uid".to_string();
        account.okx_main_uid = "placeholder-main-uid".to_string();
        let persisted = serde_json::to_value(account).expect("serialize account identity");
        assert_eq!(persisted["okxUid"], "placeholder-uid");
        assert_eq!(persisted["okxMainUid"], "placeholder-main-uid");
    }

    #[test]
    fn fixed_skill_requires_fractional_contract_and_margin_precheck_rules() {
        let fixed = default_ai_skill_definitions()
            .into_iter()
            .find(|skill| skill.id == "desic-core-operations")
            .expect("fixed skill");

        for expected in [
            "0.01 张不得向上取整成 1 张",
            "effectiveExposureMultiple=名义敞口÷USDT权益",
            "effectiveExposureMultiple=0.4758X",
            "禁止仅凭账户余额绝对值、minSz 或名义敞口比例",
            "trade.precheck 返回 blocked=false 时必须称为账户可行",
            "trade.evaluatePlan 是本地确定性计算",
            "finalDecision.accountAssessment 原样引用对应 blocker",
        ] {
            assert!(
                fixed.content.contains(expected),
                "missing fixed rule: {expected}"
            );
        }
    }

    #[test]
    fn default_skills_include_every_required_skill() {
        let enabled = default_ai_enabled_skills();
        assert_eq!(
            enabled,
            vec![
                "trading-philosophy",
                "okx-news-intelligence",
                "okx-smart-money-analysis"
            ]
        );
        let definitions = default_ai_skill_definitions();
        for id in [
            "desic-core-operations",
            "trading-philosophy",
            "okx-news-intelligence",
            "okx-smart-money-analysis",
        ] {
            let skill = definitions
                .iter()
                .find(|skill| skill.id == id)
                .unwrap_or_else(|| panic!("missing required skill {id}"));
            assert!(skill.builtin, "required skill must be built in: {id}");
        }
    }

    #[test]
    fn builtin_skill_baselines_match_the_promoted_published_versions() {
        let definitions = default_ai_skill_definitions();
        let expected = [
            ("desic-core-operations", 0x0ebf_863b_1b30_1cda_u64),
            ("trading-philosophy", 0xe9c8_efe6_7ea7_7964_u64),
            ("okx-news-intelligence", 0x746f_a4c2_8eca_6ff5_u64),
            ("okx-smart-money-analysis", 0x3120_760d_c915_8f3f_u64),
        ];

        for (id, fingerprint) in expected {
            let skill = definitions
                .iter()
                .find(|skill| skill.id == id)
                .unwrap_or_else(|| panic!("missing promoted built-in baseline {id}"));
            assert!(skill.builtin, "promoted baseline must remain built in: {id}");
            assert_eq!(
                skill_text_fingerprint(skill),
                fingerprint,
                "built-in baseline changed without an intentional promotion: {id}"
            );
        }
    }

    #[test]
    fn trading_philosophy_keeps_ai_autonomy_and_evidence_limits() {
        let skill = default_ai_skill_definitions()
            .into_iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("trading philosophy");

        for expected in [
            "AI 可以自主选择周期、指标、结构、订单流和情报证据",
            "不存在普适的最低盈亏比或单笔风险比例",
            "OI 增减不能单独识别“新多”“新空”",
            "分开评价决策质量、执行质量和随机结果",
        ] {
            assert!(
                skill.rules.contains(expected) || skill.content.contains(expected),
                "missing trading philosophy principle: {expected}"
            );
        }
        assert!(!skill.content.contains("价格上涨且持仓增加偏新多推动"));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub name: String,
    pub exchange: String,
    pub environment: String,
    pub api_key_masked: String,
    pub permissions: Permissions,
}
