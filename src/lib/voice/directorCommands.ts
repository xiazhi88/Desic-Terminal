/**
 * 导演模式的确定性指令解析：把一句口述转成一串有类型的界面动作。
 *
 * 只覆盖「可逆、不涉及交易」的界面操作；认不出的整句交给 AI，
 * 含下单类动词的整句一律拒绝，语音永远不会直接成交。
 *
 * 本模块刻意不依赖 React、Tauri 或路径别名，便于用 node 直接测试。
 */

export type DirectorSection =
  | "ai"
  | "terminal"
  | "radar"
  | "opportunities"
  | "automation"
  | "intelligence"
  | "systematic"
  | "data"
  | "config";

export type DirectorTimeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1H" | "2H" | "4H" | "6H" | "12H" | "1D";

export type DirectorAction =
  | { type: "workspace"; section: DirectorSection }
  | { type: "instrument"; instId: string }
  | { type: "timeframe"; bar: DirectorTimeframe }
  | { type: "orderFlow"; enabled: boolean }
  | { type: "indicator"; op: "add" | "remove"; id: string }
  | { type: "clearIndicators" };

export type DirectorParseResult =
  | { kind: "actions"; actions: DirectorAction[] }
  | { kind: "undo" }
  | { kind: "trade-refused" }
  | { kind: "unrecognized" };

export type DirectorCatalog = {
  /** 可选合约；只用 instId 与 baseCcy。 */
  instruments: readonly { instId: string; baseCcy?: string }[];
  /** 图表当前可用的指标 id。 */
  indicatorIds: readonly string[];
};

export const DIRECTOR_TIMEFRAMES: readonly DirectorTimeframe[] = ["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D"];

const SECTION_ALIASES: readonly (readonly [DirectorSection, readonly string[]])[] = [
  ["radar", ["雷达", "市场雷达", "radar"]],
  ["terminal", ["终端", "交易终端", "看盘", "图表", "k线", "行情", "terminal", "chart"]],
  ["intelligence", ["情报", "市场情报", "新闻", "intelligence", "news"]],
  ["automation", ["自动化", "值守", "automation"]],
  ["opportunities", ["交易机会", "机会", "opportunities"]],
  ["systematic", ["策略研究", "策略", "回测", "systematic", "strategy", "backtest"]],
  ["data", ["数据", "账户绩效", "绩效", "交易复盘", "复盘", "data"]],
  ["config", ["设置", "配置", "settings", "config"]],
  ["ai", ["ai研究", "ai 研究", "ai助手", "研究", "人工智能", "ai", "research"]],
];

const CHINESE_ALIASES: readonly (readonly [string, string])[] = [
  ["比特币", "BTC"],
  ["大饼", "BTC"],
  ["以太坊", "ETH"],
  ["以太", "ETH"],
  ["索拉纳", "SOL"],
  ["狗狗币", "DOGE"],
  ["瑞波币", "XRP"],
  ["瑞波", "XRP"],
  ["币安币", "BNB"],
  ["莱特币", "LTC"],
  ["艾达币", "ADA"],
  ["波场", "TRX"],
];

const INDICATOR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ma: ["ma", "均线", "简单均线", "移动平均线", "移动平均"],
  ema: ["ema", "指数均线", "指数移动平均线", "指数移动平均"],
  vwap: ["vwap", "成交量加权平均价", "成交量加权"],
  boll: ["boll", "bollinger", "布林带", "布林线", "布林"],
  donchian: ["donchian", "唐奇安通道", "唐奇安"],
  keltner: ["keltner", "肯特纳通道", "肯特纳"],
  psar: ["psar", "抛物线sar", "抛物线", "sar"],
  supertrend: ["supertrend", "超级趋势"],
  ichimoku: ["ichimoku", "一目均衡表", "一目均衡", "一目"],
  rsi: ["rsi", "相对强弱指标", "相对强弱"],
  macd: ["macd"],
  kdj: ["kdj"],
  atr: ["atr", "真实波幅", "平均真实波幅"],
  adx: ["adx", "趋向指标"],
  stochastic: ["stochastic", "stoch", "随机指标"],
  cci: ["cci", "顺势指标"],
  roc: ["roc", "变动率"],
  aroon: ["aroon", "阿隆指标", "阿隆"],
  trix: ["trix"],
  "williams-r": ["williams", "威廉指标", "威廉"],
  mfi: ["mfi", "资金流量指标", "资金流量"],
  cmf: ["cmf", "蔡金资金流"],
  obv: ["obv", "能量潮"],
  "volume-ma": ["成交量均线", "volume ma"],
};

const TRADE_VERBS = /买入|卖出|买|卖|做多|做空|开多|开空|开仓|平仓|平掉|清仓|全平|下单|挂单|加仓|减仓|\bbuy\b|\bsell\b|go long|go short|open (?:a )?(?:long|short)|close (?:the )?position|place (?:an? )?order/;
/** 带疑问 / 征询语气：这是在问问题（「该不该做多」），不是在下指令，交给语音指挥分析即可。 */
const QUESTION_MARKERS = /该不该|要不要|能不能|可不可以|值不值|是不是|是否|会不会|怎么看|怎么样|怎么办|如何|吗|呢|[?？]|\bshould\b|\bwhether\b|\bhow\b|\bwhy\b|\bis it\b|\bcan i\b/;
const UNDO_PATTERN = /^(?:撤销|撤回|回退|恢复(?:刚才|上一步)?|取消刚才(?:的)?(?:操作)?|撤销上一步|undo|go back)$/;
const REMOVE_VERBS = /去掉|去除|删除|删掉|移除|关闭|关掉|隐藏|取消|不要|\bremove\b|\bhide\b|\bdelete\b|turn off|\boff\b/;
const SPLITTERS = /[，,。.；;、!！?？\n]+|然后|接着|之后|并且|而且|同时|\bthen\b|\band\b|再|并/;
const FILLERS = [
  "帮我", "给我", "麻烦", "请", "我要", "我想要", "我想", "看一下", "看看", "看下", "看", "切换到", "切换成", "切换", "切到", "换成", "换到",
  "打开", "进入", "回到", "去", "到", "的", "图表", "走势图", "走势", "图", "行情", "和", "跟", "与", "以及", "还有", "界面", "页面", "吧", "啊", "呀", "呢", "一下", "把", "它", "成", "为", "周期", "时间",
  "加上", "加入", "添加", "加", "显示", "开启", "叠加", "去掉", "去除", "删除", "删掉", "移除", "关闭", "关掉", "隐藏", "取消", "不要", "指标",
  "模式", "切", "换", "下", "show", "switch", "to", "go", "open", "add", "remove", "hide", "delete", "turn", "on", "off", "the", "me", "please",
  "chart", "view", "timeframe", "a", "an", "of", "indicator", "mode",
];

const CHINESE_DIGITS: Readonly<Record<string, number>> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 把「十二 / 三十 / 四 / 15」这类数字转成整数；认不出返回 null。 */
export function parseSpokenNumber(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  const tens = value.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (tens) return (tens[1] ? CHINESE_DIGITS[tens[1]] : 1) * 10 + (tens[2] ? CHINESE_DIGITS[tens[2]] : 0);
  if (value.length === 1 && value in CHINESE_DIGITS) return CHINESE_DIGITS[value];
  return null;
}

const MINUTE_BARS: Readonly<Record<number, DirectorTimeframe>> = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m" };
const HOUR_BARS: Readonly<Record<number, DirectorTimeframe>> = { 1: "1H", 2: "2H", 4: "4H", 6: "6H", 12: "12H" };
const NUMBER = "(\\d+|[零一二两三四五六七八九十]+)";

function normalize(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”"'`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

/** 在文本里查找别名；ASCII 别名要求词边界，避免 `ma` 命中 `macd`。 */
function findAlias(text: string, alias: string): RegExpExecArray | null {
  const pattern = isAscii(alias) ? new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`) : new RegExp(escapeRegExp(alias));
  return pattern.exec(text);
}

function removeRange(text: string, match: RegExpExecArray): string {
  return `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
}

type Extraction<T> = { rest: string; value: T } | null;

function extractTimeframe(text: string): Extraction<DirectorTimeframe | "invalid"> {
  const half = /半小时/.exec(text);
  if (half) return { rest: removeRange(text, half), value: "30m" };
  const daily = /日线|(?<![0-9])(?:1|一)\s*(?:天|日)|(?<![a-z0-9])1d(?![a-z0-9])|\bdaily\b/.exec(text);
  if (daily) return { rest: removeRange(text, daily), value: "1D" };
  const minutes = new RegExp(`${NUMBER}\\s*(?:分钟|分|min(?:ute)?s?(?![a-z])|m(?![a-z]))`).exec(text);
  if (minutes) {
    const value = parseSpokenNumber(minutes[1]);
    return { rest: removeRange(text, minutes), value: (value !== null && MINUTE_BARS[value]) || "invalid" };
  }
  const hours = new RegExp(`${NUMBER}\\s*(?:个)?(?:小时|hours?(?![a-z])|h(?![a-z]))`).exec(text);
  if (hours) {
    const value = parseSpokenNumber(hours[1]);
    return { rest: removeRange(text, hours), value: (value !== null && HOUR_BARS[value]) || "invalid" };
  }
  return null;
}

function extractIndicators(text: string, ids: readonly string[], remove: boolean): { rest: string; actions: DirectorAction[] } {
  let rest = text;
  const actions: DirectorAction[] = [];
  const clear = /(?:所有|全部|清空|清除)(?:的)?指标|清空指标|clear (?:all )?indicators/.exec(rest);
  if (clear) {
    rest = removeRange(rest, clear);
    actions.push({ type: "clearIndicators" });
  }
  // 先匹配长别名，避免「指数均线」被「均线」抢走。
  const candidates = ids.flatMap((id) => (INDICATOR_ALIASES[id] ?? []).map((alias) => ({ id, alias })));
  candidates.sort((a, b) => b.alias.length - a.alias.length);
  for (const candidate of candidates) {
    const match = findAlias(rest, candidate.alias);
    if (!match) continue;
    rest = removeRange(rest, match);
    if (!actions.some((item) => item.type === "indicator" && item.id === candidate.id)) {
      actions.push({ type: "indicator", op: remove ? "remove" : "add", id: candidate.id });
    }
  }
  return { rest, actions };
}

function stripFillers(text: string): string {
  let rest = ` ${text} `.replace(/[\s,.;:!?，。；：！？、()（）\-_/]+/g, " ");
  // 先去长词，避免「看一下」被拆成「看」「一下」后留下残渣。
  for (const filler of [...FILLERS].sort((a, b) => b.length - a.length)) {
    const pattern = isAscii(filler) ? new RegExp(`(?<![a-z0-9])${escapeRegExp(filler)}(?![a-z0-9])`, "g") : new RegExp(escapeRegExp(filler), "g");
    rest = rest.replace(pattern, " ");
  }
  return rest.replace(/\s+/g, "").trim();
}

const ASCII_FILLERS = FILLERS.filter(isAscii);

/** 去掉英文口语词；把连字符算作词内字符，这样 `on-usdt-swap` 里的 on 不会被误删。 */
function stripAsciiFillers(text: string): string {
  let rest = text;
  for (const filler of [...ASCII_FILLERS].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(`(?<![a-z0-9-])${escapeRegExp(filler)}(?![a-z0-9-])`, "g"), " ");
  }
  return rest;
}

function resolveInstrument(text: string, catalog: DirectorCatalog): { rest: string; instId: string } | "ambiguous" | null {
  const bases = new Map<string, string>();
  for (const instrument of catalog.instruments) {
    const base = (instrument.baseCcy ?? instrument.instId.split("-")[0] ?? "").toLowerCase();
    if (base && /-usdt-swap$/i.test(instrument.instId)) bases.set(base, instrument.instId);
  }
  const found = new Map<string, { match: RegExpExecArray }>();
  for (const [chinese, base] of CHINESE_ALIASES) {
    const match = new RegExp(escapeRegExp(chinese)).exec(text);
    const instId = bases.get(base.toLowerCase());
    if (match && instId) found.set(instId, { match });
  }
  for (const [base, instId] of bases) {
    if (found.has(instId)) continue;
    const match = findAlias(text, base);
    if (match) found.set(instId, { match });
  }
  // 精确写成 BTC-USDT-SWAP 的情况
  for (const instrument of catalog.instruments) {
    const match = findAlias(text, instrument.instId.toLowerCase());
    if (match) found.set(instrument.instId, { match });
  }
  if (found.size === 0) return null;
  if (found.size > 1) return "ambiguous";
  const [[instId, { match }]] = [...found];
  return { rest: removeRange(text, match), instId };
}

const ACTION_ORDER: Readonly<Record<DirectorAction["type"], number>> = {
  workspace: 0,
  instrument: 1,
  timeframe: 2,
  orderFlow: 3,
  clearIndicators: 4,
  indicator: 5,
};

function parseClause(clause: string, catalog: DirectorCatalog): DirectorAction[] | null {
  let rest = clause;
  const actions: DirectorAction[] = [];
  const remove = REMOVE_VERBS.test(rest);

  const flow = /订单流|order ?flow/.exec(rest);
  if (flow) {
    rest = removeRange(rest, flow);
    actions.push({ type: "orderFlow", enabled: !remove });
  }
  const indicators = extractIndicators(rest, catalog.indicatorIds, remove);
  rest = indicators.rest;
  actions.push(...indicators.actions);

  const timeframe = extractTimeframe(rest);
  if (timeframe) {
    if (timeframe.value === "invalid") return null;
    rest = timeframe.rest;
    actions.push({ type: "timeframe", bar: timeframe.value });
  }

  let section: DirectorSection | null = null;
  const sectionCandidates = SECTION_ALIASES.flatMap(([id, aliases]) => aliases.map((alias) => ({ id, alias }))).sort((a, b) => b.alias.length - a.alias.length);
  for (const candidate of sectionCandidates) {
    const match = findAlias(rest, candidate.alias);
    if (match) {
      section = candidate.id;
      rest = removeRange(rest, match);
      break;
    }
  }

  const instrument = resolveInstrument(stripAsciiFillers(rest), catalog);
  if (instrument === "ambiguous") return null;
  if (instrument) {
    rest = instrument.rest;
    actions.unshift({ type: "instrument", instId: instrument.instId });
  }
  // 选合约会自动进入终端；与其它工作区同时出现意图矛盾，交给 AI 处理。
  if (section && instrument && section !== "terminal") return null;
  if (section && actions.some((item) => item.type === "timeframe" || item.type === "orderFlow" || item.type === "indicator" || item.type === "clearIndicators") && section !== "terminal") return null;
  if (section) actions.unshift({ type: "workspace", section });

  if (stripFillers(rest)) return null;
  if (actions.length === 0) return null;
  return actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => ACTION_ORDER[a.action.type] - ACTION_ORDER[b.action.type] || a.index - b.index)
    .map((item) => item.action);
}

export function parseDirectorCommand(transcript: string, catalog: DirectorCatalog): DirectorParseResult {
  const text = normalize(transcript);
  if (!text) return { kind: "unrecognized" };
  // 只有「像指令」的句子才拒绝；疑问句不会下单，由语音指挥去回答（它没有任何下单工具）。
  if (TRADE_VERBS.test(text) && !QUESTION_MARKERS.test(text)) return { kind: "trade-refused" };
  if (UNDO_PATTERN.test(text.replace(/[\s,.，。!！]+/g, ""))) return { kind: "undo" };

  const clauses = text.split(SPLITTERS).map((item) => item.trim()).filter(Boolean);
  if (clauses.length === 0) return { kind: "unrecognized" };
  const actions: DirectorAction[] = [];
  for (const clause of clauses) {
    const parsed = parseClause(clause, catalog);
    // 整句要么全部认得，要么全部交给 AI，避免只执行一半。
    if (!parsed) return { kind: "unrecognized" };
    actions.push(...parsed);
  }
  return actions.length > 0 ? { kind: "actions", actions } : { kind: "unrecognized" };
}
