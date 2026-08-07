import { BrainCircuit, Code2, Eye, EyeOff, Pencil, Plus, Search, Send, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { generateChartIndicatorWithAi, listenAiEvents } from "../lib/ai";
import { useDraggableSurface } from "./useDraggableSurface";
import {
  BUILT_IN_INDICATORS,
  INDICATOR_DEFINITIONS,
  type IndicatorDefinition,
  type IndicatorId,
  type IndicatorInstance,
  type IndicatorParameters
} from "../lib/chartIndicators";
import { listenOptional } from "../lib/tauri";
import type { AiChatMessage, AiEvent } from "../types";
import { AiMessageError, AiProcessTimeline, AiTokenUsageLine, MarkdownMessage, applyAiEvent, updateLastAssistant, type AiUiMessage } from "./AiMessageProcess";
import type { ChartScriptDefinition, ChartScriptRunState } from "./chartScriptEngine";

type Props = {
  instances: readonly IndicatorInstance[];
  onChange: (instances: IndicatorInstance[]) => void;
  unavailableIds?: ReadonlySet<string>;
  externalTrigger?: HTMLElement | null;
  openRequest?: number;
  hideInlineControls?: boolean;
  customScripts?: readonly ChartScriptDefinition[];
  customScriptRunStates?: Readonly<Record<string, ChartScriptRunState>>;
  onOpenCustomIndicatorEditor?: (scriptId?: string) => void;
  onEnableCustomIndicator?: (scriptId: string) => void;
  onToggleCustomIndicatorVisibility?: (scriptId: string) => void;
  onRemoveCustomIndicator?: (scriptId: string) => void;
};

type PopoverPosition = {
  left: number;
  top: number;
  maxHeight: number;
  placement: "above" | "below";
};

type IndicatorTooltip = {
  id: string;
  name: string;
  description: string;
  pane: "main" | "sub" | "script";
  left: number;
  top: number;
};

type IndicatorAiStatus = "idle" | "running" | "done" | "error";

type IndicatorAiChartAction = {
  id?: string;
  sessionId?: string;
  toolName?: string;
  payload?: Record<string, unknown>;
};

const COLOR_BY_INDICATOR: Record<IndicatorId, string> = {
  ma: "#f5a524",
  ema: "#e5e7eb",
  vwap: "#67e8f9",
  boll: "#b792ff",
  donchian: "#38bdf8",
  keltner: "#22d3ee",
  psar: "#fb7185",
  rsi: "#a78bfa",
  macd: "#5eead4",
  kdj: "#f0abfc",
  atr: "#fb923c",
  supertrend: "#22c55e",
  ichimoku: "#f97316",
  adx: "#60a5fa",
  stochastic: "#c084fc",
  cci: "#fb7185",
  roc: "#38bdf8",
  aroon: "#818cf8",
  trix: "#f472b6",
  "williams-r": "#facc15",
  mfi: "#34d399",
  cmf: "#14b8a6",
  obv: "#93c5fd",
  "volume-ma": "#fbbf24"
};

const INDICATOR_DESCRIPTION_KEYS: Record<IndicatorId, string> = {
  ma: "indicatorDescriptionMa",
  ema: "indicatorDescriptionEma",
  vwap: "indicatorDescriptionVwap",
  boll: "indicatorDescriptionBoll",
  donchian: "indicatorDescriptionDonchian",
  keltner: "indicatorDescriptionKeltner",
  psar: "indicatorDescriptionPsar",
  supertrend: "indicatorDescriptionSupertrend",
  ichimoku: "indicatorDescriptionIchimoku",
  rsi: "indicatorDescriptionRsi",
  macd: "indicatorDescriptionMacd",
  kdj: "indicatorDescriptionKdj",
  atr: "indicatorDescriptionAtr",
  adx: "indicatorDescriptionAdx",
  stochastic: "indicatorDescriptionStochastic",
  cci: "indicatorDescriptionCci",
  roc: "indicatorDescriptionRoc",
  aroon: "indicatorDescriptionAroon",
  trix: "indicatorDescriptionTrix",
  "williams-r": "indicatorDescriptionWilliamsR",
  mfi: "indicatorDescriptionMfi",
  cmf: "indicatorDescriptionCmf",
  obv: "indicatorDescriptionObv",
  "volume-ma": "indicatorDescriptionVolumeMa"
};

const INDICATOR_PARAMETER_LABEL_KEYS: Record<string, string> = {
  period: "indicatorParameterPeriod",
  multiplier: "indicatorParameterMultiplier",
  atrPeriod: "indicatorParameterAtrPeriod",
  step: "indicatorParameterStep",
  maxStep: "indicatorParameterMaxStep",
  conversionPeriod: "indicatorParameterConversion",
  basePeriod: "indicatorParameterBase",
  spanBPeriod: "indicatorParameterSpanB",
  fast: "indicatorParameterFast",
  slow: "indicatorParameterSlow",
  signal: "indicatorParameterSignal",
  kPeriod: "indicatorParameterKSmoothing",
  dPeriod: "indicatorParameterDSmoothing",
  kSmoothing: "indicatorParameterKSmoothing"
};

export function createBuiltInIndicator(definitionId: IndicatorId, index: number): IndicatorInstance {
  const definition = INDICATOR_DEFINITIONS[definitionId];
  const parameters = Object.fromEntries(definition.parameters.map((item) => [item.key, item.defaultValue]));
  const id = `indicator-${definitionId}-${Date.now()}-${index}`;
  return {
    id,
    definitionId,
    paneId: definition.pane === "main" ? "main" : `pane-${id}`,
    visible: true,
    parameters
  };
}

export function indicatorColor(definitionId: IndicatorId, outputIndex = 0) {
  const base = COLOR_BY_INDICATOR[definitionId];
  if (outputIndex === 0) return base;
  const variants = ["#b792ff", "#67e8f9", "#f5a524", "#f0abfc"];
  return variants[(outputIndex - 1) % variants.length];
}

function customIndicatorColor(script: ChartScriptDefinition, state?: ChartScriptRunState) {
  if (state?.status === "error" || state?.status === "timeout") return "#f6465d";
  return state?.output.lines.find((line) => line.color)?.color
    ?? scriptColorFromId(script.id)
    ?? (script.enabled ? "#67e8f9" : "rgba(255,255,255,0.32)");
}

function scriptColorFromId(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  const palette = ["#67e8f9", "#b792ff", "#f5a524", "#5eead4", "#f0abfc", "#fb7185"];
  return palette[hash % palette.length];
}

function clampParameterValue(value: number, parameter: { min?: number; max?: number; type: "integer" | "number" }) {
  const lower = Number.isFinite(parameter.min) ? parameter.min! : Number.NEGATIVE_INFINITY;
  const upper = Number.isFinite(parameter.max) ? parameter.max! : Number.POSITIVE_INFINITY;
  const bounded = Math.min(upper, Math.max(lower, value));
  return parameter.type === "integer" ? Math.round(bounded) : bounded;
}

function resolvePopoverPosition(trigger: HTMLElement, wide = false): PopoverPosition {
  const rect = trigger.getBoundingClientRect();
  const margin = 10;
  const targetWidth = wide ? 1120 : 760;
  const width = Math.min(targetWidth, Math.max(0, window.innerWidth - margin * 2));
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const centeredLeft = rect.left + (rect.width - width) / 2;
  const left = Math.min(Math.max(margin, centeredLeft), maxLeft);
  const below = rect.bottom + 8;
  const belowSpace = Math.max(0, window.innerHeight - below - margin);
  const aboveSpace = Math.max(0, rect.top - margin);
  const estimatedHeight = Math.min(610, Math.max(320, window.innerHeight * 0.72));
  const openAbove = belowSpace < Math.min(260, estimatedHeight) && aboveSpace > belowSpace;
  const availableHeight = openAbove ? aboveSpace : belowSpace;
  const maxHeight = Math.min(estimatedHeight, availableHeight);
  const top = openAbove
    ? Math.max(margin, rect.top - maxHeight)
    : Math.min(Math.max(margin, below), Math.max(margin, window.innerHeight - margin - maxHeight));
  return { left, top, maxHeight, placement: openAbove ? "above" : "below" };
}

function resolveTooltipPosition(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const margin = 10;
  const width = Math.min(280, Math.max(220, window.innerWidth - margin * 2));
  const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
  const belowTop = rect.bottom + 7;
  const top = belowTop + 120 > window.innerHeight && rect.top > 136
    ? rect.top - 126
    : belowTop;
  return { left, top: Math.max(margin, top) };
}

function createIndicatorAiSessionId() {
  return `chart-indicator-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function canonicalAiToolName(name: string) {
  return name.replaceAll("_", ".");
}

function formatIndicatorAiError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : String(error || fallback);
}

function toIndicatorAiChatMessages(messages: AiUiMessage[]): AiChatMessage[] {
  return messages
    .filter((message) => message.id !== "welcome" && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.text.trim()
    }))
    .filter((message) => message.content.length > 0);
}

function indicatorAiRuntimeStatus(status: string): IndicatorAiStatus {
  if (status === "failed" || status === "stopped") return "error";
  if (status === "idle") return "done";
  if (status === "connecting" || status === "running" || status === "streaming" || status === "tooling") return "running";
  return "running";
}

export function ChartIndicatorCenter({
  instances,
  onChange,
  unavailableIds = new Set<string>(),
  externalTrigger = null,
  openRequest,
  hideInlineControls = false,
  customScripts = [],
  customScriptRunStates = {},
  onOpenCustomIndicatorEditor,
  onEnableCustomIndicator,
  onToggleCustomIndicatorVisibility,
  onRemoveCustomIndicator
}: Props) {
  const { t, i18n } = useTranslation(["chart", "common", "errors"]);
  const popoverDrag = useDraggableSurface<HTMLElement>();
  const parameterDialogDrag = useDraggableSurface<HTMLElement>();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const [indicatorTooltip, setIndicatorTooltip] = useState<IndicatorTooltip | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiSessionId] = useState(createIndicatorAiSessionId);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiStatus, setAiStatus] = useState<IndicatorAiStatus>("idle");
  const [aiClockNow, setAiClockNow] = useState(Date.now());
  const [aiMessages, setAiMessages] = useState<AiUiMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: t("chart:indicatorAiWelcome"),
      tools: [],
      approvals: [],
      status: t("chart:indicatorAiWaitingInput")
    }
  ]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const aiMessagesRef = useRef<HTMLDivElement | null>(null);
  const aiCreatedScriptRef = useRef(false);
  const aiTerminalErrorRef = useRef(false);
  const popoverId = useId();
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const choices = useMemo(
    () => BUILT_IN_INDICATORS.filter((item) => !deferredQuery || `${item.name} ${item.id} ${t(`chart:${INDICATOR_DESCRIPTION_KEYS[item.id]}`)}`.toLowerCase().includes(deferredQuery)),
    [deferredQuery, t]
  );
  const customChoices = useMemo(
    () => customScripts.filter((script) => !deferredQuery || `${script.name} ${script.description} ${script.id}`.toLowerCase().includes(deferredQuery)),
    [customScripts, deferredQuery]
  );
  const selectedCustomScripts = useMemo(() => customScripts.filter((script) => script.enabled), [customScripts]);
  const selectedCount = instances.length + selectedCustomScripts.length;
  const updatePosition = useCallback(() => {
    const trigger = externalTrigger ?? triggerRef.current;
    if (!trigger) return;
    setPosition(resolvePopoverPosition(trigger, aiPanelOpen));
  }, [aiPanelOpen, externalTrigger]);
  const toggle = (id: string) => onChange(instances.map((item) => item.id === id ? { ...item, visible: !item.visible } : item));
  const remove = (id: string) => onChange(instances.filter((item) => item.id !== id));
  const updateParameters = (id: string, parameters: IndicatorParameters) =>
    onChange(instances.map((item) => item.id === id ? { ...item, parameters } : item));
  const add = (definitionId: IndicatorId) => {
    onChange([...instances, createBuiltInIndicator(definitionId, instances.length)]);
  };
  const showBuiltInIndicatorTooltip = (definition: IndicatorDefinition, target: HTMLElement) => {
    const next = resolveTooltipPosition(target);
    setIndicatorTooltip({
      id: definition.id,
      name: definition.name,
      description: t(`chart:${INDICATOR_DESCRIPTION_KEYS[definition.id]}`),
      pane: definition.pane,
      left: next.left,
      top: next.top,
    });
  };
  const showCustomIndicatorTooltip = (script: ChartScriptDefinition, state: ChartScriptRunState | undefined, target: HTMLElement) => {
    const next = resolveTooltipPosition(target);
    setIndicatorTooltip({
      id: script.id,
      name: script.name,
      description: state?.error
        ? t("chart:indicatorErrorReason", { error: state.error })
        : script.description || t("chart:indicatorCustomDescriptionFallback"),
      pane: "script",
      left: next.left,
      top: next.top,
    });
  };
  const hideBuiltInIndicatorTooltip = () => setIndicatorTooltip(null);
  const submitIndicatorAiPrompt = async () => {
    const content = aiPrompt.trim();
    if (!content || aiStatus === "running") return;
    const now = Date.now();
    const userMessage: AiUiMessage = { id: `user-${now}`, role: "user", text: content, tools: [], approvals: [] };
    const nextConversation = toIndicatorAiChatMessages([...aiMessages, userMessage]);
    aiCreatedScriptRef.current = false;
    aiTerminalErrorRef.current = false;
    setAiStatus("running");
    setAiPrompt("");
    setAiMessages((items) => [
      ...items,
      userMessage,
      { id: `assistant-${now}`, role: "assistant", text: "", reasoning: "", tools: [], approvals: [], status: t("chart:indicatorAiPreparing") }
    ]);
    try {
      await generateChartIndicatorWithAi(aiSessionId, content, nextConversation);
    } catch (error) {
      aiTerminalErrorRef.current = true;
      setAiStatus("error");
      setAiMessages((items) => updateLastAssistant(items, (message) => ({
        ...message,
        text: formatIndicatorAiError(error, t("chart:indicatorAiRequestFailed")),
        status: t("chart:indicatorAiRequestFailed"),
        error: true
      })));
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const trigger = externalTrigger ?? triggerRef.current;
    const observer = typeof ResizeObserver === "undefined" || !trigger
      ? null
      : new ResizeObserver(updatePosition);
    if (observer && trigger) observer.observe(trigger);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [externalTrigger, open, updatePosition]);

  useEffect(() => {
    if (openRequest === undefined) return;
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    setAiMessages((items) => items.map((message) => message.id === "welcome"
      ? { ...message, text: t("chart:indicatorAiWelcome"), status: t("chart:indicatorAiWaitingInput") }
      : message));
  }, [i18n.resolvedLanguage, t]);

  useEffect(() => {
    if (!open) setIndicatorTooltip(null);
  }, [open]);

  useEffect(() => {
    if (!aiPanelOpen) return;
    const node = aiMessagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [aiMessages, aiPanelOpen]);

  useEffect(() => {
    if (!aiPanelOpen || aiStatus !== "running") return;
    setAiClockNow(Date.now());
    const timer = window.setInterval(() => setAiClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [aiPanelOpen, aiStatus]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [aiPanelOpen, open, updatePosition]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAiEvents((event: AiEvent) => {
      if (disposed || event.sessionId !== aiSessionId) return;
      if (event.type === "error") {
        aiTerminalErrorRef.current = true;
        applyAiEvent(event, (status) => setAiStatus(indicatorAiRuntimeStatus(status)), setAiMessages);
        setAiMessages((items) => updateLastAssistant(items, (message) => ({ ...message, error: true })));
        return;
      }
      if (event.type === "done") {
        applyAiEvent(event, (status) => setAiStatus(indicatorAiRuntimeStatus(status)), setAiMessages);
        const failed = event.finishReason?.trim().toLowerCase() === "error";
        if (!failed && !aiTerminalErrorRef.current) {
          setAiStatus("done");
          setAiMessages((items) => updateLastAssistant(items, (message) => ({
            ...message,
            error: false,
            status: aiCreatedScriptRef.current ? undefined : t("chart:indicatorAiReady")
          })));
        }
        return;
      }
      if (event.type === "toolResult" && !event.ok) {
        aiTerminalErrorRef.current = true;
      }
      applyAiEvent(event, (status) => setAiStatus(indicatorAiRuntimeStatus(status)), setAiMessages);
      if (event.type === "toolResult" && !event.ok) {
        setAiStatus("error");
        setAiMessages((items) => updateLastAssistant(items, (message) => ({ ...message, error: true })));
      }
    }).then((dispose) => {
      if (disposed) {
        dispose?.();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [aiSessionId, t]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenOptional<IndicatorAiChartAction>("ai:chart-action", (action) => {
      if (disposed || action.sessionId !== aiSessionId) return;
      if (canonicalAiToolName(action.toolName ?? "") !== "script.createOrUpdate") return;
      const scriptName = typeof action.payload?.name === "string" && action.payload.name.trim()
        ? action.payload.name.trim()
        : typeof action.id === "string" && action.id.trim()
          ? action.id.trim()
          : t("chart:indicatorAiDefaultScriptName");
      aiCreatedScriptRef.current = true;
      setAiMessages((items) => updateLastAssistant(items, (message) => ({
        ...message,
        text: `${message.text.trim() ? message.text.trimEnd() : t("chart:indicatorAiCreatedDefault")}\n${t("chart:indicatorAiSavedToLibrary", { name: scriptName })}`,
        status: undefined,
        error: false
      })));
    }).then((dispose) => {
      if (disposed) {
        dispose?.();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [aiSessionId, t]);

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || triggerRef.current?.contains(target) || externalTrigger?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [externalTrigger, open]);

  const indicatorPopover = open && position && typeof document !== "undefined"
    ? createPortal(
      <section
        ref={(node) => {
          popoverRef.current = node;
          popoverDrag.surfaceRef.current = node;
        }}
        id={popoverId}
        className={aiPanelOpen ? "chart-indicator-popover chart-indicator-floating-popover ai-open" : "chart-indicator-popover chart-indicator-floating-popover"}
        data-popover-placement={position.placement}
        aria-label={t("chart:indicatorCenter")}
        style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        <header {...popoverDrag.handleProps}>
          <div>
            <strong>{t("chart:indicatorCenter")}</strong>
            <span>{t("chart:indicatorCenterDescription")}</span>
          </div>
          <button type="button" className="icon-button" title={t("common:close")} aria-label={t("common:close")} onClick={() => setOpen(false)}><X size={15} /></button>
        </header>
        <div className={aiPanelOpen ? "chart-indicator-workspace ai-open" : "chart-indicator-workspace"}>
          <aside className="chart-indicator-selected" aria-live="polite">
            <div className="chart-indicator-section-title"><strong>{t("chart:indicatorSelected")}</strong><span>{t("chart:indicatorCount", { count: selectedCount })}</span></div>
            <div className="chart-indicator-selected-list">
              {selectedCount === 0 ? <p>{t("chart:indicatorNoneSelected")}</p> : <>
              {instances.map((item) => {
                const definition = INDICATOR_DEFINITIONS[item.definitionId];
                const blocked = unavailableIds.has(item.id);
                return (
                  <article
                    key={item.id}
                    className={blocked ? "unavailable" : undefined}
                    data-indicator-instance={item.id}
                    onPointerEnter={(event) => showBuiltInIndicatorTooltip(definition, event.currentTarget)}
                    onPointerLeave={hideBuiltInIndicatorTooltip}
                    onFocus={(event) => showBuiltInIndicatorTooltip(definition, event.currentTarget)}
                    onBlur={hideBuiltInIndicatorTooltip}
                  >
                    <div className="chart-indicator-instance-title">
                      <i style={{ backgroundColor: indicatorColor(item.definitionId) }} />
                      <strong>{definition.name}</strong>
                      <span>{item.paneId === "main" ? t("chart:indicatorMainPane") : t("chart:indicatorSubPane")}</span>
                      <em className="chart-indicator-kind-tag">{t("chart:indicatorBuiltin")}</em>
                      {blocked && <em>{t("chart:indicatorRequiresTrades")}</em>}
                      <div className="chart-indicator-instance-actions">
                        <button type="button" title={item.visible ? t("chart:indicatorHide") : t("chart:indicatorShow")} aria-label={item.visible ? t("chart:indicatorHide") : t("chart:indicatorShow")} onClick={() => toggle(item.id)}>{item.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                        <button type="button" title={t("chart:indicatorEditParameters")} aria-label={t("chart:indicatorEditParameters")} onClick={() => setEditingId(item.id)}><Pencil size={14} /></button>
                        <button type="button" title={t("chart:indicatorDelete")} aria-label={t("chart:indicatorDelete")} onClick={() => remove(item.id)}><Trash2 size={14} /></button>
                      </div>
                    </div>
                  </article>
                );
              })}
              {selectedCustomScripts.map((script) => {
                const state = customScriptRunStates[script.id];
                const visible = !script.hidden;
                return (
                  <article
                    key={script.id}
                    className={state?.status === "error" || state?.status === "timeout" ? "unavailable" : undefined}
                    data-custom-indicator={script.id}
                    title={state?.error}
                    aria-describedby={indicatorTooltip?.id === script.id ? `${popoverId}-indicator-tip` : undefined}
                    onPointerEnter={(event) => showCustomIndicatorTooltip(script, state, event.currentTarget)}
                    onPointerLeave={hideBuiltInIndicatorTooltip}
                    onFocus={(event) => showCustomIndicatorTooltip(script, state, event.currentTarget)}
                    onBlur={hideBuiltInIndicatorTooltip}
                  >
                    <div className="chart-indicator-instance-title">
                      <i style={{ backgroundColor: customIndicatorColor(script, state) }} />
                      <strong data-i18n-skip>{script.name}</strong>
                      <span>{t("chart:indicatorScript")}</span>
                      <em className="chart-indicator-kind-tag custom">{t("chart:indicatorCustom")}</em>
                      {(state?.status === "error" || state?.status === "timeout") && <em>{t("chart:indicatorAbnormal")}</em>}
                      <div className="chart-indicator-instance-actions">
                        <button type="button" title={visible ? t("chart:indicatorHide") : t("chart:indicatorShow")} aria-label={visible ? t("chart:indicatorHide") : t("chart:indicatorShow")} onClick={() => onToggleCustomIndicatorVisibility?.(script.id)}>{visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                        <button type="button" title={t("chart:indicatorEditCustom")} aria-label={t("chart:indicatorEditCustom")} onClick={() => onOpenCustomIndicatorEditor?.(script.id)}><Pencil size={14} /></button>
                        <button type="button" title={t("chart:indicatorRemoveFromChart")} aria-label={t("chart:indicatorRemoveFromChart")} onClick={() => onRemoveCustomIndicator?.(script.id)}><Trash2 size={14} /></button>
                      </div>
                    </div>
                    {state?.error && <p className="chart-indicator-script-error" data-i18n-skip>{state.error}</p>}
                  </article>
                );
              })}
              </>}
            </div>
          </aside>
          <section className="chart-indicator-library" aria-label={t("chart:indicatorLibrary")}>
            <div className="chart-indicator-section-title"><strong>{t("chart:indicatorLibrary")}</strong><span>{t("chart:indicatorLibrarySummary", { builtin: choices.length, custom: customChoices.length })}</span></div>
            <div className="chart-indicator-library-tools">
              <div className="chart-indicator-search"><Search size={14} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("chart:indicatorSearchPlaceholder")} aria-label={t("chart:indicatorSearchPlaceholder")} /></div>
              <button type="button" className="chart-indicator-custom-button" onClick={() => onOpenCustomIndicatorEditor?.()}><Code2 size={14} /> {t("chart:indicatorCustomEditor")}</button>
              <button
                type="button"
                className="chart-indicator-ai-button"
                onClick={() => setAiPanelOpen((value) => !value)}
                aria-pressed={aiPanelOpen}
                title={t("chart:indicatorAiGenerateTitle")}
              >
                <BrainCircuit size={14} />
                AI
              </button>
            </div>
            <div className="chart-indicator-add-list" aria-label={t("chart:indicatorAdd")}>
              {choices.map((definition) => (
                <button
                  type="button"
                  key={definition.id}
                  onClick={() => add(definition.id)}
                  onPointerEnter={(event) => showBuiltInIndicatorTooltip(definition, event.currentTarget)}
                  onPointerLeave={hideBuiltInIndicatorTooltip}
                  onFocus={(event) => showBuiltInIndicatorTooltip(definition, event.currentTarget)}
                  onBlur={hideBuiltInIndicatorTooltip}
                  data-indicator-add={definition.id}
                  aria-describedby={indicatorTooltip?.id === definition.id ? `${popoverId}-indicator-tip` : undefined}
                >
                  <i style={{ backgroundColor: indicatorColor(definition.id) }} /><span>{definition.name}</span><small className="chart-indicator-kind-tag">{t("chart:indicatorBuiltin")}</small><small>{definition.pane === "main" ? t("chart:indicatorMainPane") : t("chart:indicatorSubPane")}</small><Plus size={14} />
                </button>
              ))}
              {customChoices.map((script) => {
                const state = customScriptRunStates[script.id];
                return (
                  <button
                    type="button"
                    key={script.id}
                    className="custom"
                    onClick={() => onEnableCustomIndicator?.(script.id)}
                    onPointerEnter={(event) => showCustomIndicatorTooltip(script, state, event.currentTarget)}
                    onPointerLeave={hideBuiltInIndicatorTooltip}
                    onFocus={(event) => showCustomIndicatorTooltip(script, state, event.currentTarget)}
                    onBlur={hideBuiltInIndicatorTooltip}
                    title={state?.error}
                    data-custom-indicator-add={script.id}
                    aria-describedby={indicatorTooltip?.id === script.id ? `${popoverId}-indicator-tip` : undefined}
                  >
                    <i style={{ backgroundColor: customIndicatorColor(script, state) }} /><span data-i18n-skip>{script.name}</span><small className="chart-indicator-kind-tag custom">{t("chart:indicatorCustom")}</small><small>{state?.status === "error" || state?.status === "timeout" ? t("chart:indicatorAbnormal") : script.enabled && !script.hidden ? t("common:enabled") : t("chart:indicatorScript")}</small><Plus size={14} />
                  </button>
                );
              })}
              {choices.length === 0 && customChoices.length === 0 && <p className="chart-indicator-add-empty">{t("chart:indicatorNoMatches")}</p>}
            </div>
          </section>
          {aiPanelOpen && (
            <aside className="chart-indicator-ai-panel" role="dialog" aria-label={t("chart:indicatorAiGenerateTitle")}>
              <header>
                <div>
                  <strong><BrainCircuit size={14} /> {t("chart:indicatorAiPanelTitle")}</strong>
                  <span>{t("chart:indicatorAiPanelDescription")}</span>
                </div>
                <button type="button" className="icon-button" title={t("chart:indicatorAiClose")} aria-label={t("chart:indicatorAiClose")} onClick={() => setAiPanelOpen(false)}><X size={15} /></button>
              </header>
              <div className="chart-indicator-ai-messages" aria-live="polite" ref={aiMessagesRef}>
                {aiMessages.map((message) => (
                  <article key={message.id} className={`ai-message ${message.role === "user" ? "user" : message.error ? "assistant error" : "assistant"}`}>
                    <div className="ai-message-role">{message.role === "user" ? t("chart:indicatorAiYou") : "AI"}</div>
                    <AiProcessTimeline message={message} now={aiClockNow} onApprove={() => undefined} />
                    <AiMessageError message={message} />
                    {message.text && (
                      <div className="ai-answer" data-i18n-skip>
                        {message.role === "assistant" ? <MarkdownMessage content={message.text} /> : <p data-i18n-skip>{message.text}</p>}
                      </div>
                    )}
                    {message.role === "assistant" && message.usage ? <AiTokenUsageLine usage={message.usage} /> : null}
                    {message.status && <span className="ai-message-status">{message.status}</span>}
                  </article>
                ))}
              </div>
              <form
                className="chart-indicator-ai-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitIndicatorAiPrompt();
                }}
              >
                <textarea
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  placeholder={t("chart:indicatorAiPlaceholder")}
                  disabled={aiStatus === "running"}
                />
                <div>
                  <span>{aiStatus === "running" ? t("chart:indicatorAiGenerating") : aiStatus === "done" ? t("chart:indicatorAiReady") : aiStatus === "error" ? t("chart:indicatorAiRequestFailed") : t("chart:indicatorAiWaitingInput")}</span>
                  <button type="submit" disabled={!aiPrompt.trim() || aiStatus === "running"}><Send size={13} /> {t("chart:indicatorAiSend")}</button>
                </div>
              </form>
            </aside>
          )}
          {editingId && (() => {
            const item = instances.find((candidate) => candidate.id === editingId);
            if (!item) return null;
            const definition = INDICATOR_DEFINITIONS[item.definitionId];
            return <section ref={parameterDialogDrag.surfaceRef} className="chart-indicator-parameter-dialog" role="dialog" aria-label={t("chart:indicatorParameterDialogAria", { name: definition.name })}>
              <header {...parameterDialogDrag.handleProps}><div><strong>{t("chart:indicatorParameterTitle", { name: definition.name })}</strong><span>{item.paneId === "main" ? t("chart:indicatorMainPaneIndicator") : t("chart:indicatorSubPaneIndicator")}</span></div><button type="button" className="icon-button" title={t("common:close")} aria-label={t("common:close")} onClick={() => setEditingId(null)}><X size={15} /></button></header>
              <div className="chart-indicator-parameters">
                {definition.parameters.length === 0 ? <p>{t("chart:indicatorNoParameters")}</p> : definition.parameters.map((parameter) => {
                  const current = item.parameters?.[parameter.key] ?? parameter.defaultValue;
                  const labelKey = INDICATOR_PARAMETER_LABEL_KEYS[parameter.key];
                  return <label key={parameter.key}><span>{labelKey ? t(`chart:${labelKey}`) : parameter.label}</span><input type="number" value={typeof current === "number" ? current : parameter.defaultValue} min={parameter.min} max={parameter.max} step={parameter.type === "integer" ? 1 : "any"} onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (!Number.isFinite(value)) return;
                    updateParameters(item.id, { ...item.parameters, [parameter.key]: clampParameterValue(value, parameter) });
                  }} /></label>;
                })}
              </div>
            </section>;
          })()}
        </div>
      </section>,
      document.body,
    )
    : null;
  const indicatorTooltipPortal = indicatorTooltip && typeof document !== "undefined"
    ? createPortal(
      <div
        id={`${popoverId}-indicator-tip`}
        className="chart-indicator-tooltip"
        role="tooltip"
        style={{ left: indicatorTooltip.left, top: indicatorTooltip.top }}
      >
        <div>
          <strong data-i18n-skip={indicatorTooltip.pane === "script" ? true : undefined}>{indicatorTooltip.name}</strong>
          <span>{indicatorTooltip.pane === "main" ? t("chart:indicatorMainPaneIndicator") : indicatorTooltip.pane === "sub" ? t("chart:indicatorSubPaneIndicator") : t("chart:indicatorCustom")}</span>
        </div>
        <p data-i18n-skip={indicatorTooltip.pane === "script" ? true : undefined}>{indicatorTooltip.description}</p>
      </div>,
      document.body,
    )
    : null;

  return (
    <div className={hideInlineControls ? "chart-indicator-center chart-indicator-center--external" : "chart-indicator-center"}>
      {!hideInlineControls && <>
      <button
        type="button"
        ref={triggerRef}
        className="chart-indicator-center-trigger"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={t("chart:indicatorCenter")}
        title={t("chart:indicatorCenter")}
      >
        <SlidersHorizontal size={14} />
        <span>{t("chart:indicators")}</span>
        <b>{selectedCount}</b>
      </button>
      </>}
      {indicatorPopover}
      {indicatorTooltipPortal}
    </div>
  );
}
