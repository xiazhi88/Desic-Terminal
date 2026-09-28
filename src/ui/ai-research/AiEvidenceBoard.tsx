import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import { ArrowLeft, ExternalLink, Scale } from "lucide-react";
import {
  deriveEvidenceLedger,
  deriveOrbitExperts,
  toolResultRecord,
  type EvidenceDecision,
  type EvidenceLedger,
  type EvidenceLedgerItem,
  type EvidenceSource
} from "../../lib/aiEvidenceLedger";
import { prefersReducedMotion, stepSpring } from "../../lib/springMotion";
import { aiResearchArtifactForTool, type AiResearchArtifact, type AiToolRun, type AiUiMessage } from "../AiMessageProcess";
import { AiCollaborationOrbit } from "./AiCollaborationOrbit";
import { alpha, EVB_COLORS, evidenceDrawer, prepCanvas } from "./evidenceViz";
import "./ai-evidence.css";

// 证据天平：结构、几何与动效复刻证据天平原型（viz/prototypes/evidence-scale.html）。
// 数据只来自 research.recordEvidence / recordDecision 与主 Agent 工具结果上的 evidenceRef；
// 没有账本的回合不画天平，卡片全部留在「待定」，界面不从正文推断立场或权重。

type UiText = (zh: string, en: string) => string;

type BoardProps = {
  message: AiUiMessage | null;
  /** 该回合是否仍在生成；由工作区的流式状态传入。 */
  running?: boolean;
  uiText: UiText;
  onOpenArtifact?: (artifact: AiResearchArtifact) => void;
};

type CardState = "pending" | "bear" | "bull" | "neutral";

type CardModel = {
  key: string;
  /** 从待定区飞入立场列时，用来源编号找到起飞位置。 */
  flipOrigin?: string;
  state: CardState;
  claim: string;
  src: string;
  via: string | null;
  kindLabel: string | null;
  weight: number;
  previousWeight: number | null;
  reviewed: boolean;
  refs: string[];
  tool: AiToolRun | undefined;
  item: EvidenceLedgerItem | null;
};

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const BAL = { px: 300, py: 30, L: 170, drop: 44 };
const SVG_NS = "http://www.w3.org/2000/svg";

function isExpertTool(tool: AiToolRun | undefined) {
  return tool?.name === "consult_expert" || tool?.name === "consult_experts" || tool?.name === "follow_up";
}

function expertNames(tool: AiToolRun | undefined) {
  if (!tool || !isExpertTool(tool)) return null;
  const result = toolResultRecord(tool);
  const names = Array.isArray(result.results)
    ? result.results.map((entry) => String((entry as Record<string, unknown>)?.expertName ?? "")).filter(Boolean)
    : [String(result.expertName ?? "")].filter(Boolean);
  return names.length > 0 ? names.join(" / ") : null;
}

function buildCards(ledger: EvidenceLedger, uiText: UiText): CardModel[] {
  const cards: CardModel[] = ledger.items.map((item) => {
    const sources = item.sourceRefs.map((ref) => ledger.sources.get(ref)).filter((source): source is EvidenceSource => Boolean(source));
    const expert = sources.find((source) => isExpertTool(source.tool))?.tool;
    const direct = sources.find((source) => !isExpertTool(source.tool))?.tool ?? sources[0]?.tool;
    return {
      key: `item:${item.id}`,
      flipOrigin: item.sourceRefs[0] ? `ref:${item.sourceRefs[0]}` : undefined,
      state: item.stance === "constraint" ? "neutral" : item.stance,
      claim: item.claim,
      src: direct && !isExpertTool(direct) ? direct.name : direct ? uiText("专家结论", "Expert finding") : uiText("来源缺失", "Missing source"),
      via: expertNames(expert),
      kindLabel: item.stance === "constraint" ? uiText("约束", "Constraint") : item.stance === "neutral" ? uiText("中性", "Neutral") : null,
      weight: item.weight,
      previousWeight: item.revisions > 0 && item.previousWeight !== null && item.previousWeight !== item.weight ? item.previousWeight : null,
      reviewed: item.revisions > 0,
      refs: item.sourceRefs,
      tool: direct,
      item
    };
  });
  for (const source of ledger.unassigned) {
    cards.push({
      key: `ref:${source.ref}`,
      state: "pending",
      claim: source.tool.summary || source.tool.name,
      src: source.tool.name,
      via: expertNames(source.tool),
      kindLabel: null,
      weight: 0,
      previousWeight: null,
      reviewed: false,
      refs: [source.ref],
      tool: source.tool,
      item: null
    });
  }
  return cards;
}

export function AiEvidenceBoard({ message, running: runningProp, uiText, onOpenArtifact }: BoardProps) {
  const [view, setView] = useState<"evidence" | "orbit">("evidence");
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const ledger = useMemo(() => (message ? deriveEvidenceLedger(message) : null), [message]);
  const cards = useMemo(() => (ledger ? buildCards(ledger, uiText) : []), [ledger, uiText]);
  const expertSignature = message ? (message.agents ?? []).map((agent) => `${agent.id}:${agent.status}:${agent.endedAt ?? ""}`).join("|") : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const experts = useMemo(() => (message ? deriveOrbitExperts(message) : []), [expertSignature]);
  const activeExperts = experts.filter((expert) => expert.status === "running" || expert.status === "queued").length;
  const running = Boolean(message && runningProp && !message.completed && !message.error);

  if (!message || !ledger) {
    return <section className="evb is-empty" aria-label={uiText("证据天平", "Evidence balance")}>
      <p className="evb-empty-note">{uiText("还没有研究回合。提出一个需要判断方向的问题后，工具结果会在这里按证据整理。", "No research turn yet. Ask a question that needs a directional call and tool results will be organized here as evidence.")}</p>
    </section>;
  }

  const assigned = cards.filter((card) => card.state !== "pending").length;
  const pending = cards.length - assigned;
  const sealed = Boolean(ledger.decision) && pending === 0;
  // 回答进行中即使还没有账本也显示天平（等待证据入账）；回合结束仍没有账本才说明原因。
  const noLedger = !ledger.hasLedger && !running;
  const detail = detailKey ? cards.find((card) => card.key === detailKey) ?? null : null;

  return <section className={clsx("evb", noLedger && "is-no-ledger", sealed && "is-sealed")} aria-label={uiText("证据天平", "Evidence balance")}>
    <header className="evb-head">
      <div className="evb-seg" role="group" aria-label={uiText("证据视图", "Evidence view")}>
        <button type="button" aria-pressed={view === "evidence"} onClick={() => setView("evidence")}>{uiText("证据板", "Evidence")}</button>
        <button type="button" aria-pressed={view === "orbit"} onClick={() => setView("orbit")}>
          {uiText("协作轨道", "Collaboration")}
          {activeExperts > 0 ? <span className="evb-tab-badge"><span className="evb-live is-ai" />{activeExperts}</span> : null}
        </button>
      </div>
      <span className="evb-ledger-tag">
        {!noLedger
          ? uiText(`账本 ${assigned} 条${pending > 0 ? ` · ${pending} 待定` : ""}`, `${assigned} ledger items${pending > 0 ? ` · ${pending} pending` : ""}`)
          : uiText(`来源 ${ledger.sources.size} · 无账本`, `${ledger.sources.size} sources · no ledger`)}
      </span>
    </header>
    <div className="evb-body">
      <div className="evb-view" data-hidden={view !== "evidence"}>
        <EvidenceView ledger={ledger} cards={cards} running={running} noLedger={noLedger} messageKey={message.id} uiText={uiText} onOpenDetail={setDetailKey} />
      </div>
      <div className="evb-view" data-hidden={view !== "orbit"}>
        {view === "orbit" ? <AiCollaborationOrbit message={message} running={running} uiText={uiText} /> : null}
      </div>
      {detail ? <EvidenceDetail card={detail} messageId={message.id} uiText={uiText} onClose={() => setDetailKey(null)} onOpenArtifact={onOpenArtifact} /> : null}
    </div>
  </section>;
}

function EvidenceView({ ledger, cards, running, noLedger, messageKey, uiText, onOpenDetail }: { ledger: EvidenceLedger; cards: CardModel[]; running: boolean; noLedger: boolean; messageKey: string; uiText: UiText; onOpenDetail: (key: string) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useFlip(hostRef, `${messageKey}|${cards.map((card) => `${card.key}:${card.state}`).join(",")}`);
  const bear = cards.filter((card) => card.state === "bear");
  const bull = cards.filter((card) => card.state === "bull");
  const neutral = cards.filter((card) => card.state === "neutral");
  const pending = cards.filter((card) => card.state === "pending");
  const open = (card: CardModel) => () => onOpenDetail(card.key);
  return <div className="evb-ev" ref={hostRef}>
    {!noLedger
      ? <Balance ledger={ledger} running={running} uiText={uiText} />
      : <section className="evb-bal-empty">
        <b>{uiText("本轮输出未包含结构化立场字段", "This turn has no structured stance fields")}</b>
        {uiText("模型没有调用 research.recordEvidence，缺少 stance / weight，不显示天平。证据卡保留在待定区，界面不会从正文推断立场或权重。", "The model did not call research.recordEvidence, so stance / weight are missing and no balance is drawn. Evidence stays pending; the UI never infers stance or weight from the prose.")}
      </section>}
    <section className="evb-pending">
      <div className="evb-side-label"><span className="evb-micro">{uiText("待定", "Pending")}</span><span>{!noLedger ? uiText("等待账本立场", "Awaiting stance") : uiText("未归类", "Unassigned")}</span></div>
      <div className="evb-pending-row">
        {pending.length === 0 ? <span className="evb-pending-empty">{uiText("工具返回的证据先落在这里", "Returned evidence lands here first")}</span> : null}
        {pending.map((card) => <EvidenceCard key={card.key} card={card} running={running} uiText={uiText} onOpen={open(card)} />)}
      </div>
    </section>
    <section className="evb-cols">
      <Column title={uiText("偏空", "Bearish")} stance="bear" cards={bear} running={running} uiText={uiText} open={open} />
      <Column title={uiText("偏多", "Bullish")} stance="bull" cards={bull} running={running} uiText={uiText} open={open} />
    </section>
    <section className="evb-neutral">
      <div className="evb-side-label"><span className="evb-micro">{uiText("中性", "Neutral")}</span><span>{uiText("约束 · 不计权重", "Constraints · unweighted")}</span></div>
      <div className="evb-neutral-row">
        {neutral.length === 0 ? <span className="evb-pending-empty">—</span> : neutral.map((card) => <EvidenceCard key={card.key} card={card} running={running} uiText={uiText} onOpen={open(card)} />)}
      </div>
    </section>
  </div>;
}

function Column({ title, stance, cards, running, uiText, open }: { title: string; stance: "bear" | "bull"; cards: CardModel[]; running: boolean; uiText: UiText; open: (card: CardModel) => () => void }) {
  return <div className={clsx("evb-col", `is-${stance}`)}>
    <div className="evb-col-head"><span className="evb-micro">{title}</span><span className="evb-cnt">{cards.length}</span><span className="evb-rule-line" /></div>
    <div className="evb-col-list">
      {cards.length === 0 ? <span className="evb-col-empty">{uiText("暂无", "None yet")}</span> : cards.map((card) => <EvidenceCard key={card.key} card={card} running={running} uiText={uiText} onOpen={open(card)} />)}
    </div>
  </div>;
}

function EvidenceCard({ card, running, uiText, onOpen }: { card: CardModel; running: boolean; uiText: UiText; onOpen: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draw = useMemo(() => evidenceDrawer(card.tool), [card.tool]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !draw) return;
    const context = prepCanvas(canvas, 84, 34);
    if (context) draw(context, 84, 34, false);
  }, [draw]);
  const weighted = card.state === "bear" || card.state === "bull";
  return <article
    className={clsx("evb-card", `is-${card.state}`, card.reviewed && "is-reviewed")}
    data-flip-key={card.key}
    data-flip-origin={card.flipOrigin}
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen();
      }
    }}
  >
    <div className="evb-top">
      <span className="evb-src">{card.src}</span>
      {card.via ? <span className="evb-via">via {card.via}</span> : null}
      {card.reviewed ? <span className="evb-check">· {uiText("已复核", "Reviewed")}</span> : null}
      {card.kindLabel ? <span className="evb-kind">{card.kindLabel}</span> : null}
      {weighted ? <span className="evb-w">
        {card.previousWeight !== null ? <span className="evb-adj">{card.previousWeight.toFixed(1)}→</span> : null}
        <i><b style={{ width: `${Math.min(100, (card.weight / 3) * 100)}%` }} /></i>
        <em>{card.weight.toFixed(1)}</em>
      </span> : null}
      {card.state === "pending" ? <span className="evb-wait">{running ? <span className="evb-spin" /> : null}{card.refs.join(" ")}</span> : null}
    </div>
    <div className="evb-card-body">
      <p className="evb-claim">{card.claim}</p>
      {draw ? <canvas className="evb-viz" ref={canvasRef} aria-hidden="true" /> : null}
    </div>
  </article>;
}

// —— 天平：几何与原型一致；横梁是欠阻尼弹簧（k 42 / c 5.2），砝码块按权重落入秤盘 ——
type Block = {
  side: "bear" | "bull";
  el: SVGRectElement;
  target: number;
  y: { value: number; velocity: number };
  w: { value: number; velocity: number };
};

function Balance({ ledger, running, uiText }: { ledger: EvidenceLedger; running: boolean; uiText: UiText }) {
  const beamRef = useRef<SVGGElement | null>(null);
  const needleRef = useRef<SVGLineElement | null>(null);
  const leftRef = useRef<SVGGElement | null>(null);
  const rightRef = useRef<SVGGElement | null>(null);
  const leftBlocksRef = useRef<SVGGElement | null>(null);
  const rightBlocksRef = useRef<SVGGElement | null>(null);
  const beam = useRef({ value: 0, velocity: 0 });
  const blocks = useRef(new Map<string, Block>());
  const frame = useRef<number | null>(null);
  const mounted = useRef(false);

  const weighted = ledger.items.filter((item) => item.stance === "bear" || item.stance === "bull");
  const total = ledger.bull + ledger.bear;
  // 与原型相同的倾角映射：净权重相对总权重，最多 ±12°。
  const target = total > 0 ? Math.max(-1, Math.min(1, (ledger.bull - ledger.bear) / (total * 0.35 + 2))) * 12 : 0;
  const signature = weighted.map((item) => `${item.id}:${item.stance}:${item.weight}`).join("|");

  useEffect(() => {
    const reduced = prefersReducedMotion();
    const instant = reduced || !mounted.current;
    mounted.current = true;
    const map = blocks.current;
    const seen = new Set<string>();
    for (const item of weighted) {
      seen.add(item.id);
      const side = item.stance as "bear" | "bull";
      const existing = map.get(item.id);
      if (existing && existing.side === side) {
        existing.target = item.weight * 12;
        continue;
      }
      existing?.el.remove();
      const parent = side === "bear" ? leftBlocksRef.current : rightBlocksRef.current;
      if (!parent) continue;
      const color = side === "bear" ? EVB_COLORS.rise : EVB_COLORS.fall;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("height", "7");
      rect.setAttribute("rx", "1");
      rect.setAttribute("fill", alpha(color, 0.35));
      rect.setAttribute("stroke", color);
      rect.setAttribute("stroke-width", "0.8");
      parent.appendChild(rect);
      map.set(item.id, { side, el: rect, target: item.weight * 12, y: { value: instant ? 0 : -38, velocity: 0 }, w: { value: item.weight * 12, velocity: 0 } });
    }
    for (const [id, block] of map) {
      if (seen.has(id)) continue;
      block.el.remove();
      map.delete(id);
    }
    if (instant) beam.current = { value: target, velocity: 0 };

    const render = () => {
      const th = beam.current.value;
      const rad = (th * Math.PI) / 180;
      const pivot = `translate(${BAL.px} ${BAL.py}) rotate(${th.toFixed(3)})`;
      beamRef.current?.setAttribute("transform", pivot);
      needleRef.current?.setAttribute("transform", pivot);
      leftRef.current?.setAttribute("transform", `translate(${(BAL.px - BAL.L * Math.cos(rad)).toFixed(2)} ${(BAL.py - BAL.L * Math.sin(rad)).toFixed(2)})`);
      rightRef.current?.setAttribute("transform", `translate(${(BAL.px + BAL.L * Math.cos(rad)).toFixed(2)} ${(BAL.py + BAL.L * Math.sin(rad)).toFixed(2)})`);
      for (const side of ["bear", "bull"] as const) {
        const list = [...map.values()].filter((block) => block.side === side);
        // 秤盘宽 116：砝码按行码放，满一行向上叠。
        let x = -54;
        let row = 0;
        for (const block of list) {
          const width = Math.max(1, block.w.value);
          if (x + width > 54 && x > -54) {
            x = -54;
            row += 1;
          }
          block.el.setAttribute("x", x.toFixed(2));
          block.el.setAttribute("width", width.toFixed(2));
          block.el.setAttribute("y", (BAL.drop - 8 - row * 8 + block.y.value).toFixed(2));
          block.el.setAttribute("opacity", Math.max(0, Math.min(1, 1 + block.y.value / 38)).toFixed(2));
          x += width + 2;
        }
      }
    };

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      beam.current = reduced ? { value: target, velocity: 0 } : stepSpring(beam.current, target, dt, { stiffness: 42, damping: 5.2 });
      let settled = Math.abs(beam.current.value - target) < 0.01 && Math.abs(beam.current.velocity) < 0.01;
      for (const block of map.values()) {
        block.y = reduced ? { value: 0, velocity: 0 } : stepSpring(block.y, 0, dt, { stiffness: 190, damping: 16 });
        block.w = reduced ? { value: block.target, velocity: 0 } : stepSpring(block.w, block.target, dt, { stiffness: 120, damping: 18 });
        if (Math.abs(block.y.value) > 0.05 || Math.abs(block.w.value - block.target) > 0.05) settled = false;
      }
      render();
      frame.current = settled ? null : requestAnimationFrame(tick);
    };
    render();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    // 只在账本内容（立场 / 权重）变化时重新驱动弹簧；weighted 由 signature 完整描述。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, target]);

  const bearCount = weighted.filter((item) => item.stance === "bear").length;
  const bullCount = weighted.length - bearCount;
  return <section className="evb-bal">
    <div className="evb-bal-top">
      <span className="evb-micro">{uiText("证据天平", "Evidence balance")}</span>
      <span className="evb-rule">{uiText("|净| / 总 < 20% → 证据冲突", "|net| / total < 20% → conflict")}</span>
    </div>
    <div className="evb-bal-stage">
      <svg className="evb-bal-svg" viewBox="0 0 600 118" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g>
          {Array.from({ length: 9 }, (_, index) => {
            const angle = -12 + index * 3;
            const radian = ((angle - 90) * Math.PI) / 180;
            const inner = angle % 6 === 0 ? 19 : 21;
            return <line key={angle} x1={BAL.px + Math.cos(radian) * inner} y1={BAL.py + Math.sin(radian) * inner} x2={BAL.px + Math.cos(radian) * 24} y2={BAL.py + Math.sin(radian) * 24} stroke={angle === 0 ? EVB_COLORS.ink2 : EVB_COLORS.ink4} strokeWidth={1} />;
          })}
          <text x={BAL.px - 30} y={BAL.py - 12} fill={EVB_COLORS.rise} fontSize={9.5} fontFamily={MONO} textAnchor="middle">{uiText("空", "S")}</text>
          <text x={BAL.px + 30} y={BAL.py - 12} fill={EVB_COLORS.fall} fontSize={9.5} fontFamily={MONO} textAnchor="middle">{uiText("多", "L")}</text>
        </g>
        <line x1={BAL.px} y1={BAL.py} x2={BAL.px} y2={94} stroke={EVB_COLORS.ink3} strokeWidth={1.2} />
        <path d={`M${BAL.px - 34} 94 L${BAL.px + 34} 94`} stroke={EVB_COLORS.ink3} strokeWidth={1.2} strokeLinecap="round" />
        <path d={`M${BAL.px - 12} 94 L${BAL.px} 83 L${BAL.px + 12} 94`} stroke={EVB_COLORS.ink4} strokeWidth={1} fill="none" />
        <g ref={beamRef} transform={`translate(${BAL.px} ${BAL.py})`}>
          <line x1={-BAL.L} y1={0} x2={BAL.L} y2={0} stroke={EVB_COLORS.ink} strokeWidth={1.6} strokeLinecap="round" />
          {[-4, -3, -2, -1, 1, 2, 3, 4].map((tick) => <line key={tick} x1={tick * (BAL.L / 4.5)} y1={-2.5} x2={tick * (BAL.L / 4.5)} y2={2.5} stroke={EVB_COLORS.ink3} strokeWidth={1} />)}
          <circle cx={-BAL.L} cy={0} r={2.6} fill={EVB_COLORS.bg} stroke={EVB_COLORS.ink} strokeWidth={1.2} />
          <circle cx={BAL.L} cy={0} r={2.6} fill={EVB_COLORS.bg} stroke={EVB_COLORS.ink} strokeWidth={1.2} />
        </g>
        {(["bear", "bull"] as const).map((side) => {
          const color = side === "bear" ? EVB_COLORS.rise : EVB_COLORS.fall;
          return <g key={side} ref={side === "bear" ? leftRef : rightRef} transform={`translate(${side === "bear" ? BAL.px - BAL.L : BAL.px + BAL.L} ${BAL.py})`}>
            <path d={`M0 0 L-50 ${BAL.drop} M0 0 L50 ${BAL.drop}`} stroke={EVB_COLORS.ink4} strokeWidth={0.8} />
            <g ref={side === "bear" ? leftBlocksRef : rightBlocksRef} />
            <path d={`M-58 ${BAL.drop} Q0 ${BAL.drop + 16} 58 ${BAL.drop}`} stroke={EVB_COLORS.ink2} strokeWidth={1.3} fill={alpha(color, 0.05)} />
            <path d={`M-58 ${BAL.drop} L58 ${BAL.drop}`} stroke={alpha(color, 0.5)} strokeWidth={1} />
          </g>;
        })}
        <line ref={needleRef} x1={0} y1={0} x2={0} y2={-20} stroke={EVB_COLORS.ink} strokeWidth={1.4} strokeLinecap="round" transform={`translate(${BAL.px} ${BAL.py})`} />
        <circle cx={BAL.px} cy={BAL.py} r={3.6} fill={running ? EVB_COLORS.ai : EVB_COLORS.ink3} />
      </svg>
      <div className="evb-bal-total is-bear"><span className="evb-micro">{uiText("偏空", "Bearish")}</span><RollingNumber value={ledger.bear} /><span className="evb-cnt">{uiText(`${bearCount} 条`, `${bearCount} items`)}</span></div>
      <div className="evb-bal-total is-bull"><span className="evb-micro">{uiText("偏多", "Bullish")}</span><RollingNumber value={ledger.bull} /><span className="evb-cnt">{uiText(`${bullCount} 条`, `${bullCount} items`)}</span></div>
      <div className="evb-bal-readout">
        {total > 0
          ? <>{uiText("净", "Net")} <b>{ledger.net > 0 ? "+" : ledger.net < 0 ? "−" : ""}{Math.abs(ledger.net).toFixed(1)}</b> · {uiText("总", "Total")} <b>{total.toFixed(1)}</b> · {uiText("冲突度", "Conflict")} <b>{Math.round((ledger.conflict ?? 0) * 100)}%</b></>
          : uiText("等待证据", "Awaiting evidence")}
      </div>
    </div>
    <Outcomes decision={ledger.decision} conflict={ledger.conflict} uiText={uiText} />
  </section>;
}

// 合计权重：数值变化时滚动到新值（与原型的里程表读数一致）。
function RollingNumber({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const shown = useRef(value);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const from = shown.current;
    shown.current = value;
    if (from === value || prefersReducedMotion()) {
      element.textContent = value.toFixed(1);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 520);
      const eased = 1 - Math.pow(1 - p, 3);
      element.textContent = (from + (value - from) * eased).toFixed(1);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className="evb-num" ref={ref}>{value.toFixed(1)}</span>;
}

function Outcomes({ decision, conflict, uiText }: { decision: EvidenceDecision | null; conflict: number | null; uiText: UiText }) {
  const stampRef = useRef<HTMLDivElement | null>(null);
  const seenRef = useRef<string | undefined>(undefined);
  const stampKey = decision ? `${decision.outcome}:${decision.recordedAt ?? ""}` : "";
  useEffect(() => {
    const first = seenRef.current === undefined;
    const changed = seenRef.current !== stampKey;
    seenRef.current = stampKey;
    if (!stampKey || first || !changed || prefersReducedMotion() || !stampRef.current) return;
    stampRef.current.animate([
      { transform: "rotate(-4deg) scale(1.5)", opacity: 0 },
      { transform: "rotate(0.6deg) scale(0.985)", opacity: 1, offset: 0.62 },
      { transform: "none", opacity: 1 }
    ], { duration: 560, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)" });
  }, [stampKey]);
  const slot = decision?.outcome === "short" ? "short" : decision?.outcome === "long" ? "long" : decision ? "mid" : null;
  const label = decision?.outcome === "long" ? uiText("开多", "Long") : decision?.outcome === "short" ? uiText("开空", "Short") : decision?.outcome === "hold" ? uiText("持有", "Hold") : uiText("放弃", "Abstain");
  const sub = conflict !== null && conflict >= 0.8 ? uiText("证据冲突", "Conflicting") : uiText("账本决策", "Ledger decision");
  const stamp = <div className="evb-stamp" ref={stampRef} title={decision?.reason}>{label} <small>{sub}</small></div>;
  return <>
    <div className="evb-outcomes">
      <div className="evb-oc is-short">{uiText("开空", "Short")}{slot === "short" ? stamp : null}</div>
      <div className="evb-oc"><em>{uiText("待决策", "Pending")}</em>{slot === "mid" ? stamp : null}</div>
      <div className="evb-oc is-long">{uiText("开多", "Long")}{slot === "long" ? stamp : null}</div>
    </div>
    <div className={clsx("evb-no-trade", decision?.outcome === "abstain" && "is-on")}>{uiText("不交易也是有效决策 · 等待证据收敛", "Not trading is a valid decision · waiting for evidence to converge")}</div>
  </>;
}

// —— 详情：原型的检查器视图，大图 + 指标 + 来源调用 + 账本字段 ——
function EvidenceDetail({ card, messageId, uiText, onClose, onOpenArtifact }: { card: CardModel; messageId: string; uiText: UiText; onClose: () => void; onOpenArtifact?: (artifact: AiResearchArtifact) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draw = useMemo(() => evidenceDrawer(card.tool), [card.tool]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !draw) return;
    const rect = canvas.getBoundingClientRect();
    const context = prepCanvas(canvas, rect.width, rect.height);
    if (context) draw(context, rect.width, rect.height, true);
  }, [draw]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [onClose]);
  const result = card.tool ? toolResultRecord(card.tool) : {};
  const metrics = Object.entries(result)
    .filter(([key, value]) => key !== "evidenceRef" && key !== "evidenceLedgerReminder" && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 40)))
    .slice(0, 8);
  const stanceLabel = card.state === "bear" ? uiText("偏空", "Bearish") : card.state === "bull" ? uiText("偏多", "Bullish") : card.state === "neutral" ? card.kindLabel ?? uiText("中性", "Neutral") : uiText("待定", "Pending");
  const args = card.tool?.arguments && typeof card.tool.arguments === "object" ? Object.entries(card.tool.arguments as Record<string, unknown>) : [];
  const call = card.tool ? `${card.tool.name}(${args.map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ")})` : "";
  const artifact = card.tool && onOpenArtifact ? aiResearchArtifactForTool(card.tool, messageId) : null;
  return <div className="evb-detail" role="dialog" aria-label={card.claim}>
    <div className="evb-detail-bar">
      <button type="button" className="evb-btn" onClick={onClose}><ArrowLeft size={13} />{uiText("返回证据板", "Back")}</button>
      {artifact && onOpenArtifact ? <button type="button" className="evb-btn" onClick={() => onOpenArtifact(artifact)}><ExternalLink size={13} />{uiText("在检查器中打开", "Open in inspector")}</button> : null}
    </div>
    <div className={clsx("evb-detail-head", `is-${card.state}`)}>
      <div className="evb-row1">
        <span className="evb-stance">{stanceLabel}</span>
        {card.item && card.state !== "neutral" ? <span>{uiText("权重", "Weight")} {card.previousWeight !== null ? `${card.previousWeight.toFixed(1)} → ` : ""}{card.weight.toFixed(1)}</span> : null}
        {card.via ? <span>via {card.via}</span> : null}
        <span>{card.refs.join(" · ")}</span>
      </div>
      <h2>{card.claim}</h2>
    </div>
    {draw ? <canvas className="evb-detail-canvas" ref={canvasRef} aria-hidden="true" /> : null}
    {metrics.length > 0 ? <div className="evb-metrics">{metrics.map(([key, value]) => <div key={key}><span>{key}</span><b>{String(value)}</b></div>)}</div> : null}
    <div className="evb-prov">
      {call ? <><span>{uiText("来源调用", "Source call")}</span><code>{call}</code></> : null}
      {card.item ? <><span>{uiText("账本字段", "Ledger fields")}</span><code>{JSON.stringify({ id: card.item.id, stance: card.item.stance, weight: card.item.weight, sourceRefs: card.item.sourceRefs, ...(card.item.revisionNote ? { revisionNote: card.item.revisionNote } : {}) }, null, 2)}</code></> : null}
    </div>
  </div>;
}

// —— FLIP：卡片在待定区与立场列之间的物理位移（平移 + 缩放，与原型一致）——
function useFlip(hostRef: RefObject<HTMLDivElement | null>, signature: string) {
  const rects = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const previous = rects.current;
    const next = new Map<string, DOMRect>();
    const animate = !prefersReducedMotion() && previous.size > 0;
    for (const node of host.querySelectorAll<HTMLElement>("[data-flip-key]")) {
      const key = node.dataset.flipKey!;
      const rect = node.getBoundingClientRect();
      next.set(key, rect);
      if (!animate || rect.width === 0) continue;
      const before = previous.get(key) ?? (node.dataset.flipOrigin ? previous.get(node.dataset.flipOrigin) : undefined);
      if (!before) {
        node.animate([{ opacity: 0, transform: "translateY(8px) scale(0.97)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: EASE });
        continue;
      }
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      const sx = before.width / rect.width;
      const sy = before.height / rect.height;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      node.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: "none" }], { duration: 560, easing: EASE });
    }
    rects.current = next;
  }, [hostRef, signature]);
}

// —— 消息流内的紧凑摘要：有账本的回合一行天平，点击打开证据板 ——
export function AiEvidenceSummaryStrip({ message, uiText, onOpen }: { message: AiUiMessage; uiText: UiText; onOpen: () => void }) {
  const ledger = useMemo(() => deriveEvidenceLedger(message), [message]);
  if (!ledger.hasLedger) return null;
  const tilt = ledger.total > 0 ? Math.max(-1, Math.min(1, ledger.net / (ledger.total * 0.35 + 2))) : 0;
  const outcome = ledger.decision?.outcome;
  const outcomeLabel = outcome === "long" ? uiText("开多", "Long") : outcome === "short" ? uiText("开空", "Short") : outcome === "hold" ? uiText("持有", "Hold") : outcome === "abstain" ? uiText("放弃", "Abstain") : uiText("待决策", "Pending");
  return <button type="button" className="ai-evidence-strip" onClick={onOpen} title={uiText("打开证据天平", "Open evidence balance")}>
    <Scale size={13} />
    <span className="ai-evidence-strip-side is-bear">{uiText("空", "Bear")} {ledger.bear.toFixed(1)}</span>
    <span className="ai-evidence-strip-beam" aria-hidden="true"><i style={{ transform: `rotate(${tilt * 12}deg)` }} /></span>
    <span className="ai-evidence-strip-side is-bull">{uiText("多", "Bull")} {ledger.bull.toFixed(1)}</span>
    {ledger.conflict !== null ? <small>{uiText("冲突度", "Conflict")} {Math.round(ledger.conflict * 100)}%</small> : null}
    <b className={clsx("ai-evidence-strip-outcome", outcome && `is-${outcome}`)}>{outcomeLabel}</b>
  </button>;
}
