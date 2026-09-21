import { useTranslation } from "react-i18next";
import {
  Activity, ArrowRightLeft, ClipboardCheck, Clock3, Crosshair, Gauge, Lightbulb, Percent, WalletCards
} from "lucide-react";

/**
 * 观察条件的**展示层单一定义**（快判运行记录 / 关键动作卡片共用）。
 *
 * 文案与图标**逐字对齐旧模式**（`AiAutomationPanel` 的运行详情卡片）：同一个条件在两条链路里
 * 必须长得一样，否则用户要在两套说法之间做翻译。
 *
 * 为什么不用 `resources.ts` 的键：旧模式本来就是 `i18n.t(key, { defaultValue })` 的兜底写法
 *（`automationText`），键大多不在资源文件里 —— 这里沿用同一机制，避免为纯展示文案造一批
 * 只被一个组件使用的键。
 */
export type ViewText = (
  key: string,
  english: string,
  chinese: string,
  values?: Record<string, unknown>
) => string;

/** `t` 的适配器：语言前缀决定取英文还是中文兜底（与 `automationText` 同口径）。 */
export function useViewText(): ViewText {
  const { t, i18n } = useTranslation(["automation"]);
  const language = (i18n.resolvedLanguage || i18n.language || "en-US").toLowerCase();
  const chinese = language.startsWith("zh");
  return (key, english, chineseText, values = {}) =>
    String(t(`automation:${key}`, { defaultValue: chinese ? chineseText : english, ...values }));
}

export function isConditionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 取出某条计划里的条件数组（`llm.params.nextWakePlan.conditions` / `input.nextWakePlan.conditions`）。 */
export function wakeConditionsOf(plan: unknown): Array<Record<string, unknown>> {
  const conditions = isConditionRecord(plan) ? plan.conditions : undefined;
  return Array.isArray(conditions) ? conditions.filter(isConditionRecord) : [];
}

/**
 * 计划里的条件有**两种形状**，必须在这里统一，否则格式化会静默走到兜底分支：
 * - 嵌套（快判侧车原始输出）：`{ "type": "timer", "params": { "intervalMinutes": 5 } }`
 * - 扁平（落库后的 `config_json` / 旧模式 `finishRun` 入参）：`{ "type": "timer", "intervalMinutes": 5 }`
 *
 * 真机踩过：夹具按嵌套写、格式化按扁平读 → 渲染成 `定时唤醒 · {"type":"timer",…}`（内行看是
 * JSON，用户看是天书）。统一在**展示入口**做一次，不在每个 formatter 里重复判断。
 */
export function flattenWakeCondition(condition: Record<string, unknown>): Record<string, unknown> {
  const params = condition.params;
  if (!isConditionRecord(params)) return condition;
  return { ...params, type: condition.type ?? params.type };
}

function formatStructured(value: unknown): string {
  if (value === null || value === undefined || value === "") return "--";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => formatStructured(item)).filter((item) => item !== "--").join(" · ") || "--";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatThresholdDirection(value: unknown, text: ViewText) {
  const labels: Record<string, string> = {
    up: text("directionBreaksAbove", "breaks above", "向上突破"),
    above: text("directionAbove", "above", "高于"),
    down: text("directionBreaksBelow", "breaks below", "向下跌破"),
    below: text("directionBelow", "below", "低于"),
    absolute: text("directionAbsoluteChange", "absolute change exceeds", "绝对变化超过")
  };
  return labels[String(value ?? "")] ?? String(value ?? text("directionReaches", "reaches", "达到"));
}

/**
 * 条件类型的展示表（19 类，与 Rust `wake_condition_schema()` 的类型集合一致）：`type → [i18n 键, 英文兜底, 中文兜底]`。
 *
 * **单一定义**：这张表同时是 (a) 类型名的中文/英文说法、(b) "系统认不认识这个类型"的判据。
 * 另抄一份 19 类清单去判断"未知类型"就是第二份真相 —— 表里加了新类型而清单没跟，界面会把
 * 一个**已经认识**的类型说成"未知（未写入）"。
 */
const WAKE_CONDITION_LABELS: Record<string, [string, string, string]> = {
  timer: ["wakeTypeTimer", "Scheduled wake-up", "定时唤醒"],
  price_cross: ["wakeTypePriceCross", "Price breakout", "价格突破"],
  price_change_pct: ["wakeTypePriceChange", "Window price change", "窗口涨跌幅"],
  candle_volume_ratio: ["wakeTypeVolumeRatio", "Candle volume surge", "K 线放量"],
  funding_rate_threshold: ["wakeTypeFundingThreshold", "Funding-rate threshold", "资金费率阈值"],
  orderbook_imbalance: ["wakeTypeOrderbookImbalance", "Order-book imbalance", "盘口失衡"],
  order_state_changed: ["wakeTypeOrderState", "Order state changed", "订单状态变化"],
  position_changed: ["wakeTypePositionState", "Position changed", "持仓变化"],
  opportunity_state_changed: ["wakeTypeOpportunityState", "Opportunity state changed", "交易机会状态变化"],
  episode_closed: ["wakeTypeEpisodeClosed", "Position episode closed", "持仓 Episode 结束"],
  open_interest_anomaly: ["wakeTypeOiAnomaly", "Open-interest anomaly", "OI 异常"],
  taker_flow_imbalance: ["wakeTypeTakerFlow", "Taker-flow imbalance", "主动流失衡"],
  crowding_divergence: ["wakeTypeCrowding", "Crowding divergence", "拥挤度分歧"],
  funding_extreme: ["wakeTypeFundingExtreme", "Funding-rate extreme", "资金费率极端"],
  liquidation_cluster: ["wakeTypeLiquidation", "Liquidation cluster", "清算簇"],
  important_news_event: ["wakeTypeNewsEvent", "Important news event", "重要新闻事件"],
  sentiment_reversal: ["wakeTypeSentiment", "Sentiment reversal", "情绪反转"],
  smart_money_change: ["wakeTypeSmartMoney", "Smart-money change", "聪明钱变化"],
  macro_event_window: ["wakeTypeMacroWindow", "Macro event window", "宏观事件窗口"]
};

/** 条件类型的中文名（19 类，与 Rust `wake_condition_schema()` 的类型集合一致）。 */
export function wakeConditionLabel(type: string, text: ViewText): string {
  const label = WAKE_CONDITION_LABELS[type];
  return label ? text(label[0], label[1], label[2]) : type;
}

/** 展示层认得的类型集合 = 上面那张表的键（**不是**第二份清单）。 */
export function isKnownWakeConditionType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(WAKE_CONDITION_LABELS, type);
}

/**
 * 未知类型的人话：**说清楚它没被写入，且不贴原始 JSON**。
 *
 * 真机（2026-09-21）：模型自己发明了 `{"type":"price","direction":"cross","price":84986.4}`，
 * 旧实现走到兜底分支把整段 JSON 渲染出来 —— 用户看到的是天书。类型不认识就意味着这条**没有写库**
 *（Rust 只认 19 类），所以文案必须同时给出"未写入"，而不是假装它是条能生效的条件。
 */
export function formatUnknownWakeCondition(type: string, text: ViewText): string {
  return text("wakeUnknownType", "Unknown condition type: {{type}} (not saved)", "未知条件类型：{{type}}（未写入）", { type });
}

/** 类型图标（与旧模式逐条同映射）。 */
export function wakeConditionIcon(type: string, size = 14) {
  if (type === "timer") return <Clock3 size={size} />;
  if (type === "price_cross") return <Crosshair size={size} />;
  if (type === "price_change_pct") return <Activity size={size} />;
  if (type === "candle_volume_ratio") return <Gauge size={size} />;
  if (type === "funding_rate_threshold") return <Percent size={size} />;
  if (["open_interest_anomaly", "taker_flow_imbalance", "crowding_divergence", "funding_extreme", "liquidation_cluster"].includes(type)) return <Gauge size={size} />;
  if (["important_news_event", "sentiment_reversal", "smart_money_change", "macro_event_window"].includes(type)) return <Activity size={size} />;
  if (type === "position_changed" || type === "episode_closed") return <WalletCards size={size} />;
  if (type === "opportunity_state_changed") return <Lightbulb size={size} />;
  if (type === "order_state_changed") return <ClipboardCheck size={size} />;
  return <ArrowRightLeft size={size} />;
}

/** 一条条件的人话（真机踩过的坑：直接贴 JSON 用户看不懂"什么时候会醒"）。 */
export function formatWakeCondition(condition: Record<string, unknown>, text: ViewText): string {
  const type = String(condition.type ?? "condition");
  // C33：**不认识的类型**先说清楚"未写入"，绝不贴原始 JSON（真机：模型自创的
  // `{"type":"price","direction":"cross","price":84986.4}` 被整段贴出来，用户看不懂）。
  // 这条分支必须在所有具名分支之前 —— 未知类型没有任何可格式化阈值。
  if (!isKnownWakeConditionType(type)) return formatUnknownWakeCondition(type, text);
  const symbol = condition.instId ? `${String(condition.instId)} ` : "";
  if (type === "timer") {
    if (condition.intervalMinutes) {
      return text("wakeEveryMinutes", "Reanalyze every {{minutes}} minutes", "每 {{minutes}} 分钟重新分析", { minutes: String(condition.intervalMinutes) });
    }
    if (condition.atMs) {
      const at = Number(condition.atMs);
      return text("wakeReanalyzeAt", "Reanalyze at {{time}}", "在 {{time}} 重新分析", {
        time: Number.isFinite(at) ? new Date(at).toLocaleTimeString() : String(condition.atMs)
      });
    }
  }
  if (type === "price_cross") return `${symbol}${formatThresholdDirection(condition.direction, text)} ${String(condition.price ?? "--")}`;
  if (type === "price_change_pct") {
    return text("wakePriceChangeSummary", "{{symbol}}{{direction}} {{threshold}}% within {{minutes}} minutes", "{{symbol}}{{minutes}} 分钟内{{direction}} {{threshold}}%", {
      symbol, minutes: String(condition.windowMinutes ?? "--"), direction: formatThresholdDirection(condition.direction, text), threshold: String(condition.thresholdPct ?? "--")
    });
  }
  if (type === "candle_volume_ratio") {
    return text("wakeVolumeSummary", "{{symbol}}{{bar}} volume exceeds the {{lookback}}-candle average by {{ratio}}x", "{{symbol}}{{bar}} 成交量超过最近 {{lookback}} 根均值 {{ratio}} 倍", {
      symbol, bar: String(condition.bar ?? "--"), lookback: String(condition.lookback ?? "--"), ratio: String(condition.ratio ?? "--")
    });
  }
  if (type === "funding_rate_threshold") {
    return text("wakeFundingSummary", "{{symbol}}funding rate {{direction}} {{rate}}", "{{symbol}}资金费率{{direction}} {{rate}}", {
      symbol, direction: formatThresholdDirection(condition.direction, text), rate: String(condition.rate ?? "--")
    });
  }
  if (type === "orderbook_imbalance") {
    return text("wakeOrderbookSummary", "{{symbol}}{{side}} reaches {{ratio}} across the first {{depth}} levels", "{{symbol}}{{side}}前 {{depth}} 档占比达到 {{ratio}}", {
      symbol,
      side: condition.direction === "sell" ? text("wakeAskSide", "Ask depth", "卖盘") : text("wakeBidSide", "Bid depth", "买盘"),
      depth: String(condition.depth ?? "--"),
      ratio: String(condition.ratio ?? "--")
    });
  }
  if ([
    "open_interest_anomaly", "taker_flow_imbalance", "crowding_divergence", "funding_extreme",
    "liquidation_cluster", "important_news_event", "sentiment_reversal", "smart_money_change", "macro_event_window"
  ].includes(type)) {
    return `${symbol || text("wakeAllInstrumentsPrefix", "All instruments · ", "全品种 ")}${wakeConditionLabel(type, text)}`;
  }
  // 兜底：**只带 type / instId / accountId 的条件不再贴 JSON**（真机渲染成
  // `持仓变化 · {"instId":"…","type":"position_changed"}`）—— 无阈值可展示时就是"品种 + 类型名"。
  const extras = Object.keys(condition).filter((key) => !["type", "instId", "accountId"].includes(key));
  if (extras.length === 0) {
    return `${symbol || text("wakeAllInstrumentsPrefix", "All instruments · ", "全品种 ")}${wakeConditionLabel(type, text)}`;
  }
  // 带附加字段的条件（`order_state_changed.states` 等）：**逐字段写成人话**，不再整段贴 JSON。
  // 真机（2026-09-21，与未知类型同一张卡片）：`订单状态变化 · {"type":"order_state_changed","states":["filled"]}`
  // —— 用户看不懂，且 `type` 在 JSON 里又重复了一遍（上面已经写了类型名）。
  const details = extras
    .map((key) => `${key}: ${formatStructured(condition[key])}`)
    .join(" · ");
  return `${symbol}${wakeConditionLabel(type, text)} · ${details}`;
}

/** 条件标签（品种 / 间隔 / 方向 / 价格 / 周期 / 账户）—— 与旧模式的 chip 同口径。 */
export function wakeConditionTags(condition: Record<string, unknown>, text: ViewText): string[] {
  return [
    condition.instId ? String(condition.instId) : null,
    condition.intervalMinutes ? text("wakeIntervalTag", "Every {{minutes}} min", "间隔 {{minutes}} 分钟", { minutes: String(condition.intervalMinutes) }) : null,
    condition.direction ? formatThresholdDirection(condition.direction, text) : null,
    condition.price ? `${String(condition.price)} USDT` : null,
    condition.bar ? String(condition.bar) : null,
    condition.opportunityId ? String(condition.opportunityId) : null,
    condition.accountId ? text("wakeAccountTag", "Account {{account}}", "账户 {{account}}", { account: String(condition.accountId) }) : null
  ].filter((value): value is string => Boolean(value));
}

/**
 * 观察条件清单 —— **直接复用旧模式运行详情的样式**（`.automation-run-wake-list`，两列瓷砖格子）。
 *
 * 为什么不是"另做一套快判样式"：同一个事实在两处长得不一样，用户要自己做翻译；样式单一定义后，
 * 改动只会发生在一个地方。因此这里连 class 名都沿用旧模式（`styles.css` 里那套瓷砖）。
 *
 * `hook` 加在容器上（`data-fastlane-wake-list="<hook>"`），每条带
 * `data-fastlane-wake-condition="<type>"` —— smoke 靠这两个钩子定位，不依赖配色。
 */
export function WakeConditionList({
  conditions,
  text,
  hook
}: {
  conditions: Array<Record<string, unknown>>;
  text: ViewText;
  hook: string;
}) {
  return (
    <div className="automation-run-wake-list" data-fastlane-wake-list={hook}>
      {conditions.map((condition, index) => {
        const type = String(condition.type ?? "condition");
        // 嵌套（快判侧车）/ 扁平（落库与旧模式）两种形状都在这一个入口归一。
        const normalized = flattenWakeCondition(condition);
        // C33：未知类型带显式钩子（smoke 断言"说人话且没有 JSON"用），并置灰 —— 它没写进库。
        const unknown = !isKnownWakeConditionType(type);
        return (
          <div
            key={`${type}-${index}`}
            data-fastlane-wake-condition={type}
            data-fastlane-wake-text={formatWakeCondition(normalized, text)}
            data-fastlane-wake-unknown={unknown ? type : undefined}
          >
            {wakeConditionIcon(type, 13)}
            <span>{formatWakeCondition(normalized, text)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default WakeConditionList;
