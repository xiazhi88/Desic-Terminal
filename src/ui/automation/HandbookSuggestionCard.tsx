import { useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, FileDiff, Loader2, Sparkles, X } from "lucide-react";
import { cancelTraderDraft, draftHandbookSuggestion, listenAiEvents } from "../../lib/ai";
import { setupToText } from "../../lib/handbookText";
import type { AiOptimizationSuggestion } from "../../types";
import { useHandbookLabels } from "./HandbookEditor";
import { diffTextLines, TextDiffTable } from "./TextDiff";
import { commandErrorText, newDraftRequestId } from "./traderApi";
import "./trader-workspace.css";

function asLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "")).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 交易手册建议（由你的纠正生成）：列出纠正 → 让 AI 起草修改 → 在卡片里看前后差异 → 采用或拒绝。
 * 采用 = 直接替换原形态并发布手册的新版次（id、状态、暂停不变），可在交易手册的版次里一键回退。
 */
export function HandbookSuggestionCard({
  item,
  focused,
  busy,
  statusBadge,
  onUpdate,
  onDrafted
}: {
  item: AiOptimizationSuggestion;
  focused: boolean;
  busy: boolean;
  statusBadge: ReactNode;
  onUpdate: (id: string, status: string) => Promise<boolean>;
  onDrafted: () => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const { displayName, textLabels } = useHandbookLabels();
  const [diffOpen, setDiffOpen] = useState(false);
  const [drafting, setDrafting] = useState<{ requestId: string; chars: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detail = item.handbook ?? null;
  const settled = ["applied", "accepted", "rejected"].includes(item.status);
  const proposed = detail?.proposedSetup ?? null;
  const baseline = detail?.baselineSetup ?? null;
  const rows = useMemo(
    () => (proposed && baseline ? diffTextLines(setupToText(baseline, textLabels), setupToText(proposed, textLabels)) : []),
    [baseline, proposed, textLabels]
  );

  const draft = async () => {
    const requestId = newDraftRequestId("setup-revision");
    setDrafting({ requestId, chars: 0 });
    setError(null);
    const dispose = await listenAiEvents((event) => {
      if (event.type === "agentDraftDelta" && event.requestId === requestId) setDrafting((current) => (current ? { ...current, chars: event.chars } : current));
    });
    try {
      await draftHandbookSuggestion(item.id, requestId);
      onDrafted();
    } catch (reason) {
      const message = commandErrorText(reason);
      if (!message.includes("已取消")) setError(message);
      onDrafted();
    } finally {
      dispose?.();
      setDrafting(null);
    }
  };

  return (
    <article className={clsx("automation-suggestion-card is-handbook", focused && "focused")} data-handbook-suggestion={item.id}>
      <div className="automation-suggestion-card-head">
        <div className="automation-suggestion-title">
          <span className="automation-suggestion-led is-handbook"><BookOpen size={14} /></span>
          <div>
            <strong data-i18n-skip>{item.title}</strong>
            <p data-i18n-skip>{asText(item.problem)}</p>
          </div>
        </div>
        <div className="automation-suggestion-badges">
          <span className="hsg-kind">{t("automation:handbookSuggestionKind")}</span>
          {statusBadge}
          <span>{t("automation:handbookSuggestionCorrections", { count: item.sampleSize })}</span>
        </div>
      </div>
      <div className="hsg-body">
        <section>
          <span className="hsg-label">{t("automation:handbookSuggestionEvidence")}</span>
          <ul className="hsg-evidence" data-i18n-skip>
            {asLines(item.evidence).map((line) => <li key={line}>{line.replace(/^-\s*/, "")}</li>)}
          </ul>
        </section>
        {proposed ? (
          <div className="hsg-draft">
            <section><span className="hsg-label">{t("automation:proposedChangesLabel")}</span><p data-i18n-skip>{asText(item.proposedChanges) || "—"}</p></section>
            <section><span className="hsg-label">{t("automation:handbookSuggestionBenefits")}</span><p data-i18n-skip>{asText(item.benefits) || "—"}</p></section>
            <section><span className="hsg-label">{t("automation:risksLabel")}</span><p data-i18n-skip>{asText(item.risks) || "—"}</p></section>
          </div>
        ) : !settled ? (
          <p className="hsg-hint">{t("automation:handbookSuggestionNotDrafted")}</p>
        ) : null}
        {detail?.draftError ? <p className="hsg-error" data-i18n-skip>{t("automation:handbookSuggestionDraftFailed", { error: detail.draftError })}</p> : null}
        {error ? <p className="hsg-error" role="alert" data-i18n-skip>{error}</p> : null}
        {diffOpen && proposed && baseline ? (
          <div className="hsg-diff" data-handbook-suggestion-diff-view>
            <TextDiffTable
              rows={rows}
              ariaLabel={t("automation:handbookSuggestionDiff")}
              oldLabel={t("automation:handbookSuggestionBefore", { revision: detail?.handbookRevision ?? "?" })}
              newLabel={t("automation:handbookSuggestionAfter")}
            />
          </div>
        ) : null}
      </div>
      <div className="automation-suggestion-footer">
        <div className="automation-suggestion-skill">
          <span data-i18n-skip>
            {[
              `${t("automation:handbookSuggestionTarget")} ${displayName(detail?.handbookName ?? null)}`,
              detail?.handbookRevision ? t("automation:handbookRevision", { revision: detail.handbookRevision }) : null,
              detail?.setupId ?? null
            ].filter(Boolean).join(" · ")}
          </span>
        </div>
        {!settled ? (
          <div>
            <button type="button" disabled={busy || Boolean(drafting)} onClick={() => void onUpdate(item.id, "rejected")}><X size={14} />{t("automation:handbookSuggestionReject")}</button>
            {drafting ? (
              <button type="button" onClick={() => void cancelTraderDraft(drafting.requestId)} data-handbook-suggestion-cancel>
                <Loader2 className="spin" size={14} />{t("automation:handbookSuggestionDrafting", { chars: drafting.chars })}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void draft()} data-handbook-suggestion-draft>
                <Sparkles size={14} />{proposed ? t("automation:handbookSuggestionRedraft") : t("automation:handbookSuggestionDraft")}
              </button>
            )}
            {proposed ? (
              <button type="button" disabled={busy || Boolean(drafting)} onClick={() => setDiffOpen((open) => !open)} data-handbook-suggestion-diff>
                <FileDiff size={14} />{diffOpen ? t("automation:handbookSuggestionHideDiff") : t("automation:handbookSuggestionShowDiff")}
              </button>
            ) : null}
            {proposed && diffOpen ? (
              <button type="button" className="primary" disabled={busy || Boolean(drafting)} onClick={() => void onUpdate(item.id, "applied")} data-handbook-suggestion-apply>
                {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}{t("automation:handbookSuggestionApply")}
              </button>
            ) : null}
          </div>
        ) : proposed ? (
          <button type="button" onClick={() => setDiffOpen((open) => !open)} data-handbook-suggestion-diff>
            <FileDiff size={14} />{diffOpen ? t("automation:handbookSuggestionHideDiff") : t("automation:handbookSuggestionShowDiff")}
          </button>
        ) : null}
      </div>
    </article>
  );
}
