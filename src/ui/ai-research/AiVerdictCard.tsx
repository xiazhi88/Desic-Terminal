import { useMemo } from "react";
import clsx from "clsx";
import { buildVerdict, confidenceLabel, type Verdict } from "../../lib/aiVerdict";
import type { AiToolRun } from "../AiMessageProcess";

type UiText = (zh: string, en: string) => string;

const OUTCOME: Record<Verdict["outcome"], [string, string]> = {
  long: ["倾向做多", "Leaning long"],
  short: ["倾向做空", "Leaning short"],
  abstain: ["观望", "Stand aside"],
  hold: ["持有", "Hold"],
};
const CONFIDENCE: Record<ReturnType<typeof confidenceLabel>, [string, string]> = { high: ["高", "High"], mid: ["中", "Medium"], low: ["低", "Low"] };

const price = (value: number | null) => (value === null ? "--" : value >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 1 }) : value >= 10 ? value.toFixed(2) : value.toFixed(4));
const pad = (n: number) => String(n).padStart(2, "0");

function expiryLabel(expiresAt: number, uiText: UiText): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return uiText("已过期", "Expired");
  const hours = ms / 3_600_000;
  if (hours < 1) return uiText(`${Math.max(1, Math.round(ms / 60_000))} 分钟内`, `within ${Math.max(1, Math.round(ms / 60_000))} min`);
  if (hours < 48) return uiText(`${Math.round(hours)} 小时内`, `within ${Math.round(hours)} h`);
  const d = new Date(expiresAt);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 回答顶部的结论卡：把 AI 这一轮真正产出的「倾向 + 交易计划」放在最前面。
 * 只在本轮调用过 `tradeOpportunity.create` / `research.recordDecision` 时出现；数据全部来自工具结果。
 */
export function AiVerdictCard({ tools, uiText, onOpenEvidence }: { tools: readonly AiToolRun[]; uiText: UiText; onOpenEvidence: () => void }) {
  const verdict = useMemo(() => buildVerdict(tools), [tools]);
  if (!verdict) return null;
  const base = verdict.instId?.replace(/-USDT-SWAP$/, "") ?? "";
  const label = confidenceLabel(verdict.confidence ?? 0);
  const cells: [string, string | null][] = [
    [uiText("入场", "Entry"), verdict.entry === null ? null : price(verdict.entry)],
    [uiText("止损", "Stop"), verdict.stop === null ? null : price(verdict.stop)],
    [uiText("止盈", "Target"), verdict.target === null ? null : price(verdict.target)],
    [uiText("盈亏比", "R : R"), verdict.rewardRisk === null ? null : verdict.rewardRisk.toFixed(2)],
    [uiText("规模", "Size"), verdict.size === null ? null : `${verdict.size}${uiText(" 张", " ct")}${verdict.leverage ? ` · ${verdict.leverage}x` : ""}`],
    [uiText("有效期", "Valid"), verdict.expiresAt === null ? null : expiryLabel(verdict.expiresAt, uiText)],
  ];
  const shown = cells.filter(([, value]) => value !== null);
  return (
    <section className={clsx("ai-verdict", `is-${verdict.outcome}`, shown.length === 0 && !verdict.opportunityId && "is-slim")} aria-label={uiText("本轮结论", "Verdict")}>
      <div className="ai-verdict-top">
        <span className="ai-verdict-kicker">{uiText("结论", "Verdict")}</span>
        <span className="ai-verdict-badge">{uiText(...OUTCOME[verdict.outcome])}{base ? ` · ${base}` : ""}</span>
        {verdict.confidence !== null && (
          <span className="ai-verdict-conf" title={`${Math.round(verdict.confidence * 100)}%`}>
            {uiText("把握度", "Confidence")}
            <i><b style={{ width: `${Math.round(verdict.confidence * 100)}%` }} /></i>
            {uiText(...CONFIDENCE[label])}
          </span>
        )}
      </div>
      {verdict.headline && <p className="ai-verdict-say">{verdict.headline}</p>}
      {shown.length > 0 && (
        <dl className="ai-verdict-grid">
          {shown.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl>
      )}
      <div className="ai-verdict-foot">
        {verdict.opportunityId && (
          <button type="button" className="is-link" onClick={() => window.dispatchEvent(new CustomEvent("desic:open-trade-opportunity", { detail: { id: verdict.opportunityId } }))}>
            {uiText("已存为待审批 · 打开交易机会 →", "Saved for approval · Open opportunity →")}
          </button>
        )}
        <button type="button" onClick={onOpenEvidence}>{uiText("看证据与天平", "Evidence & balance")}</button>
      </div>
    </section>
  );
}
