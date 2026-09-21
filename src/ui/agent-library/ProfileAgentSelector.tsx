import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { AlertTriangle, Bot, CircleHelp, Layers, Loader2, RefreshCw, Sparkles, UserRoundPlus, Users } from "lucide-react";
import type { AiAgentSource, AiAgentSummary, AiSingleAgentMode } from "../../types";
import { TerminalSelect } from "../TerminalSelect";
import { AGENT_OUTPUT_I18N_KEY, agentOutputContract } from "./agentDocument";
import { limitRowChips, type AgentRowChip } from "./rowChips";
import "./AgentLibrary.css";

/**
 * Profile 编辑器的「专家勾选」区块（契约 v3 C7 / §6.4 / C14）。
 *
 * 旧的 `multiAgentMode` / `multiAgents` 自定义团队与方案模板已删除：
 * 这里只写 `enabledAgentIds` + `collaborationEnabled`，不做「至少 2 个 / 最多 N 个」
 * 的数量校验，也不做相关性打分——勾选即允许点名，未勾选即主 Agent 独立工作。
 *
 * C14 总开关是「载荷闸门」：关闭时运行载荷的 `enabledAgents` 为空，但**不清空**
 * `enabledAgentIds`，重新开启即恢复原名单。因此关闭只禁用交互，绝不改写勾选。
 */

type ProfileAgentSelectorProps = {
  agents: AiAgentSummary[];
  /** 一句话职责；由 `ai_agent_read` 正文抽取，缺省回退到角色文案。 */
  responsibilities: Record<string, string>;
  selectedIds: string[];
  /** C14 协作编排总开关。关闭时勾选列表禁用，但名单原样保留。 */
  collaborationEnabled?: boolean;
  /** C24：单 Agent 模式（仅协作关闭时可见/可改）。 */
  singleAgentMode?: AiSingleAgentMode;
  onChangeSingleAgentMode?: (mode: AiSingleAgentMode) => void;
  onToggleCollaboration?: (enabled: boolean) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  onChange: (nextIds: string[]) => void;
  onOpenAgentLibrary: () => void;
  onReload: () => void;
};

const GROUP_ORDER: readonly AiAgentSource[] = ["builtin", "custom", "ai"];

const SOURCE_I18N_KEY: Record<AiAgentSource, string> = {
  builtin: "agentSourceBuiltin",
  custom: "agentSourceCustom",
  ai: "agentSourceAi"
};

const SOURCE_ICON = {
  builtin: Layers,
  custom: UserRoundPlus,
  ai: Sparkles
} as const;

export function ProfileAgentSelector({
  agents,
  responsibilities,
  selectedIds,
  collaborationEnabled = true,
  singleAgentMode = "standard",
  onChangeSingleAgentMode,
  onToggleCollaboration,
  loading = false,
  error = null,
  disabled = false,
  onChange,
  onOpenAgentLibrary,
  onReload
}: ProfileAgentSelectorProps) {
  const { t } = useTranslation(["automation", "common"]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  // C20.5（改写版）：下线的历史专家**彻底隐藏**（不再有折叠组/停用徽标），列表只显示 Rust 返回的候选；
  // 这里再兜一层过滤，避免旧后端把 deprecated 条目混进来。
  const visibleAgents = useMemo(() => agents.filter((agent) => !agent.deprecated), [agents]);
  const groups = useMemo(() => GROUP_ORDER.map((source) => ({
    source,
    items: visibleAgents.filter((agent) => agent.source === source)
  })).filter((group) => group.items.length > 0), [visibleAgents]);
  // C20.1（改写版）：内置组现在**最多 1 条**（可选的对手盘），因此"全选内置"最多再勾一个。
  const builtinIds = useMemo(() => visibleAgents.filter((agent) => agent.source === "builtin").map((agent) => agent.id), [visibleAgents]);
  // 只保留库里仍存在的 id，顺序沿用当前勾选顺序（契约 C4：顺序 = 勾选顺序）。
  const knownIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  const effectiveSelection = useMemo(() => selectedIds.filter((id) => knownIds.has(id)), [knownIds, selectedIds]);

  const toggle = (id: string, next: boolean) => {
    const nextIds = next
      ? [...effectiveSelection, id]
      : effectiveSelection.filter((item) => item !== id);
    onChange(Array.from(new Set(nextIds)));
  };

  const selectAllBuiltin = () => onChange(Array.from(new Set([...effectiveSelection, ...builtinIds])));

  // C14：关闭时列表与动作区整体不挂载（见下方条件渲染），因此这里只剩父级 busy 的禁用。
  const selectionDisabled = disabled;

  const renderPickerRow = (agent: AiAgentSummary) => {
    const checked = selected.has(agent.id);
    const responsibility = responsibilities[agent.id]?.trim() || agent.role || agent.id;
    // P0-2：徽标"优先级 + 限量"——风险审查 > 缺失账户/技能 > 已本地改动 > 被勾选计数。
    const chips: AgentRowChip[] = [];
    if (agent.envelope === "risk") {
      chips.push({ key: "risk", priority: 0, summary: t("agentEnvelopeRisk"), node: <em key="risk" className="agent-chip is-risk">{t("agentEnvelopeRisk")}</em> });
    }
    if (agent.missingAccount) {
      chips.push({ key: "account", priority: 1, summary: t("agentNeedsAccount"), node: <em key="account" className="agent-chip is-warning" title={t("agentNeedsAccount")}><AlertTriangle size={10} />{t("agentNeedsAccount")}</em> });
    }
    if (agent.missingSkills.length > 0) {
      const text = t("agentMissingSkills", { skills: agent.missingSkills.join(", ") });
      chips.push({ key: "skills", priority: 2, summary: text, node: <em key="skills" className="agent-chip is-warning" title={t("agentMissingSkillsHint")}><CircleHelp size={10} />{text}</em> });
    }
    if (agent.modified) {
      chips.push({ key: "modified", priority: 3, summary: t("agentModified"), node: <em key="modified" className="agent-chip is-modified" title={t("agentModifiedHint")}>{t("agentModified")}</em> });
    }
    if (agent.enabledByProfiles.length > 0) {
      const text = t("agentEnabledProfiles", { count: agent.enabledByProfiles.length });
      chips.push({ key: "profiles", priority: 4, summary: t("agentEnabledProfilesHint", { profiles: agent.enabledByProfiles.join(", ") }), node: <em key="profiles" className="agent-chip is-quiet" title={t("agentEnabledProfilesHint", { profiles: agent.enabledByProfiles.join(", ") })}>{text}</em> });
    }
    return (
      <label
        className={clsx("agent-picker__row", checked && "is-checked", selectionDisabled && "is-disabled")}
        data-agent-selector-item
        data-agent-id={agent.id}
        data-agent-source={agent.source}
        key={agent.id}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={selectionDisabled}
          onChange={(event) => toggle(agent.id, event.target.checked)}
        />
        <span className="agent-picker__row-copy">
          <strong>{agent.name}</strong>
          <small title={responsibility}>{responsibility}</small>
        </span>
        <span className="agent-picker__row-tags">
          {/* C20.4：输出契约（这个专家返回什么形态）。 */}
          <em className="agent-chip is-accent" data-agent-output={agentOutputContract(agent.role)} title={t("agentOutputLabel")}>
            {t(AGENT_OUTPUT_I18N_KEY[agentOutputContract(agent.role)])}
          </em>
          {limitRowChips(chips)}
        </span>
      </label>
    );
  };

  return (
    <div className="automation-form-section agent-picker" data-agent-selector data-collaboration-enabled={collaborationEnabled ? "true" : "false"}>
      {/* 行 1（最上）：C14 总开关行，整行可点 label。原生 checkbox 保持可见
          （appearance:none 自定义 pill 样式，不隐藏、不移位），键盘与 Playwright
          check/uncheck 都直接操作它。 */}
      <label className="agent-picker__toggle-row" title={t("profileCollaborationToggleHint")}>
        <span className="agent-picker__toggle-copy">
          <strong>{t("profileCollaborationToggle")}</strong>
          <small>{t("profileCollaborationToggleHint")}</small>
        </span>
        <input
          type="checkbox"
          data-agent-collaboration-toggle
          checked={collaborationEnabled}
          disabled={disabled}
          aria-label={t("profileCollaborationToggle")}
          onChange={(event) => onToggleCollaboration?.(event.target.checked)}
        />
      </label>

      {/* C24：单 Agent 模式 —— 仅在协作关闭时渲染/可改（协作开启时该字段被 Rust 忽略）。 */}
      {!collaborationEnabled ? (
        <div className="agent-picker__single-mode" data-single-agent-mode>
          <div className="agent-picker__single-mode-head">
            <strong>{t("singleAgentMode")}</strong>
            <span>{t("singleAgentModeHint")}</span>
          </div>
          <div data-single-agent-mode-select>
            <TerminalSelect
              ariaLabel={t("singleAgentMode")}
              value={singleAgentMode === "minimal" ? "minimal" : "standard"}
              disabled={disabled}
              options={[
                { value: "standard", label: t("singleAgentModeStandard"), description: t("singleAgentModeHint") },
                { value: "minimal", label: t("singleAgentModeMinimal"), description: t("singleAgentModeMinimalHint") }
              ]}
              onChange={(value) => onChangeSingleAgentMode?.(value === "minimal" ? "minimal" : "standard")}
            />
          </div>
        </div>
      ) : null}

      {/* C25②：协作关闭说明提示已按董事会要求移除（含 data-agent-collaboration-off-hint 节点）。
          协作开关本身（[data-agent-collaboration-toggle]）与可访问性标签保持不变。 */}

      {/* 行 3+（仅开启态）：参与 Agent 区块整体挂载/卸载 —— 关闭时不渲染标题、计数、
          全选内置/清空、"管理 Agent 库" 与勾选列表（不是禁用、也不是 display:none）。 */}
      {collaborationEnabled ? (
        <>
        {/* 头部行：标题 + hint（左）| 计数 chip（右，唯一计数出口，aria-live 保留）。 */}
        <div className="agent-picker__head">
          <div>
            <strong><Users size={13} />{t("profileAgents")}</strong>
          {/* C20.1（改写版）：内置只剩一个可选的对手盘；主 Agent 自己取数、判断、出方案并执行
              （旧的四角色流程分工"取数 / 账户 / 分析候选 / 反方"已下线）。 */}
          <em className="agent-picker__roles-note">{t("agentDefaultRolesHint")}</em>
          {/* C20.1（改写版）：咨询是**可选**的，且最多一次（对手盘）。 */}
          <em className="agent-picker__roles-note" data-agent-consult-optional>{t("agentConsultOptionalHint")}</em>
            <span>{t("profileAgentsHint")}</span>
          </div>
          <span className="agent-chip is-quiet agent-picker__count" aria-live="polite">
            {t("agentPickerSelected", { selected: effectiveSelection.length, total: agents.length })}
          </span>
        </div>

        {/* 动作行：快捷动作（左）| 跳转 + 刷新（右）。 */}
        <div className="agent-picker__actions">
          <button type="button" data-agent-select-all disabled={selectionDisabled || builtinIds.length === 0} onClick={selectAllBuiltin}>{t("profileAgentsSelectAll")}</button>
          <button type="button" data-agent-select-clear disabled={selectionDisabled || effectiveSelection.length === 0} onClick={() => onChange([])}>{t("profileAgentsClear")}</button>
          <button type="button" className="agent-picker__jump" onClick={onOpenAgentLibrary}><Bot size={13} />{t("agentProfileJump")}</button>
          <button type="button" className="agent-picker__reload" disabled={loading} onClick={onReload} title={t("common:refresh")} aria-label={t("common:refresh")}>
            <RefreshCw size={13} className={loading ? "spin" : undefined} />
          </button>
        </div>

        {loading && agents.length === 0 ? (
          <p className="agent-picker__state"><Loader2 size={13} className="spin" />{t("common:loading")}</p>
        ) : error ? (
          <p className="agent-picker__state is-error"><AlertTriangle size={13} />{error}</p>
        ) : agents.length === 0 ? (
          <div className="agent-picker__empty" data-agent-selector-empty>
            <Bot size={18} />
            <strong>{t("profileAgentsEmpty")}</strong>
            <span>{t("agentsIntro")}</span>
            <button type="button" onClick={onOpenAgentLibrary}><Bot size={13} />{t("createAgent")}</button>
          </div>
        ) : (
          <>
            {effectiveSelection.length === 0 ? (
              <p className="agent-picker__empty-hint" role="note" data-agent-selector-empty>{t("profileAgentEmptyStateHint")}</p>
            ) : null}
            {groups.map((group) => {
              const Icon = SOURCE_ICON[group.source];
              return (
                <div className="agent-picker__group" key={group.source}>
                  <div className={`agent-picker__group-title is-${group.source}`}>
                    <Icon size={12} aria-hidden="true" />
                    <span>{t(SOURCE_I18N_KEY[group.source])}</span>
                    <em className="agent-chip is-quiet">{group.items.length}</em>
                    {group.source === "builtin" ? <i className="agent-picker__group-note">{t("agentGroupReadonly")}</i> : null}
                  </div>
                  <div className="agent-picker__list">
                    {group.items.map((agent) => renderPickerRow(agent))}
                  </div>
                </div>
              );
            })}
          </>
        )}
        </>
      ) : null}
    </div>
  );
}

export default ProfileAgentSelector;
