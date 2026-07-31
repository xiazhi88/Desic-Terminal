import i18n from "i18next";

const LEGACY_KEYS: Readonly<Record<string, string>> = {
  "交易": "navigation:trading",
  "交易机会": "navigation:opportunities",
  "AI 自动化": "navigation:automation",
  "市场情报": "navigation:intelligence",
  "数据": "navigation:data",
  "配置": "navigation:settings",
  "保存": "common:save",
  "取消": "common:cancel",
  "关闭": "common:close",
  "删除": "common:delete",
  "修改": "common:edit",
  "编辑": "common:edit",
  "确认": "common:confirm",
  "加载中": "common:loading",
  "刷新": "common:refresh",
  "重试": "common:retry",
  "启用": "common:enabled",
  "已启用": "common:enabled",
  "禁用": "common:disabled",
  "全部": "common:all",
  "状态": "common:status",
  "时间": "common:time",
  "价格": "common:price",
  "数量": "common:quantity",
  "成功": "common:success",
  "失败": "common:failed",
  "错误": "common:error",
  "警告": "common:warning",
  "未知": "common:unknown",
  "搜索": "common:search",
  "详情": "common:details",
  "今天": "common:today",
  "昨天": "common:yesterday",
  "实盘": "common:live",
  "模拟盘": "common:demo",
  "账户": "common:account",
  "永续": "common:perpetual",
  "系统": "common:system",
  "语言": "common:language",
  "新建": "common:new",
  "运行": "common:run",
  "历史": "common:history",
  "帮助": "common:help",
  "未配置账号": "common:unconfiguredAccount",
  "只读行情": "common:readOnlyMarket",
  "仅桌面端可用": "common:desktopOnly",
  "连接中": "common:connecting",
  "已完成": "common:completed",
  "处理中": "common:processing",
  "复制": "common:copy",
  "导出": "common:export",
  "导入": "common:import",
  "下载": "common:download",
  "打开": "common:open",
  "返回": "common:back",
  "更多": "common:more",
  "采用": "common:apply",
  "拒绝": "common:reject",
  "重置": "common:reset",
  "恢复": "common:restore",
  "清除": "common:clear",
  "名称": "common:name",
  "描述": "common:description",
  "类型": "common:type",
  "来源": "common:source",
  "结果": "common:result",
  "输入": "common:input",
  "输出": "common:output",
  "操作": "common:actions",
  "做多": "trading:long",
  "做空": "trading:short",
  "平多": "trading:closeLong",
  "平空": "trading:closeShort",
  "买入": "trading:buy",
  "卖出": "trading:sell",
  "市价": "trading:market",
  "限价": "trading:limit",
  "止盈": "trading:takeProfit",
  "止损": "trading:stopLoss",
  "持仓": "trading:positions",
  "当前委托": "trading:openOrders",
  "历史委托": "trading:historicalOrders",
  "历史成交": "trading:historicalFills",
  "历史持仓": "trading:historicalPositions",
  "资金流水": "trading:bills",
  "交易审计": "trading:audit",
  "余额": "trading:balance",
  "合约": "trading:contract",
  "方向": "trading:direction",
  "委托类型": "trading:orderType",
  "数量(张)": "trading:quantityContracts",
  "数量（张）": "trading:quantityContracts",
  "价格(USDT)": "trading:priceUsdt",
  "价格（USDT）": "trading:priceUsdt",
  "杠杆": "trading:leverage",
  "保证金模式": "trading:marginMode",
  "全仓": "trading:cross",
  "逐仓": "trading:isolated",
  "市场深度": "trading:orderBook",
  "最新成交": "trading:latestTrades",
  "交易对": "trading:tradingPair",
  "开仓": "trading:openPosition",
  "平仓": "trading:closePosition",
  "预估收益": "trading:estimatedPnl",
  "手续费": "trading:fee",
  "资金费": "trading:fundingFee",
  "实时": "trading:realTime",
  "实盘交易": "trading:liveTrading",
  "模拟盘交易": "trading:demoTrading",
  "可用余额": "trading:availableBalance",
  "预计占用保证金": "trading:estimatedMargin",
  "预估强平价": "trading:liquidationPrice",
  "提交中": "trading:submitting",
  "等待有效输入": "trading:waitingInput",
  "张": "trading:contracts",
  "标记价格": "trading:markPrice",
  "最新": "trading:lastPrice",
  "高": "trading:high",
  "低": "trading:low",
  "开": "trading:open",
  "收": "trading:close",
  "成交量": "trading:volume",
  "盈亏": "trading:pnl",
  "自选": "trading:watchlist",
  "行情": "trading:marketData",
  "张数": "trading:quantityContracts",
  "持仓量": "trading:positionSize",
  "开仓/标记": "trading:entryMark",
  "收益额": "trading:pnl",
  "占用保证金": "trading:marginUsed",
  "强平价": "trading:liquidationPrice",
  "市价全平": "trading:marketCloseAll",
  "未配置账号，暂无持仓。添加账号后可查看余额、持仓、挂单和历史数据。": "trading:noAccountPositions",
  "实时盘口": "trading:liveOrderBook",
  "买卖压力": "trading:marketPressure",
  "添加账号": "trading:addAccount",
  "行情可正常查看，配置账号后即可提交委托。": "trading:marketWithoutAccount",
  "限价委托": "trading:limit",
  "买一": "trading:bestBid",
  "卖一": "trading:bestAsk",
  "价格无效": "trading:invalidPrice",
  "请输入下单张数": "trading:enterOrderSize",
  "止盈/止损": "trading:takeProfitStopLoss",
  "触发后市价": "trading:marketAfterTrigger",
  "模拟 · 买入开多": "trading:demoLong",
  "模拟 · 卖出开空": "trading:demoShort",
  "指标": "chart:indicators",
  "提醒": "chart:alerts",
  "图层": "chart:layers",
  "网格": "chart:grid",
  "图表": "chart:chart",
  "表格": "chart:table",
  "弹出图表": "chart:popout",
  "加载更早 K 线...": "chart:loadingEarlier",
  "绘图": "chart:drawings",
  "快速交易": "chart:quickTrade",
  "指标中心": "chart:indicatorCenter",
  "K 线数据": "chart:chartData",
  "导出表格": "chart:exportTable",
  "实时监听中": "chart:realtimeMonitoring",
  "表格视图": "chart:tableView",
  "Restore": "chart:restore",
  "Reset": "chart:reset",
  "Profiles": "automation:profiles",
  "运行记录": "automation:runs",
  "观察计划": "automation:wakeConditions",
  "复盘": "automation:reviews",
  "优化建议": "automation:suggestions",
  "通知": "automation:notifications",
  "正在加载 AI 自动化工作台": "automation:loadingWorkspace",
  "运行中": "automation:running",
  "待处理": "automation:pending",
  "已停止": "automation:stopped",
  "分析结果": "automation:analysisResult",
  "主 Agent": "automation:mainAgent",
  "Profile 模型": "automation:profileModel",
  "预览": "automation:preview",
  "新闻": "intelligence:news",
  "情绪与宏观": "intelligence:sentiment",
  "衍生品": "intelligence:derivatives",
  "聪明钱": "intelligence:smartMoney",
  "经济日历": "intelligence:economicCalendar",
  "事件": "intelligence:events",
  "原文": "intelligence:original",
  "同步全部": "intelligence:refreshAll",
  "最后同步": "intelligence:lastSync",
  "日历": "intelligence:calendar",
  "周": "intelligence:week",
  "月": "intelligence:month",
  "重要": "intelligence:importantOnly",
  "当天没有经济事件": "intelligence:noEvents",
  "数据覆盖度": "intelligence:dataCoverage",
  "币种情绪": "intelligence:coinSentiment",
  "交易员排行榜": "intelligence:traderRanking",
  "市场简报": "intelligence:marketBriefing",
  "新闻详情": "intelligence:newsDetail",
  "事件证据": "intelligence:eventEvidence",
  "来源时间线": "intelligence:sourceTimeline",
  "查询本地库": "intelligence:queryLocal",
  "帮助中心": "help:title",
  "搜索帮助": "help:search",
  "快速开始": "help:quickStart",
  "故障排查": "help:troubleshooting",
  "页面加载失败": "errors:bootstrap",
  "数据加载失败": "errors:loadFailed",
  "保存失败": "errors:saveFailed",
  "网络请求失败": "errors:network"
};

const SKIP_SELECTOR = [
  "[data-i18n-skip]",
  ".ai-markdown",
  ".intelligence-article-body",
  ".cm-editor",
  "code",
  "pre",
  "[contenteditable='true']"
].join(",");

type TextRecord = { source: string; rendered: string };
type AttributeRecord = Record<string, TextRecord>;

const textRecords = new WeakMap<Text, TextRecord>();
const attributeRecords = new WeakMap<Element, AttributeRecord>();
const TRANSLATED_ATTRIBUTES = ["title", "aria-label", "placeholder"] as const;

function shouldSkip(element: Element | null) {
  return Boolean(element?.closest(SKIP_SELECTOR));
}

const DYNAMIC_PREFIX_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["标记价格", "trading:markPrice"],
  ["Last", "trading:lastPrice"],
  ["最新", "trading:lastPrice"],
  ["时间", "common:time"],
  ["Time", "common:time"],
  ["高", "trading:high"],
  ["High", "trading:high"],
  ["低", "trading:low"],
  ["Low", "trading:low"],
  ["开", "trading:open"],
  ["Open", "trading:open"],
  ["收", "trading:close"],
  ["Close", "trading:close"],
  ["量", "trading:volume"],
  ["Volume", "trading:volume"]
];

function translateDynamicValue(source: string) {
  const counted = source.match(/^(持仓|当前委托|余额)\(([^)]+)\)$/);
  if (counted) {
    const key = counted[1] === "持仓" ? "trading:positions" : counted[1] === "当前委托" ? "trading:openOrders" : "trading:balance";
    return `${i18n.t(key)}(${counted[2]})`;
  }
  const pressure = source.match(/^(等待盘口数据|主动买|买|卖)\s+(.+)$/);
  if (pressure) {
    const key = pressure[1] === "等待盘口数据"
      ? "trading:waitingOrderBook"
      : pressure[1] === "主动买"
        ? "trading:activeBuy"
        : pressure[1] === "买"
          ? "trading:buy"
          : "trading:sell";
    return `${i18n.t(key)} ${pressure[2]}`;
  }
  for (const [prefix, key] of DYNAMIC_PREFIX_KEYS) {
    if (source.startsWith(`${prefix} `)) return `${i18n.t(key)} ${source.slice(prefix.length + 1)}`;
  }
  return null;
}

function translateValue(value: string) {
  const match = value.match(/^(\s*)(.*?)(\s*)$/s);
  if (!match) return value;
  const source = match[2];
  const key = LEGACY_KEYS[source];
  const translated = key ? i18n.t(key) : translateDynamicValue(source);
  if (!translated) return value;
  return `${match[1]}${translated}${match[3]}`;
}

function translateTextNode(node: Text) {
  if (shouldSkip(node.parentElement)) return;
  const previous = textRecords.get(node);
  const source = previous && node.data === previous.rendered ? previous.source : node.data;
  const rendered = translateValue(source);
  textRecords.set(node, { source, rendered });
  if (node.data !== rendered) node.data = rendered;
}

function translateAttributes(element: Element) {
  if (shouldSkip(element)) return;
  const records = attributeRecords.get(element) ?? {};
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    if (!element.hasAttribute(attribute)) continue;
    const value = element.getAttribute(attribute) ?? "";
    const previous = records[attribute];
    const source = previous && value === previous.rendered ? previous.source : value;
    const rendered = translateValue(source);
    records[attribute] = { source, rendered };
    if (value !== rendered) element.setAttribute(attribute, rendered);
  }
  attributeRecords.set(element, records);
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text);
    return;
  }
  if (!(root instanceof Element) && !(root instanceof Document)) return;
  if (root instanceof Element) translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text);
    else translateAttributes(node as Element);
    node = walker.nextNode();
  }
}

let observer: MutationObserver | null = null;
let languageHandler: (() => void) | null = null;

export function installLegacyI18nBridge() {
  if (typeof document === "undefined" || observer) return;
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") translateTextNode(mutation.target as Text);
      if (mutation.type === "attributes" && mutation.target instanceof Element) translateAttributes(mutation.target);
      for (const node of mutation.addedNodes) translateTree(node);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATED_ATTRIBUTES]
  });
  languageHandler = () => translateTree(document.documentElement);
  i18n.on("languageChanged", languageHandler);
  translateTree(document.documentElement);
}

export function removeLegacyI18nBridge() {
  observer?.disconnect();
  observer = null;
  if (languageHandler) i18n.off("languageChanged", languageHandler);
  languageHandler = null;
}

export function legacyTranslationKey(source: string) {
  return LEGACY_KEYS[source] ?? null;
}
