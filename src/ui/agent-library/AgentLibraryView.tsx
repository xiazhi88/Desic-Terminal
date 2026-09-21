import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import {
  AlertTriangle,
  Bot,
  Check,
  Clipboard,
  Eye,
  FileCode2,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserRoundPlus,
  Users,
  X
} from "lucide-react";
import type {
  AiAgentDetail,
  AiAgentProfile,
  AiAgentSource,
  AiAgentSummary,
  AiModelConfigSummary,
  AiSkillDefinition
} from "../../types";
import { AiMarkdown } from "../AiMarkdown";
import { useConfirmPrompt } from "../ConfirmPrompt";
import { useDraggableSurface } from "../useDraggableSurface";
import { logger } from "../../lib/logger";
import { formatLocalizedDate } from "../../i18n/runtime";
import {
  cancelAiAgentDraft,
  deleteAiAgent,
  duplicateAiAgent,
  generateAiAgentDraft,
  invalidateAgentResponsibilityCache,
  readAiAgent,
  saveAiAgent,
  type AgentDraftRequest
} from "../agentLibraryCommands";
import { listenAiEvents } from "../../lib/ai";
import { AgentSkillSelect } from "./AgentSkillSelect";
import { AgentRoleCombo } from "./AgentRoleCombo";
import { TerminalSelect } from "../TerminalSelect";
import {
  AGENT_ENVELOPE_OPTIONS,
  AGENT_OUTPUT_I18N_KEY,
  AGENT_ROLE_SUGGESTIONS,
  agentOutputContract,
  buildAgentSkeletonBody,
  renderAgentDocument,
  slugifyAgentName,
  validateAgentDraft,
  type AiAgentDraftFields
} from "./agentDocument";
import { limitRowChips, type AgentRowChip } from "./rowChips";
import "./AgentLibrary.css";

/**
 * agents tab（契约 v3 C7 / §6.1）：三栏 = 左列表 / 中 AGENTS.md 编辑与预览 / 右动作与元数据。
 *
 * 列宽沿用 systematic-lab 的做法：CSS 变量 + localStorage（键不同，互不影响），
 * 拖拽条贴被调整面板的边缘，双击复位。
 */

type AgentLibraryViewProps = {
  agents: AiAgentSummary[];
  profiles: AiAgentProfile[];
  /** 可选依赖项数据源（C16）：创建对话框的 Skills 多选与 AI 对话框的模型选择。 */
  skills?: AiSkillDefinition[];
  /** 已激活的 Skill id：未激活只在选项里标记，不阻断保存。 */
  enabledSkillIds?: string[];
  models?: AiModelConfigSummary[];
  activeModelId?: string;
  loading: boolean;
  error: string | null;
  onReload: () => Promise<AiAgentSummary[]>;
  onNotify: (notification: { kind: "success" | "info" | "warning" | "error"; title: string; message: string }) => void;
  /**
   * 可注入的正文读取器（默认走 `ai_agent_read`）。浏览器预览没有 Tauri 运行时，
   * 注入后可视化回归才能渲染真实编辑器（含源码框高度），而不是永远停在错误态。
   */
  readAgent?: (id: string) => Promise<AiAgentDetail | null>;
  /** 可注入的草稿生成（预览夹具用；默认走 `ai_agent_generate`）。 */
  generateDraft?: (input: AgentDraftRequest) => Promise<{ content: string; warnings: string[] }>;
};

const AGENT_LIBRARY_COLUMNS_KEY = "desic.agent-library.columns";

type AgentLibraryColumnSide = "list" | "rail";
type AgentLibraryColumnWidths = { list: number | null; rail: number | null };

const AGENT_LIBRARY_COLUMN_LIMITS: Record<AgentLibraryColumnSide, { min: number; max: number }> = {
  list: { min: 220, max: 460 },
  rail: { min: 248, max: 460 }
};

/** 前端预检的失败码 → i18n 键（最终校验仍以 Rust 返回的消息为准）。 */
export const AGENT_VALIDATION_KEYS: Record<string, string> = {
  "id-mismatch": "agentValidation_id-mismatch",
  "id-invalid": "agentValidation_id-invalid",
  "id-conflict": "agentValidation_id-conflict",
  "name-invalid": "agentValidation_name-invalid",
  "role-invalid": "agentValidation_role-invalid",
  "body-empty": "agentValidation_body-empty",
  "too-large": "agentValidation_too-large"
};

function agentValidationText(t: (key: string) => string, code: string | null) {
  if (!code) return "";
  return t(AGENT_VALIDATION_KEYS[code] ?? "agentSaveFailed");
}

/** P1：生成过程的本地阶段机（阶段文案由本地状态推导，不新增事件字段）。 */
type AgentDraftStage = "idle" | "preparing" | "requested" | "streaming" | "finalizing" | "cancelling" | "cancelled" | "failed";

const AGENT_DRAFT_PHASE_KEY: Record<AgentDraftStage, string> = {
  idle: "agentDraftPhasePreparing",
  preparing: "agentDraftPhasePreparing",
  requested: "agentDraftPhaseRequested",
  streaming: "agentDraftPhaseStreaming",
  finalizing: "agentDraftPhaseFinalizing",
  cancelling: "agentDraftPhaseFinalizing",
  cancelled: "agentDraftStageCancelled",
  failed: "agentDraftStageFailed"
};

function createDraftRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SOURCE_I18N_KEY: Record<AiAgentSource, string> = {
  builtin: "agentSourceBuiltin",
  custom: "agentSourceCustom",
  ai: "agentSourceAi"
};

const SOURCE_ICON = { builtin: Layers, custom: UserRoundPlus, ai: Sparkles } as const;
const SOURCE_ORDER: readonly AiAgentSource[] = ["builtin", "custom", "ai"];

function readAgentLibraryColumnWidths(): AgentLibraryColumnWidths {
  try {
    const raw = window.localStorage.getItem(AGENT_LIBRARY_COLUMNS_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const read = (side: AgentLibraryColumnSide) => {
      const value = Number(parsed[side]);
      if (!Number.isFinite(value)) return null;
      const limits = AGENT_LIBRARY_COLUMN_LIMITS[side];
      return Math.max(limits.min, Math.min(limits.max, Math.round(value)));
    };
    return { list: read("list"), rail: read("rail") };
  } catch {
    return { list: null, rail: null };
  }
}

function formatAgentTime(value: number) {
  if (!value) return "--";
  return formatLocalizedDate(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function sourceLabel(t: (key: string) => string, source: AiAgentSource) {
  return t(SOURCE_I18N_KEY[source]);
}

function agentMissingSkillsText(t: (key: string, values?: Record<string, unknown>) => string, skills: string[]) {
  return t("agentMissingSkills", { skills: skills.join(", ") });
}

function agentPathHint(id: string) {
  return `workspace/.cline/agents/${id}/AGENTS.md`;
}

export function AgentLibraryView({
  agents,
  profiles,
  skills = [],
  enabledSkillIds = [],
  models = [],
  activeModelId = "",
  loading,
  error,
  onReload,
  onNotify,
  readAgent = readAiAgent,
  generateDraft = generateAiAgentDraft
}: AgentLibraryViewProps) {
  const { t } = useTranslation(["automation", "common", "errors"]);
  const confirmPrompt = useConfirmPrompt();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiAgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editorMode, setEditorMode] = useState<"source" | "preview">("source");
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState<AgentLibraryColumnWidths>(() => readAgentLibraryColumnWidths());
  const [draggingColumn, setDraggingColumn] = useState<AgentLibraryColumnSide | null>(null);
  const columnWidthsRef = useRef(columnWidths);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  const persistColumnWidths = useCallback((next: AgentLibraryColumnWidths) => {
    setColumnWidths(next);
    try {
      window.localStorage.setItem(AGENT_LIBRARY_COLUMNS_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式或配额受限：忽略，仅本次会话生效 */
    }
  }, []);

  const clampColumnWidth = useCallback((side: AgentLibraryColumnSide, value: number) => {
    const limits = AGENT_LIBRARY_COLUMN_LIMITS[side];
    return Math.max(limits.min, Math.min(limits.max, Math.round(value)));
  }, []);

  const beginColumnResize = useCallback((side: AgentLibraryColumnSide, event: React.PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const pane = handle.parentElement;
    if (!pane) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = pane.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    setDraggingColumn(side);
    const onMove = (moveEvent: PointerEvent) => {
      const delta = side === "list" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      const next = clampColumnWidth(side, startWidth + delta);
      setColumnWidths((current) => ({ ...current, [side]: next }));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      setDraggingColumn(null);
      persistColumnWidths(columnWidthsRef.current);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }, [clampColumnWidth, persistColumnWidths]);

  const nudgeColumnWidth = useCallback((side: AgentLibraryColumnSide, event: React.KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = (event.shiftKey ? 48 : 16) * direction * (side === "list" ? 1 : -1);
    const current = columnWidthsRef.current[side];
    const pane = event.currentTarget.parentElement;
    const base = current ?? pane?.getBoundingClientRect().width ?? AGENT_LIBRARY_COLUMN_LIMITS[side].min;
    persistColumnWidths({ ...columnWidthsRef.current, [side]: clampColumnWidth(side, base + step) });
  }, [clampColumnWidth, persistColumnWidths]);

  const columnStyle = {
    ...(columnWidths.list ? { "--agent-lib-list-width": `${columnWidths.list}px` } : {}),
    ...(columnWidths.rail ? { "--agent-lib-rail-width": `${columnWidths.rail}px` } : {})
  } as CSSProperties;

  const columnResizeHandle = (side: AgentLibraryColumnSide, label: string) => (
    <div
      className={clsx("agent-lib-column-resize", side === "rail" && "agent-lib-column-resize--start", draggingColumn === side && "is-dragging")}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={columnWidths[side] ?? undefined}
      aria-valuemin={AGENT_LIBRARY_COLUMN_LIMITS[side].min}
      aria-valuemax={AGENT_LIBRARY_COLUMN_LIMITS[side].max}
      tabIndex={0}
      title={label}
      onPointerDown={(event) => beginColumnResize(side, event)}
      onKeyDown={(event) => nudgeColumnWidth(side, event)}
      onDoubleClick={() => persistColumnWidths({ ...columnWidthsRef.current, [side]: null })}
    />
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return agents;
    return agents.filter((agent) => [agent.id, agent.name, agent.role, agent.source]
      .some((value) => String(value ?? "").toLowerCase().includes(normalized)));
  }, [agents, query]);

  // C20.5（改写版）：下线的历史专家**彻底隐藏**（文件保留、可恢复），不再出现折叠组或停用徽标；
  // 列表只展示 Rust 返回且未下线的条目（这里再兜一层，避免旧后端把 deprecated 混进来）。
  const visibleAgents = useMemo(() => filtered.filter((agent) => !agent.deprecated), [filtered]);
  const groups = useMemo(() => SOURCE_ORDER
    .map((source) => ({ source, items: visibleAgents.filter((agent) => agent.source === source) }))
    .filter((group) => group.items.length > 0), [visibleAgents]);

  const profileNames = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.name || profile.id])), [profiles]);

  // 选中项：优先保留当前选择，其次第一个可用 Agent。
  useEffect(() => {
    if (selectedId && agents.some((agent) => agent.id === selectedId)) return;
    setSelectedId(agents[0]?.id ?? null);
  }, [agents, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDraft("");
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void readAgent(selectedId)
      .then((value) => {
        if (cancelled) return;
        if (!value) {
          setDetail(null);
          setDraft("");
          setDetailError(t("agentLoadFailed"));
          return;
        }
        setDetail(value);
        setDraft(value.content);
      })
      .catch((nextError) => {
        if (cancelled) return;
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        logger.error("ai agent read failed", nextError);
        setDetail(null);
        setDetailError(message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, t, readAgent]);

  const selectedAgent = detail ?? agents.find((agent) => agent.id === selectedId) ?? null;
  const readOnly = selectedAgent?.source === "builtin";
  const loadedContent = detail?.content ?? null;
  const dirty = loadedContent !== null && draft !== loadedContent;

  const refreshList = useCallback(async (options: { saved?: boolean } = {}) => {
    const next = await onReload();
    if (options.saved) onNotify({ kind: "success", title: t("agentSaved"), message: t("agentSave") });
    return next;
  }, [onNotify, onReload, t]);

  const handleSave = useCallback(async () => {
    if (!selectedAgent) return;
    const validation = validateAgentDraft(draft, selectedAgent.id);
    if (validation) {
      onNotify({ kind: "warning", title: t("agentSaveFailed"), message: agentValidationText(t, validation) });
      return;
    }
    setBusy("save");
    try {
      const saved = await saveAiAgent({ id: selectedAgent.id, content: draft });
      invalidateAgentResponsibilityCache(selectedAgent.id);
      await refreshList({ saved: true });
      if (saved) setSelectedId(saved.id);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      logger.error("ai agent save failed", nextError);
      onNotify({ kind: "error", title: t("agentSaveFailed"), message });
    } finally {
      setBusy(null);
    }
  }, [draft, onNotify, refreshList, selectedAgent, t]);

  const handleDuplicate = useCallback((agent: AiAgentSummary) => {
    setBusy("duplicate");
    void duplicateAiAgent({ id: agent.id })
      .then(async (created) => {
        if (!created) throw new Error(t("agentSaveFailed"));
        await refreshList();
        setSelectedId(created.id);
        setEditorMode("source");
      })
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        logger.error("ai agent duplicate failed", nextError);
        onNotify({ kind: "error", title: t("agentDuplicate"), message });
      })
      .finally(() => setBusy(null));
  }, [onNotify, refreshList, t]);

  const handleDelete = useCallback((agent: AiAgentSummary) => {
    if (agent.source === "builtin") {
      onNotify({ kind: "warning", title: t("agentDelete"), message: t("agentBuiltinReadonly") });
      return;
    }
    confirmPrompt.confirm({
      title: t("agentDelete"),
      message: t("agentDeleteConfirm", { name: agent.name }),
      confirmText: t("common:delete"),
      danger: true,
      onConfirm: () => {
        setBusy("delete");
        void deleteAiAgent(agent.id)
          .then(async () => {
            invalidateAgentResponsibilityCache(agent.id);
            await refreshList();
            setSelectedId(null);
          })
          .catch((nextError) => {
            const message = nextError instanceof Error ? nextError.message : String(nextError);
            logger.error("ai agent delete failed", nextError);
            onNotify({ kind: "error", title: t("agentDelete"), message });
          })
          .finally(() => setBusy(null));
      }
    });
  }, [confirmPrompt, onNotify, refreshList, t]);

  /** 切换选中项：有未保存改动时先确认（复用 Profile 编辑器的未保存交互模式）。 */
  const selectAgent = useCallback((id: string) => {
    if (id === selectedId) return;
    if (!dirty) {
      setSelectedId(id);
      return;
    }
    confirmPrompt.confirm({
      title: t("profileUnsavedTitle"),
      message: t("agentUnsavedDetail"),
      confirmText: t("profileUnsavedDiscard"),
      danger: true,
      onConfirm: () => setSelectedId(id)
    });
  }, [confirmPrompt, dirty, selectedId, t]);

  const handleDraftCreated = useCallback(async (created: AiAgentSummary | null) => {
    invalidateAgentResponsibilityCache(created?.id);
    await refreshList();
    if (created) setSelectedId(created.id);
    setCreateOpen(false);
    setGenerateOpen(false);
    setEditorMode("source");
  }, [refreshList, t]);

  const renderLibraryRow = (agent: AiAgentSummary) => {
    const chips: AgentRowChip[] = [];
    if (agent.requiresAccount) {
      chips.push({ key: "account", priority: 1, summary: t("agentNeedsAccount"), node: <em key="account" className="agent-chip is-warn">{t("agentNeedsAccount")}</em> });
    }
    if (agent.missingSkills.length > 0) {
      const text = agentMissingSkillsText(t, agent.missingSkills);
      chips.push({ key: "skills", priority: 2, summary: text, node: <em key="skills" className="agent-chip is-warn" title={text}>{text}</em> });
    }
    if (agent.modified) {
      chips.push({ key: "modified", priority: 3, summary: t("agentModified"), node: <em key="modified" className="agent-chip is-accent" title={t("agentModifiedHint")}>{t("agentModified")}</em> });
    }
    if (agent.enabledByProfiles.length > 0) {
      const names = agent.enabledByProfiles.map((id) => profileNames.get(id) ?? id).join(", ");
      chips.push({ key: "profiles", priority: 4, summary: names, node: <em key="profiles" className="agent-chip is-quiet" title={names}><Users size={10} />{agent.enabledByProfiles.length}</em> });
    }
    return (
      <button
        type="button"
        key={agent.id}
        className={clsx("agent-lib__row", agent.id === selectedId && "is-active")}
        data-agent-library-item
        data-agent-id={agent.id}
        data-agent-source={agent.source}
        onClick={() => selectAgent(agent.id)}
      >
        <span className="agent-lib__row-title">
          <strong>{agent.name}</strong>
          <small>{agent.role || "--"}</small>
        </span>
        <span className="agent-lib__row-meta">
          {/* C20.4：输出契约 —— 这个专家返回什么形态。 */}
          <em className="agent-chip is-accent" data-agent-output={agentOutputContract(agent.role)} title={t("agentOutputLabel")}>
            {t(AGENT_OUTPUT_I18N_KEY[agentOutputContract(agent.role)])}
          </em>
          {limitRowChips(chips)}
        </span>
      </button>
    );
  };

  const editorHeader = (
    <header className="agent-lib__editor-head">
      <div className="agent-lib__editor-identity">
        <strong>{selectedAgent?.name ?? t("agents")}</strong>
        {selectedAgent ? (
          <div className="agent-lib__editor-tags">
            <em className={`agent-chip is-source is-${selectedAgent.source}`}>{sourceLabel(t, selectedAgent.source)}</em>
            <em className="agent-chip is-role">{selectedAgent.role || "--"}</em>
            {selectedAgent.envelope === "risk" ? <em className="agent-chip is-risk">{t("agentEnvelopeRisk")}</em> : null}
            {selectedAgent.modified ? <em className="agent-chip is-modified">{t("agentModified")}</em> : null}
            {dirty ? <em className="agent-chip is-dirty">{t("agentUnsavedChanges")}</em> : null}
          </div>
        ) : null}
      </div>
      <div className="agent-lib__editor-actions">
        <div className="agent-lib__mode" role="tablist" aria-label={t("agentEditorModeAria")}>
          <button type="button" role="tab" aria-selected={editorMode === "source"} className={editorMode === "source" ? "active" : ""} onClick={() => setEditorMode("source")}>
            <FileCode2 size={13} />{t("agentSourceTab")}
          </button>
          <button type="button" role="tab" aria-selected={editorMode === "preview"} className={editorMode === "preview" ? "active" : ""} onClick={() => setEditorMode("preview")}>
            <Eye size={13} />{t("common:preview")}
          </button>
        </div>
        <span className="agent-lib__head-divider" aria-hidden="true" />
        <button type="button" data-agent-save className="agent-lib__save" disabled={readOnly || !dirty || busy !== null} title={readOnly ? t("agentBuiltinReadonly") : t("agentSave")} onClick={() => void handleSave()}>
          {busy === "save" ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
          {t("agentSave")}
        </button>
      </div>
    </header>
  );

  return (
    <div className="agent-lib" style={columnStyle} data-agents-tab data-loading={loading ? "true" : undefined}>
      <aside className="agent-lib__list">
        {columnResizeHandle("list", t("agentListResize"))}
        <div className="agent-lib__pane-head agent-lib__list-head">
          <span className="agent-lib__pane-title"><Bot size={13} />{t("agents")}</span>
          <div className="agent-lib__list-tools">
            <span className="agent-chip is-quiet agent-lib__count">{t("common:itemCount", { count: agents.length })}</span>
            <button type="button" onClick={() => void onReload()} disabled={loading} title={t("common:refresh")} aria-label={t("common:refresh")}>
              <RefreshCw size={13} className={loading ? "spin" : undefined} />
            </button>
          </div>
        </div>
        <label className="agent-lib__search">
          <Search size={13} aria-hidden="true" />
          <input type="search" value={query} placeholder={t("agentSearchPlaceholder")} aria-label={t("agentSearchPlaceholder")} onChange={(event) => setQuery(event.target.value)} />
          {query ? <button type="button" onClick={() => setQuery("")} title={t("common:search")} aria-label={t("common:search")}><X size={12} /></button> : null}
        </label>
        {error && agents.length > 0 ? (
          <div className="agent-lib__list-error" role="status">
            <AlertTriangle size={12} />
            <span title={error}>{t("errors:loadFailed")}</span>
            <button type="button" onClick={() => void onReload()}>{t("common:retry")}</button>
          </div>
        ) : null}
        <div className="agent-lib__list-scroll">
          {loading && agents.length === 0 ? (
            <p className="agent-lib__state"><Loader2 size={14} className="spin" />{t("common:loading")}</p>
          ) : error && agents.length === 0 ? (
            <div className="agent-lib__state is-error">
              <AlertTriangle size={14} />
              <span title={error}>{t("errors:loadFailed")}</span>
              <button type="button" onClick={() => void onReload()}>{t("common:retry")}</button>
            </div>
          ) : agents.length === 0 ? (
            <div className="agent-lib__empty" data-agent-library-empty>
              <Bot size={18} />
              <strong>{t("agentsEmpty")}</strong>
              <span>{t("agentsIntro")}</span>
              <button type="button" data-agent-create-manual onClick={() => setCreateOpen(true)}><Plus size={13} />{t("createAgent")}</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="agent-lib__state agent-lib__state--stack">
              <span className="agent-lib__state-line"><Search size={14} />{t("profileNoMatches")}</span>
              <span className="agent-lib__state-detail">{t("agentsIntro")}</span>
            </div>
          ) : (
            <>
              {groups.map((group) => {
                const Icon = SOURCE_ICON[group.source];
                return (
                  <div className="agent-lib__group" key={group.source}>
                    <div className={`agent-lib__group-title is-${group.source}`}>
                      <Icon size={12} aria-hidden="true" />
                      <span>{sourceLabel(t, group.source)}</span>
                      <em className="agent-chip is-quiet">{group.items.length}</em>
                      {group.source === "builtin" ? <i className="agent-lib__group-note">{t("agentGroupReadonly")}</i> : null}
                    </div>
                    {group.items.map((agent) => renderLibraryRow(agent))}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </aside>

      <section className={clsx("agent-lib__editor", readOnly && "is-readonly")} data-agent-editor>
        {editorHeader}
        {!selectedAgent ? (
          <div className="agent-lib__editor-empty">
            <FileCode2 size={20} />
            <strong>{t("agentSelectHint")}</strong>
            <span>{t("agentsIntro")}</span>
          </div>
        ) : detailLoading && !detail ? (
          <p className="agent-lib__state"><Loader2 size={14} className="spin" />{t("common:loading")}</p>
        ) : detailError ? (
          <div className="agent-lib__state is-error">
            <AlertTriangle size={14} />
            <span title={detailError}>{t("agentLoadFailed")}</span>
            <button type="button" onClick={() => setSelectedId((current) => current)}>{t("common:retry")}</button>
          </div>
        ) : editorMode === "preview" ? (
          <div className="agent-lib__preview">
            <AiMarkdown content={draft} />
          </div>
        ) : (
          <div className="agent-lib__source-wrap">
            <textarea
              ref={bodyRef}
              className="agent-lib__source"
              spellCheck={false}
              readOnly={readOnly}
              value={draft}
              aria-label={t("agentSourceTab")}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        )}
        {readOnly ? <p className="agent-lib__readonly-note"><ShieldAlert size={12} />{t("agentBuiltinReadonly")}</p> : null}
      </section>

      <aside className="agent-lib__rail">
        {columnResizeHandle("rail", t("agentRailResize"))}
        <div className="agent-lib__pane-head agent-lib__rail-head">
          <span className="agent-lib__pane-title">{t("agentRailTitle")}</span>
        </div>
        <div className="agent-lib__rail-actions">
          <button type="button" data-agent-create-manual className="is-primary" onClick={() => setCreateOpen(true)}><Plus size={12} />{t("createAgent")}</button>
          <button type="button" data-agent-create-ai onClick={() => setGenerateOpen(true)}><Sparkles size={12} />{t("createAgentWithAi")}</button>
          <button type="button" data-agent-duplicate disabled={!selectedAgent} onClick={() => selectedAgent && handleDuplicate(selectedAgent)}>
            <Clipboard size={12} />{t("agentDuplicate")}
          </button>
          <button
            type="button"
            className="is-danger"
            data-agent-delete
            disabled={!selectedAgent || selectedAgent.source === "builtin" || busy !== null}
            title={selectedAgent?.source === "builtin" ? t("agentBuiltinReadonly") : t("agentDeleteConfirm", { name: selectedAgent?.name ?? "" })}
            onClick={() => selectedAgent && handleDelete(selectedAgent)}
          >
            <Trash2 size={12} />{t("agentDelete")}
          </button>
        </div>

        {selectedAgent ? (
          <div className="agent-lib__rail-body">
            <dl className="agent-lib__facts">
              <div><dt>{t("agentRole")}</dt><dd>{selectedAgent.role || "--"}</dd></div>
              <div>
                <dt>{t("agentOutputLabel")}</dt>
                <dd data-agent-output={agentOutputContract(selectedAgent.role)}>{t(AGENT_OUTPUT_I18N_KEY[agentOutputContract(selectedAgent.role)])}</dd>
              </div>
              <div><dt>{t("agentVersion")}</dt><dd className="is-num">v{selectedAgent.version}</dd></div>
              <div><dt>{t("agentUpdatedAt")}</dt><dd className="is-num">{formatAgentTime(selectedAgent.updatedAt)}</dd></div>
            </dl>

            <div className="agent-lib__rail-flags">
              {selectedAgent.requiresAccount ? (
                <em className={clsx("agent-chip", selectedAgent.missingAccount ? "is-danger" : "is-warn")}>
                  <AlertTriangle size={10} />{t("agentNeedsAccount")}
                </em>
              ) : null}
              {selectedAgent.missingSkills.length > 0 ? (
                <em className="agent-chip is-warn" title={agentMissingSkillsText(t, selectedAgent.missingSkills)}>
                  <AlertTriangle size={10} />{agentMissingSkillsText(t, selectedAgent.missingSkills)}
                </em>
              ) : null}
              {selectedAgent.modified ? (
                <em className="agent-chip is-accent" title={t("agentModifiedHint")}>
                  <Pencil size={10} />{t("agentModified")}
                </em>
              ) : null}
              {selectedAgent.enabledByProfiles.map((id) => (
                <em key={id} className="agent-chip is-quiet" title={t("agentEnabledProfilesHint", { profiles: profileNames.get(id) ?? id })}>
                  <Users size={10} />{profileNames.get(id) ?? id}
                </em>
              ))}
            </div>

            {/* C15.1：旧文件里出现过已废弃的 scopes 字段 —— 一行灰字，不报错、不阻塞保存。 */}
            {selectedAgent.scopesDeprecated ? (
              <p className="agent-lib__deprecated-note" role="note">{t("agentScopesDeprecated")}</p>
            ) : null}

            <p className="agent-lib__path" data-i18n-skip>{agentPathHint(selectedAgent.id)}</p>
          </div>
        ) : null}
      </aside>

      {createOpen ? (
        <AgentCreateDialog
          existingIds={agents.map((agent) => agent.id)}
          skills={skills}
          enabledSkillIds={enabledSkillIds}
          busy={busy === "create"}
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (fields) => {
            setBusy("create");
            try {
              const created = await saveAiAgent({ id: fields.id, content: renderAgentDocument(fields) });
              await handleDraftCreated(created);
            } catch (nextError) {
              const message = nextError instanceof Error ? nextError.message : String(nextError);
              logger.error("ai agent create failed", nextError);
              onNotify({ kind: "error", title: t("createAgent"), message });
            } finally {
              setBusy(null);
            }
          }}
        />
      ) : null}

      {generateOpen ? (
        <AgentGenerateDialog
          models={models}
          activeModelId={activeModelId}
          generateDraft={generateDraft}
          onCancel={() => setGenerateOpen(false)}
          onSaved={handleDraftCreated}
          onNotify={onNotify}
        />
      ) : null}

      {confirmPrompt.element}
    </div>
  );
}

/** 新建 Agent：字段 → 五段骨架 AGENTS.md → `ai_agent_save`。 */
function AgentCreateDialog({
  existingIds,
  skills: availableSkills,
  enabledSkillIds,
  busy,
  onCancel,
  onSubmit
}: {
  existingIds: string[];
  skills: AiSkillDefinition[];
  enabledSkillIds: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (fields: AiAgentDraftFields) => Promise<void>;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const dialogDrag = useDraggableSurface<HTMLElement>();
  const [name, setName] = useState("");
  // C31：新建自定义 Agent 的默认 role = 只读咨询角色（对手盘视角的通用形态）。
  // 具体咨询对象由用户在 Profile 里勾选；这里只是建议起手值。
  const [role, setRole] = useState<string>(AGENT_ROLE_SUGGESTIONS[0]);
  const [responsibility, setResponsibility] = useState("");
  const [envelope, setEnvelope] = useState<AiAgentDraftFields["envelope"]>("standard");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [requiresAccount, setRequiresAccount] = useState(false);
  const [idOverride, setIdOverride] = useState("");
  const derivedId = useMemo(() => slugifyAgentName(name.trim() || "agent", idOverride ? "custom" : "custom"), [idOverride, name]);
  const id = idOverride.trim() || derivedId;
  const idConflict = idOverride.trim() ? existingIds.includes(idOverride.trim()) : false;
  // 契约 C15：envelope 取严只看"声明 risk 或 role=account_risk"（不再由 scopes 推导），且不可关闭。
  const riskLocked = role === "account_risk";
  const effectiveEnvelope: AiAgentDraftFields["envelope"] = riskLocked || envelope === "risk" ? "risk" : "standard";
  const preview = useMemo(() => renderAgentDocument({
    id,
    name: name.trim(),
    role,
    envelope: effectiveEnvelope,
    skills: skillIds,
    requiresAccount,
    source: "custom",
    version: 1,
    createdAt: Date.now(),
    body: buildAgentSkeletonBody({ name: name.trim(), role, responsibility, requiresAccount })
  }), [effectiveEnvelope, id, name, requiresAccount, responsibility, role, skillIds]);

  const submit = () => {
    if (!name.trim() || !responsibility.trim() || idConflict) return;
    void onSubmit({
      id,
      name: name.trim(),
      role,
      envelope: effectiveEnvelope,
      skills: skillIds,
      requiresAccount,
      source: "custom",
      version: 1,
      createdAt: Date.now(),
      body: buildAgentSkeletonBody({ name: name.trim(), role, responsibility, requiresAccount })
    });
  };

  return createPortal(
    <div className="modal-backdrop agent-lib-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section ref={dialogDrag.surfaceRef} className="modal-shell agent-lib-dialog" role="dialog" aria-modal="true" aria-label={t("createAgent")}>
        <header className="modal-head agent-lib-dialog__head" {...dialogDrag.handleProps}>
          <div><strong>{t("createAgent")}</strong><span>{t("agentsIntro")}</span></div>
          <button className="window-button" type="button" onClick={onCancel} title={t("common:close")}><X size={16} /></button>
        </header>
        <div className="agent-lib-dialog__body">
          <div className="agent-lib-dialog__form">
            <label><span>{t("agentName")}</span><input autoFocus maxLength={40} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label><span>{t("agentRole")}</span>
              {/* C16②：可输入 + 建议下拉的组合控件（保留自由输入 slug 的能力）。 */}
              <AgentRoleCombo value={role} suggestions={AGENT_ROLE_SUGGESTIONS} onChange={setRole} ariaLabel={t("agentRole")} />
            </label>
            <label className="wide"><span>{t("agentResponsibility")}</span><textarea rows={4} maxLength={800} value={responsibility} placeholder={t("agentResponsibilityPlaceholder")} onChange={(event) => setResponsibility(event.target.value)} /></label>
            <label><span>{t("agentId")}</span><input value={idOverride} placeholder={derivedId} maxLength={48} onChange={(event) => setIdOverride(event.target.value)} /></label>
            <label><span>{t("agentEnvelope")}</span>
              {/* C16②：原生 select 收敛为设计系统的 TerminalSelect（触发按钮带冻结钩子）。 */}
              <div data-agent-envelope-select>
                <TerminalSelect
                  ariaLabel={t("agentEnvelope")}
                  value={effectiveEnvelope}
                  disabled={riskLocked}
                  options={AGENT_ENVELOPE_OPTIONS.map((item) => ({
                    value: item,
                    label: item === "risk" ? t("agentEnvelopeRisk") : t("agentEnvelopeStandard"),
                    description: item === "risk" ? t("agentEnvelopeHint") : undefined
                  }))}
                  onChange={(value) => setEnvelope(value as AiAgentDraftFields["envelope"])}
                />
              </div>
            </label>
            <p className="agent-lib-dialog__note"><ShieldAlert size={12} />{t("agentEnvelopeHint")}</p>
            <label className="wide"><span>{t("agentSkills")}</span>
              {/* C16①：多选下拉（可搜索、键盘可操作），只允许从已配置 Skill 里选。 */}
              <AgentSkillSelect
                skills={availableSkills}
                enabledSkillIds={enabledSkillIds}
                value={skillIds}
                onChange={setSkillIds}
                disabled={busy}
              />
              <small>{t("agentSkillsHint")}</small>
            </label>
            <label className="wide agent-lib-dialog__check">
              <input type="checkbox" checked={requiresAccount} onChange={(event) => setRequiresAccount(event.target.checked)} />
              <span>{t("agentNeedsAccount")}</span>
            </label>
            {idConflict ? <p className="agent-lib-dialog__error" role="alert"><AlertTriangle size={12} />{agentValidationText(t, "id-conflict")}</p> : null}
            <p className="agent-lib-dialog__path" data-i18n-skip>{t("agentPath")}: {agentPathHint(id)}</p>
          </div>
          <div className="agent-lib-dialog__preview">
            <div className="agent-lib-dialog__preview-head"><Eye size={12} />{t("common:preview")}</div>
            <div className="agent-lib__preview"><AiMarkdown content={preview} /></div>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>{t("common:cancel")}</button>
          <button type="button" className="confirm" disabled={busy || !name.trim() || !responsibility.trim() || idConflict} onClick={submit}>
            {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}{t("agentSave")}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

/** AI 创建 Agent：描述 → `ai_agent_generate` 草稿（不落盘）→ 可编辑预览 → `ai_agent_save`。 */
function AgentGenerateDialog({
  models,
  activeModelId,
  generateDraft,
  onCancel,
  onSaved,
  onNotify
}: {
  models: AiModelConfigSummary[];
  activeModelId: string;
  generateDraft: (input: AgentDraftRequest) => Promise<{ content: string; warnings: string[] }>;
  onCancel: () => void;
  onSaved: (created: AiAgentSummary | null) => Promise<void>;
  onNotify: AgentLibraryViewProps["onNotify"];
}) {
  const { t } = useTranslation(["automation", "common"]);
  const dialogDrag = useDraggableSurface<HTMLElement>();
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [mode, setMode] = useState<"source" | "preview">("preview");
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // P1/P2/P3：生成过程可见 —— 阶段、秒表、字符数、流式文本、取消。
  const [stage, setStage] = useState<AgentDraftStage>("idle");
  const [streamText, setStreamText] = useState("");
  const [streamChars, setStreamChars] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const requestIdRef = useRef("");
  // Rust 侧自己生成 requestId（`agent-draft-<ms>-<suffix>`），UI 只有在收到第一个 delta 时
  // 才知道它。因此这里采用"首个 delta 的 requestId 即为本轮流标识"：既不会串入上一次请求的
  // 残留增量（id 不同），也能与 Rust 自生成 id 对齐。
  const streamRequestIdRef = useRef("");
  const cancelledRef = useRef(false);
  const streamRef = useRef<HTMLPreElement | null>(null);
  // C16③：默认选中当前模型；模型消失时提示并回落（不静默）。
  const fallbackModelId = useMemo(
    () => (models.some((item) => item.id === activeModelId) ? activeModelId : models[0]?.id ?? ""),
    [activeModelId, models]
  );
  const [modelId, setModelId] = useState(fallbackModelId);
  const [generatedByModelId, setGeneratedByModelId] = useState("");
  const [modelNotice, setModelNotice] = useState("");
  const modelMissing = Boolean(modelId) && !models.some((item) => item.id === modelId);
  const effectiveModelId = modelMissing || !modelId ? fallbackModelId : modelId;
  const modelLabel = useCallback((id: string) => {
    const model = models.find((item) => item.id === id);
    return model ? `${model.name} · ${model.model}` : id || "--";
  }, [models]);
  const generatedByName = generatedByModelId ? modelLabel(generatedByModelId) : "";

  useEffect(() => {
    setModelId((current) => (current && models.some((item) => item.id === current) ? current : fallbackModelId));
    if (modelMissing) setModelNotice(t("agentModelMissing"));
  }, [fallbackModelId, modelMissing, models, t]);

  const resolveModelId = () => {
    if (modelMissing) {
      setModelId(fallbackModelId);
      setModelNotice(t("agentModelMissing"));
      return fallbackModelId;
    }
    return effectiveModelId;
  };

  const appendDelta = useCallback((delta: string, chars?: number) => {
    setStreamText((current) => current + delta);
    setStreamChars((current) => (typeof chars === "number" && Number.isFinite(chars) ? Math.max(current, chars) : current + delta.length));
    setStage((current) => (current === "streaming" || current === "finalizing" ? current : "streaming"));
  }, []);

  // P2：真机增量来自 `ai:event`（`agentDraftDelta`），按 requestId 严格过滤；
  // 只有 Rust 没回传 requestId 时才退回"本次生成期间全部接收"。
  useEffect(() => {
    if (busy !== "generate" || !requestIdRef.current) return;
    let cleanup: (() => void) | null = null;
    let disposed = false;
    void listenAiEvents((event) => {
      if (event.type !== "agentDraftDelta") return;
      if (event.requestId) {
        if (!streamRequestIdRef.current) streamRequestIdRef.current = event.requestId;
        else if (event.requestId !== streamRequestIdRef.current) return;
      }
      if (cancelledRef.current) return;
      appendDelta(event.delta, event.chars);
    }).then((unlisten) => {
      if (disposed) { unlisten?.(); return; }
      cleanup = unlisten;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [appendDelta, busy]);

  // P1：1s 秒表（只在生成期间走）。
  useEffect(() => {
    if (busy !== "generate") return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds(Math.round((Date.now() - startedAt) / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // P2：流式区自动滚到底部。
  useEffect(() => {
    const node = streamRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [streamText]);

  const generate = () => {
    if (!description.trim()) return;
    const requestModelId = resolveModelId();
    const requestId = createDraftRequestId();
    requestIdRef.current = requestId;
    streamRequestIdRef.current = "";
    cancelledRef.current = false;
    setCancelling(false);
    setBusy("generate");
    setError(null);
    setStreamText("");
    setStreamChars(0);
    setDraftContent("");
    setWarnings([]);
    setStage("preparing");
    // 阶段一：先进入"准备提示词"，下一帧就算已发出请求（本地推导，不依赖新事件）。
    window.setTimeout(() => setStage((current) => (current === "preparing" ? "requested" : current)), 0);
    void generateDraft({
      description: description.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(requestModelId ? { model: requestModelId } : {}),
      requestId,
      onDelta: (delta, chars) => { if (!cancelledRef.current) appendDelta(delta, chars); },
      isCancelled: () => cancelledRef.current
    })
      .then((result) => {
        if (cancelledRef.current) {
          setStage("cancelled");
          return;
        }
        setStage("finalizing");
        setDraftContent(result.content);
        setWarnings(result.warnings);
        setGeneratedByModelId(requestModelId);
        setMode("preview");
      })
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        if (cancelledRef.current || /cancel/i.test(message)) {
          setStage("cancelled");
          return;
        }
        logger.error("ai agent generate failed", nextError);
        setStage("failed");
        setError(t("agentGenerateFailed"));
        onNotify({ kind: "error", title: t("agentGenerateFailed"), message });
      })
      .finally(() => setBusy(null));
  };

  // P3：取消（幂等：重复点击不再发第二次请求，命令报错也按已结束处理）。
  const cancelGenerate = () => {
    if (cancelling) return;
    // 优先用 delta 里学到的 Rust requestId；还没有 delta 时退回 UI 请求 id。
    const requestId = streamRequestIdRef.current || requestIdRef.current;
    cancelledRef.current = true;
    setCancelling(true);
    setStage("cancelling");
    void cancelAiAgentDraft(requestId);
  };

  const save = () => {
    const validation = validateAgentDraft(draftContent, "");
    if (validation) {
      setError(agentValidationText(t, validation));
      return;
    }
    // 保存不依赖模型，但模型已被移除时仍要显式提示（不静默）。
    resolveModelId();
    setBusy("save");
    setError(null);
    void saveAiAgent({ content: draftContent })
      .then((created) => onSaved(created))
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        logger.error("ai agent draft save failed", nextError);
        setError(t("agentSaveFailed"));
        onNotify({ kind: "error", title: t("agentSaveFailed"), message });
      })
      .finally(() => setBusy(null));
  };

  return createPortal(
    <div className="modal-backdrop agent-lib-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section ref={dialogDrag.surfaceRef} className="modal-shell agent-lib-dialog" role="dialog" aria-modal="true" aria-label={t("createAgentWithAi")}>
        <header className="modal-head agent-lib-dialog__head" {...dialogDrag.handleProps}>
          <div><strong>{t("createAgentWithAi")}</strong><span>{t("agentGenerateHint")}</span></div>
          <button className="window-button" type="button" onClick={onCancel} title={t("common:close")}><X size={16} /></button>
        </header>
        <div className="agent-lib-dialog__body is-generate">
          <div className="agent-lib-dialog__form">
            <label className="wide"><span>{t("agentName")}</span><input value={name} maxLength={40} placeholder={t("agentNameOptional")} onChange={(event) => setName(event.target.value)} /></label>
            <label className="wide"><span>{t("agentModelSelect")}</span>
              {/* C16③：与 Profile 模型选择同款控件与文案风格，默认当前模型。 */}
              <div data-agent-model-select>
                <TerminalSelect
                  ariaLabel={t("agentModelSelect")}
                  value={effectiveModelId}
                  disabled={busy !== null}
                  options={models.length > 0
                    ? models.map((item) => ({ value: item.id, label: `${item.name} · ${item.model}` }))
                    : [{ value: "", label: t("agentNoModels"), disabled: true }]}
                  onChange={(value) => {
                    setModelId(value);
                    setModelNotice("");
                  }}
                />
              </div>
              <small>{t("agentModelHint")}</small>
            </label>
            {modelNotice ? <p className="agent-lib-dialog__error" role="alert"><AlertTriangle size={12} />{modelNotice}</p> : null}
            <label className="wide"><span>{t("agentDescription")}</span>
              <textarea rows={7} data-agent-ai-description value={description} placeholder={t("agentGeneratePlaceholder")} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <p className="agent-lib-dialog__note"><Sparkles size={12} />{t("agentGenerateNote")}</p>
            {warnings.length > 0 ? (
              <div className="agent-lib-dialog__warnings" role="note">
                <strong>{t("agentGenerateWarnings")}</strong>
                <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            ) : null}
            {error ? <p className="agent-lib-dialog__error" role="alert"><AlertTriangle size={12} />{error}</p> : null}
          </div>
          <div className="agent-lib-dialog__preview">
            <div className="agent-lib-dialog__preview-head">
              <div className="agent-lib__mode" role="tablist" aria-label={t("agentEditorModeAria")}>
                <button type="button" role="tab" aria-selected={mode === "source"} disabled={busy === "generate"} className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}><FileCode2 size={12} />{t("agentSourceTab")}</button>
                <button type="button" role="tab" aria-selected={mode === "preview"} disabled={busy === "generate"} className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}><Eye size={12} />{t("common:preview")}</button>
              </div>
            </div>
            <div className="agent-lib-dialog__preview-body">
            {generatedByName ? (
              <p className="agent-lib-dialog__note" data-agent-generated-by>
                <Sparkles size={12} />{t("agentGeneratedBy", { model: generatedByName })}
              </p>
            ) : null}
            {/* P1/P2/P3：生成中 / 取消中 / 失败 / 已取消 —— 右栏从空态切为可见的过程卡片。 */}
            {busy === "generate" || stage === "failed" || stage === "cancelled" ? (
              <div className="agent-draft-progress" data-agent-draft-progress data-draft-stage={stage} role="status">
                <div className="agent-draft-progress__head">
                  <span className={clsx("agent-draft-progress__pulse", busy === "generate" && "is-live")} aria-hidden="true">
                    {busy === "generate" ? <Loader2 size={12} className="spin" /> : stage === "cancelled" ? <X size={12} /> : <AlertTriangle size={12} />}
                  </span>
                  <strong>{t("agentDraftProgressTitle")}</strong>
                  <em data-agent-draft-phase>{t(AGENT_DRAFT_PHASE_KEY[stage])}</em>
                </div>
                <dl className="agent-draft-progress__facts">
                  <div><dt>{t("agentDraftElapsedLabel")}</dt><dd data-agent-draft-elapsed>{t("agentDraftElapsed", { seconds: elapsedSeconds })}</dd></div>
                  <div>
                    <dt>{t("agentModelSelect")}</dt>
                    {/* 终态不再说"生成中"：取消/失败后这行是记录，不是进行时。 */}
                    <dd data-agent-draft-model>
                      {busy === "generate"
                        ? t("agentDraftModel", { model: modelLabel(effectiveModelId) })
                        : t("agentGeneratedBy", { model: modelLabel(effectiveModelId) })}
                    </dd>
                  </div>
                  <div><dt>{t("agentDraftCharsLabel")}</dt><dd data-agent-draft-chars>{t("agentDraftChars", { chars: streamChars })}</dd></div>
                </dl>
                {stage === "cancelled" ? <p className="agent-draft-progress__note">{t("agentDraftStageCancelled")}</p> : null}
                {stage === "failed" ? <p className="agent-draft-progress__note is-error"><AlertTriangle size={11} />{error || t("agentGenerateFailed")}</p> : null}
                {/* P2：模型原始输出逐字显示（未渲染 frontmatter），保留换行并自动滚到底。 */}
                <pre className="agent-draft-progress__stream" data-agent-draft-stream ref={streamRef}>{streamText}</pre>
              </div>
            ) : null}
            {!draftContent && busy !== "generate" && (stage === "failed" || stage === "cancelled") ? (
              <div className="agent-lib-dialog__preview-actions">
                <button type="button" onClick={generate} disabled={!description.trim()}>{t("agentGenerateAction")}</button>
              </div>
            ) : null}
            {busy !== "generate" && draftContent ? (
              mode === "source" ? (
                <textarea className="agent-lib__source" data-agent-draft-editor spellCheck={false} value={draftContent} aria-label={t("agentSourceTab")} onChange={(event) => setDraftContent(event.target.value)} />
              ) : (
                <div className="agent-lib__preview" data-agent-draft-preview><AiMarkdown content={draftContent} /></div>
              )
            ) : null}
            {!draftContent && busy !== "generate" && stage !== "failed" && stage !== "cancelled" ? (
              <div className="agent-lib-dialog__preview-empty">
                <Sparkles size={18} />
                <strong>{t("agentGenerateEmptyTitle")}</strong>
                <span>{t("agentGenerateEmptyHint")}</span>
              </div>
            ) : null}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>{t("common:cancel")}</button>
          {busy === "generate" ? (
            <button type="button" className="agent-lib__cancel" data-agent-ai-cancel disabled={cancelling} onClick={cancelGenerate}>
              {cancelling ? <Loader2 size={13} className="spin" /> : <X size={13} />}
              {cancelling ? t("agentDraftCancelling") : t("agentDraftCancel")}
            </button>
          ) : null}
          <button
            type="button"
            className="agent-lib__generate"
            data-agent-ai-generate
            data-draft-ready={draftContent ? "true" : "false"}
            disabled={busy !== null || !description.trim()}
            onClick={generate}
          >
            {busy === "generate" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            {busy === "generate" ? t("agentDraftGenerating") : draftContent ? t("agentRegenerate") : t("agentGenerateAction")}
          </button>
          <button type="button" className="confirm" disabled={!draftContent || busy !== null} title={draftContent ? t("agentSave") : t("agentGenerateEmptyHint")} onClick={save}>
            {busy === "save" ? <Loader2 size={13} className="spin" /> : <Check size={13} />}{t("agentSave")}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

export default AgentLibraryView;
