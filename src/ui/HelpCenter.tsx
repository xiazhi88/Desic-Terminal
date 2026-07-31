import {
  ArrowRight,
  Bell,
  BookOpen,
  Bot,
  ChartCandlestick,
  ChevronDown,
  CircleHelp,
  Database,
  Keyboard,
  Newspaper,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  WalletCards,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";

export type HelpSettingsTab = "account" | "proxy" | "ai" | "prompt" | "skills" | "notifications" | "storage";
export type HelpWorkspace = "terminal" | "automation" | "intelligence" | "data";

export type HelpTarget =
  | { kind: "settings"; tab: HelpSettingsTab }
  | { kind: "workspace"; section: HelpWorkspace; automationTab?: "profiles" | "runs" }
  | { kind: "notifications" }
  | { kind: "onboarding" };

type HelpCategoryId = "start" | "market" | "trade" | "shortcuts" | "ai" | "intelligence" | "data" | "troubleshoot";

type HelpCategory = {
  id: HelpCategoryId;
  label: string;
  description: string;
  tone: "violet" | "blue" | "green" | "amber" | "cyan" | "slate" | "red";
  icon: typeof BookOpen;
};

type HelpQuestion = {
  id: string;
  category: HelpCategoryId;
  title: string;
  paragraphs: string[];
  steps?: string[];
  shortcuts?: Array<{ keys: string[]; description: string }>;
  keywords?: string[];
  action?: { label: string; target: HelpTarget };
};

type ShortcutPlatform = {
  id: "macos" | "windows";
  label: "macOS" | "Windows";
  modifier: "Option" | "Alt";
};

function resolveShortcutPlatform(): ShortcutPlatform {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) {
    return { id: "macos", label: "macOS", modifier: "Option" };
  }
  return { id: "windows", label: "Windows", modifier: "Alt" };
}

const HELP_CATEGORIES_ZH: HelpCategory[] = [
  { id: "start", label: "快速开始", description: "账号、网络、模型与首次配置", tone: "violet", icon: BookOpen },
  { id: "market", label: "行情与图表", description: "实时行情、K 线、盘口与提醒", tone: "blue", icon: ChartCandlestick },
  { id: "trade", label: "交易与账户", description: "数量、杠杆、委托与实盘安全", tone: "green", icon: WalletCards },
  { id: "shortcuts", label: "快捷键", description: "下单模式、委托类型与输入定位", tone: "violet", icon: Keyboard },
  { id: "ai", label: "AI 与自动化", description: "模型、权限、Profile 与运行记录", tone: "amber", icon: Bot },
  { id: "intelligence", label: "市场情报", description: "新闻、Smart Money 与证据时效", tone: "cyan", icon: Newspaper },
  { id: "data", label: "本地数据", description: "历史同步、缓存、数据库与隐私", tone: "slate", icon: Database },
  { id: "troubleshoot", label: "故障排查", description: "网络异常、错误定位与恢复顺序", tone: "red", icon: Wrench }
];

const HELP_CATEGORIES_EN: HelpCategory[] = [
  { id: "start", label: "Quick start", description: "Accounts, network, models, and initial setup", tone: "violet", icon: BookOpen },
  { id: "market", label: "Markets & charts", description: "Live markets, candles, order book, and alerts", tone: "blue", icon: ChartCandlestick },
  { id: "trade", label: "Trading & accounts", description: "Quantity, leverage, orders, and live-trading safety", tone: "green", icon: WalletCards },
  { id: "shortcuts", label: "Keyboard shortcuts", description: "Order mode, order type, and input focus", tone: "violet", icon: Keyboard },
  { id: "ai", label: "AI & automation", description: "Models, permissions, Profiles, and run records", tone: "amber", icon: Bot },
  { id: "intelligence", label: "Market intelligence", description: "News, Smart Money, and evidence freshness", tone: "cyan", icon: Newspaper },
  { id: "data", label: "Local data", description: "History sync, cache, database, and privacy", tone: "slate", icon: Database },
  { id: "troubleshoot", label: "Troubleshooting", description: "Network issues, error diagnosis, and recovery", tone: "red", icon: Wrench }
];

const HELP_QUESTIONS_ZH: HelpQuestion[] = [
  {
    id: "setup-sequence",
    category: "start",
    title: "第一次使用，应该按什么顺序配置？",
    paragraphs: ["先建立可验证的连接，再启用自动化。建议先在模拟盘完成一轮行情、下单和 AI 分析验证，确认账号环境与权限无误后再考虑实盘。"],
    steps: ["添加 OKX API 账号，并执行连接测试。", "所在网络无法直连 OKX 时配置代理。", "添加 AI 模型并验证连接。", "创建 Agent Profile，选择账号、模型、权限模式与关注标的。", "回到交易页，在模拟盘检查行情、委托和历史记录。"],
    keywords: ["新手", "首次", "入门", "配置顺序"],
    action: { label: "打开账号配置", target: { kind: "settings", tab: "account" } }
  },
  {
    id: "okx-api-permissions",
    category: "start",
    title: "OKX API 需要哪些权限？",
    paragraphs: ["行情浏览不需要账号。查看余额、持仓和历史需要“读取”权限；从终端提交委托还需要“交易”权限。不要授予“提现”权限，应用也不会使用该权限。", "账号的实盘或模拟盘环境由 API Key 自动识别，不需要手工选择。"],
    keywords: ["API Key", "Secret", "Passphrase", "权限", "提现", "只读"],
    action: { label: "管理 OKX 账号", target: { kind: "settings", tab: "account" } }
  },
  {
    id: "proxy-needed",
    category: "start",
    title: "什么情况下需要配置代理？",
    paragraphs: ["当启动检查提示连接拒绝、代理隧道失败、DNS、TLS 或 OKX REST / WebSocket 不可达时，再检查代理。代理配置会同时影响 OKX REST、WebSocket 和 AI 请求。", "修改代理后应用会重建连接并重新同步 OKX 服务器时间。"],
    keywords: ["网络", "连接拒绝", "HTTP", "SOCKS5", "代理", "WebSocket"],
    action: { label: "打开代理配置", target: { kind: "settings", tab: "proxy" } }
  },
  {
    id: "demo-vs-live",
    category: "start",
    title: "模拟盘和实盘有什么区别？",
    paragraphs: ["模拟盘使用 OKX 模拟环境，不会动用真实资金；实盘连接真实账户并承担真实盈亏。切换到实盘时应用会要求风险确认，每次实盘下单仍会再次确认。", "环境以当前 API Key 的检测结果为准。界面顶部会持续显示“模拟盘”或“实盘”，下单前应再次核对。"],
    keywords: ["demo", "live", "模拟盘", "实盘", "风险"],
    action: { label: "检查当前账号", target: { kind: "settings", tab: "account" } }
  },
  {
    id: "required-skills",
    category: "start",
    title: "为什么有些 Skills 不能关闭？",
    paragraphs: ["核心操作规范、交易理念、新闻情报和 Smart Money 分析属于终端的基础能力。它们负责统一证据、风险、权限和工具调用口径，因此保持启用。", "可以编辑允许定制的 Skill 内容或发布新版本，但不要移除安全约束。"],
    keywords: ["Skill", "技能", "trading philosophy", "不可关闭"],
    action: { label: "查看 Skills", target: { kind: "settings", tab: "skills" } }
  },
  {
    id: "market-not-updating",
    category: "market",
    title: "价格、盘口或成交不再更新怎么办？",
    paragraphs: ["先看顶部连接状态。公共行情、业务频道或服务器时间任一异常，都可能让部分数据降级。不要仅凭页面仍有旧价格判断连接正常。"],
    steps: ["打开通知中心，查看 REST、WebSocket 或时间同步的具体错误。", "确认系统时间和代理设置没有变化。", "切换一次交易对，观察连接是否恢复。", "仍未恢复时重启应用，让行情订阅和代理连接完整重建。"],
    keywords: ["行情", "盘口", "成交", "卡住", "延迟", "WebSocket"],
    action: { label: "查看通知中心", target: { kind: "notifications" } }
  },
  {
    id: "candles-empty",
    category: "market",
    title: "K 线为空、断层或加载很慢怎么办？",
    paragraphs: ["终端优先读取本地 K 线，发现窗口不足或中间缺口时再从 OKX 补齐。首次查看新交易对、向左加载很早历史或网络波动时，补数时间会更长。", "不要反复快速切换周期；先等待当前同步完成，再到存储页检查观察交易对完整性。"],
    keywords: ["K线", "蜡烛图", "断层", "空白", "历史", "同步"],
    action: { label: "检查本地存储", target: { kind: "settings", tab: "storage" } }
  },
  {
    id: "chart-timezone",
    category: "market",
    title: "图表时间使用哪个时区？",
    paragraphs: ["K 线的真实时间戳保持 Unix epoch，界面统一按 Asia/Shanghai（UTC+8）显示。时间轴、十字光标、成交和历史订单应使用同一显示口径。", "如果某处出现 8 小时偏差，请记录页面、交易对和具体时间并作为显示问题反馈，不要手工换算后修改订单参数。"],
    keywords: ["时区", "UTC+8", "Asia/Shanghai", "时间偏差"],
  },
  {
    id: "orderbook-difference",
    category: "market",
    title: "为什么盘口数字和 OKX 页面略有不同？",
    paragraphs: ["盘口是实时快照，两个页面的观察时刻、聚合档位和网络延迟可能不同。终端会固定显示档数并持续合并增量，不应把不同快照直接当成数据冲突。", "若差异持续扩大，记录盘口时间、交易对和连接状态，再检查通知中心是否有陈旧帧重连或频道降级。"],
    keywords: ["盘口", "买卖盘", "深度", "快照", "差异"],
    action: { label: "返回交易终端", target: { kind: "workspace", section: "terminal" } }
  },
  {
    id: "chart-tools",
    category: "market",
    title: "绘图、提醒和图表交易保存在哪里？",
    paragraphs: ["绘图和价格提醒按图表工作区保存在本机。图表上的下单、改单、平仓或保护价操作仍会进入标准交易确认和审计流程，不会绕过账号权限与实盘确认。", "首次打开尚未创建工作区时显示为空是正常状态；完成第一次保存后会建立对应工作区。"],
    keywords: ["绘图", "提醒", "图表交易", "工作区", "保存"],
    action: { label: "打开交易终端", target: { kind: "workspace", section: "terminal" } }
  },
  {
    id: "contract-size",
    category: "trade",
    title: "下单数量为什么使用“张”？",
    paragraphs: ["OKX 永续合约的数量单位是张，不是 BTC、ETH 等币数量。终端按合约面值计算对应币数量、名义价值、保证金和手续费。", "输入值会按该合约的最小数量与步进自动规范化。提交前请同时核对“张数”和估算的币数量或 USDT 名义价值。"],
    keywords: ["张", "币数量", "合约面值", "ctVal", "数量"],
    action: { label: "返回下单面板", target: { kind: "workspace", section: "terminal" } }
  },
  {
    id: "leverage-sync",
    category: "trade",
    title: "修改杠杆后为什么显示同步失败？",
    paragraphs: ["杠杆切换会立即同步到 OKX。失败常见原因包括账号无交易权限、保证金模式不匹配、网络异常或 OKX 对当前持仓有限制。", "失败后界面会恢复为 OKX 当前杠杆或标记未同步。不要在状态不明确时继续按目标杠杆估算风险。"],
    keywords: ["杠杆", "同步失败", "保证金模式", "cross", "isolated"],
    action: { label: "查看通知中心", target: { kind: "notifications" } }
  },
  {
    id: "order-disabled",
    category: "trade",
    title: "为什么下单按钮不可用？",
    paragraphs: ["按钮不可用通常表示缺少可执行条件，而不是页面故障。常见原因是未选择账号、账号无交易权限、合约规则尚未加载、数量低于最小步进、限价为空，或平仓方向没有可平仓位。", "先阅读输入框下方提示；它会指出当前缺少的具体条件。"],
    keywords: ["按钮灰色", "无法下单", "禁用", "最小数量", "权限"],
    action: { label: "管理账号权限", target: { kind: "settings", tab: "account" } }
  },
  {
    id: "order-uncertain",
    category: "trade",
    title: "提交后没有马上看到委托，应该重试吗？",
    paragraphs: ["不要立即重复提交。网络超时只表示本地没有及时收到结果，不等于 OKX 没有接受委托。终端会使用客户端订单 ID、私有 WebSocket 和历史同步继续对账。", "先检查当前委托、历史委托和通知中心。只有在状态明确为失败或订单不存在后，才考虑重新提交。"],
    keywords: ["超时", "重复下单", "订单未知", "委托没显示", "对账"],
    action: { label: "打开本地数据", target: { kind: "workspace", section: "data" } }
  },
  {
    id: "close-position",
    category: "trade",
    title: "平仓、止盈止损和保护价有什么区别？",
    paragraphs: ["平仓会直接减少或结束现有仓位；止盈止损在触发条件满足后提交平仓；图表保护价用于快速设置或调整这些条件。", "所有操作都以当前可平张数和持仓方向为边界。实盘操作会显示明确的交易环境和确认内容。"],
    keywords: ["平仓", "止盈", "止损", "保护价", "algo"],
    action: { label: "返回持仓与下单", target: { kind: "workspace", section: "terminal" } }
  },
  {
    id: "trade-hotkeys",
    category: "shortcuts",
    title: "交易面板快捷键一览",
    paragraphs: [
      "这些快捷键只在交易终端可见、页面获得焦点且没有输入框、菜单、弹窗、AI 面板或交易门禁遮挡时生效。组合键会自动使用当前系统的修饰键名称。",
      "快捷键只切换草稿、填写数量或发起标准下单流程，不会绕过账号权限、交易预检或实盘确认。"
    ],
    shortcuts: [
      { keys: ["Mod", "B"], description: "开仓模式：做多；平仓模式：平空" },
      { keys: ["Mod", "S"], description: "开仓模式：做空；平仓模式：平多" },
      { keys: ["Mod", "O"], description: "切换到开仓" },
      { keys: ["Mod", "C"], description: "切换到平仓" },
      { keys: ["Mod", "L"], description: "选择限价委托" },
      { keys: ["Mod", "M"], description: "选择市价委托" },
      { keys: ["Mod", "T"], description: "选择计划委托" },
      { keys: ["Mod", "P"], description: "聚焦价格输入框" },
      { keys: ["Mod", "Q"], description: "聚焦数量输入框" },
      { keys: ["Mod", "1"], description: "数量设为 25%" },
      { keys: ["Mod", "2"], description: "数量设为 50%" },
      { keys: ["Mod", "3"], description: "数量设为 75%" },
      { keys: ["Mod", "4"], description: "数量设为 100%" },
      { keys: ["Esc"], description: "关闭当前实盘下单确认弹窗" }
    ],
    keywords: ["键盘", "热键", "Alt+B", "Alt+S", "Alt+O", "Alt+C", "Alt+L", "Alt+M", "Alt+T", "Alt+P", "Alt+Q", "Alt+1", "Alt+2", "Alt+3", "Alt+4", "Esc", "Option"],
    action: { label: "打开交易终端", target: { kind: "workspace", section: "terminal" } }
  },
  {
    id: "assistant-vs-automation",
    category: "ai",
    title: "AI 交易助手和 AI 自动化有什么区别？",
    paragraphs: ["AI 交易助手用于当前会话中的交互分析，你决定何时提问、批准工具或采纳结果。AI 自动化按 Agent Profile 运行，可定时分析、生成交易机会、复盘或在授权范围内执行流程。", "两者都受模型配置、Skill、工具权限和交易风控约束；自动化不会绕过实盘安全链路。"],
    keywords: ["AI助手", "自动化", "Agent", "Profile", "区别"],
    action: { label: "打开 AI 自动化", target: { kind: "workspace", section: "automation", automationTab: "profiles" } }
  },
  {
    id: "model-insufficient-balance",
    category: "ai",
    title: "“模型服务余额不足”指的是哪个余额？",
    paragraphs: ["它指 AI Provider 账户的调用额度或计费余额，不是 OKX 交易账户余额。终端会将这类错误标为“模型服务错误”，不会把它解释为交易风控结论。", "请到模型服务商后台充值或更换可用模型连接，然后在 AI 配置中重新测试。"],
    keywords: ["Insufficient Balance", "余额不足", "模型错误", "DeepSeek", "Provider"],
    action: { label: "检查 AI 模型", target: { kind: "settings", tab: "ai" } }
  },
  {
    id: "ai-stuck",
    category: "ai",
    title: "AI 一直显示处理中，或者没有最终回答怎么办？",
    paragraphs: ["先展开处理过程，确认是模型仍在生成、工具等待审批，还是已经出现模型或网络错误。运行完成事件是状态更新主路径，低频状态查询只负责兜底。", "可以先停止当前生成，再检查通知中心与 AI 配置。不要连续发送相同请求，以免产生多个并行会话。"],
    keywords: ["处理中", "卡住", "不结束", "没有回答", "轮询"],
    action: { label: "查看 AI 配置", target: { kind: "settings", tab: "ai" } }
  },
  {
    id: "ai-permission-modes",
    category: "ai",
    title: "顾问、副驾驶和自动模式如何选择？",
    paragraphs: ["顾问模式适合只读分析；副驾驶允许准备操作，但关键工具需要用户批准；更高自动化模式只应分配给经过验证的 Profile，并保持严格的交易限制。", "权限模式决定工具可用范围，不代表模型结论一定正确。交易前仍应核对证据时效、账户状态和预检结果。"],
    keywords: ["advisor", "copilot", "autopilot", "顾问", "副驾驶", "权限"],
    action: { label: "管理 Agent Profile", target: { kind: "workspace", section: "automation", automationTab: "profiles" } }
  },
  {
    id: "run-records",
    category: "ai",
    title: "运行记录如何更新，详情为什么可能稍晚出现？",
    paragraphs: ["Run 完成事件会主动刷新列表和当前详情；轻量状态查询只在低频情况下兜底。完成正文、工具轨迹和数据库状态可能在极短时间内依次落库，界面会继续合并最新详情。", "若记录长期停留在运行中，先查看通知中心是否有 Sidecar 或数据库错误，再重新打开运行记录。"],
    keywords: ["运行记录", "实时更新", "详情", "轮询", "Sidecar"],
    action: { label: "打开运行记录", target: { kind: "workspace", section: "automation", automationTab: "runs" } }
  },
  {
    id: "profile-skills",
    category: "ai",
    title: "Profile、Prompt 和 Skills 分别控制什么？",
    paragraphs: ["Profile 固定运行时的账号、模型、模式、成员和关注标的；Prompt 定义全局行为；Skills 提供领域规则与工具说明。Run 入队后会冻结具体快照，之后修改配置不会改变已经开始的 Run。", "选择“最新版”的 Skill 会在下一次 Run 入队时解析最新发布版；手工选择 vN 则保持固定版本。"],
    keywords: ["Profile", "Prompt", "Skills", "版本", "快照"],
    action: { label: "查看 Skills", target: { kind: "settings", tab: "skills" } }
  },
  {
    id: "intelligence-local-cache",
    category: "intelligence",
    title: "市场情报为什么优先显示本地数据？",
    paragraphs: ["新闻和 Smart Money 等情报先写入本地数据库，界面和专家 Agent 都从本地读取，避免每次查看或多专家并发时同步等待上游 HTTP。", "数据缺失或过期时会立即返回当前状态，并在后台去重刷新。请同时看数据时间、过期标记和刷新状态。"],
    keywords: ["本地缓存", "刷新", "过期", "stale", "后台"],
    action: { label: "打开市场情报", target: { kind: "workspace", section: "intelligence" } }
  },
  {
    id: "intelligence-frequency",
    category: "intelligence",
    title: "新闻、衍生品和 Smart Money 多久更新一次？",
    paragraphs: ["活跃标的衍生品和新闻通常按约 60 秒刷新，Smart Money 当前概览通常按 5 分钟刷新；OI、资金费率、爆仓和 ADL 的实时部分由 WebSocket 持续更新。", "实际频率还会受标的优先级、上游限制和系统压力影响。界面中的数据时间比“刚刷新”提示更重要。"],
    keywords: ["频率", "60秒", "5分钟", "新闻", "Smart Money", "OI"],
    action: { label: "查看情报状态", target: { kind: "workspace", section: "intelligence" } }
  },
  {
    id: "intelligence-conflict",
    category: "intelligence",
    title: "市场结构与资金情报方向冲突时怎么办？",
    paragraphs: ["冲突通常来自不同时间窗口、样本群体或观测快照，不应直接平均成一个方向。先核对每条证据的时间、标的、口径、覆盖率和限制，再区分“当前状态”和“变化趋势”。", "情报只能作为交易证据。形成交易方案后仍需读取最新决策上下文和账户预检，不能仅凭单个看涨或看跌百分比执行。"],
    keywords: ["冲突", "看涨", "看跌", "证据", "时间窗口", "口径"],
    action: { label: "打开市场情报", target: { kind: "workspace", section: "intelligence" } }
  },
  {
    id: "smart-money-meaning",
    category: "intelligence",
    title: "Smart Money 信号可以直接作为交易指令吗？",
    paragraphs: ["不可以。交易员样本、账户多空比、头部持仓比和净名义价值各自代表不同口径，也可能出现内部背离。", "正确用法是把它作为带时间与来源的证据，与价格结构、流动性、账户风险和可执行预检一起评估。"],
    keywords: ["聪明钱", "Smart Money", "多空比", "交易指令"],
    action: { label: "查看 Smart Money", target: { kind: "workspace", section: "intelligence" } }
  },
  {
    id: "intelligence-empty-history",
    category: "intelligence",
    title: "趋势历史为空，是否表示没有发生过？",
    paragraphs: ["不一定。空结果可能表示采集尚未覆盖该时间段、筛选条件不匹配、账号不可用或上游暂时没有返回。它只能说明当前本地查询窗口没有可用记录。", "查看覆盖率、限制说明和采集状态；不要把本地空窗口解释成市场或账户从未发生相关事件。"],
    keywords: ["历史为空", "趋势", "覆盖率", "无数据"],
    action: { label: "检查情报采集", target: { kind: "workspace", section: "intelligence" } }
  },
  {
    id: "local-data-scope",
    category: "data",
    title: "哪些数据会保存在本机？",
    paragraphs: ["终端会保存 K 线、账号私有历史、AI 会话与运行记录、市场情报、交易审计、绘图和提醒等工作数据。高频实时状态会按用途保留快照或聚合，不会无限增长。", "本地数据用于恢复、对账、分析和减少网络等待，不替代 OKX 的最终订单与账户记录。"],
    keywords: ["SQLite", "本地", "数据库", "缓存", "保存"],
    action: { label: "查看数据工作台", target: { kind: "workspace", section: "data" } }
  },
  {
    id: "private-history-sync",
    category: "data",
    title: "历史订单或成交不完整怎么办？",
    paragraphs: ["私有 WebSocket 负责实时事件，历史同步负责首次补数和断线补偿。顶部历史按钮可手动同步，右键可执行更深的历史补数。", "同步为空不等于远端账户从未交易。先确认当前账号、实盘或模拟盘环境、读取权限和时间窗口。"],
    keywords: ["历史订单", "成交", "同步", "补数", "空记录"],
    action: { label: "打开本地数据", target: { kind: "workspace", section: "data" } }
  },
  {
    id: "storage-maintenance",
    category: "data",
    title: "什么时候需要运行本地存储维护？",
    paragraphs: ["当缓存明显膨胀、旧同步日志过多或需要检查观察交易对 K 线覆盖时，可以运行维护。维护会按既定保留策略清理过期数据，并显示各表行数和 K 线范围。", "维护不应删除当前配置、有效交易审计或仍在保留期内的关键记录。"],
    keywords: ["清理", "维护", "磁盘", "K线完整性", "retention"],
    action: { label: "打开存储维护", target: { kind: "settings", tab: "storage" } }
  },
  {
    id: "credential-storage",
    category: "data",
    title: "API Key 和密码如何保存？",
    paragraphs: ["OKX、代理、AI 和通知凭据保存在本机的敏感配置中，写入时采用原子替换并限制当前系统用户访问。界面摘要、日志和诊断信息只显示脱敏值。", "不要在截图、问题反馈、聊天消息或日志中粘贴完整 API Key、Secret、Passphrase、Token 或私钥。"],
    keywords: ["安全", "密钥", "API Key", "密码", "隐私", "脱敏"],
    action: { label: "管理账号凭据", target: { kind: "settings", tab: "account" } }
  },
  {
    id: "diagnose-errors",
    category: "troubleshoot",
    title: "遇到错误时，第一步应该看哪里？",
    paragraphs: ["先打开通知中心。它会集中显示前端异常、Tauri 命令失败、OKX REST / WebSocket、AI Sidecar、K 线同步和自动化 Run 错误。", "记录错误发生时间、页面、交易对、账号环境和完整错误文案。不要只描述“不能用”，也不要发送任何完整凭据。"],
    keywords: ["报错", "通知中心", "诊断", "日志", "错误信息"],
    action: { label: "打开通知中心", target: { kind: "notifications" } }
  },
  {
    id: "network-troubleshoot",
    category: "troubleshoot",
    title: "REST 正常但 WebSocket 异常，怎么排查？",
    paragraphs: ["REST 和 WebSocket 连接方式不同，代理可能只允许普通 HTTP 请求，却不能建立 WebSocket 隧道。也可能是 Business WS、Private WS 或服务器时间单独异常。"],
    steps: ["在顶部连接状态确认具体异常频道。", "打开通知中心查看代理隧道、认证、TLS 或超时信息。", "测试代理配置，确认 REST 与 WebSocket 使用同一策略。", "保存代理后等待连接重建；仍失败再重启应用。"],
    keywords: ["REST", "WSS", "WebSocket", "代理隧道", "连接"],
    action: { label: "检查代理配置", target: { kind: "settings", tab: "proxy" } }
  },
  {
    id: "ai-provider-errors",
    category: "troubleshoot",
    title: "AI 返回 401、429、超时或模型错误怎么办？",
    paragraphs: ["401 通常与 API Key 或 Provider 配置有关；429 表示频率或额度限制；超时和连接错误需要检查代理与服务状态；模型错误应查看错误卡中的具体原因。", "先在 AI 配置中测试当前模型。不要通过降低交易工具权限或移除安全规则来解决模型连接问题。"],
    keywords: ["401", "429", "超时", "模型错误", "Provider", "API Key"],
    action: { label: "测试 AI 模型", target: { kind: "settings", tab: "ai" } }
  },
  {
    id: "ui-slow",
    category: "troubleshoot",
    title: "界面突然变慢或短暂卡顿怎么办？",
    paragraphs: ["先判断是否发生在大量历史加载、图表补数、存储维护或多个自动化 Run 同时更新时。实时盘口与成交采用微批绘制，普通状态查询是异步执行，不应持续阻塞界面。", "关闭不需要的浮动窗口，等待当前任务结束并查看通知中心。若持续复现，请记录页面、持续时间、当时运行的任务和窗口尺寸。"],
    keywords: ["卡顿", "性能", "轮询", "异步", "慢"],
    action: { label: "查看通知中心", target: { kind: "notifications" } }
  },
  {
    id: "safe-recovery",
    category: "troubleshoot",
    title: "可以按什么顺序安全恢复应用？",
    paragraphs: ["恢复前先确认没有状态不明的实盘委托。网络超时期间不要重复下单或反复修改同一订单。"],
    steps: ["查看当前委托、历史委托和通知中心，确认是否有未知订单。", "停止仍在运行的 AI 会话或自动化任务。", "保存必要的配置修改。", "关闭并重新打开应用，让 Sidecar、REST 和 WebSocket 完整重建。", "恢复后先在只读页面核对账号环境、持仓、委托和行情时间。"],
    keywords: ["重启", "恢复", "安全", "未知订单"],
    action: { label: "返回交易终端", target: { kind: "workspace", section: "terminal" } }
  }
];

type HelpQuestionEnglish = Pick<HelpQuestion, "title" | "paragraphs"> & {
  steps?: string[];
  shortcuts?: HelpQuestion["shortcuts"];
  keywords?: string[];
  actionLabel?: string;
};

const HELP_QUESTIONS_EN_BY_ID: Record<string, HelpQuestionEnglish> = {
  "setup-sequence": {
    title: "What should I configure first?",
    paragraphs: ["Establish verifiable connections before enabling automation. Complete one market-data, order, and AI-analysis pass in demo trading, then consider live trading only after the account environment and permissions are correct."],
    steps: ["Add an OKX API account and test the connection.", "Configure a proxy if your network cannot reach OKX directly.", "Add an AI model and validate its connection.", "Create an Agent Profile and select its account, model, permission mode, and watched markets.", "Return to Trading and verify market data, orders, and history in demo trading."],
    keywords: ["beginner", "first use", "setup order"], actionLabel: "Open account settings"
  },
  "okx-api-permissions": {
    title: "Which OKX API permissions are required?",
    paragraphs: ["Viewing public markets needs no account. Balances, positions, and history require Read permission; submitting orders also requires Trade permission. Never grant Withdraw permission. The app does not use it.", "The API Key determines whether the account is live or demo; you do not select the environment manually."],
    keywords: ["API Key", "Secret", "Passphrase", "permissions", "withdraw", "read only"], actionLabel: "Manage OKX accounts"
  },
  "proxy-needed": {
    title: "When do I need a proxy?",
    paragraphs: ["Check the proxy when startup reports connection refused, proxy-tunnel failure, DNS or TLS errors, or unreachable OKX REST/WebSocket services. The proxy applies to OKX REST, WebSocket, and AI requests.", "After a proxy change, the app rebuilds connections and synchronizes OKX server time again."],
    keywords: ["network", "connection refused", "HTTP", "SOCKS5", "proxy", "WebSocket"], actionLabel: "Open proxy settings"
  },
  "demo-vs-live": {
    title: "What is the difference between demo and live trading?",
    paragraphs: ["Demo trading uses the OKX simulated environment and no real funds. Live trading connects to a real account and creates real profit or loss. The app requires a risk acknowledgement when switching to live, and every live order still requires confirmation.", "The detected API Key environment is authoritative. The header continuously shows Demo or Live; verify it again before submitting an order."],
    keywords: ["demo", "live", "risk"], actionLabel: "Check the current account"
  },
  "required-skills": {
    title: "Why can some Skills not be disabled?",
    paragraphs: ["Core operating rules, trading philosophy, news intelligence, and Smart Money analysis are foundational terminal capabilities. They standardize evidence, risk, permissions, and tool use, so they remain enabled.", "You can edit customizable Skill content or publish a new version, but do not remove safety constraints."],
    keywords: ["Skill", "trading philosophy", "required"], actionLabel: "View Skills"
  },
  "market-not-updating": {
    title: "What should I do when prices, the order book, or trades stop updating?",
    paragraphs: ["Check the connection status in the header first. A fault in public markets, business channels, or server time can degrade part of the data. An old price still visible on screen does not prove the connection is healthy."],
    steps: ["Open Notification center and inspect the REST, WebSocket, or time-sync error.", "Confirm that system time and proxy settings have not changed.", "Switch markets once and see whether the connection recovers.", "If it does not recover, restart the app to rebuild market subscriptions and proxy connections."],
    keywords: ["market", "order book", "trades", "stuck", "latency", "WebSocket"], actionLabel: "Open Notification center"
  },
  "candles-empty": {
    title: "What if candles are empty, have gaps, or load slowly?",
    paragraphs: ["The terminal reads local candles first and backfills from OKX when the window is short or has gaps. A new market, very old history, or unstable networking can make backfill take longer.", "Do not switch timeframes repeatedly. Wait for the current sync, then check watched-market integrity in Storage."],
    keywords: ["candles", "chart", "gap", "empty", "history", "sync"], actionLabel: "Check local storage"
  },
  "chart-timezone": {
    title: "Which time zone do charts use?",
    paragraphs: ["Candle timestamps remain Unix epoch values, while the interface consistently displays Asia/Shanghai (UTC+8). The time axis, crosshair, fills, and order history should use the same display convention.", "If you see an eight-hour offset, record the page, market, and exact time as a display issue. Do not manually convert time and then alter order parameters."],
    keywords: ["time zone", "UTC+8", "Asia/Shanghai", "time offset"]
  },
  "orderbook-difference": {
    title: "Why is the order book slightly different from the OKX page?",
    paragraphs: ["An order book is a live snapshot. Observation time, aggregation level, and network latency can differ between pages. The terminal displays a fixed depth and continuously merges updates, so different snapshots are not automatically a data conflict.", "If the difference keeps growing, record the snapshot time, market, and connection state, then check Notification center for stale-frame reconnects or channel degradation."],
    keywords: ["order book", "depth", "snapshot", "difference"], actionLabel: "Return to Trading"
  },
  "chart-tools": {
    title: "Where are drawings, alerts, and chart trades saved?",
    paragraphs: ["Drawings and price alerts are stored locally by chart workspace. Orders, amendments, closes, and protection changes from the chart still use the standard confirmation and audit flow; they do not bypass account permissions or live confirmation.", "An empty first launch is normal before a workspace exists. The first save creates it."],
    keywords: ["drawing", "alert", "chart trading", "workspace", "save"], actionLabel: "Open Trading"
  },
  "contract-size": {
    title: "Why is order quantity measured in contracts?",
    paragraphs: ["OKX perpetual quantities are contracts, not BTC, ETH, or another coin amount. The terminal uses contract value to calculate base quantity, notional value, margin, and fees.", "Input is normalized to the instrument's minimum quantity and step. Before submitting, verify both contract quantity and the estimated base or USDT notional value."],
    keywords: ["contracts", "base quantity", "contract value", "ctVal", "quantity"], actionLabel: "Return to the order ticket"
  },
  "leverage-sync": {
    title: "Why did leverage synchronization fail?",
    paragraphs: ["A leverage change is synchronized to OKX immediately. Common failures include missing Trade permission, an incompatible margin mode, a network error, or an OKX restriction on the current position.", "After failure, the interface restores the current OKX leverage or marks it unsynchronized. Do not estimate risk using the intended leverage while the state is unclear."],
    keywords: ["leverage", "sync failed", "margin mode", "cross", "isolated"], actionLabel: "Open Notification center"
  },
  "order-disabled": {
    title: "Why is the order button disabled?",
    paragraphs: ["A disabled button usually means an execution requirement is missing, not that the page is broken. Typical causes are no selected account, missing Trade permission, unloaded instrument rules, quantity below the minimum step, no limit price, or no closable position on that side.", "Read the hint below the input first; it identifies the missing condition."],
    keywords: ["disabled button", "cannot order", "minimum quantity", "permission"], actionLabel: "Manage account permissions"
  },
  "order-uncertain": {
    title: "An order did not appear immediately. Should I retry?",
    paragraphs: ["Do not submit it again immediately. A network timeout means the local app did not receive a timely result; it does not prove that OKX rejected the order. The terminal continues reconciliation using the client order ID, private WebSocket, and history sync.", "Check open orders, order history, and Notification center. Retry only after the state is explicitly failed or the order is confirmed absent."],
    keywords: ["timeout", "duplicate order", "unknown order", "reconciliation"], actionLabel: "Open local data"
  },
  "close-position": {
    title: "How do close, take-profit/stop-loss, and protection prices differ?",
    paragraphs: ["Close directly reduces or ends a position. Take-profit and stop-loss submit a close after their trigger condition is met. Chart protection prices provide a fast way to set or adjust those conditions.", "Every action is bounded by current closable contracts and position side. Live actions show the environment and explicit confirmation details."],
    keywords: ["close", "take profit", "stop loss", "protection", "algo"], actionLabel: "Return to positions and orders"
  },
  "trade-hotkeys": {
    title: "Trading panel keyboard shortcuts",
    paragraphs: ["These shortcuts work only while Trading is visible, the page has focus, and no input, menu, dialog, AI panel, or trading gate is active. The modifier automatically matches the current operating system.", "Shortcuts only change the draft, enter quantity, or start the standard order flow. They never bypass account permissions, pre-trade checks, or live confirmation."],
    shortcuts: [
      { keys: ["Mod", "B"], description: "Open mode: long; close mode: close short" },
      { keys: ["Mod", "S"], description: "Open mode: short; close mode: close long" },
      { keys: ["Mod", "O"], description: "Switch to open mode" },
      { keys: ["Mod", "C"], description: "Switch to close mode" },
      { keys: ["Mod", "L"], description: "Select limit order" },
      { keys: ["Mod", "M"], description: "Select market order" },
      { keys: ["Mod", "T"], description: "Select trigger order" },
      { keys: ["Mod", "P"], description: "Focus the price input" },
      { keys: ["Mod", "Q"], description: "Focus the quantity input" },
      { keys: ["Mod", "1"], description: "Set quantity to 25%" },
      { keys: ["Mod", "2"], description: "Set quantity to 50%" },
      { keys: ["Mod", "3"], description: "Set quantity to 75%" },
      { keys: ["Mod", "4"], description: "Set quantity to 100%" },
      { keys: ["Esc"], description: "Close the current live-order confirmation" }
    ],
    keywords: ["keyboard", "hotkey", "Alt", "Option", "Esc"], actionLabel: "Open Trading"
  },
  "assistant-vs-automation": {
    title: "How do the AI trading assistant and AI Automation differ?",
    paragraphs: ["The AI trading assistant provides interactive analysis in the current session; you choose when to ask, approve tools, or use the result. AI Automation runs Agent Profiles to analyze on a schedule, create opportunities, review activity, or execute authorized workflows.", "Both follow model configuration, Skills, tool permissions, and trading risk controls. Automation does not bypass the live-trading safety chain."],
    keywords: ["AI assistant", "automation", "Agent", "Profile", "difference"], actionLabel: "Open AI Automation"
  },
  "model-insufficient-balance": {
    title: "Which balance is meant by 'model service balance insufficient'?",
    paragraphs: ["It means the AI Provider's usage quota or billing balance, not the OKX trading-account balance. The terminal classifies it as a model-service error and never treats it as a trading-risk conclusion.", "Add credit in the provider console or switch to a working model connection, then test it again in AI settings."],
    keywords: ["Insufficient Balance", "model error", "DeepSeek", "Provider"], actionLabel: "Check AI models"
  },
  "ai-stuck": {
    title: "What if AI remains in progress or never returns a final answer?",
    paragraphs: ["Expand the process first and determine whether the model is still generating, a tool awaits approval, or a model/network error occurred. Completion events are the primary status path; low-frequency polling is only a fallback.", "Stop the current generation, then check Notification center and AI settings. Do not send the same request repeatedly, because that can create parallel sessions."],
    keywords: ["processing", "stuck", "no answer", "polling"], actionLabel: "Open AI settings"
  },
  "ai-permission-modes": {
    title: "How should I choose Advisor, Copilot, or automated mode?",
    paragraphs: ["Advisor is for read-only analysis. Copilot may prepare actions, but critical tools require approval. Higher automation should only be assigned to validated Profiles with strict trading limits.", "Permission mode determines tool availability; it does not guarantee that model conclusions are correct. Verify evidence freshness, account state, and precheck results before trading."],
    keywords: ["advisor", "copilot", "autopilot", "permissions"], actionLabel: "Manage Agent Profiles"
  },
  "run-records": {
    title: "How do run records update, and why can details arrive slightly later?",
    paragraphs: ["A Run completion event refreshes the list and selected details. Lightweight polling is only a low-frequency fallback. Final text, tool traces, and database status can be committed milliseconds apart, so the interface keeps merging newer details.", "If a record remains Running for a long time, check Notification center for Sidecar or database errors, then reopen Runs."],
    keywords: ["run records", "live update", "details", "polling", "Sidecar"], actionLabel: "Open Runs"
  },
  "profile-skills": {
    title: "What do Profile, Prompt, and Skills control?",
    paragraphs: ["A Profile fixes the runtime account, model, mode, members, and watched markets. Prompt defines global behavior. Skills provide domain rules and tool guidance. Queuing a Run freezes a concrete snapshot; later configuration changes do not alter that Run.", "Selecting Latest resolves the newest published Skill when the next Run is queued. Selecting vN pins that version."],
    keywords: ["Profile", "Prompt", "Skills", "version", "snapshot"], actionLabel: "View Skills"
  },
  "intelligence-local-cache": {
    title: "Why does Market Intelligence prefer local data?",
    paragraphs: ["News, Smart Money, and other intelligence are written to the local database first. The interface and specialist Agents read locally, avoiding an upstream HTTP wait for every view or parallel Agent.", "Missing or stale data returns its current state immediately and queues a deduplicated refresh. Check the data timestamp, stale flag, and refresh status together."],
    keywords: ["local cache", "refresh", "stale", "background"], actionLabel: "Open Market Intelligence"
  },
  "intelligence-frequency": {
    title: "How often do news, derivatives, and Smart Money update?",
    paragraphs: ["Active-market derivatives and news typically refresh about every 60 seconds, while the current Smart Money overview usually refreshes every five minutes. Live OI, funding, liquidation, and ADL updates continue over WebSocket.", "Actual frequency also depends on market priority, upstream limits, and system load. The displayed data timestamp matters more than a recent-refresh label."],
    keywords: ["frequency", "60 seconds", "5 minutes", "news", "Smart Money", "OI"], actionLabel: "View intelligence status"
  },
  "intelligence-conflict": {
    title: "What if market structure and capital-flow intelligence conflict?",
    paragraphs: ["Conflicts often come from different time windows, sample populations, or snapshots. Do not average them into one direction. Verify each item's time, market, definition, coverage, and limits, then distinguish current state from trend.", "Intelligence is trading evidence, not an instruction. A trade plan still needs the latest decision context and account precheck; never execute from one bullish or bearish percentage."],
    keywords: ["conflict", "bullish", "bearish", "evidence", "time window"], actionLabel: "Open Market Intelligence"
  },
  "smart-money-meaning": {
    title: "Can a Smart Money signal be used directly as a trade instruction?",
    paragraphs: ["No. Trader samples, account long/short ratio, top-position ratio, and net notional use different definitions and can diverge internally.", "Use Smart Money as timestamped, sourced evidence and evaluate it together with price structure, liquidity, account risk, and executable prechecks."],
    keywords: ["Smart Money", "long short ratio", "trade instruction"], actionLabel: "View Smart Money"
  },
  "intelligence-empty-history": {
    title: "Does empty trend history mean nothing happened?",
    paragraphs: ["Not necessarily. An empty result can mean collection did not cover the period, filters do not match, the account is unavailable, or upstream returned nothing. It only means the current local query window has no usable record.", "Check coverage, limitations, and collection status. Do not interpret an empty local window as proof that the event never occurred in the market or account."],
    keywords: ["empty history", "trend", "coverage", "no data"], actionLabel: "Check intelligence collection"
  },
  "local-data-scope": {
    title: "Which data is stored locally?",
    paragraphs: ["The terminal stores working data such as candles, private account history, AI sessions and runs, market intelligence, trade audits, drawings, and alerts. High-frequency live state is retained as snapshots or aggregates according to purpose and does not grow without limit.", "Local data supports recovery, reconciliation, analysis, and lower network latency. It does not replace OKX as the final source for orders and account records."],
    keywords: ["SQLite", "local", "database", "cache", "storage"], actionLabel: "Open the data dashboard"
  },
  "private-history-sync": {
    title: "What if order or fill history is incomplete?",
    paragraphs: ["Private WebSocket handles live events; history sync provides initial backfill and disconnect recovery. The history button in the header performs a manual sync, and its context menu can request a deeper backfill.", "An empty sync does not prove that the remote account never traded. Verify the selected account, live/demo environment, Read permission, and time window."],
    keywords: ["order history", "fills", "sync", "backfill", "empty"], actionLabel: "Open local data"
  },
  "storage-maintenance": {
    title: "When should I run local storage maintenance?",
    paragraphs: ["Run maintenance when cache size clearly grows, old sync logs accumulate, or you need to inspect candle coverage for watched markets. Maintenance applies the configured retention policy and reports table rows and candle ranges.", "Maintenance should not delete current configuration, valid trade audits, or key records still inside their retention period."],
    keywords: ["cleanup", "maintenance", "disk", "candle integrity", "retention"], actionLabel: "Open storage maintenance"
  },
  "credential-storage": {
    title: "How are API Keys and passwords stored?",
    paragraphs: ["OKX, proxy, AI, and notification credentials are stored in local sensitive configuration with atomic replacement and access limited to the current system user. UI summaries, logs, and diagnostics show masked values only.", "Never paste a complete API Key, Secret, Passphrase, Token, or private key into screenshots, issue reports, chat messages, or logs."],
    keywords: ["security", "key", "API Key", "password", "privacy", "masking"], actionLabel: "Manage account credentials"
  },
  "diagnose-errors": {
    title: "Where should I look first when an error occurs?",
    paragraphs: ["Open Notification center first. It collects frontend errors, failed Tauri commands, OKX REST/WebSocket issues, AI Sidecar failures, candle-sync problems, and automation Run errors.", "Record the time, page, market, account environment, and complete error text. Do not report only that it does not work, and never send complete credentials."],
    keywords: ["error", "Notification center", "diagnostics", "logs"], actionLabel: "Open Notification center"
  },
  "network-troubleshoot": {
    title: "REST works but WebSocket fails. How do I troubleshoot it?",
    paragraphs: ["REST and WebSocket connect differently. A proxy may allow ordinary HTTP but fail to establish a WebSocket tunnel. Business WS, Private WS, or server-time synchronization can also fail independently."],
    steps: ["Use the header connection state to identify the affected channel.", "Open Notification center and inspect proxy-tunnel, authentication, TLS, or timeout details.", "Test proxy settings and confirm REST and WebSocket use the same strategy.", "Save the proxy and wait for reconnection. Restart the app if it still fails."],
    keywords: ["REST", "WSS", "WebSocket", "proxy tunnel", "connection"], actionLabel: "Check proxy settings"
  },
  "ai-provider-errors": {
    title: "What should I do about AI 401, 429, timeout, or model errors?",
    paragraphs: ["401 usually indicates an API Key or Provider configuration issue. 429 indicates a rate or quota limit. Timeouts and connection errors require checking the proxy and service status. For model errors, read the exact reason on the error card.", "Test the current model in AI settings first. Do not weaken trading-tool permissions or remove safety rules to solve a model connection problem."],
    keywords: ["401", "429", "timeout", "model error", "Provider", "API Key"], actionLabel: "Test the AI model"
  },
  "ui-slow": {
    title: "What if the interface suddenly slows down or briefly freezes?",
    paragraphs: ["Check whether it coincides with large history loads, candle backfill, storage maintenance, or several automation Runs updating together. Live order book and trades are rendered in micro-batches, and ordinary state queries are asynchronous, so they should not block the interface continuously.", "Close unneeded floating windows, wait for the current task, and check Notification center. If it repeats, record the page, duration, active tasks, and window size."],
    keywords: ["slow", "freeze", "performance", "polling", "async"], actionLabel: "Open Notification center"
  },
  "safe-recovery": {
    title: "What is the safe recovery sequence for the app?",
    paragraphs: ["Before recovery, confirm that no live order has an unknown state. Do not resubmit or repeatedly amend an order during a network timeout."],
    steps: ["Check open orders, order history, and Notification center for unknown orders.", "Stop any running AI session or automation task.", "Save necessary configuration changes.", "Close and reopen the app so Sidecar, REST, and WebSocket rebuild completely.", "After recovery, verify account environment, positions, orders, and market timestamps in read-only views first."],
    keywords: ["restart", "recovery", "safety", "unknown order"], actionLabel: "Return to Trading"
  }
};

const HELP_QUESTIONS_EN: HelpQuestion[] = HELP_QUESTIONS_ZH.map((question) => {
  const translated = HELP_QUESTIONS_EN_BY_ID[question.id];
  const { actionLabel, ...content } = translated;
  return {
    ...question,
    ...content,
    action: question.action ? { ...question.action, label: actionLabel ?? question.action.label } : undefined
  };
});

const QUICK_ACTIONS_ZH = [
  { label: "账号与权限", icon: ShieldCheck, target: { kind: "settings", tab: "account" } as HelpTarget },
  { label: "网络与代理", icon: Settings, target: { kind: "settings", tab: "proxy" } as HelpTarget },
  { label: "AI 模型", icon: Bot, target: { kind: "settings", tab: "ai" } as HelpTarget },
  { label: "通知与错误", icon: Bell, target: { kind: "notifications" } as HelpTarget }
];

const QUICK_ACTIONS_EN = [
  { label: "Accounts & permissions", icon: ShieldCheck, target: { kind: "settings", tab: "account" } as HelpTarget },
  { label: "Network & proxy", icon: Settings, target: { kind: "settings", tab: "proxy" } as HelpTarget },
  { label: "AI models", icon: Bot, target: { kind: "settings", tab: "ai" } as HelpTarget },
  { label: "Notifications & errors", icon: Bell, target: { kind: "notifications" } as HelpTarget }
];

const HELP_UI = {
  zh: {
    searchPlaceholder: "搜索问题、错误代码或功能名称", searchAria: "搜索帮助", clearSearch: "清除搜索", quickActionsAria: "常用入口",
    categoriesAria: "帮助分类", categories: "问题分类", answerCount: "{{count}} 个解答", reopenSetup: "重新查看首次配置",
    searchResults: "搜索结果", foundCount: "找到 {{count}} 个相关解答", searching: "正在搜索“{{query}}”", categoryPrompt: "选择问题查看原因、处理顺序和对应入口。",
    shortcutTableAria: "{{platform}} 交易面板快捷键", shortcuts: "快捷键", function: "功能", keyJoin: " 加 ",
    noResults: "没有找到对应解答", noResultsDetail: "换一个更短的关键词，或从左侧选择“故障排查”。", viewTroubleshooting: "查看故障排查",
    protectCredentials: "反馈问题时保护凭据", credentialDetail: "可以提供错误文案、时间、页面、交易对和账号环境，但不要发送完整 API Key、Secret、Passphrase、Token 或私钥。"
  },
  en: {
    searchPlaceholder: "Search questions, error codes, or features", searchAria: "Search help", clearSearch: "Clear search", quickActionsAria: "Common destinations",
    categoriesAria: "Help categories", categories: "Categories", answerCount: "{{count}} answers", reopenSetup: "Review initial setup",
    searchResults: "Search results", foundCount: "{{count}} matching answers", searching: "Searching for '{{query}}'", categoryPrompt: "Select a question to see the cause, recovery sequence, and relevant destination.",
    shortcutTableAria: "{{platform}} trading panel shortcuts", shortcuts: "Shortcut", function: "Function", keyJoin: " plus ",
    noResults: "No matching answer", noResultsDetail: "Try a shorter keyword or select Troubleshooting on the left.", viewTroubleshooting: "View troubleshooting",
    protectCredentials: "Protect credentials when reporting an issue", credentialDetail: "You can provide the error text, time, page, market, and account environment, but never send a complete API Key, Secret, Passphrase, Token, or private key."
  }
} as const;

function searchableQuestionText(question: HelpQuestion, category: HelpCategory) {
  return [
    question.title,
    category.label,
    category.description,
    ...question.paragraphs,
    ...(question.steps ?? []),
    ...(question.shortcuts?.flatMap((shortcut) => [...shortcut.keys, shortcut.description]) ?? []),
    ...(question.keywords ?? [])
  ].join(" ").toLocaleLowerCase("zh-CN");
}

export function HelpCenter({
  searchInputRef,
  canReopenOnboarding,
  onNavigate
}: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  canReopenOnboarding: boolean;
  onNavigate: (target: HelpTarget) => void;
}) {
  const { i18n } = useTranslation("help");
  const chinese = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("zh");
  const categories = chinese ? HELP_CATEGORIES_ZH : HELP_CATEGORIES_EN;
  const questions = chinese ? HELP_QUESTIONS_ZH : HELP_QUESTIONS_EN;
  const quickActions = chinese ? QUICK_ACTIONS_ZH : QUICK_ACTIONS_EN;
  const ui = chinese ? HELP_UI.zh : HELP_UI.en;
  const text = (template: string, values: Record<string, string | number>) => Object.entries(values).reduce((result, [key, value]) => result.replace(`{{${key}}}`, String(value)), template);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<HelpCategoryId>("start");
  const [expandedId, setExpandedId] = useState<string | null>("setup-sequence");
  const shortcutPlatform = useMemo(resolveShortcutPlatform, []);
  const normalizedQuery = query.trim().toLocaleLowerCase(chinese ? "zh-CN" : "en-US");
  const categoryMap = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<HelpCategoryId, number>();
    for (const category of categories) counts.set(category.id, 0);
    for (const question of questions) counts.set(question.category, (counts.get(question.category) ?? 0) + 1);
    return counts;
  }, [categories, questions]);
  const visibleQuestions = useMemo(() => {
    if (!normalizedQuery) return questions.filter((question) => question.category === activeCategory);
    return questions.filter((question) => {
      const category = categoryMap.get(question.category);
      return category ? searchableQuestionText(question, category).includes(normalizedQuery) : false;
    });
  }, [activeCategory, categoryMap, normalizedQuery, questions]);
  const activeMeta = categoryMap.get(activeCategory) ?? categories[0];

  useEffect(() => {
    setExpandedId(visibleQuestions[0]?.id ?? null);
  }, [activeCategory, normalizedQuery]);

  return (
    <div className="help-center">
      <div className="help-center-toolbar">
        <label className="help-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={ui.searchPlaceholder}
            aria-label={ui.searchAria}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} title={ui.clearSearch} aria-label={ui.clearSearch}>
              <X size={14} />
            </button>
          )}
        </label>
        <div className="help-quick-actions" aria-label={ui.quickActionsAria}>
          {quickActions.map(({ label, icon: Icon, target }) => (
            <button type="button" onClick={() => onNavigate(target)} key={label}>
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="help-center-layout">
        <nav className="help-category-nav" aria-label={ui.categoriesAria}>
          <div className="help-category-nav-head">
            <span>{ui.categories}</span>
            <strong>{text(ui.answerCount, { count: questions.length })}</strong>
          </div>
          <div className="help-category-list">
            {categories.map((category) => {
              const Icon = category.icon;
              return (
                <button
                  type="button"
                  className={clsx(activeCategory === category.id && !normalizedQuery && "active")}
                  data-tone={category.tone}
                  onClick={() => {
                    setQuery("");
                    setActiveCategory(category.id);
                  }}
                  aria-current={activeCategory === category.id && !normalizedQuery ? "page" : undefined}
                  key={category.id}
                >
                  <span className="help-category-icon"><Icon size={15} aria-hidden="true" /></span>
                  <span><strong>{category.label}</strong><small>{category.description}</small></span>
                  <b>{categoryCounts.get(category.id) ?? 0}</b>
                </button>
              );
            })}
          </div>
          {canReopenOnboarding && (
            <div className="help-category-foot">
              <button type="button" onClick={() => onNavigate({ kind: "onboarding" })}>
                <RotateCcw size={14} aria-hidden="true" />
                {ui.reopenSetup}
              </button>
            </div>
          )}
        </nav>

        <section className="help-question-pane" aria-live="polite">
          <header className="help-question-head">
            <div className="help-question-kicker">
              {normalizedQuery ? <Search size={14} /> : <activeMeta.icon size={14} />}
              <span>{normalizedQuery ? ui.searchResults : activeMeta.label}</span>
            </div>
            <h2>{normalizedQuery ? text(ui.foundCount, { count: visibleQuestions.length }) : activeMeta.description}</h2>
            <p>{normalizedQuery ? text(ui.searching, { query: query.trim() }) : ui.categoryPrompt}</p>
          </header>

          {visibleQuestions.length > 0 ? (
            <div className="help-question-list">
              {visibleQuestions.map((question) => {
                const category = categoryMap.get(question.category) ?? activeMeta;
                const expanded = expandedId === question.id;
                const answerId = `help-answer-${question.id}`;
                return (
                  <article className={clsx("help-question", expanded && "expanded")} data-tone={category.tone} key={question.id}>
                    <button
                      type="button"
                      className="help-question-trigger"
                      onClick={() => setExpandedId((current) => current === question.id ? null : question.id)}
                      aria-expanded={expanded}
                      aria-controls={answerId}
                    >
                      <span>
                        {normalizedQuery && <small>{category.label}</small>}
                        <strong>{question.title}</strong>
                      </span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </button>
                    <div className="help-answer-reveal" data-open={expanded ? "true" : "false"}>
                      <div id={answerId}>
                        <div className="help-answer-content">
                          {question.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                          {question.steps && (
                            <ol>
                              {question.steps.map((step) => <li key={step}>{step}</li>)}
                            </ol>
                          )}
                          {question.shortcuts && (
                            <div className="help-shortcut-table" role="table" aria-label={text(ui.shortcutTableAria, { platform: shortcutPlatform.label })} data-shortcut-platform={shortcutPlatform.id}>
                              <div className="help-shortcut-row help-shortcut-head" role="row">
                                <span role="columnheader">{ui.shortcuts} <small>{shortcutPlatform.label}</small></span>
                                <span role="columnheader">{ui.function}</span>
                              </div>
                              {question.shortcuts.map((shortcut) => {
                                const displayKeys = shortcut.keys.map((key) => key === "Mod" ? shortcutPlatform.modifier : key);
                                return (
                                  <div className="help-shortcut-row" role="row" key={`${shortcut.keys.join("-")}-${shortcut.description}`}>
                                    <span className="help-shortcut-keys" role="cell" aria-label={displayKeys.join(ui.keyJoin)}>
                                      {displayKeys.map((key, index) => (
                                        <span key={key}>
                                          {index > 0 && <i aria-hidden="true">+</i>}
                                          <kbd>{key}</kbd>
                                        </span>
                                      ))}
                                    </span>
                                    <span role="cell">{shortcut.description}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {question.action && (
                            <button type="button" className="help-answer-action" onClick={() => onNavigate(question.action!.target)}>
                              {question.action.label}
                              <ArrowRight size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="help-empty">
              <CircleHelp size={24} aria-hidden="true" />
              <strong>{ui.noResults}</strong>
              <p>{ui.noResultsDetail}</p>
              <button type="button" onClick={() => { setQuery(""); setActiveCategory("troubleshoot"); }}>{ui.viewTroubleshooting}</button>
            </div>
          )}

          <footer className="help-support-note">
            <ShieldCheck size={15} aria-hidden="true" />
            <span><strong>{ui.protectCredentials}</strong>{ui.credentialDetail}</span>
          </footer>
        </section>
      </div>
    </div>
  );
}
