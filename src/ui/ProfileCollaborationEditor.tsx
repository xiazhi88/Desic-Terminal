import { useEffect, useMemo, useState } from "react";
import { useConfirmPrompt } from "./ConfirmPrompt";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  LayoutTemplate,
  LockKeyhole,
  Minus,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UsersRound,
  Workflow,
  X
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type {
  AiAgentProfile,
  AiAgentScheme,
  AiProfileSubAgent
} from "../types";
import { TerminalSelect } from "./TerminalSelect";

type CollaborationPatch = Partial<Pick<
  AiAgentProfile,
  "multiAgentMode" | "multiAgentMaxAgents" | "multiAgentSchemeId" | "multiAgents"
>>;

export type AiAgentSchemeDraft = {
  name: string;
  description: string;
  agents: AiProfileSubAgent[];
  instructions: string;
};

export const AGENT_TEMPLATE_INSTRUCTION_LIMIT = 4000;

type ProfileCollaborationEditorProps = {
  mode: AiAgentProfile["multiAgentMode"];
  maxAgents: number;
  agents: AiProfileSubAgent[];
  schemes?: AiAgentScheme[];
  selectedSchemeId?: string | null;
  schemeBusy?: boolean;
  onChange: (patch: CollaborationPatch) => void;
  onSaveScheme?: (scheme: AiAgentSchemeDraft) => Promise<AiAgentScheme | null>;
  onDeleteScheme?: (id: string) => Promise<boolean>;
};

export const AUTO_AGENT_LIMIT = 8;
export const CUSTOM_AGENT_LIMIT = 10;
export const PERPETUAL_DECISION_SCHEME_ID = "builtin-perpetual-decision-desk";

const BUILTIN_AGENT_TRANSLATION_SUFFIX: Record<string, string> = {
  "market-structure": "MarketStructure",
  "intelligence-flow": "IntelligenceFlow",
  "account-risk": "AccountRisk",
  "contrarian-review": "ContrarianReview"
};

const PERPETUAL_DECISION_TEMPLATE: AiProfileSubAgent[] = [
  {
    id: "market-structure",
    name: "市场结构",
    role: "市场结构分析",
    responsibility: "分析 K 线结构、成交、盘口、资金费率、持仓量与流动性，输出方向、关键价位和证据。",
    scopes: ["market", "derivatives", "history"],
    required: true,
    enabled: true
  },
  {
    id: "intelligence-flow",
    name: "情报资金",
    role: "情报与资金分析",
    responsibility: "核对新闻、宏观事件、情绪、Smart Money 与资金流，区分事实、推断和时效。",
    scopes: ["intelligence", "derivatives", "history"],
    required: false,
    enabled: true
  },
  {
    id: "account-risk",
    name: "账户风险",
    role: "账户与执行风险",
    responsibility: "检查仓位、保证金、订单、交易预检和历史风险暴露，给出可执行约束。",
    scopes: ["account", "history", "market"],
    required: true,
    enabled: true
  },
  {
    id: "contrarian-review",
    name: "反方审查",
    role: "反方与数据缺口审查",
    responsibility: "主动寻找结论冲突、数据缺口、无效假设和极端风险，给出明确否决条件。",
    scopes: ["market", "derivatives", "intelligence", "account", "history"],
    required: false,
    enabled: true
  }
];

function cloneAgents(agents: AiProfileSubAgent[]) {
  return agents.map((agent) => ({ ...agent, scopes: [...agent.scopes] }));
}

function createAgentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `agent-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  }
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPerpetualDecisionTeam() {
  return cloneAgents(PERPETUAL_DECISION_TEMPLATE);
}

export function createBuiltinAgentSchemes(): AiAgentScheme[] {
  return [{
    id: PERPETUAL_DECISION_SCHEME_ID,
    name: "永续合约决策台",
    description: "市场、情报与账户并行取证，反方审查后由主 Agent 汇总决策。",
    builtin: true,
    agents: createPerpetualDecisionTeam(),
    instructions: "",
    skillIds: [],
    phase: "primary",
    model: null,
    reasoningDepth: "medium",
    createdAt: 0,
    updatedAt: 0
  }];
}

function limitForMode(mode: AiAgentProfile["multiAgentMode"]) {
  return mode === "auto" ? AUTO_AGENT_LIMIT : CUSTOM_AGENT_LIMIT;
}

function clampMaxAgents(value: number, mode: AiAgentProfile["multiAgentMode"]) {
  return Math.max(2, Math.min(limitForMode(mode), Math.round(value) || 2));
}

export function ProfileCollaborationEditor({
  mode,
  maxAgents,
  agents,
  schemes = [],
  selectedSchemeId,
  schemeBusy = false,
  onChange,
  onSaveScheme,
  onDeleteScheme
}: ProfileCollaborationEditorProps) {
  const { t } = useTranslation(["automation", "common"]);
  const confirmPrompt = useConfirmPrompt();
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [savingScheme, setSavingScheme] = useState(false);
  const [schemeName, setSchemeName] = useState("");
  const [schemeDescription, setSchemeDescription] = useState("");
  const [schemeInstructions, setSchemeInstructions] = useState("");
  const enabledAgents = useMemo(() => agents.filter((agent) => agent.enabled).length, [agents]);
  const safeMaxAgents = clampMaxAgents(maxAgents, mode);
  const selectedScheme = useMemo(
    () => schemes.find((scheme) => scheme.id === selectedSchemeId) ?? null,
    [schemes, selectedSchemeId]
  );
  const schemeDisplayName = (scheme: AiAgentScheme) => scheme.id === PERPETUAL_DECISION_SCHEME_ID
    ? t("collaborationBuiltinSchemeName")
    : scheme.name;
  const schemeDisplayDescription = (scheme: AiAgentScheme) => scheme.id === PERPETUAL_DECISION_SCHEME_ID
    ? t("collaborationBuiltinSchemeDescription")
    : scheme.description;
  const localizeBuiltinAgent = (agent: AiProfileSubAgent): AiProfileSubAgent => {
    const suffix = BUILTIN_AGENT_TRANSLATION_SUFFIX[agent.id];
    if (!suffix) return agent;
    return {
      ...agent,
      name: t(`collaborationBuiltinAgent${suffix}Name`),
      role: t(`collaborationBuiltinAgent${suffix}Role`),
      responsibility: t(`collaborationBuiltinAgent${suffix}Responsibility`)
    };
  };

  useEffect(() => {
    if (expandedAgentId && !agents.some((agent) => agent.id === expandedAgentId)) {
      setExpandedAgentId(null);
    }
  }, [agents, expandedAgentId]);

  const changeCustomTeam = (nextAgents: AiProfileSubAgent[], extra: CollaborationPatch = {}) => {
    const nextEnabled = nextAgents.filter((agent) => agent.enabled).length;
    onChange({
      multiAgentSchemeId: null,
      multiAgentMaxAgents: Math.max(2, Math.min(CUSTOM_AGENT_LIMIT, Math.max(safeMaxAgents, nextEnabled))),
      multiAgents: nextAgents,
      ...extra
    });
  };

  const updateAgent = (id: string, patch: Partial<AiProfileSubAgent>) => {
    changeCustomTeam(agents.map((agent) => agent.id === id ? { ...agent, ...patch } : agent));
  };

  const addAgent = () => {
    if (agents.length >= CUSTOM_AGENT_LIMIT) return;
    const agent: AiProfileSubAgent = {
      id: createAgentId(),
      name: t("collaborationDefaultAgentName", { number: agents.length + 1 }),
      role: t("collaborationDefaultAgentRole"),
      responsibility: "",
      scopes: [],
      required: false,
      enabled: true
    };
    changeCustomTeam([...agents, agent]);
    setExpandedAgentId(agent.id);
  };

  const applyScheme = (id: string) => {
    const scheme = schemes.find((item) => item.id === id);
    if (!scheme || scheme.id === selectedSchemeId) return;
    // Applying a scheme replaces the agents already configured, so confirm first.
    if (agents.length > 0) {
      confirmPrompt.confirm({
        title: t("collaborationApplyScheme", { defaultValue: t("collaborationSchemes") }),
        message: t("collaborationConfirmApplyScheme", { name: schemeDisplayName(scheme) }),
        confirmText: t("common:confirm"),
        onConfirm: () => applySchemeNow(scheme)
      });
      return;
    }
    applySchemeNow(scheme);
  };

  const applySchemeNow = (scheme: AiAgentScheme) => {
    const next = cloneAgents(scheme.agents)
      .slice(0, CUSTOM_AGENT_LIMIT)
      .map((agent) => scheme.id === PERPETUAL_DECISION_SCHEME_ID ? localizeBuiltinAgent(agent) : agent);
    const nextEnabled = next.filter((agent) => agent.enabled).length;
    onChange({
      multiAgentMode: "custom",
      multiAgentMaxAgents: Math.max(2, nextEnabled),
      multiAgentSchemeId: scheme.id,
      multiAgents: next
    });
    setSchemeInstructions(scheme.instructions ?? "");
    setExpandedAgentId(null);
    setSavingScheme(false);
  };

  const saveCurrentScheme = async () => {
    const name = schemeName.trim();
    if (!onSaveScheme || !name || enabledAgents < 2 || agents.length > CUSTOM_AGENT_LIMIT) return;
    const saved = await onSaveScheme({
      name,
      description: schemeDescription.trim(),
      agents: cloneAgents(agents),
      instructions: schemeInstructions.trim().slice(0, AGENT_TEMPLATE_INSTRUCTION_LIMIT)
    });
    if (!saved) return;
    onChange({ multiAgentSchemeId: saved.id });
    setSavingScheme(false);
    setSchemeName("");
    setSchemeDescription("");
    setSchemeInstructions("");
  };

  const deleteCurrentScheme = () => {
    if (!selectedScheme || selectedScheme.builtin || !onDeleteScheme) return;
    const scheme = selectedScheme;
    const remove = onDeleteScheme;
    confirmPrompt.confirm({
      title: t("collaborationDeleteScheme", { defaultValue: t("common:delete") }),
      message: t("collaborationConfirmDeleteScheme", { name: scheme.name }),
      confirmText: t("common:delete"),
      danger: true,
      onConfirm: () => {
        void remove(scheme.id).then((removed) => {
          if (removed) onChange({ multiAgentSchemeId: null });
        });
      }
    });
  };

  const updateMaxAgents = (value: number) => {
    onChange({ multiAgentMaxAgents: clampMaxAgents(value, mode) });
  };

  return (
    <div className="automation-form-section automation-collaboration-section">
      <div className="automation-collaboration-heading">
        <div>
          <strong><Workflow size={13} />{t("collaborationTitle")}</strong>
          <span>{mode === "auto" ? t("collaborationModeSummaryAuto", { count: safeMaxAgents }) : mode === "custom" ? t("collaborationModeSummaryCustom", { count: enabledAgents }) : t("collaborationModeSummarySingle")}</span>
        </div>
        <span className="automation-collaboration-capacity">{t("collaborationCapacity", { auto: AUTO_AGENT_LIMIT, custom: CUSTOM_AGENT_LIMIT })}</span>
      </div>

      <div className="automation-collaboration-mode" role="radiogroup" aria-label={t("collaborationModeAria")}>
        <button type="button" role="radio" aria-checked={mode === "off"} className={mode === "off" ? "active" : ""} onClick={() => onChange({ multiAgentMode: "off" })}>
          <Bot size={14} /><span>{t("collaborationModeOff")}</span>
        </button>
        <button type="button" role="radio" aria-checked={mode === "auto"} className={mode === "auto" ? "active" : ""} onClick={() => onChange({ multiAgentMode: "auto", multiAgentMaxAgents: clampMaxAgents(maxAgents, "auto") })}>
          <Sparkles size={14} /><span>{t("collaborationModeAuto")}</span>
        </button>
        <button type="button" role="radio" aria-checked={mode === "custom"} className={mode === "custom" ? "active" : ""} onClick={() => onChange({ multiAgentMode: "custom", multiAgentMaxAgents: Math.max(clampMaxAgents(maxAgents, "custom"), enabledAgents, 2) })}>
          <UsersRound size={14} /><span>{t("collaborationModeCustom")}</span>
        </button>
      </div>

      {mode !== "off" && (
        <div className="automation-collaboration-cost-warning" role="note">
          <CircleAlert size={14} aria-hidden="true" />
          <div>
            <strong>{t("collaborationCostWarning")}</strong>
            <span>{t("collaborationCostDetail")}</span>
          </div>
        </div>
      )}

      {mode === "custom" ? (
        <div className="automation-scheme-library">
          <div className="automation-scheme-picker">
            <span className="automation-scheme-icon"><LayoutTemplate size={14} /></span>
            <label>
              <span>{t("collaborationScheme")}</span>
              <TerminalSelect
                ariaLabel={t("collaborationScheme")}
                value={selectedScheme?.id ?? ""}
                options={[
                  { value: "", label: t("collaborationUnsavedScheme") },
                  ...schemes.map((scheme) => ({ value: scheme.id, label: `${schemeDisplayName(scheme)}${scheme.builtin ? ` · ${t("collaborationBuiltin")}` : ""}` }))
                ]}
                onChange={applyScheme}
              />
            </label>
            <span className="automation-scheme-description">
              {selectedScheme?.builtin ? <LockKeyhole size={11} /> : null}
              {selectedScheme ? schemeDisplayDescription(selectedScheme) || t("collaborationSchemeNotSaved") : t("collaborationSchemeNotSaved")}
            </span>
            <div className="automation-scheme-actions">
              <button type="button" className="save-template" disabled={schemeBusy || agents.length === 0} onClick={() => setSavingScheme(true)}><Save size={13} /><span>{t("collaborationSaveScheme")}</span></button>
              <button type="button" title={t("collaborationDeleteScheme")} aria-label={t("collaborationDeleteScheme")} disabled={schemeBusy || !selectedScheme || selectedScheme.builtin} onClick={() => void deleteCurrentScheme()}><Trash2 size={13} /></button>
            </div>
          </div>
          {savingScheme ? (
            <div className="automation-scheme-editor">
              <div className="automation-scheme-editor-heading">
                <div>
                  <strong>{t("collaborationTemplateEditorTitle")}</strong>
                  <span>{t("collaborationTemplateSecurityNote")}</span>
                </div>
              </div>
              <div className="automation-scheme-editor-grid">
                <label><span>{t("collaborationSchemeName")}</span><input autoFocus maxLength={60} value={schemeName} placeholder={t("collaborationSchemeNamePlaceholder")} onChange={(event) => setSchemeName(event.target.value)} /></label>
                <label><span>{t("collaborationSchemeDescription")}</span><input maxLength={200} value={schemeDescription} placeholder={t("collaborationSchemeDescriptionPlaceholder")} onChange={(event) => setSchemeDescription(event.target.value)} /></label>
                <label className="instructions">
                  <span>{t("collaborationTemplateInstructions")}</span>
                  <textarea
                    maxLength={AGENT_TEMPLATE_INSTRUCTION_LIMIT}
                    value={schemeInstructions}
                    placeholder={t("collaborationTemplateInstructionsPlaceholder")}
                    onChange={(event) => setSchemeInstructions(event.target.value)}
                  />
                  <small>{schemeInstructions.length.toLocaleString()} / {AGENT_TEMPLATE_INSTRUCTION_LIMIT.toLocaleString()}</small>
                </label>
              </div>
              <div className="automation-scheme-editor-footer">
                <span className={clsx("automation-scheme-requirement", enabledAgents < 2 && "blocking")}>
                  {enabledAgents < 2
                    ? t("collaborationSchemeRequiresAgents")
                    : t("collaborationTemplateAgentCount", { count: enabledAgents })}
                </span>
                <button type="button" disabled={schemeBusy} onClick={() => setSavingScheme(false)}><X size={14} />{t("collaborationCancel")}</button>
                <button type="button" className="confirm" disabled={schemeBusy || !schemeName.trim() || enabledAgents < 2} onClick={() => void saveCurrentScheme()}><Check size={14} />{t("collaborationConfirmSave")}</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={clsx("automation-collaboration-topology", `mode-${mode}`)}>
        <div className="automation-topology-lead">
          <span className="automation-agent-node lead"><Bot size={14} /></span>
          <span><strong>{t("mainAgent")}</strong><small>{t("collaborationMainAgentDescription")}</small></span>
          <em><ShieldCheck size={11} />{t("collaborationOnlyDecisionMaker")}</em>
        </div>

        {mode === "off" ? (
          <div className="automation-topology-empty">
            <span className="automation-agent-connector" aria-hidden="true" />
            <span><CircleDashed size={13} />{t("collaborationNoSubagents")}</span>
          </div>
        ) : null}

        {mode === "auto" ? (
          <div className="automation-auto-team">
            <div className="automation-agent-limit">
              <span><strong>{t("collaborationParticipantLimit")}</strong><small>{t("collaborationParticipantLimitHelp")}</small></span>
              <div role="group" aria-label={t("collaborationAutoLimitAria")}>
                <button type="button" title={t("collaborationDecreaseAgent")} aria-label={t("collaborationDecreaseAgent")} disabled={safeMaxAgents <= 2} onClick={() => updateMaxAgents(safeMaxAgents - 1)}><Minus size={12} /></button>
                <strong>{safeMaxAgents}</strong>
                <button type="button" title={t("collaborationIncreaseAgent")} aria-label={t("collaborationIncreaseAgent")} disabled={safeMaxAgents >= AUTO_AGENT_LIMIT} onClick={() => updateMaxAgents(safeMaxAgents + 1)}><Plus size={12} /></button>
              </div>
            </div>
            <div className="automation-auto-agent-slots" aria-label={t("collaborationAutoAgentsAria", { count: safeMaxAgents })}>
              {Array.from({ length: safeMaxAgents }, (_, index) => (
                <div className="automation-auto-agent-slot" key={index}>
                  <span className="automation-agent-node"><Sparkles size={12} /></span>
                  <span><strong>Agent {index + 1}</strong><small>{t("collaborationAssignedAtRuntime")}</small></span>
                  <em>{t("collaborationReadOnly")}</em>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {mode === "custom" ? (
          <div className="automation-custom-team">
            {agents.length === 0 ? (
              <div className="automation-team-empty">
                <UsersRound size={16} />
                <span><strong>{t("collaborationNoAgents")}</strong><small>{t("collaborationNoAgentsDetail")}</small></span>
              </div>
            ) : (
              <div className="automation-agent-roster">
                {agents.map((agent, index) => {
                  const expanded = expandedAgentId === agent.id;
                  const displayAgent = selectedScheme?.id === PERPETUAL_DECISION_SCHEME_ID
                    ? localizeBuiltinAgent(agent)
                    : agent;
                  return (
                    <div className={clsx("automation-agent-row", expanded && "expanded", !agent.enabled && "disabled")} key={agent.id}>
                      <button
                        type="button"
                        className="automation-agent-row-summary"
                        aria-expanded={expanded}
                        onClick={() => setExpandedAgentId(expanded ? null : agent.id)}
                      >
                        <span className="automation-agent-index">{index + 1}</span>
                        <span className="automation-agent-node"><UsersRound size={12} /></span>
                        <span className="automation-agent-row-copy">
                          <strong>{displayAgent.name || t("collaborationUnnamedAgent")}</strong>
                          <small>{displayAgent.role || t("collaborationNoRole")}</small>
                        </span>
                        <span className="automation-agent-row-tags">
                          {agent.required ? <em>{t("collaborationRequired")}</em> : null}
                          <b>{agent.enabled ? t("collaborationParticipating") : t("collaborationDisabled")}</b>
                        </span>
                        <ChevronDown size={14} />
                      </button>

                      {expanded ? (
                        <div className="automation-agent-inline-editor">
                          <div className="automation-agent-fields">
                            <label><span>{t("collaborationAgentName")}</span><input value={displayAgent.name} maxLength={40} onChange={(event) => updateAgent(agent.id, { name: event.target.value })} /></label>
                            <label><span>{t("collaborationAgentRole")}</span><input value={displayAgent.role} maxLength={60} onChange={(event) => updateAgent(agent.id, { role: event.target.value })} /></label>
                            <label className="wide"><span>{t("collaborationAgentResponsibility")}</span><textarea value={displayAgent.responsibility} maxLength={500} rows={3} onChange={(event) => updateAgent(agent.id, { responsibility: event.target.value })} /></label>
                          </div>
                          <div className="automation-agent-scope-legacy">
                            <div className="automation-agent-scope-note">{t("collaborationDataScopesAuto")}</div>
                          </div>
                          <div className="automation-agent-editor-actions">
                            <label><input type="checkbox" checked={agent.enabled} onChange={(event) => updateAgent(agent.id, { enabled: event.target.checked, required: event.target.checked ? agent.required : false })} /><span>{t("collaborationEnableAgent")}</span></label>
                            <label><input type="checkbox" checked={agent.required} disabled={!agent.enabled} onChange={(event) => updateAgent(agent.id, { required: event.target.checked })} /><span>{t("collaborationMustReturn")}</span></label>
                            <span><ShieldCheck size={12} />{t("collaborationSubagentReadOnly")}</span>
                            <button type="button" title={t("collaborationDeleteAgent")} aria-label={t("collaborationDeleteNamedAgent", { name: agent.name || "Agent" })} onClick={() => changeCustomTeam(agents.filter((item) => item.id !== agent.id))}><Trash2 size={13} /></button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="automation-team-footer">
              <span>{t("collaborationTeamCount", { count: agents.length, limit: CUSTOM_AGENT_LIMIT, enabled: enabledAgents })}</span>
              <button type="button" onClick={addAgent} disabled={agents.length >= CUSTOM_AGENT_LIMIT}><Plus size={13} />{t("collaborationAddAgent")}</button>
            </div>
          </div>
        ) : null}
      </div>
      {confirmPrompt.element}
    </div>
  );
}

export default ProfileCollaborationEditor;
