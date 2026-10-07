import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles, Trash2, X } from "lucide-react";
import type { TraderHandbookSetup } from "../../lib/ai";
import { HANDBOOK_LIMITS, HANDBOOK_REGIMES, validHandbookId } from "../../lib/handbookText";
import { TerminalSelect } from "../TerminalSelect";
import { EditorSegmented, HelpTip } from "./ProfileEditorControls";
import { commandErrorText, newDraftRequestId, type TraderHandbookApi } from "./traderApi";

type TextField = "name" | "entry" | "stop" | "target" | "invalidation";

/** 可空的数字框：留空表示不设限制；失焦时夹到合法范围。 */
function OptionalNumber({
  value,
  min,
  max,
  unit,
  ariaLabel,
  disabled,
  onChange
}: {
  value: number | undefined;
  min: number;
  max: number;
  unit?: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onChange(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(max, Math.max(min, Number(parsed.toFixed(2)))));
  };
  return (
    <span className={clsx("pfe-number", disabled && "is-disabled")}>
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? (value === undefined ? "" : String(value))}
        placeholder="—"
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          commit(event.target.value);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {unit ? <span>{unit}</span> : null}
    </span>
  );
}

function Field({ label, help, counter, error, children }: { label: string; help?: string; counter?: string | null; error?: string | null; children: ReactNode }) {
  return (
    <label className={clsx("hbe-field", error && "is-invalid")}>
      <span className="hbe-field__label">
        {label}
        {help ? <HelpTip text={help} /> : null}
        {counter ? <em>{counter}</em> : null}
      </span>
      {children}
      {error ? <small className="hbe-field__error">{error}</small> : null}
    </label>
  );
}

/**
 * 编辑一个形态（右侧抽屉）。「完成」只改编辑器里的副本，整本手册由底部的保存按钮发布成新版次。
 * 已经发布过的形态 id 不能改（决策、暂停、成绩都按它关联）。
 */
/**
 * 新形态的「用大白话描述你的打法」：交给 AI 起草，结果填进下面的表单（状态一律观察中），用户看过、改过再点完成。
 */
function SetupDraftAssist({
  api,
  handbookId,
  takenIds,
  onDraft
}: {
  api: TraderHandbookApi;
  handbookId: string;
  takenIds: string[];
  onDraft: (setup: TraderHandbookSetup) => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const [description, setDescription] = useState("");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [model, setModel] = useState("");
  const [drafting, setDrafting] = useState<{ requestId: string; startedAt: number; chars: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.models().then((result) => {
      if (cancelled) return;
      setModels(result.models);
      setModel(result.activeModelId || result.models[0]?.id || "");
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!drafting) return;
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - drafting.startedAt) / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, [drafting]);

  const start = async () => {
    const requestId = newDraftRequestId();
    setDrafting({ requestId, startedAt: Date.now(), chars: 0 });
    setElapsed(0);
    setError(null);
    setNotes([]);
    setWarnings([]);
    try {
      const result = await api.draftSetup({
        description: description.trim(),
        handbookId,
        model: model || null,
        requestId,
        onDelta: (chars) => setDrafting((current) => (current && current.requestId === requestId ? { ...current, chars } : current))
      });
      if (result) {
        const id = takenIds.includes(result.setup.id) ? `${result.setup.id}_new` : result.setup.id;
        onDraft({ ...result.setup, id, status: "observing" });
        setNotes(result.notes);
        setWarnings(result.warnings);
      }
    } catch (reason) {
      const message = commandErrorText(reason);
      if (!message.includes("已取消")) setError(message);
    } finally {
      setDrafting(null);
    }
  };

  const cancel = () => {
    if (drafting) void api.cancelDraft(drafting.requestId);
    setDrafting(null);
  };

  return (
    <section className="hbe-assist" data-setup-assist>
      <span className="hbe-field__label">
        {t("automation:setupAssistTitle")}
        <HelpTip text={t("automation:setupAssistHelp")} />
      </span>
      <textarea
        rows={3}
        value={description}
        maxLength={2_000}
        disabled={Boolean(drafting)}
        placeholder={t("automation:setupAssistPlaceholder")}
        onChange={(event) => setDescription(event.target.value)}
        data-setup-assist-input
        data-i18n-skip
      />
      <div className="hbe-assist__bar">
        {models.length > 0 ? (
          <div className="hbe-assist__model">
            <TerminalSelect ariaLabel={t("automation:setupAssistModel")} value={model} options={models.map((item) => ({ value: item.id, label: item.name }))} disabled={Boolean(drafting)} onChange={setModel} />
          </div>
        ) : null}
        <span className="pfe-spacer" />
        {drafting ? (
          <>
            <span className="hbe-assist__progress" data-setup-assist-progress>
              <Loader2 className="spin" size={12} />
              {t("automation:setupAssistProgress", { chars: drafting.chars, seconds: elapsed })}
            </span>
            <button type="button" className="pfe-btn is-small" onClick={cancel} data-setup-assist-cancel>{t("common:cancel")}</button>
          </>
        ) : (
          <button type="button" className="pfe-btn is-small is-primary" disabled={!description.trim()} onClick={() => void start()} data-setup-assist-run>
            <Sparkles size={12} />{t("automation:setupAssistRun")}
          </button>
        )}
      </div>
      {error ? <small className="hbe-field__error" role="alert" data-i18n-skip>{error}</small> : null}
      {notes.length > 0 || warnings.length > 0 ? (
        <div className="hbe-assist__notes" data-setup-assist-notes>
          <span>{t("automation:setupAssistCheck")}</span>
          <ul data-i18n-skip>
            {[...notes, ...warnings].map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function SetupEditorDrawer({
  api,
  handbookId,
  setup,
  isNew,
  takenIds,
  pausedCount,
  readOnly,
  onDone,
  onDelete,
  onClose
}: {
  api: TraderHandbookApi;
  handbookId: string;
  setup: TraderHandbookSetup;
  isNew: boolean;
  takenIds: string[];
  pausedCount: number;
  readOnly: boolean;
  onDone: (setup: TraderHandbookSetup) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const [draft, setDraft] = useState<TraderHandbookSetup>(setup);
  const [attempted, setAttempted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const patch = (next: Partial<TraderHandbookSetup>) => setDraft((current) => ({ ...current, ...next }));

  // 只在打开时聚焦一次。和下面的 Esc 监听分开写：Esc 的依赖 onClose 每次渲染都是新函数，
  // 外层面板又在轮询运行状态，合在一起会每隔几秒把焦点从用户正在输入的框里抢回来。
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const labels: Record<TextField, string> = {
    name: t("automation:setupName"),
    entry: t("automation:setupEntry"),
    stop: t("automation:setupStop"),
    target: t("automation:setupTarget"),
    invalidation: t("automation:setupInvalidation")
  };
  const limitOf = (field: TextField) => (field === "name" ? HANDBOOK_LIMITS.name : HANDBOOK_LIMITS.setupText);
  const textError = (field: TextField) => {
    const value = draft[field].trim();
    if (!value) return attempted ? t("automation:setupRequired", { field: labels[field] }) : null;
    if (value.length > limitOf(field)) return t("automation:setupTextTooLong", { field: labels[field], max: limitOf(field) });
    return null;
  };
  const idError = !validHandbookId(draft.id)
    ? t("automation:setupIdInvalid")
    : isNew && takenIds.includes(draft.id)
      ? t("automation:setupIdTaken")
      : null;
  const regimesError = draft.regimes.length === 0 ? t("automation:setupRegimesRequired") : null;
  const limitError = draft.stopAtrMin !== undefined && draft.stopAtrMax !== undefined && draft.stopAtrMin > draft.stopAtrMax
    ? t("automation:setupStopAtrOrder")
    : null;
  const textFields: TextField[] = ["name", "entry", "stop", "target", "invalidation"];
  const invalid = Boolean(idError || regimesError || limitError || textFields.some((field) => !draft[field].trim() || draft[field].trim().length > limitOf(field)));
  const counter = (field: TextField) => {
    const length = draft[field].length;
    return length > limitOf(field) * 0.75 ? `${length}/${limitOf(field)}` : null;
  };
  const finish = () => {
    setAttempted(true);
    if (invalid || readOnly) return;
    onDone({
      ...draft,
      name: draft.name.trim(),
      entry: draft.entry.trim(),
      stop: draft.stop.trim(),
      target: draft.target.trim(),
      invalidation: draft.invalidation.trim(),
      sizeNote: draft.sizeNote?.trim() || undefined
    });
  };
  const textArea = (field: Exclude<TextField, "name">) => (
    <Field label={labels[field]} counter={counter(field)} error={textError(field)}>
      <textarea
        rows={2}
        value={draft[field]}
        disabled={readOnly}
        onChange={(event) => patch({ [field]: event.target.value } as Partial<TraderHandbookSetup>)}
        data-setup-field={field}
        data-i18n-skip
      />
    </Field>
  );

  return createPortal(
    <div className="hbe-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="hbe-drawer" role="dialog" aria-modal="true" aria-label={isNew ? t("automation:setupDrawerNew") : t("automation:setupDrawerEdit")} data-setup-drawer>
        <header className="hbe-drawer__head">
          <strong>{isNew ? t("automation:setupDrawerNew") : t("automation:setupDrawerEdit")}</strong>
          <button type="button" className="pfe-btn is-ghost is-icon" onClick={onClose} aria-label={t("common:close")}><X size={15} /></button>
        </header>
        <div className="hbe-drawer__body">
          {isNew && !readOnly ? (
            <>
              <SetupDraftAssist api={api} handbookId={handbookId} takenIds={takenIds} onDraft={(next) => { setDraft(next); setAttempted(false); }} />
              <div className="hbe-drawer__sep" />
            </>
          ) : null}
          <Field label={labels.name} counter={counter("name")} error={textError("name")}>
            <input ref={nameRef} type="text" value={draft.name} disabled={readOnly} onChange={(event) => patch({ name: event.target.value })} data-setup-field="name" data-i18n-skip />
          </Field>
          <Field label="id" help={t("automation:setupIdHelp")} error={isNew ? idError : null}>
            {isNew ? (
              <input type="text" value={draft.id} disabled={readOnly} spellCheck={false} onChange={(event) => patch({ id: event.target.value.trim().toLowerCase() })} className="is-mono" data-setup-field="id" />
            ) : (
              <code className="hbe-field__static" data-i18n-skip>{draft.id}</code>
            )}
          </Field>
          <div className="hbe-field-row">
            <Field label={t("automation:setupRegimes")} error={regimesError}>
              <div className="hbe-chips" role="group" aria-label={t("automation:setupRegimes")}>
                {HANDBOOK_REGIMES.map((regime) => {
                  const active = draft.regimes.includes(regime);
                  return (
                    <button
                      type="button"
                      key={regime}
                      aria-pressed={active}
                      disabled={readOnly}
                      className={clsx(active && "is-active")}
                      onClick={() => patch({ regimes: active ? draft.regimes.filter((item) => item !== regime) : HANDBOOK_REGIMES.filter((item) => item === regime || draft.regimes.includes(item)) })}
                      data-setup-regime={regime}
                    >
                      {t(`automation:regime_${regime}`)}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label={t("automation:setupDirection")} help={t("automation:setupDirectionHelp")}>
              <EditorSegmented
                value={draft.direction === "both" ? "both" : "with_trend"}
                ariaLabel={t("automation:setupDirection")}
                disabled={readOnly}
                options={[
                  { value: "with_trend", label: t("automation:setupDirectionWithTrend") },
                  { value: "both", label: t("automation:setupDirectionBoth") }
                ]}
                onChange={(direction) => patch({ direction })}
              />
            </Field>
          </div>
          <Field label={t("automation:setupStatus")} help={t("automation:setupStatusHelp")}>
            <EditorSegmented
              value={draft.status === "live" ? "live" : "observing"}
              ariaLabel={t("automation:setupStatus")}
              disabled={readOnly}
              options={[
                { value: "observing", label: t("automation:setupStatusObserving") },
                { value: "live", label: t("automation:setupStatusLive"), danger: true }
              ]}
              onChange={(status) => patch({ status })}
            />
          </Field>
          {draft.status === "live" && setup.status !== "live" ? <p className="hbe-drawer__warn" data-setup-going-live>{t("automation:setupGoingLiveHint")}</p> : null}
          <div className="hbe-drawer__sep" />
          {textArea("entry")}
          {textArea("stop")}
          {textArea("target")}
          {textArea("invalidation")}
          <div className="hbe-drawer__sep" />
          <span className="hbe-drawer__group">{t("automation:setupLimits")}</span>
          <div className="hbe-field-row is-three">
            <Field label={t("automation:setupMinNetRr")}>
              <OptionalNumber value={draft.minNetRr} min={0.5} max={10} ariaLabel={t("automation:setupMinNetRr")} disabled={readOnly} onChange={(minNetRr) => patch({ minNetRr })} />
            </Field>
            <Field label={t("automation:setupStopAtrMin")}>
              <OptionalNumber value={draft.stopAtrMin} min={0.1} max={10} unit="×ATR" ariaLabel={t("automation:setupStopAtrMin")} disabled={readOnly} onChange={(stopAtrMin) => patch({ stopAtrMin })} />
            </Field>
            <Field label={t("automation:setupStopAtrMax")} error={limitError}>
              <OptionalNumber value={draft.stopAtrMax} min={0.1} max={10} unit="×ATR" ariaLabel={t("automation:setupStopAtrMax")} disabled={readOnly} onChange={(stopAtrMax) => patch({ stopAtrMax })} />
            </Field>
          </div>
          <Field label={t("automation:setupSizeNote")}>
            <input type="text" value={draft.sizeNote ?? ""} maxLength={HANDBOOK_LIMITS.rule} disabled={readOnly} onChange={(event) => patch({ sizeNote: event.target.value })} data-i18n-skip />
          </Field>
          {!isNew && pausedCount > 0 ? <p className="hbe-drawer__note">{t("automation:setupPausedNote", { count: pausedCount })}</p> : null}
        </div>
        <footer className="hbe-drawer__foot">
          {!isNew && !readOnly ? (
            confirmDelete ? (
              <span className="hbe-drawer__confirm">
                {t("automation:setupDeleteConfirm")}
                <button type="button" className="pfe-btn is-small is-danger" onClick={onDelete} data-setup-delete-confirm>{t("common:delete")}</button>
                <button type="button" className="pfe-btn is-small is-ghost" onClick={() => setConfirmDelete(false)}>{t("common:cancel")}</button>
              </span>
            ) : (
              <button type="button" className="pfe-btn is-ghost is-danger" onClick={() => setConfirmDelete(true)} data-setup-delete><Trash2 size={13} />{t("automation:setupDelete")}</button>
            )
          ) : <span />}
          <span className="pfe-spacer" />
          <button type="button" className="pfe-btn" onClick={onClose}>{t("common:cancel")}</button>
          {!readOnly ? <button type="button" className="pfe-btn is-primary" onClick={finish} disabled={attempted && invalid} data-setup-done>{t("automation:setupDone")}</button> : null}
        </footer>
      </aside>
    </div>,
    document.body
  );
}
