import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Archive, ArchiveRestore, ChevronRight, Copy, Download, FilePlus2, History, Loader2, MoreHorizontal, Pencil, Plus, Save, Upload, X } from "lucide-react";
import { TerminalSelect } from "../TerminalSelect";
import { DEFAULT_TRADER_HANDBOOK_ID, type TraderHandbook, type TraderHandbookDetail, type TraderHandbookLibraryEntry, type TraderHandbookRule, type TraderHandbookSetup } from "../../lib/ai";
import {
  blankSetup,
  estimateHandbookChars,
  HANDBOOK_LIMITS,
  handbooksEqual,
  setupIsLive,
  suggestSetupId,
  uniqueHandbookId,
  validHandbookId,
  type HandbookTextLabels
} from "../../lib/handbookText";
import { AutomationConfirmDialog } from "./AutomationConfirmDialog";
import { HandbookVersions } from "./HandbookVersions";
import { HelpTip } from "./ProfileEditorControls";
import { SetupEditorDrawer } from "./SetupEditorDrawer";
import { commandErrorText, type TraderHandbookApi } from "./traderApi";
import "./profile-editor.css";
import "./handbook-editor.css";

type RuleListKey = "noTradeRules" | "managementRules";
type NameDialog = { mode: "create" | "copy" | "rename"; value: string };
type PendingConfirm = { title: string; message: string; details?: string[]; confirmText: string; danger?: boolean; onConfirm: () => void };

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 手册界面通用的显示名、日线阶段等文案（版次对比的逐行文本也用它）。 */
export function useHandbookLabels() {
  const { t } = useTranslation(["automation", "common"]);
  const displayName = useCallback((name: string | null | undefined) => (name && name.trim() ? name : t("automation:handbookDefaultName")), [t]);
  const regime = useCallback((value: string) => t(`automation:regime_${value}`, { defaultValue: value }), [t]);
  const side = useCallback((value: string) => (value === "long" ? t("automation:sideLong") : value === "short" ? t("automation:sideShort") : value), [t]);
  const textLabels = useMemo<HandbookTextLabels>(() => ({
    directionPolicy: t("automation:handbookDirectionPolicy"),
    setup: t("automation:handbookSetupWord"),
    regimes: t("automation:setupRegimes"),
    direction: t("automation:setupDirection"),
    entry: t("automation:setupEntry"),
    stop: t("automation:setupStop"),
    target: t("automation:setupTarget"),
    invalidation: t("automation:setupInvalidation"),
    limits: t("automation:setupLimitsShort"),
    minNetRr: t("automation:setupMinNetRr"),
    stopAtrMin: t("automation:setupStopAtrMin"),
    stopAtrMax: t("automation:setupStopAtrMax"),
    sizeNote: t("automation:setupSizeNote"),
    noTrade: t("automation:handbookNoTrade"),
    management: t("automation:handbookManagement"),
    paused: t("automation:handbookPausedScopes"),
    all: t("automation:handbookPausedAll"),
    status: (status) => (status === "live" ? t("automation:setupStatusLive") : t("automation:setupStatusObserving")),
    directionValue: (direction) => (direction === "both" ? t("automation:setupDirectionBoth") : t("automation:setupDirectionWithTrend")),
    regime,
    side
  }), [regime, side, t]);
  return { displayName, regime, side, textLabels };
}

/** 发布前的检查（与后端一致的子集，后端是最终校验）。返回第一条问题。 */
function firstProblem(handbook: TraderHandbook, t: (key: string, options?: Record<string, unknown>) => string): string | null {
  if (handbook.setups.length === 0) return t("automation:handbookNeedsSetup");
  if (handbook.setups.length > HANDBOOK_LIMITS.setups) return t("automation:handbookTooManySetups", { max: HANDBOOK_LIMITS.setups });
  if (handbook.directionPolicy.length > HANDBOOK_LIMITS.policy) return t("automation:handbookPolicyTooLong", { max: HANDBOOK_LIMITS.policy });
  const ids = new Set<string>();
  for (const setup of handbook.setups) {
    if (!validHandbookId(setup.id) || ids.has(setup.id)) return t("automation:setupIdInvalid");
    ids.add(setup.id);
    if (![setup.name, setup.entry, setup.stop, setup.target, setup.invalidation].every((value) => value.trim()) || setup.regimes.length === 0) {
      return t("automation:handbookSetupIncomplete", { name: setup.name || setup.id });
    }
  }
  for (const key of ["noTradeRules", "managementRules"] as const) {
    if (handbook[key].length > HANDBOOK_LIMITS.rules) return t("automation:handbookTooManyRules", { max: HANDBOOK_LIMITS.rules });
    if (handbook[key].some((rule) => !rule.text.trim())) return t("automation:handbookEmptyRule");
    if (handbook[key].some((rule) => rule.text.length > HANDBOOK_LIMITS.rule)) return t("automation:handbookRuleTooLong", { max: HANDBOOK_LIMITS.rule });
  }
  return null;
}

/**
 * 交易手册编辑器：手册库（选 / 新建 / 复制 / 重命名 / 归档）、方向纪律、形态、不做清单、持仓管理、版次与回退。
 * 编辑的是本地副本，保存时整本发布成新版次（带编辑开始时的版次，别处改过会被拒绝）。
 */
export function HandbookEditor({
  api,
  initialHandbookId,
  focusNonce,
  onLibraryChanged
}: {
  api: TraderHandbookApi;
  initialHandbookId?: string | null;
  focusNonce?: number;
  onLibraryChanged?: () => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const { displayName, regime, textLabels } = useHandbookLabels();
  const [library, setLibrary] = useState<TraderHandbookLibraryEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>(initialHandbookId || DEFAULT_TRADER_HANDBOOK_ID);
  const [detail, setDetail] = useState<TraderHandbookDetail | null>(null);
  const [draft, setDraft] = useState<TraderHandbook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ index: number | null; setup: TraderHandbookSetup } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [importNotice, setImportNotice] = useState<string[] | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusRuleRef = useRef<string | null>(null);

  const reloadLibrary = useCallback(async () => {
    const items = await api.list(true).catch(() => null);
    setLibrary(items ?? []);
    return items ?? [];
  }, [api]);

  const loadDetail = useCallback(async (handbookId: string) => {
    setLoadError(null);
    setConflict(null);
    setSaveError(null);
    try {
      const next = await api.detail(handbookId);
      setDetail(next);
      setDraft(next ? clone(next.content) : null);
      if (!next) setLoadError(t("automation:handbookLoadFailed"));
    } catch (reason) {
      setDetail(null);
      setDraft(null);
      setLoadError(commandErrorText(reason));
    }
  }, [api, t]);

  useEffect(() => {
    void reloadLibrary();
  }, [reloadLibrary]);

  // 外部（Profile 编辑器的「管理手册」、成绩单的链接）要求打开某本手册。
  useEffect(() => {
    if (initialHandbookId) setSelectedId(initialHandbookId);
  }, [focusNonce, initialHandbookId]);

  useEffect(() => {
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [menuOpen]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const id = focusRuleRef.current;
    if (!id) return;
    focusRuleRef.current = null;
    document.querySelector<HTMLInputElement>(`[data-handbook-rule-input="${id}"]`)?.focus();
  });

  const readOnly = Boolean(detail?.archivedAt);
  const dirty = Boolean(detail && draft && !handbooksEqual(detail.content, draft));
  const entry = library?.find((item) => item.id === selectedId) ?? null;
  const name = displayName(detail?.name ?? entry?.name ?? null);
  const chars = draft ? estimateHandbookChars(draft) : 0;
  const liveCount = draft?.setups.filter(setupIsLive).length ?? 0;

  const confirmDiscard = (action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    setPendingConfirm({
      title: t("automation:handbookDiscardTitle"),
      message: t("automation:handbookDiscardDetail"),
      confirmText: t("automation:handbookDiscard"),
      danger: true,
      onConfirm: action
    });
  };

  const selectHandbook = (handbookId: string) => {
    if (handbookId === selectedId) return;
    confirmDiscard(() => {
      setSelectedId(handbookId);
      setDrawer(null);
    });
  };

  const patchDraft = (patch: Partial<TraderHandbook>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  const publish = async () => {
    if (!detail || !draft || readOnly) return;
    const problem = firstProblem(draft, t);
    if (problem) {
      setSaveError(problem);
      return;
    }
    const before = new Map(detail.content.setups.map((setup) => [setup.id, setup]));
    const goingLive = draft.setups.filter((setup) => setupIsLive(setup) && !(before.get(setup.id) && setupIsLive(before.get(setup.id)!)));
    const run = async () => {
      setSaving(true);
      setSaveError(null);
      try {
        const published = await api.publish(detail.id, draft, detail.revision, null);
        if (published) {
          setDetail({ ...detail, version: published.version, revision: published.revision, content: published.content });
          setDraft(clone(published.content));
          setNotice(t("automation:handbookPublished", { revision: published.revision }));
          void reloadLibrary();
          onLibraryChanged?.();
        }
      } catch (reason) {
        const message = commandErrorText(reason);
        if (message.startsWith("handbook_conflict")) setConflict(message.replace(/^handbook_conflict[：:]\s*/, ""));
        else setSaveError(message);
      } finally {
        setSaving(false);
      }
    };
    if (goingLive.length === 0) {
      void run();
      return;
    }
    setPendingConfirm({
      title: t("automation:handbookGoLiveTitle"),
      message: t("automation:handbookGoLiveDetail"),
      details: goingLive.map((setup) => `${setup.name} · ${setup.id}`),
      confirmText: t("automation:handbookGoLiveConfirm"),
      danger: true,
      onConfirm: () => void run()
    });
  };

  const applySetup = (setup: TraderHandbookSetup, index: number | null) => {
    if (!draft) return;
    const setups = [...draft.setups];
    if (index === null) setups.push(setup);
    else setups[index] = setup;
    patchDraft({ setups });
    setDrawer(null);
  };

  const deleteSetup = (index: number) => {
    if (!draft) return;
    const removed = draft.setups[index];
    patchDraft({ setups: draft.setups.filter((_, position) => position !== index), paused: draft.paused.filter((entry) => entry.setupId !== removed.id) });
    setDrawer(null);
  };

  const updateRule = (key: RuleListKey, id: string, text: string) => {
    if (!draft) return;
    patchDraft({ [key]: draft[key].map((rule) => (rule.id === id ? { ...rule, text } : rule)) } as Partial<TraderHandbook>);
  };
  const removeRule = (key: RuleListKey, id: string) => {
    if (!draft) return;
    patchDraft({ [key]: draft[key].filter((rule) => rule.id !== id) } as Partial<TraderHandbook>);
  };
  const addRule = (key: RuleListKey) => {
    if (!draft) return;
    const id = uniqueHandbookId(key === "noTradeRules" ? "no_trade" : "manage", [...draft.noTradeRules, ...draft.managementRules].map((rule) => rule.id));
    focusRuleRef.current = id;
    patchDraft({ [key]: [...draft[key], { id, text: "" }] } as Partial<TraderHandbook>);
  };

  const submitName = async () => {
    if (!nameDialog) return;
    const value = nameDialog.value.trim();
    if (!value) {
      setNameError(t("automation:handbookNameRequired"));
      return;
    }
    setNameBusy(true);
    setNameError(null);
    try {
      const result = nameDialog.mode === "rename"
        ? await api.rename(selectedId, value)
        : await api.create(value, nameDialog.mode === "copy" ? selectedId : null);
      setNameDialog(null);
      await reloadLibrary();
      onLibraryChanged?.();
      if (result && nameDialog.mode !== "rename") {
        setSelectedId(result.id);
        setNotice(t("automation:handbookCreated", { name: value }));
      } else if (result) {
        setDetail((current) => (current ? { ...current, name: result.name } : current));
      }
    } catch (reason) {
      setNameError(commandErrorText(reason));
    } finally {
      setNameBusy(false);
    }
  };

  const exportHandbook = async () => {
    if (!detail) return;
    try {
      const path = await api.exportHandbook(detail.id);
      if (path) setNotice(t("automation:handbookExported", { path }));
    } catch (reason) {
      setSaveError(commandErrorText(reason));
    }
  };

  const importHandbook = async () => {
    try {
      const result = await api.importHandbook();
      if (!result) return;
      await reloadLibrary();
      onLibraryChanged?.();
      setSelectedId(result.id);
      setImportNotice(result.importWarnings ?? []);
    } catch (reason) {
      setSaveError(commandErrorText(reason));
    }
  };

  const toggleArchive = async () => {
    if (!detail) return;
    try {
      const result = await api.archive(detail.id, !detail.archivedAt);
      if (result) setDetail((current) => (current ? { ...current, archivedAt: result.archivedAt } : current));
      await reloadLibrary();
      onLibraryChanged?.();
    } catch (reason) {
      setSaveError(commandErrorText(reason));
    }
  };

  const options = useMemo(() => (library ?? []).map((item) => ({
    value: item.id,
    label: [
      displayName(item.name),
      item.revision ? t("automation:handbookRevision", { revision: item.revision }) : null,
      item.archivedAt ? t("automation:handbookArchivedTag") : null
    ].filter(Boolean).join(" · "),
    description: [
      item.usedBy.length > 0 ? t("automation:handbookUsedBy", { names: item.usedBy.map((user) => user.name).join(t("automation:listSeparator")) }) : t("automation:handbookUnused"),
      item.score90d.resolved > 0 && item.score90d.shrunkAvgR !== null
        ? t("automation:handbookScore90d", { count: item.score90d.resolved, r: `${item.score90d.shrunkAvgR >= 0 ? "+" : ""}${item.score90d.shrunkAvgR.toFixed(2)}R` })
        : t("automation:handbookScoreNone")
    ].join(" · ")
  })), [displayName, library, t]);

  const pausedCount = (setupId: string) => draft?.paused.filter((item) => item.setupId === setupId).length ?? 0;
  const usedBy = detail?.usedBy ?? entry?.usedBy ?? [];
  const archiveBlocked = selectedId === DEFAULT_TRADER_HANDBOOK_ID
    ? t("automation:handbookArchiveBlockedDefault")
    : usedBy.length > 0 && !detail?.archivedAt
      ? t("automation:handbookArchiveBlockedInUse")
      : null;

  const ruleList = (key: RuleListKey, title: string, help: string) => (
    <section className="hbe-section" data-handbook-rules={key}>
      <div className="hbe-section__head">
        <span>{title}<HelpTip text={help} /></span>
        <small>{draft?.[key].length ?? 0}/{HANDBOOK_LIMITS.rules}</small>
        {!readOnly ? (
          <button type="button" className="pfe-link" disabled={(draft?.[key].length ?? 0) >= HANDBOOK_LIMITS.rules} onClick={() => addRule(key)} data-handbook-add-rule={key}>
            <Plus size={12} />{t("automation:handbookAddRule")}
          </button>
        ) : null}
      </div>
      {(draft?.[key] ?? []).length === 0 ? <p className="hbe-muted">{t("automation:handbookRulesEmpty")}</p> : null}
      {(draft?.[key] ?? []).map((rule: TraderHandbookRule) => (
        <div className="hbe-rule" key={rule.id}>
          <span className="hbe-rule__dot" />
          <input
            type="text"
            value={rule.text}
            maxLength={HANDBOOK_LIMITS.rule}
            disabled={readOnly}
            placeholder={t("automation:handbookRulePlaceholder")}
            onChange={(event) => updateRule(key, rule.id, event.target.value)}
            data-handbook-rule-input={rule.id}
            data-i18n-skip
          />
          {!readOnly ? (
            <button type="button" className="pfe-btn is-ghost is-icon" onClick={() => removeRule(key, rule.id)} aria-label={t("automation:handbookRemoveRule")} title={t("automation:handbookRemoveRule")}>
              <X size={13} />
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );

  return (
    <section className="hbe" data-handbook-editor data-handbook-id={selectedId}>
      <header className="hbe-head">
        <div className="hbe-head__select" data-handbook-select>
          <TerminalSelect
            ariaLabel={t("automation:handbookSelectAria")}
            value={selectedId}
            options={options.length > 0 ? options : [{ value: selectedId, label: name }]}
            menuMinWidth={340}
            onChange={selectHandbook}
          />
        </div>
        <span className="hbe-head__meta" data-i18n-skip>
          {usedBy.length > 0
            ? t("automation:handbookUsedBy", { names: usedBy.map((user) => user.name).join(t("automation:listSeparator")) })
            : t("automation:handbookUnused")}
        </span>
        <span className="pfe-spacer" />
        <button type="button" className="pfe-btn is-small" onClick={() => setVersionsOpen(true)} disabled={!detail} data-handbook-versions-open>
          <History size={13} />{t("automation:handbookVersions")}
        </button>
        <div className="hbe-menu" ref={menuRef}>
          <button type="button" className="pfe-btn is-small is-icon" aria-label={t("automation:handbookMore")} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} data-handbook-menu>
            <MoreHorizontal size={14} />
          </button>
          {menuOpen ? (
            <div className="hbe-menu__list" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); confirmDiscard(() => { setNameError(null); setNameDialog({ mode: "create", value: "" }); }); }} data-handbook-action="create">
                <FilePlus2 size={13} />{t("automation:handbookNewFromTemplate")}
              </button>
              <button type="button" role="menuitem" disabled={!detail} onClick={() => { setMenuOpen(false); confirmDiscard(() => { setNameError(null); setNameDialog({ mode: "copy", value: t("automation:handbookCopyName", { name }) }); }); }} data-handbook-action="copy">
                <Copy size={13} />{t("automation:handbookDuplicate")}
              </button>
              <button type="button" role="menuitem" disabled={!detail || readOnly} onClick={() => { setMenuOpen(false); setNameError(null); setNameDialog({ mode: "rename", value: detail?.name ?? "" }); }} data-handbook-action="rename">
                <Pencil size={13} />{t("automation:handbookRename")}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!detail || Boolean(archiveBlocked)}
                title={archiveBlocked ?? undefined}
                onClick={() => { setMenuOpen(false); confirmDiscard(() => void toggleArchive()); }}
                data-handbook-action="archive"
              >
                {detail?.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                {detail?.archivedAt ? t("automation:handbookUnarchive") : t("automation:handbookArchive")}
              </button>
              <span className="hbe-menu__sep" />
              <button type="button" role="menuitem" disabled={!detail} onClick={() => { setMenuOpen(false); void exportHandbook(); }} data-handbook-action="export">
                <Download size={13} />{t("automation:handbookExport")}
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); confirmDiscard(() => void importHandbook()); }} data-handbook-action="import">
                <Upload size={13} />{t("automation:handbookImport")}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {loadError ? (
        <p className="hbe-error" role="alert" data-i18n-skip>{loadError}</p>
      ) : !draft || !detail ? (
        <div className="hbe-loading"><Loader2 className="spin" size={15} />{t("common:loading")}</div>
      ) : (
        <div className="hbe-body">
          {readOnly ? <p className="hbe-banner">{t("automation:handbookArchivedReadonly")}</p> : null}
          {importNotice && detail.origin === "import" ? (
            <div className="hbe-banner is-info" data-handbook-import-notice>
              <span>{t("automation:handbookImportedNotice")}</span>
              {importNotice.length > 0 ? <ul data-i18n-skip>{importNotice.map((line) => <li key={line}>{line}</li>)}</ul> : null}
            </div>
          ) : null}
          {detail.fallback ? <p className="hbe-banner" data-i18n-skip>{detail.fallback}</p> : null}

          <section className="hbe-section">
            <div className="hbe-section__head">
              <span>{t("automation:handbookDirectionPolicy")}<HelpTip text={t("automation:handbookDirectionPolicyHelp")} /></span>
            </div>
            <textarea
              className="hbe-policy"
              rows={2}
              value={draft.directionPolicy}
              maxLength={HANDBOOK_LIMITS.policy}
              disabled={readOnly}
              onChange={(event) => patchDraft({ directionPolicy: event.target.value })}
              data-handbook-policy
              data-i18n-skip
            />
          </section>

          <section className="hbe-section" data-handbook-setups>
            <div className="hbe-section__head">
              <span>{t("automation:handbookSetups")}<HelpTip text={t("automation:handbookSetupsHelp")} /></span>
              <small>{draft.setups.length}/{HANDBOOK_LIMITS.setups}</small>
              {!readOnly ? (
                <button
                  type="button"
                  className="pfe-link"
                  disabled={draft.setups.length >= HANDBOOK_LIMITS.setups}
                  onClick={() => setDrawer({ index: null, setup: blankSetup(suggestSetupId("", draft.setups.map((setup) => setup.id))) })}
                  data-handbook-add-setup
                >
                  <Plus size={12} />{t("automation:handbookAddSetup")}
                </button>
              ) : null}
            </div>
            {liveCount === 0 ? <p className="hbe-banner is-warn" data-handbook-no-live>{t("automation:handbookNoLiveSetups")}</p> : null}
            {draft.setups.map((setup, index) => {
              const paused = pausedCount(setup.id);
              const changed = !detail.content.setups.some((item) => JSON.stringify(item) === JSON.stringify(setup));
              return (
                <button type="button" className="hbe-setup" key={setup.id} onClick={() => setDrawer({ index, setup: clone(setup) })} data-handbook-setup-row={setup.id}>
                  <span className="hbe-setup__index">{index + 1}</span>
                  <span className="hbe-setup__name">
                    <b data-i18n-skip>{setup.name || "—"}</b>
                    <code data-i18n-skip>{setup.id}</code>
                    {changed ? <i className="hbe-dot" title={t("automation:handbookDirty")} /> : null}
                  </span>
                  <span className="hbe-setup__meta">
                    {setup.regimes.map(regime).join(" / ")} · {setup.direction === "both" ? t("automation:setupDirectionBoth") : t("automation:setupDirectionWithTrend")}
                  </span>
                  <span className="hbe-setup__paused">{paused > 0 ? <span className="pfe-paused">{t("automation:setupPausedCount", { count: paused })}</span> : null}</span>
                  <span className={clsx("hbe-status", setupIsLive(setup) ? "is-live" : "is-observing")} data-setup-status={setupIsLive(setup) ? "live" : "observing"}>
                    {setupIsLive(setup) ? t("automation:setupStatusLive") : t("automation:setupStatusObserving")}
                  </span>
                  <ChevronRight size={14} className="hbe-setup__chevron" />
                </button>
              );
            })}
          </section>

          {ruleList("noTradeRules", t("automation:handbookNoTrade"), t("automation:handbookNoTradeHelp"))}
          {ruleList("managementRules", t("automation:handbookManagement"), t("automation:handbookManagementHelp"))}
        </div>
      )}

      <footer className="hbe-foot">
        {conflict ? (
          <span className="hbe-foot__conflict" role="alert">
            <span data-i18n-skip>{conflict}</span>
            <button type="button" className="pfe-btn is-small" onClick={() => void loadDetail(selectedId)} data-handbook-reload>{t("automation:handbookReload")}</button>
          </span>
        ) : saveError ? (
          <span className="hbe-foot__error" role="alert" data-i18n-skip>{saveError}</span>
        ) : (
          <span className={clsx("hbe-foot__size", chars > HANDBOOK_LIMITS.rendered * 0.9 && "is-warn")}>
            {t("automation:handbookSize", { chars: chars.toLocaleString("en-US"), max: HANDBOOK_LIMITS.rendered.toLocaleString("en-US") })}
          </span>
        )}
        <span className="pfe-spacer" />
        {notice ? <span className="hbe-foot__notice">{notice}</span> : dirty ? <span className="hbe-foot__dirty">{t("automation:handbookDirty")}</span> : detail ? <span className="hbe-foot__clean">{t("automation:handbookRevision", { revision: detail.revision })}</span> : null}
        {!readOnly ? (
          <>
            <button type="button" className="pfe-btn" disabled={!dirty || saving} onClick={() => detail && setDraft(clone(detail.content))} data-handbook-discard>
              {t("automation:handbookDiscard")}
            </button>
            <button type="button" className="pfe-btn is-primary" disabled={!dirty || saving || Boolean(conflict)} onClick={() => void publish()} data-handbook-publish>
              {saving ? <Loader2 className="spin" size={13} /> : <Save size={13} />}
              {t("automation:handbookPublish", { revision: (detail?.revision ?? 0) + 1 })}
            </button>
          </>
        ) : null}
      </footer>

      {drawer && draft ? (
        <SetupEditorDrawer
          api={api}
          handbookId={selectedId}
          setup={drawer.setup}
          isNew={drawer.index === null}
          takenIds={draft.setups.filter((_, index) => index !== drawer.index).map((setup) => setup.id)}
          pausedCount={pausedCount(drawer.setup.id)}
          readOnly={readOnly}
          onDone={(setup) => applySetup(setup, drawer.index)}
          onDelete={() => drawer.index !== null && deleteSetup(drawer.index)}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {versionsOpen && detail ? (
        <HandbookVersions
          api={api}
          handbookId={detail.id}
          handbookName={name}
          currentRevision={detail.revision}
          readOnly={readOnly || dirty}
          textLabels={textLabels}
          onClose={() => setVersionsOpen(false)}
          onRestored={(published) => {
            setVersionsOpen(false);
            setDetail({ ...detail, version: published.version, revision: published.revision, content: published.content });
            setDraft(clone(published.content));
            setNotice(t("automation:handbookPublished", { revision: published.revision }));
            void reloadLibrary();
            onLibraryChanged?.();
          }}
        />
      ) : null}
      {nameDialog ? createPortal(
        <div className="modal-backdrop compact automation-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !nameBusy) setNameDialog(null); }}>
          <section className="modal-shell compact automation-confirm-modal hbe-name-dialog" role="dialog" aria-modal="true" aria-label={t(`automation:handbookNameDialog_${nameDialog.mode}`)} data-handbook-name-dialog={nameDialog.mode}>
            <header className="modal-head"><div><strong>{t(`automation:handbookNameDialog_${nameDialog.mode}`)}</strong></div></header>
            <label className="hbe-field">
              <span className="hbe-field__label">{t("automation:handbookNameLabel")}</span>
              <input
                type="text"
                autoFocus
                value={nameDialog.value}
                maxLength={40}
                placeholder={t("automation:handbookNamePlaceholder")}
                onChange={(event) => setNameDialog({ ...nameDialog, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitName();
                  if (event.key === "Escape" && !nameBusy) setNameDialog(null);
                }}
                data-handbook-name-input
                data-i18n-skip
              />
              {nameError ? <small className="hbe-field__error" data-i18n-skip>{nameError}</small> : null}
            </label>
            {nameDialog.mode === "create" ? <p className="hbe-muted">{t("automation:handbookCreateHint")}</p> : null}
            <div className="modal-actions">
              <button type="button" disabled={nameBusy} onClick={() => setNameDialog(null)}>{t("common:cancel")}</button>
              <button type="button" disabled={nameBusy} onClick={() => void submitName()} data-handbook-name-submit>
                {nameDialog.mode === "rename" ? t("automation:handbookRename") : t("automation:handbookCreate")}
              </button>
            </div>
          </section>
        </div>,
        document.body
      ) : null}
      {pendingConfirm ? (
        <AutomationConfirmDialog
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          details={pendingConfirm.details}
          confirmText={pendingConfirm.confirmText}
          danger={pendingConfirm.danger}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const pending = pendingConfirm;
            setPendingConfirm(null);
            pending.onConfirm();
          }}
        />
      ) : null}
    </section>
  );
}
