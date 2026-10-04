import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { cardHoldMs, toolLabel, type VoiceDecision, type VoiceEvidenceItem, type VoiceEvidenceSource, type VoiceEvidenceStance } from "../../lib/voice/voiceAgentModel";

type UiText = (chinese: string, english: string) => string;

const STANCE_LABELS: Record<VoiceEvidenceStance, [string, string]> = {
  bull: ["偏多", "Bullish"],
  bear: ["偏空", "Bearish"],
  neutral: ["中性", "Neutral"],
  constraint: ["约束", "Constraint"],
};
const OUTCOME_LABELS: Record<VoiceDecision["outcome"], [string, string]> = {
  long: ["倾向做多", "Leaning long"],
  short: ["倾向做空", "Leaning short"],
  abstain: ["观望", "Stand aside"],
  hold: ["持有", "Hold"],
};

type StageCard = {
  id: string;
  kind: "evidence" | "decision";
  /** 立场或结论类型，决定颜色。 */
  tone: string;
  label: [string, string];
  weight: number | null;
  text: string;
  refs: string[];
};

function buildCards(evidence: readonly VoiceEvidenceItem[], decision: VoiceDecision | null): StageCard[] {
  const cards: StageCard[] = evidence.map((item) => ({ id: item.id, kind: "evidence", tone: item.stance, label: STANCE_LABELS[item.stance], weight: item.weight, text: item.claim, refs: item.sourceRefs }));
  if (decision) cards.push({ id: "decision", kind: "decision", tone: `outcome-${decision.outcome}`, label: ["结论 · " + OUTCOME_LABELS[decision.outcome][0], "Verdict · " + OUTCOME_LABELS[decision.outcome][1]], weight: null, text: decision.reason, refs: [] });
  return cards;
}

/** 权重 0–3 画成三格像素点。 */
function WeightPips({ weight }: { weight: number }) {
  const lit = Math.round(weight);
  return (
    <span className="director-pips" aria-label={`weight ${weight}`}>
      {[0, 1, 2].map((index) => (
        <i key={index} className={index < lit ? "is-on" : undefined} />
      ))}
    </span>
  );
}

function CardView({ card, sources, openRef, onToggleRef, leaving, uiText }: { card: StageCard; sources: Record<string, VoiceEvidenceSource>; openRef: string | null; onToggleRef: (ref: string) => void; leaving?: boolean; uiText: UiText }) {
  const opened = openRef ? sources[openRef] : null;
  return (
    <div className={clsx("director-card", `is-${card.tone}`, card.kind === "decision" && "is-decision", leaving ? "is-leaving" : "is-entering")}>
      <div className="director-card-head">
        <span className="director-stance">{uiText(...card.label)}</span>
        {card.weight !== null && <WeightPips weight={card.weight} />}
      </div>
      <div className="director-card-claim">{card.text}</div>
      {card.refs.length > 0 && (
        <div className="director-card-refs">
          {card.refs.map((ref) => (
            <button key={ref} type="button" className={clsx("director-ref", openRef === ref && "is-open", !sources[ref] && "is-missing")} onClick={() => onToggleRef(ref)}>
              {ref}
            </button>
          ))}
        </div>
      )}
      {openRef && card.refs.includes(openRef) && (
        <div className="director-source">
          <b>{openRef}</b>
          {opened ? (
            <span>{uiText(...toolLabel(opened.tool))}{opened.summary ? ` — ${opened.summary}` : ""}</span>
          ) : (
            <span>{uiText("没有找到这条来源", "Source not found")}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 证据舞台：一次只演一张卡，播完停留一小段时间后自动换下一张；下方一排点是进度，点击可跳到某张并暂停自动播放。
 * 舞台高度有上限，不会像一排卡片那样顶出窗口、遮住行情。
 */
export function EvidenceStage({ evidence, decision, sources, uiText }: { evidence: readonly VoiceEvidenceItem[]; decision: VoiceDecision | null; sources: Record<string, VoiceEvidenceSource>; uiText: UiText }) {
  const cards = buildCards(evidence, decision);
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState<StageCard | null>(null);
  const [locked, setLocked] = useState(false);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const shownAt = useRef(Date.now());
  const current = cards[Math.min(index, cards.length - 1)];

  const goTo = (next: number) => {
    if (next === index || !cards[next]) return;
    setLeaving(cards[index] ?? null);
    setIndex(next);
    setOpenRef(null);
    shownAt.current = Date.now();
  };

  // 自动编排：当前这张停够时间就换下一张；新卡晚到时，停够了的会立刻接上。
  useEffect(() => {
    if (locked || !current || index >= cards.length - 1) return;
    const wait = Math.max(0, cardHoldMs(current.text) - (Date.now() - shownAt.current));
    const timer = window.setTimeout(() => goTo(index + 1), wait);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, cards.length, locked, current?.id]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), 280);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (!current) return null;
  const playing = !locked && index < cards.length - 1;

  return (
    <div className="director-stage" aria-label={uiText("分析证据", "Evidence")}>
      <div className="director-stage-slot">
        {leaving && leaving.id !== current.id && <CardView key={`out-${leaving.id}`} card={leaving} sources={sources} openRef={null} onToggleRef={() => undefined} leaving uiText={uiText} />}
        <CardView key={current.id} card={current} sources={sources} openRef={openRef} onToggleRef={(ref) => { setLocked(true); setOpenRef(openRef === ref ? null : ref); }} uiText={uiText} />
      </div>
      {cards.length > 1 && (
        <div className="director-stage-dots" role="tablist">
          {cards.map((card, position) => (
            <button
              key={card.id}
              type="button"
              role="tab"
              aria-selected={position === index}
              className={clsx("director-dot", `is-${card.tone}`, position === index && "is-current", position < index && "is-seen")}
              onClick={() => { setLocked(true); goTo(position); }}
              title={card.text}
            >
              {position === index && playing && <span key={`${current.id}-${index}`} className="director-dot-fill" style={{ animationDuration: `${cardHoldMs(current.text)}ms` }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
