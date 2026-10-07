import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { History, Loader2, RotateCcw, X } from "lucide-react";
import { formatLocalizedDate } from "../../i18n/runtime";
import type { TraderHandbook, TraderHandbookPublished, TraderHandbookRevision } from "../../lib/ai";
import { handbookToText, type HandbookTextLabels } from "../../lib/handbookText";
import { AutomationConfirmDialog } from "./AutomationConfirmDialog";
import { diffTextLines, TextDiffTable } from "./TextDiff";
import { commandErrorText, type TraderHandbookApi } from "./traderApi";

/** 版次对比与回退。回退把旧版次的内容复制成新的一版（暂停保留、观察中的形态继续观察）。 */
export function HandbookVersions({
  api,
  handbookId,
  handbookName,
  currentRevision,
  readOnly,
  textLabels,
  onClose,
  onRestored
}: {
  api: TraderHandbookApi;
  handbookId: string;
  handbookName: string;
  currentRevision: number;
  readOnly: boolean;
  textLabels: HandbookTextLabels;
  onClose: () => void;
  onRestored: (published: TraderHandbookPublished) => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const [revisions, setRevisions] = useState<TraderHandbookRevision[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rollback" | "reset" | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.revisions(handbookId)
      .then((items) => {
        if (cancelled) return;
        setRevisions(items ?? []);
        setSelected(items?.find((item) => item.revision !== currentRevision)?.revision ?? items?.[0]?.revision ?? null);
      })
      .catch((reason) => {
        if (!cancelled) setError(commandErrorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [api, currentRevision, handbookId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirm) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirm, onClose]);

  const current = revisions?.find((item) => item.revision === currentRevision) ?? revisions?.[0] ?? null;
  const picked = revisions?.find((item) => item.revision === selected) ?? null;
  const rows = useMemo(() => {
    if (!picked?.content || !current?.content) return [];
    return diffTextLines(handbookToText(picked.content as TraderHandbook, textLabels), handbookToText(current.content as TraderHandbook, textLabels));
  }, [current, picked, textLabels]);
  const changed = rows.some((row) => row.kind !== "same");
  const sourceLabel = (source: string | null) => t(`automation:handbookSource_${source ?? "legacy"}`, { defaultValue: source ?? "—" });

  const restore = useCallback(async (toRevision: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const published = await api.rollback(handbookId, toRevision, currentRevision);
      if (published) onRestored(published);
    } catch (reason) {
      setError(commandErrorText(reason));
    } finally {
      setBusy(false);
    }
  }, [api, currentRevision, handbookId, onRestored]);

  return createPortal(
    <div className="modal-backdrop hbe-versions-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="modal-shell hbe-versions" role="dialog" aria-modal="true" aria-label={t("automation:handbookVersionsTitle", { name: handbookName })} data-handbook-versions>
        <header className="modal-head">
          <div><History size={15} /><strong data-i18n-skip>{t("automation:handbookVersionsTitle", { name: handbookName })}</strong></div>
          <button type="button" className="window-button" onClick={onClose} disabled={busy} aria-label={t("common:close")}><X size={16} /></button>
        </header>
        <div className="hbe-versions__body">
          <nav className="hbe-versions__list" aria-label={t("automation:handbookVersions")}>
            {revisions === null && !error ? <span className="hbe-muted"><Loader2 className="spin" size={13} />{t("common:loading")}</span> : null}
            {revisions?.length === 0 ? <span className="hbe-muted">{t("automation:handbookVersionsEmpty")}</span> : null}
            {revisions?.map((item) => (
              <button
                type="button"
                key={item.revision}
                className={clsx(item.revision === selected && "is-selected")}
                onClick={() => setSelected(item.revision)}
                data-handbook-revision={item.revision}
              >
                <strong>
                  {t("automation:handbookRevision", { revision: item.revision })}
                  {item.revision === currentRevision ? <em>{t("automation:handbookVersionCurrent")}</em> : null}
                </strong>
                <span>{sourceLabel(item.source)} · {formatLocalizedDate(item.createdAt, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                {item.note ? <small data-i18n-skip>{item.note}</small> : null}
              </button>
            ))}
          </nav>
          <div className="hbe-versions__diff">
            {picked && current ? (
              picked.revision === current.revision ? (
                <p className="hbe-muted">{t("automation:handbookVersionIsCurrent")}</p>
              ) : !changed ? (
                <p className="hbe-muted">{t("automation:handbookVersionNoChanges")}</p>
              ) : (
                <TextDiffTable
                  rows={rows}
                  context={2}
                  collapsedLabel={(count) => t("automation:handbookVersionCollapsed", { count })}
                  className="hbe-versions__table"
                  ariaLabel={t("automation:handbookVersionCompare")}
                  oldLabel={t("automation:handbookRevision", { revision: picked.revision })}
                  newLabel={`${t("automation:handbookRevision", { revision: current.revision })} · ${t("automation:handbookVersionCurrent")}`}
                />
              )
            ) : null}
          </div>
        </div>
        {error ? <p className="hbe-error" role="alert" data-i18n-skip>{error}</p> : null}
        <footer className="hbe-versions__foot">
          {!readOnly ? (
            <button type="button" className="pfe-btn is-ghost" disabled={busy} onClick={() => setConfirm("reset")} data-handbook-reset>
              {t("automation:handbookResetTemplate")}
            </button>
          ) : null}
          <span className="pfe-spacer" />
          {!readOnly && picked && current && picked.revision !== current.revision ? (
            <button type="button" className="pfe-btn is-primary" disabled={busy} onClick={() => setConfirm("rollback")} data-handbook-rollback>
              {busy ? <Loader2 className="spin" size={13} /> : <RotateCcw size={13} />}
              {t("automation:handbookRollbackTo", { revision: picked.revision })}
            </button>
          ) : null}
        </footer>
      </section>
      {confirm ? (
        <AutomationConfirmDialog
          title={confirm === "reset" ? t("automation:handbookResetConfirmTitle") : t("automation:handbookRollbackConfirmTitle", { revision: picked?.revision ?? "" })}
          message={t("automation:handbookRollbackConfirmDetail")}
          confirmText={confirm === "reset" ? t("automation:handbookResetTemplate") : t("automation:handbookRollbackTo", { revision: picked?.revision ?? "" })}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const target = confirm === "reset" ? null : picked?.revision ?? null;
            setConfirm(null);
            if (confirm === "reset" || target !== null) void restore(target);
          }}
        />
      ) : null}
    </div>,
    document.body
  );
}
