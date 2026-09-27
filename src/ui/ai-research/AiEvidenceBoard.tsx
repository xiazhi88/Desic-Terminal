import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import clsx from "clsx";
import { Scale, Orbit, TriangleAlert, Clock3, ArrowUpRight, ArrowDownRight } from "lucide-react";
import {
  deriveEvidenceLedger,
  wakePriceDistance,
  toolResultRecord,
  type EvidenceDecision,
  type EvidenceLedger,
  type EvidenceLedgerItem,
  type EvidenceSource,
  type EvidenceWakeCondition
} from "../../lib/aiEvidenceLedger";
import { parseMarketCandles } from "../../lib/aiCandleSeries";
import { prefersReducedMotion, useSpringValue } from "../../lib/springMotion";
import { useMarketHotStore } from "../../lib/marketHotStore";
import { aiResearchArtifactForTool, type AiResearchArtifact, type AiToolRun, type AiUiMessage } from "../AiMessageProcess";
import { useNowInterval } from "./useNowInterval";
import { AiCollaborationOrbit } from "./AiCollaborationOrbit";
import "./ai-evidence.css";

type UiText = (zh: string, en: string) => string;

type BoardProps = {
  message: AiUiMessage | null;
  uiText: UiText;
  onOpenArtifact?: (artifact: AiResearchArtifact) => void;
};

const MAX_TILT_DEG = 12;

export function AiEvidenceBoard({ message, uiText, onOpenArtifact }: BoardProps) {
  const [view, setView] = useState<"evidence" | "orbit">("evidence");
  const ledger = useMemo(() => (message ? deriveEvidenceLedger(message) : null), [message]);
  const hasAgents = (message?.agents?.length ?? 0) > 0;

  if (!message || !ledger) {
    return <section className="ai-evidence-board is-empty" aria-label={uiText("证据天平", "Evidence balance")}>
      <p>{uiText("还没有研究回合。提出一个需要判断方向的问题后，工具结果会在这里按证据整理。", "No research turn yet. Ask a question that needs a directional call and tool results will be organized here as evidence.")}</p>
    </section>;
  }

  const openSource = (source: EvidenceSource) => {
    if (!onOpenArtifact) return;
    onOpenArtifact(aiResearchArtifactForTool(source.tool, message.id) ?? fallbackArtifact(source, message.id));
  };

  return <section className="ai-evidence-board" aria-label={uiText("证据天平", "Evidence balance")}>
    <header className="ai-evidence-head">
      <div className="ai-evidence-view-switch" role="tablist" aria-label={uiText("证据视图", "Evidence view")}>
        <button type="button" role="tab" aria-selected={view === "evidence"} onClick={() => setView("evidence")}><Scale size={13} />{uiText("证据板", "Evidence")}</button>
        <button type="button" role="tab" aria-selected={view === "orbit"} onClick={() => setView("orbit")} disabled={!hasAgents} title={hasAgents ? undefined : uiText("本回合没有咨询专家", "No experts were consulted this turn")}><Orbit size={13} />{uiText("协作轨道", "Collaboration")}</button>
      </div>
      <small className="ai-evidence-counts">
        {ledger.hasLedger
          ? uiText(`账本 ${ledger.items.length} 条 · 来源 ${ledger.sources.size}`, `${ledger.items.length} ledger items · ${ledger.sources.size} sources`)
          : uiText(`来源 ${ledger.sources.size} · 无账本`, `${ledger.sources.size} sources · no ledger`)}
      </small>
    </header>
    {view === "orbit" && hasAgents
      ? <AiCollaborationOrbit message={message} uiText={uiText} />
      : <EvidenceView ledger={ledger} messageKey={message.id} uiText={uiText} onOpenSource={openSource} />}
  </section>;
}

function EvidenceView({ ledger, messageKey, uiText, onOpenSource }: { ledger: EvidenceLedger; messageKey: string; uiText: UiText; onOpenSource: (source: EvidenceSource) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useFlipLayout(hostRef, `${messageKey}:${ledger.items.map((item) => `${item.id}:${item.stance}`).join("|")}:${ledger.unassigned.map((source) => source.ref).join("|")}`);
  const bear = ledger.items.filter((item) => item.stance === "bear");
  const bull = ledger.items.filter((item) => item.stance === "bull");
  const context = ledger.items.filter((item) => item.stance === "neutral" || item.stance === "constraint");

  return <div className="ai-evidence-view" ref={hostRef}>
    {ledger.hasLedger
      ? <>
        <EvidenceBalance ledger={ledger} uiText={uiText} />
        <DecisionSlots decision={ledger.decision} uiText={uiText} />
      </>
      : <p className="ai-evidence-note">{uiText("本回合没有调用证据账本：工具结果只按返回顺序列出，不从回答正文推断立场，因此不显示天平。", "This turn did not use the evidence ledger. Tool results are listed in return order, stances are never inferred from the answer text, so no balance is shown.")}</p>}
    {ledger.unknownRefs.length > 0
      ? <p className="ai-evidence-warning" role="note"><TriangleAlert size={13} />{uiText(`账本引用了本轮不存在的来源编号：${ledger.unknownRefs.join("、")}（未计入来源）`, `The ledger cites refs that do not exist this turn: ${ledger.unknownRefs.join(", ")} (not counted as sources)`)}</p>
      : null}
    {ledger.hasLedger
      ? <div className="ai-evidence-columns">
        <EvidenceColumn stance="bear" title={uiText("偏空", "Bearish")} items={bear} ledger={ledger} uiText={uiText} onOpenSource={onOpenSource} />
        <EvidenceColumn stance="bull" title={uiText("偏多", "Bullish")} items={bull} ledger={ledger} uiText={uiText} onOpenSource={onOpenSource} />
      </div>
      : null}
    {context.length > 0
      ? <section className="ai-evidence-context" aria-label={uiText("中性与约束", "Neutral and constraints")}>
        <header><span>{uiText("中性 / 约束", "Neutral / constraints")}</span><small>{uiText("不计权重", "Not weighted")}</small></header>
        <div>{context.map((item) => <EvidenceItemCard key={item.id} item={item} ledger={ledger} uiText={uiText} onOpenSource={onOpenSource} compact />)}</div>
      </section>
      : null}
    {ledger.unassigned.length > 0
      ? <section className="ai-evidence-pending" aria-label={uiText("待归类", "Unassigned")}>
        <header><span>{ledger.hasLedger ? uiText("待归类", "Unassigned") : uiText("工具结果", "Tool results")}</span><small>{ledger.hasLedger ? uiText("已返回、账本尚未引用", "Returned, not yet cited by the ledger") : uiText("按返回顺序", "In return order")}</small></header>
        <div>{ledger.unassigned.map((source) => <SourceCard key={source.ref} source={source} uiText={uiText} onOpen={() => onOpenSource(source)} />)}</div>
      </section>
      : null}
    {ledger.decision && ledger.decision.wakeConditions.length > 0
      ? <WakePanel decision={ledger.decision} instId={ledger.decision.instId ?? ledger.instId} uiText={uiText} />
      : null}
  </div>;
}

function EvidenceColumn({ stance, title, items, ledger, uiText, onOpenSource }: { stance: "bull" | "bear"; title: string; items: EvidenceLedgerItem[]; ledger: EvidenceLedger; uiText: UiText; onOpenSource: (source: EvidenceSource) => void }) {
  const total = stance === "bull" ? ledger.bull : ledger.bear;
  return <section className={clsx("ai-evidence-column", `is-${stance}`)} aria-label={title}>
    <header><span>{title}</span><small>{items.length} · {formatWeight(total)}</small></header>
    {items.length === 0
      ? <p className="ai-evidence-column-empty">{uiText("暂无", "None yet")}</p>
      : items.map((item) => <EvidenceItemCard key={item.id} item={item} ledger={ledger} uiText={uiText} onOpenSource={onOpenSource} />)}
  </section>;
}

function EvidenceItemCard({ item, ledger, uiText, onOpenSource, compact = false }: { item: EvidenceLedgerItem; ledger: EvidenceLedger; uiText: UiText; onOpenSource: (source: EvidenceSource) => void; compact?: boolean }) {
  const sources = item.sourceRefs.map((ref) => ledger.sources.get(ref)).filter((source): source is EvidenceSource => Boolean(source));
  const primary = sources[0];
  const revised = item.revisions > 0 && item.previousWeight !== null && item.previousWeight !== item.weight;
  return <button
    type="button"
    className={clsx("ai-evidence-card", `is-${item.stance}`, compact && "is-compact")}
    data-flip-key={`item:${item.id}`}
    data-flip-origin={item.sourceRefs[0] ? `ref:${item.sourceRefs[0]}` : undefined}
    onClick={() => primary && onOpenSource(primary)}
    disabled={!primary}
    title={item.revisionNote ?? undefined}
  >
    <span className="ai-evidence-card-meta">
      <code title={sources.map((source) => source.tool.name).join(", ")}>{primary ? sourceLabel(primary.tool.name, uiText) : uiText("来源缺失", "Missing source")}</code>
      <span className="ai-evidence-refs">{item.sourceRefs.map((ref) => <i key={ref} className={ledger.sources.has(ref) ? undefined : "is-unknown"}>{ref}</i>)}</span>
      {item.stance === "bull" || item.stance === "bear"
        ? <span className="ai-evidence-weight" aria-label={uiText(`权重 ${formatWeight(item.weight)}`, `Weight ${formatWeight(item.weight)}`)}>
          {revised ? <s>{formatWeight(item.previousWeight!)}</s> : null}
          <i className="ai-evidence-weight-track"><em style={{ width: `${(item.weight / 3) * 100}%` }} /></i>
          <b>{formatWeight(item.weight)}</b>
        </span>
        : <span className="ai-evidence-kind">{item.stance === "constraint" ? uiText("约束", "Constraint") : uiText("中性", "Neutral")}</span>}
    </span>
    <span className="ai-evidence-claim">{item.claim}</span>
    {revised ? <span className="ai-evidence-revision">{uiText("已修订", "Revised")}{item.revisionNote ? ` · ${item.revisionNote}` : ""}</span> : null}
    {!compact && primary ? <EvidenceMini tool={primary.tool} /> : null}
  </button>;
}

function SourceCard({ source, uiText, onOpen }: { source: EvidenceSource; uiText: UiText; onOpen: () => void }) {
  return <button type="button" className="ai-evidence-card is-pending" data-flip-key={`ref:${source.ref}`} onClick={onOpen}>
    <span className="ai-evidence-card-meta"><code title={source.tool.name}>{sourceLabel(source.tool.name, uiText)}</code><span className="ai-evidence-refs"><i>{source.ref}</i></span></span>
    <span className="ai-evidence-claim">{source.tool.summary || uiText("工具已返回", "Tool returned")}</span>
    <EvidenceMini tool={source.tool} />
  </button>;
}

// —— 天平：按净权重倾斜，欠阻尼弹簧晃动后落定 ——
function EvidenceBalance({ ledger, uiText }: { ledger: EvidenceLedger; uiText: UiText }) {
  const target = ledger.total > 0 ? Math.max(-1, Math.min(1, ledger.net / Math.max(ledger.total, 3))) * MAX_TILT_DEG : 0;
  const angle = useSpringValue(target, { stiffness: 70, damping: 7 });
  const radians = (angle * Math.PI) / 180;
  const pivot = { x: 180, y: 34 };
  const arm = 128;
  const left = { x: pivot.x - arm * Math.cos(radians), y: pivot.y - arm * Math.sin(radians) };
  const right = { x: pivot.x + arm * Math.cos(radians), y: pivot.y + arm * Math.sin(radians) };
  const bearItems = ledger.items.filter((item) => item.stance === "bear");
  const bullItems = ledger.items.filter((item) => item.stance === "bull");
  return <div className="ai-evidence-balance">
    <div className="ai-evidence-side is-bear"><small>{uiText("偏空", "Bearish")}</small><strong>{formatWeight(ledger.bear)}</strong><span>{uiText(`${bearItems.length} 条`, `${bearItems.length} items`)}</span></div>
    <svg viewBox="0 0 360 130" role="img" aria-label={uiText(`证据天平：偏空 ${formatWeight(ledger.bear)}，偏多 ${formatWeight(ledger.bull)}`, `Evidence balance: bearish ${formatWeight(ledger.bear)}, bullish ${formatWeight(ledger.bull)}`)}>
      <path className="ai-balance-stand" d={`M ${pivot.x} ${pivot.y} V 116 M ${pivot.x - 30} 116 H ${pivot.x + 30}`} />
      <line className="ai-balance-beam" x1={left.x} y1={left.y} x2={right.x} y2={right.y} />
      <circle className="ai-balance-pivot" cx={pivot.x} cy={pivot.y} r={3.5} />
      <BalancePan anchor={left} items={bearItems} stance="bear" />
      <BalancePan anchor={right} items={bullItems} stance="bull" />
    </svg>
    <div className="ai-evidence-side is-bull"><small>{uiText("偏多", "Bullish")}</small><strong>{formatWeight(ledger.bull)}</strong><span>{uiText(`${bullItems.length} 条`, `${bullItems.length} items`)}</span></div>
    <p className="ai-evidence-balance-stats">
      {uiText("净", "Net")} {formatSigned(ledger.net)} · {uiText("总", "Total")} {formatWeight(ledger.total)}
      {ledger.conflict !== null ? <> · {uiText("冲突度", "Conflict")} {Math.round(ledger.conflict * 100)}%</> : null}
    </p>
  </div>;
}

function BalancePan({ anchor, items, stance }: { anchor: { x: number; y: number }; items: EvidenceLedgerItem[]; stance: "bull" | "bear" }) {
  const panY = anchor.y + 46;
  const widths = items.map((item) => 5 + item.weight * 7);
  const totalWidth = widths.reduce((sum, width) => sum + width + 2, 0) - 2;
  let cursor = anchor.x - Math.max(totalWidth, 0) / 2;
  return <g className={clsx("ai-balance-pan", `is-${stance}`)}>
    <path className="ai-balance-string" d={`M ${anchor.x} ${anchor.y} L ${anchor.x - 30} ${panY} M ${anchor.x} ${anchor.y} L ${anchor.x + 30} ${panY}`} />
    <path className="ai-balance-dish" d={`M ${anchor.x - 38} ${panY} Q ${anchor.x} ${panY + 12} ${anchor.x + 38} ${panY}`} />
    {items.map((item, index) => {
      const width = widths[index] ?? 5;
      const x = cursor;
      cursor += width + 2;
      return <rect key={item.id} className="ai-balance-weight" x={x} y={panY - 8} width={width} height={7} rx={1.5} />;
    })}
  </g>;
}

function DecisionSlots({ decision, uiText }: { decision: EvidenceDecision | null; uiText: UiText }) {
  const middleLabel = decision?.outcome === "hold" ? uiText("持有", "Hold") : uiText("放弃", "Abstain");
  const slots: Array<{ key: string; label: string; active: boolean; tone: string }> = [
    { key: "short", label: uiText("开空", "Short"), active: decision?.outcome === "short", tone: "bear" },
    { key: "middle", label: middleLabel, active: decision?.outcome === "abstain" || decision?.outcome === "hold", tone: "neutral" },
    { key: "long", label: uiText("开多", "Long"), active: decision?.outcome === "long", tone: "bull" }
  ];
  return <div className="ai-evidence-decision">
    <div className="ai-evidence-slots" role="list" aria-label={uiText("本轮决策", "Decision")}>
      {slots.map((slot) => <span role="listitem" key={slot.key} className={clsx("ai-evidence-slot", `is-${slot.tone}`, slot.active && "is-active", !decision && "is-waiting")} aria-current={slot.active ? "true" : undefined}>{slot.label}</span>)}
    </div>
    <p className="ai-evidence-decision-reason">
      {decision
        ? <>{decision.outcome === "abstain" ? <b>{uiText("不交易也是有效决策 · ", "Not trading is a valid decision · ")}</b> : null}{decision.reason}</>
        : uiText("等待 AI 记录本轮决策", "Waiting for the AI to record a decision")}
    </p>
  </div>;
}

// —— 唤醒条件：只展示，不安排唤醒 ——
function WakePanel({ decision, instId, uiText }: { decision: EvidenceDecision; instId: string | null; uiText: UiText }) {
  const price = useLivePrice(instId);
  const hasTime = decision.wakeConditions.some((condition) => condition.kind === "time");
  const now = useNowInterval(hasTime);
  const priceConditions = decision.wakeConditions.filter((condition) => condition.price !== null);
  const bounds = priceConditions.length > 0 && price !== null
    ? rulerBounds([price, ...priceConditions.map((condition) => condition.price!)])
    : null;
  return <section className="ai-evidence-wake" aria-label={uiText("唤醒条件", "Wake conditions")}>
    <header><span>{uiText("唤醒条件", "Wake conditions")}</span><small>{instId ?? ""}{price !== null ? ` · ${formatPrice(price)}` : ` · ${uiText("无实时价格", "No live price")}`}</small></header>
    {bounds && price !== null
      ? <div className="ai-evidence-ruler" aria-hidden="true">
        <span className="ai-evidence-ruler-track" />
        {priceConditions.map((condition, index) => <span key={index} className={clsx("ai-evidence-ruler-mark", condition.kind === "price_above" ? "is-above" : "is-below")} style={{ left: `${rulerPosition(condition.price!, bounds)}%` }}><i>{formatPrice(condition.price!)}</i></span>)}
        <span className="ai-evidence-ruler-price" style={{ left: `${rulerPosition(price, bounds)}%` }} />
      </div>
      : null}
    <ul>
      {decision.wakeConditions.map((condition, index) => <WakeRow key={index} condition={condition} price={price} now={now} uiText={uiText} />)}
    </ul>
    <p className="ai-evidence-wake-note">{uiText("交互研究的唤醒条件仅用于展示，不会自动唤醒或下单。", "Interactive research wake conditions are display-only; nothing is scheduled or submitted.")}</p>
  </section>;
}

function WakeRow({ condition, price, now, uiText }: { condition: EvidenceWakeCondition; price: number | null; now: number; uiText: UiText }) {
  if (condition.kind === "time") {
    const remaining = condition.dueAt !== null ? Math.max(0, condition.dueAt - now) : null;
    const hours = (condition.afterMinutes ?? 0) / 60;
    return <li className="ai-evidence-wake-row">
      <Clock3 size={13} />
      <span>{hours >= 1 && Number.isInteger(hours) ? uiText(`${hours} 小时后复查`, `Review in ${hours}h`) : uiText(`${condition.afterMinutes} 分钟后复查`, `Review in ${condition.afterMinutes}m`)}{condition.note ? <small>{condition.note}</small> : null}</span>
      <b>{remaining === null ? "--" : remaining === 0 ? uiText("已到期", "Due") : formatCountdown(remaining)}</b>
    </li>;
  }
  const distance = wakePriceDistance(condition, price);
  const near = distance !== null && !distance.reached && Math.abs(distance.pct) < 0.0015;
  return <li className={clsx("ai-evidence-wake-row", near && "is-near", distance?.reached && "is-reached")}>
    {condition.kind === "price_above" ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
    <span>{condition.kind === "price_above" ? uiText("突破", "Above") : uiText("跌破", "Below")} {formatPrice(condition.price ?? 0)}{condition.note ? <small>{condition.note}</small> : null}</span>
    <b>{distance === null ? uiText("无实时价格", "No live price") : distance.reached ? uiText("已触及", "Reached") : `${distance.pct > 0 ? "+" : ""}${(distance.pct * 100).toFixed(2)}%`}</b>
  </li>;
}

function useLivePrice(instId: string | null) {
  return useMarketHotStore((state) => {
    if (!instId) return null;
    const ticker = state.ticker?.instId === instId ? state.ticker : state.watchTickers[instId];
    const value = Number(ticker?.last);
    return Number.isFinite(value) && value > 0 ? value : null;
  });
}

// —— 证据卡迷你可视化：只画工具真实返回的数据 ——
function EvidenceMini({ tool }: { tool: AiToolRun }): ReactNode {
  const name = tool.name;
  if (name === "market.readCandles") return <MiniCandles tool={tool} />;
  if (name === "market.readOrderBook") return <MiniDepth tool={tool} />;
  if (name === "market.readTrades") return <MiniTrades tool={tool} />;
  return null;
}

function MiniCandles({ tool }: { tool: AiToolRun }) {
  const candles = useMemo(() => parseMarketCandles(tool.result).candles.slice(-48), [tool.result]);
  if (candles.length < 2) return null;
  const highs = candles.map((item) => item.high);
  const lows = candles.map((item) => item.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = max - min || 1;
  const width = 120;
  const height = 34;
  const step = width / candles.length;
  const y = (value: number) => 2 + (1 - (value - min) / span) * (height - 4);
  return <svg className="ai-evidence-mini" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {candles.map((item, index) => {
      const x = index * step + step / 2;
      const up = item.close >= item.open;
      return <g key={item.time} className={up ? "is-up" : "is-down"}>
        <line x1={x} x2={x} y1={y(item.high)} y2={y(item.low)} />
        <rect x={x - Math.max(step * 0.32, 0.6)} width={Math.max(step * 0.64, 1.2)} y={Math.min(y(item.open), y(item.close))} height={Math.max(Math.abs(y(item.open) - y(item.close)), 0.8)} />
      </g>;
    })}
  </svg>;
}

function sideTotal(levels: unknown) {
  if (!Array.isArray(levels)) return 0;
  return levels.slice(0, 50).reduce<number>((sum, level) => {
    const size = Array.isArray(level) ? Number(level[1]) : Number((level as Record<string, unknown> | null)?.sz ?? (level as Record<string, unknown> | null)?.size);
    return Number.isFinite(size) ? sum + size : sum;
  }, 0);
}

function MiniDepth({ tool }: { tool: AiToolRun }) {
  const result = toolResultRecord(tool);
  const book = (result.book && typeof result.book === "object" ? result.book : result) as Record<string, unknown>;
  const bids = sideTotal(book.bids);
  const asks = sideTotal(book.asks);
  if (bids + asks <= 0) return null;
  const share = bids / (bids + asks);
  return <span className="ai-evidence-mini ai-evidence-mini-depth" aria-hidden="true"><i className="is-bid" style={{ width: `${share * 100}%` }} /><i className="is-ask" style={{ width: `${(1 - share) * 100}%` }} /></span>;
}

function MiniTrades({ tool }: { tool: AiToolRun }) {
  const result = toolResultRecord(tool);
  const trades = (Array.isArray(result.trades) ? result.trades : Array.isArray(result.data) ? result.data : []).slice(0, 50) as Array<Record<string, unknown>>;
  if (trades.length < 2) return null;
  const sizes = trades.map((trade) => Number(trade.sz ?? trade.size) || 0);
  const max = Math.max(...sizes, 1e-9);
  return <svg className="ai-evidence-mini" viewBox={`0 0 ${trades.length * 3} 30`} aria-hidden="true">
    {trades.slice().reverse().map((trade, index) => {
      const size = sizes[trades.length - 1 - index] ?? 0;
      const height = 2 + (Math.sqrt(size / max)) * 26;
      return <rect key={index} className={trade.side === "buy" ? "is-bid" : "is-ask"} x={index * 3} y={30 - height} width={2} height={height} />;
    })}
  </svg>;
}

// —— FLIP：卡片从「待归类」飞入立场列 ——
function useFlipLayout(hostRef: RefObject<HTMLDivElement | null>, signature: string) {
  const rectsRef = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const previous = rectsRef.current;
    const next = new Map<string, DOMRect>();
    const nodes = Array.from(host.querySelectorAll<HTMLElement>("[data-flip-key]"));
    const animate = !prefersReducedMotion() && previous.size > 0;
    for (const node of nodes) {
      const key = node.dataset.flipKey!;
      const rect = node.getBoundingClientRect();
      next.set(key, rect);
      if (!animate) continue;
      const before = previous.get(key) ?? (node.dataset.flipOrigin ? previous.get(node.dataset.flipOrigin) : undefined);
      if (!before) {
        node.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
        continue;
      }
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    }
    rectsRef.current = next;
  }, [hostRef, signature]);
}

// 卡片上的短来源标签；完整工具名在悬停提示里。
function sourceLabel(name: string, uiText: UiText) {
  if (name === "market.readCandles") return uiText("K 线", "Candles");
  if (name === "market.readOrderBook") return uiText("盘口", "Order book");
  if (name === "market.readTrades") return uiText("成交", "Trades");
  if (name === "market.readIndicators") return uiText("指标", "Indicators");
  if (name === "market.readTicker") return uiText("行情", "Ticker");
  if (name === "market.readFundingRate") return uiText("资金费率", "Funding");
  if (name === "consult_expert" || name === "consult_experts") return uiText("专家", "Experts");
  if (name === "follow_up") return uiText("追问", "Follow-up");
  if (name.startsWith("intelligence.")) return uiText("情报", "Intel");
  if (name.startsWith("radar.")) return uiText("雷达", "Radar");
  if (name.startsWith("account.")) return uiText("账户", "Account");
  if (name.startsWith("trade.")) return uiText("预检", "Precheck");
  if (name === "research.webSearch") return uiText("网页", "Web");
  return name.split(".").at(-1) ?? name;
}

function fallbackArtifact(source: EvidenceSource, messageId: string): AiResearchArtifact {
  return {
    id: `evidence:${messageId}:${source.ref}`,
    kind: "research",
    title: `${source.ref} · ${source.tool.name}`,
    summary: source.tool.summary ?? "",
    data: source.tool.result,
    toolName: source.tool.name,
    sourceMessageId: messageId
  };
}

function rulerBounds(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min || max * 0.01) * 0.18;
  return { min: min - pad, max: max + pad };
}

function rulerPosition(value: number, bounds: { min: number; max: number }) {
  return ((value - bounds.min) / (bounds.max - bounds.min || 1)) * 100;
}

function formatWeight(value: number) {
  return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(value * 10 === Math.round(value * 10) ? 1 : 2);
}

function formatSigned(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatWeight(Math.abs(value))}`;
}

function formatPrice(value: number) {
  const digits = value >= 1000 ? 1 : value >= 10 ? 2 : value >= 1 ? 3 : 5;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatCountdown(ms: number) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// —— 消息流内的紧凑摘要：决策落定后一行天平，点击打开证据板 ——
export function AiEvidenceSummaryStrip({ message, uiText, onOpen }: { message: AiUiMessage; uiText: UiText; onOpen: () => void }) {
  const ledger = useMemo(() => deriveEvidenceLedger(message), [message]);
  if (!ledger.hasLedger) return null;
  const tilt = ledger.total > 0 ? Math.max(-1, Math.min(1, ledger.net / Math.max(ledger.total, 3))) : 0;
  const outcome = ledger.decision?.outcome;
  const outcomeLabel = outcome === "long" ? uiText("开多", "Long") : outcome === "short" ? uiText("开空", "Short") : outcome === "hold" ? uiText("持有", "Hold") : outcome === "abstain" ? uiText("放弃", "Abstain") : uiText("待决策", "Pending");
  return <button type="button" className="ai-evidence-strip" onClick={onOpen} title={uiText("打开证据天平", "Open evidence balance")}>
    <Scale size={13} />
    <span className="ai-evidence-strip-side is-bear">{uiText("空", "Bear")} {formatWeight(ledger.bear)}</span>
    <span className="ai-evidence-strip-beam" aria-hidden="true"><i style={{ transform: `rotate(${tilt * MAX_TILT_DEG}deg)` }} /></span>
    <span className="ai-evidence-strip-side is-bull">{uiText("多", "Bull")} {formatWeight(ledger.bull)}</span>
    {ledger.conflict !== null ? <small>{uiText("冲突度", "Conflict")} {Math.round(ledger.conflict * 100)}%</small> : null}
    <b className={clsx("ai-evidence-strip-outcome", outcome && `is-${outcome}`)}>{outcomeLabel}</b>
  </button>;
}
