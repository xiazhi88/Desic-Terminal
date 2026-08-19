import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  ListOrdered,
  RefreshCw,
  Trash2,
  XCircle
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type { MarketAssetsSummary, TradeOpportunity } from "../types";
import { effectiveTradeOpportunityStatus, tradeOpportunityStatusMeta } from "../lib/tradeOpportunity";
import { formatLocalizedDate, formatLocalizedNumber, i18n } from "../i18n/runtime";
import { SymbolLabel } from "./SymbolIcon";

type OpportunityFilter = "all" | "pending" | "active" | "completed" | "attention";

type TradeOpportunitiesPageProps = {
  opportunities: TradeOpportunity[];
  marketAssets?: MarketAssetsSummary | null;
  status: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
};

const OPPORTUNITY_FILTERS = [
  { id: "all", icon: ListOrdered },
  { id: "pending", icon: Clock3 },
  { id: "active", icon: Activity },
  { id: "completed", icon: CheckCircle2 },
  { id: "attention", icon: AlertTriangle }
] as const;

const PENDING_STATUSES = new Set(["pending", "approved"]);
const ACTIVE_STATUSES = new Set(["executing", "submitted", "partially_filled"]);
const COMPLETED_STATUSES = new Set(["executed", "closed"]);
const ATTENTION_STATUSES = new Set(["failed", "pending_blocked", "recovery_blocked", "rejected", "cancelled", "expired"]);

export function TradeOpportunitiesPage({
  opportunities,
  marketAssets,
  status,
  selectedId,
  onSelect,
  onRefresh,
  onApprove,
  onReject,
  onDelete,
  onClearAll
}: TradeOpportunitiesPageProps) {
  useTranslation(["automation", "common", "trading"]);
  const [filter, setFilter] = useState<OpportunityFilter>("all");
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const now = useOpportunityClock();
  const summary = useMemo(() => summarizeTradeOpportunities(opportunities, now), [opportunities, now]);
  const filtered = useMemo(
    () => opportunities.filter((item) => opportunityMatchesFilter(item, filter, now)),
    [filter, now, opportunities]
  );
  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null;
  const rawRecord = selected
    ? {
        marketSnapshot: selected.marketSnapshotJson ?? null,
        precheck: selected.precheckJson ?? null,
        execution: selected.executionResultJson ?? null
      }
    : null;

  return (
    <div className="opportunity-page">
      <header className="opportunity-overview">
        <div className="opportunity-overview-title">
          <strong>{opportunityText("opportunityTitle", "Trade opportunities", "交易机会")}</strong>
          <span>{status} · {opportunityText("opportunityWorkflow", "approval, execution, and review workflow", "审批、执行与复盘链路")}</span>
        </div>
        <div className="opportunity-metrics" aria-label={opportunityText("opportunityOverview", "Trade opportunity overview", "交易机会概览")}>
          <OpportunityMetric label={opportunityFilterLabel("pending")} value={summary.pending} />
          <OpportunityMetric label={opportunityFilterLabel("active")} value={summary.active} />
          <OpportunityMetric label={opportunityFilterLabel("completed")} value={summary.completed} />
          <OpportunityMetric label={opportunityFilterLabel("attention")} value={summary.attention} />
        </div>
        <div className="opportunity-overview-actions">
          <button className="opportunity-clear-button" type="button" title={opportunityText("opportunityClearAll", "Clear all trade opportunities", "清空所有交易机会")} disabled={opportunities.length === 0} onClick={() => setConfirmClearOpen(true)}>
            <Trash2 size={15} />
            <span>{opportunityText("opportunityClear", "Clear", "清空")}</span>
          </button>
          <button className="opportunity-icon-button" type="button" title={opportunityText("opportunityRefresh", "Refresh trade opportunities", "刷新交易机会")} onClick={onRefresh}>
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      <nav className="opportunity-tabs" role="tablist" aria-label={opportunityText("opportunityFilters", "Trade opportunity filters", "交易机会筛选")}>
        {OPPORTUNITY_FILTERS.map(({ id, icon: Icon }) => {
          const count = countFilter(opportunities, id, now);
          return (
            <button
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? "active" : ""}
              onClick={() => setFilter(id)}
              key={id}
            >
              <Icon size={14} />
              <span>{opportunityFilterLabel(id)}</span>
              <b>{count}</b>
            </button>
          );
        })}
      </nav>

      <main className="opportunity-content">
        <div className="opportunity-workbench">
          <aside className="opportunity-list-panel">
            <div className="opportunity-subhead">
              <div>
                <strong>{filterLabel(filter)}</strong>
                <span>{opportunityText("opportunityCount", "{{count}} opportunities", "{{count}} 条机会", { count: filtered.length })}</span>
              </div>
              <small>{opportunityText("opportunitySortedByUpdated", "Sorted by update time", "按更新时间排序")}</small>
            </div>
            <div className="opportunity-list-scroll">
              {filtered.map((item) => (
                <article className={clsx("opportunity-list-item", selected?.id === item.id && "selected")} key={item.id}>
                  <button className="opportunity-list-select" type="button" onClick={() => onSelect(item.id)}>
                    <span className="opportunity-list-topline">
                      <SymbolLabel symbol={item.instId} marketAssets={marketAssets} />
                      <OpportunityStatus opportunity={item} now={now} />
                    </span>
                    <span className="opportunity-list-plan">
                      <b className={opportunityActionTone(item)}>{formatOpportunityDirection(item)}</b>
                      <em>{formatOpportunityListSizing(item)}</em>
                      <time>{formatOpportunityListTime(item.updatedAt || item.createdAt)}</time>
                    </span>
                    <span className="opportunity-list-strategy">{item.strategyName || item.entryCondition || opportunityText("opportunityAiPlan", "AI trading plan", "AI 交易计划")}</span>
                    <span className="opportunity-list-meta">
                      <small>v{item.revision ?? 1}</small>
                      <small>{item.environment === "live" ? i18n.t("common:live") : i18n.t("common:demo")}</small>
                      {shouldShowOpportunityExpiry(item, now) ? <small>{formatExpiry(item.expiresAt)}</small> : null}
                    </span>
                  </button>
                </article>
              ))}
              {filtered.length === 0 ? (
                <OpportunityEmpty
                  title={opportunities.length === 0 ? opportunityText("opportunityEmpty", "No trade opportunities", "暂无交易机会") : opportunityText("opportunityNoFilterMatches", "No records match this filter", "当前筛选没有记录")}
                  detail={opportunities.length === 0 ? opportunityText("opportunityEmptyDetail", "When AI forms a concrete trading plan, a trackable opportunity is created here.", "AI 形成明确交易方案后，会在这里创建可追踪的机会记录。") : opportunityText("opportunityNoFilterMatchesDetail", "Change the filter or refresh to load the latest state.", "切换筛选条件，或刷新获取最新状态。")}
                  action={opportunities.length === 0 ? <button type="button" onClick={onRefresh}><RefreshCw size={14} />{opportunityText("opportunityRefreshList", "Refresh list", "刷新列表")}</button> : null}
                />
              ) : null}
            </div>
          </aside>

          <section className="opportunity-detail-panel">
            {selected ? (
              <>
                <header className="opportunity-detail-head">
                  <div>
                    <SymbolLabel symbol={selected.instId} marketAssets={marketAssets} />
                    <span>{selected.strategyName || selected.sourceSessionId || opportunityText("opportunityAiPlan", "AI trading plan", "AI 交易计划")}</span>
                  </div>
                  <div className="opportunity-detail-head-actions">
                    <OpportunityStatus opportunity={selected} now={now} />
                    <button
                      className="opportunity-detail-delete"
                      type="button"
                      title={opportunityText("opportunityDelete", "Delete trade opportunity", "删除交易机会")}
                      aria-label={opportunityText("opportunityDeleteAria", "Delete {{symbol}} trade opportunity", "删除 {{symbol}} 交易机会", { symbol: selected.instId })}
                      onClick={() => onDelete(selected.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </header>

                <div className="opportunity-detail-scroll">
                  <section className="opportunity-plan-summary">
                    <div>
                      <span>{isManageOpportunity(selected) ? opportunityText("opportunityOrderOperation", "Order operation", "订单操作") : opportunityText("opportunityExecutionDirection", "Execution direction", "执行方向")}</span>
                      <strong className={opportunityActionTone(selected)}>{formatOpportunityDirection(selected)}</strong>
                    </div>
                    <div>
                      <span>{isManageOpportunity(selected) ? opportunityText("opportunityTargetOrder", "Target order", "目标订单") : opportunityText("opportunityQuantityLeverage", "Quantity / leverage", "数量 / 杠杆")}</span>
                      <strong>{formatOpportunityPrimaryTarget(selected)}</strong>
                    </div>
                    <div>
                      <span>{isManageOpportunity(selected) ? opportunityText("opportunityChanges", "Changes", "变更内容") : opportunityText("opportunityConfidenceHorizon", "Confidence / horizon", "置信度 / 周期")}</span>
                      <strong>{isManageOpportunity(selected) ? formatOpportunityManageChange(selected) : `${formatConfidence(selected.confidence)} · ${selected.timeHorizon || opportunityText("opportunityUnspecified", "Not specified", "未指定")}`}</strong>
                    </div>
                  </section>

                  <div className="opportunity-fact-grid">
                    <OpportunityFact label={isManageOpportunity(selected) ? opportunityText("opportunityOperationCondition", "Operation condition", "操作条件") : opportunityText("opportunityEntryCondition", "Entry condition", "入场条件")} value={formatOpportunityEntry(selected)} wide />
                    {selected.intent === "close" ? <OpportunityFact label={opportunityText("opportunityExitKind", "Exit role", "退出角色")} value={formatOpportunityExitKind(selected)} /> : null}
                    {selected.intent === "close" && selected.closeFraction ? <OpportunityFact label={opportunityText("opportunityCloseFraction", "Close fraction", "平仓比例")} value={selected.closeFraction} /> : null}
                    <OpportunityFact label={i18n.t("trading:orderType")} value={formatOrderType(selected.orderType)} />
                    <OpportunityFact label={isManageOpportunity(selected) ? opportunityText("opportunityTargetOrderId", "Target order ID", "目标订单 ID") : i18n.t("trading:takeProfit")} value={isManageOpportunity(selected) ? formatOpportunityOrderTarget(selected) : selected.takeProfit?.triggerPx || "--"} tone={isManageOpportunity(selected) ? undefined : "up"} />
                    <OpportunityFact label={isManageOpportunity(selected) ? opportunityText("opportunityTargetClientId", "Target client ID", "目标客户端 ID") : i18n.t("trading:stopLoss")} value={isManageOpportunity(selected) ? formatOpportunityClientTarget(selected) : selected.stopLoss?.triggerPx || "--"} tone={isManageOpportunity(selected) ? undefined : "down"} />
                    <OpportunityFact label={opportunityText("opportunityInvalidationPrice", "Invalidation price", "失效价")} value={selected.invalidationPrice || "--"} />
                    <OpportunityFact label={opportunityText("opportunityMaxSlippage", "Maximum slippage", "最大滑点")} value={selected.maxSlippageBps ? `${selected.maxSlippageBps} bps` : "--"} />
                  </div>

                  <OpportunitySection title={opportunityText("opportunityFundsAccount", "Funds and account", "资金与账户")} icon={<CircleDollarSign size={14} />}>
                    <dl className="opportunity-definition-grid">
                      <OpportunityDefinition label={i18n.t("trading:estimatedMargin")} value={formatUsdt(selected.estimatedMargin)} />
                      <OpportunityDefinition label={opportunityText("opportunityEstimatedFee", "Estimated fee", "预计手续费")} value={formatUsdt(selected.estimatedFee)} />
                      <OpportunityDefinition label={opportunityText("opportunityAvailableUsdt", "Available USDT", "可用 USDT")} value={formatUsdt(selected.availableUsdt)} />
                      <OpportunityDefinition label={opportunityText("opportunityAccountEnvironment", "Account / environment", "账户 / 环境")} value={`${selected.accountId || opportunityText("opportunityUnbound", "Unbound", "未绑定")} · ${selected.environment === "live" ? i18n.t("common:live") : i18n.t("common:demo")}`} />
                    </dl>
                  </OpportunitySection>

                  <OpportunitySection title={opportunityText("opportunityAiReason", "AI decision rationale", "AI 决策理由")}>
                    <p data-i18n-skip>{selected.reason || opportunityText("opportunityNoReason", "No decision rationale was recorded.", "未记录决策理由。")}</p>
                  </OpportunitySection>

                  {selected.error || (selected.riskNotes ?? []).length > 0 ? (
                    <OpportunitySection title={selected.error ? opportunityText("opportunityFailureRisk", "Execution failure and risk", "执行失败与风险") : opportunityText("opportunityRiskNotes", "Risk notes", "风险提示")} tone="danger">
                      {selected.error ? <p className="opportunity-error-text" data-i18n-skip>{selected.error}</p> : null}
                      {(selected.riskNotes ?? []).length > 0 ? <OpportunityList items={selected.riskNotes ?? []} preserveOriginal /> : null}
                    </OpportunitySection>
                  ) : null}

                  {(selected.evidence ?? []).length > 0 ? (
                    <OpportunitySection title={opportunityText("opportunityEvidence", "Decision evidence", "判断证据")}>
                      <OpportunityList items={selected.evidence ?? []} preserveOriginal />
                    </OpportunitySection>
                  ) : null}

                  <OpportunitySection title={opportunityText("opportunityVersionSource", "Version and source", "版本与来源")}>
                    <dl className="opportunity-definition-grid trace">
                      <OpportunityDefinition label={opportunityText("opportunityRevision", "Opportunity version", "机会版本")} value={`v${selected.revision ?? 1}`} />
                      <OpportunityDefinition label={opportunityText("opportunityValidity", "Validity", "有效期")} value={formatExpiry(selected.expiresAt, true)} />
                      <OpportunityDefinition label="Agent Profile" value={selected.agentProfileId || "--"} mono />
                      <OpportunityDefinition label="Agent Run" value={selected.agentRunId || "--"} mono />
                      <OpportunityDefinition label={opportunityText("opportunityRelated", "Related opportunity", "关联机会")} value={selected.relatedOpportunityId || "--"} mono />
                      <OpportunityDefinition label={opportunityText("opportunityDuplicateHandling", "Similarity handling", "相似处理")} value={formatDuplicateResolution(selected)} />
                    </dl>
                  </OpportunitySection>

                  {selected.orderId || selected.clientOrderId || selected.algoId || selected.executionKey ? (
                    <OpportunitySection title={opportunityText("opportunityOrdersExecution", "Orders and execution", "订单与执行")}>
                      <dl className="opportunity-definition-grid trace">
                        <OpportunityDefinition label={opportunityText("opportunityOkxOrder", "OKX order", "OKX 订单")} value={selected.orderId || selected.algoId || "--"} mono />
                        <OpportunityDefinition label={opportunityText("opportunityClientOrder", "Client order", "客户端订单")} value={selected.clientOrderId || selected.algoClientOrderId || "--"} mono />
                        <OpportunityDefinition label={opportunityText("opportunityExecutionKey", "Execution key", "执行键")} value={selected.executionKey || "--"} mono wide />
                      </dl>
                    </OpportunitySection>
                  ) : null}

                  <details className="opportunity-raw-record">
                    <summary>{opportunityText("opportunityRawRecord", "Market snapshot / Precheck / raw execution record", "行情快照 / Precheck / 执行原始记录")}</summary>
                    <pre>{JSON.stringify(rawRecord, null, 2)}</pre>
                  </details>
                </div>

                {canApproveOpportunity(selected, now) ? (
                  <footer className="opportunity-detail-actions">
                    <button type="button" onClick={() => onApprove(selected.id)}><CheckCircle2 size={14} />{opportunityText("opportunityApproveExecute", "Approve and execute", "通过并执行")}</button>
                    <button type="button" className="danger" onClick={() => onReject(selected.id)}><XCircle size={14} />{opportunityText("opportunityReject", "Reject opportunity", "拒绝机会")}</button>
                  </footer>
                ) : null}
              </>
            ) : (
              <OpportunityEmpty title={opportunityText("opportunitySelect", "Select a trade opportunity", "选择一条交易机会")} detail={opportunityText("opportunitySelectDetail", "Open an opportunity from the left to review its rationale, risk, version, and execution result.", "从左侧列表打开机会，查看决策理由、风险、版本和执行结果。")} />
            )}
          </section>
        </div>
      </main>

      {confirmClearOpen ? (
        <div className="opportunity-confirm-backdrop" role="presentation">
          <div className="opportunity-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-opportunities-title">
            <strong id="clear-opportunities-title">{opportunityText("opportunityConfirmClear", "Clear all trade opportunities?", "清空所有交易机会？")}</strong>
            <p>{opportunityText("opportunityConfirmClearDetail", "This deletes {{count}} opportunity records and removes their links from historical orders, fills, and audits. Order and audit history are not deleted.", "这会删除当前列表中的 {{count}} 条机会记录，并解除历史订单、成交和审计记录的机会关联。订单和审计历史不会被删除。", { count: opportunities.length })}</p>
            <div>
              <button type="button" onClick={() => setConfirmClearOpen(false)}>{i18n.t("common:cancel")}</button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirmClearOpen(false);
                  onClearAll();
                }}
              >
                {opportunityText("opportunityConfirmClearAction", "Clear opportunities", "确认清空")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OpportunityStatus({ opportunity, now }: { opportunity: Pick<TradeOpportunity, "status" | "expiresAt">; now: number }) {
  const status = effectiveTradeOpportunityStatus(opportunity, now);
  const meta = tradeOpportunityStatusMeta(status);
  return <span className={clsx("opportunity-status", meta.tone)}><i aria-hidden="true" />{opportunityStatusLabel(status)}</span>;
}

function OpportunityMetric({ label, value }: { label: string; value: number }) {
  return <div className="opportunity-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function OpportunityFact({ label, value, tone, wide = false }: { label: string; value: ReactNode; tone?: "up" | "down"; wide?: boolean }) {
  return <div className={clsx("opportunity-fact", wide && "wide")}><span>{label}</span><b className={tone} title={typeof value === "string" ? value : undefined}>{value}</b></div>;
}

function OpportunitySection({ title, icon, tone, children }: { title: string; icon?: ReactNode; tone?: "danger"; children: ReactNode }) {
  return <section className={clsx("opportunity-section", tone)}><h3>{icon}{title}</h3>{children}</section>;
}

function OpportunityDefinition({ label, value, mono = false, wide = false }: { label: string; value: ReactNode; mono?: boolean; wide?: boolean }) {
  return <div className={clsx("opportunity-definition", mono && "mono", wide && "wide")}><dt>{label}</dt><dd title={typeof value === "string" ? value : undefined}>{value}</dd></div>;
}

function OpportunityList({ items, preserveOriginal = false }: { items: string[]; preserveOriginal?: boolean }) {
  return <ul className="opportunity-text-list" data-i18n-skip={preserveOriginal || undefined}>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>;
}

function OpportunityEmpty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="opportunity-empty"><AlertTriangle size={20} /><strong>{title}</strong><span>{detail}</span>{action}</div>;
}

function useOpportunityClock() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}

function canApproveOpportunity(item: Pick<TradeOpportunity, "status" | "expiresAt">, now: number) {
  return effectiveTradeOpportunityStatus(item, now) === "pending";
}

function shouldShowOpportunityExpiry(item: Pick<TradeOpportunity, "status" | "expiresAt">, now: number) {
  return !tradeOpportunityStatusMeta(effectiveTradeOpportunityStatus(item, now)).terminal;
}

function summarizeTradeOpportunities(opportunities: TradeOpportunity[], now: number) {
  return opportunities.reduce(
    (summary, item) => {
      const status = effectiveTradeOpportunityStatus(item, now);
      if (PENDING_STATUSES.has(status)) summary.pending += 1;
      else if (ACTIVE_STATUSES.has(status)) summary.active += 1;
      else if (COMPLETED_STATUSES.has(status)) summary.completed += 1;
      else if (ATTENTION_STATUSES.has(status)) summary.attention += 1;
      return summary;
    },
    { pending: 0, active: 0, completed: 0, attention: 0 }
  );
}

function opportunityMatchesFilter(item: TradeOpportunity, filter: OpportunityFilter, now: number) {
  if (filter === "all") return true;
  const status = effectiveTradeOpportunityStatus(item, now);
  if (filter === "pending") return PENDING_STATUSES.has(status);
  if (filter === "active") return ACTIVE_STATUSES.has(status);
  if (filter === "completed") return COMPLETED_STATUSES.has(status);
  return ATTENTION_STATUSES.has(status);
}

function countFilter(opportunities: TradeOpportunity[], filter: OpportunityFilter, now: number) {
  return filter === "all" ? opportunities.length : opportunities.filter((item) => opportunityMatchesFilter(item, filter, now)).length;
}

function filterLabel(filter: OpportunityFilter) {
  return opportunityFilterLabel(OPPORTUNITY_FILTERS.find((item) => item.id === filter)?.id ?? "all");
}

function isManageOpportunity(item: Pick<TradeOpportunity, "intent" | "orderType" | "action" | "ticketMode">) {
  return item.ticketMode === "manage"
    || item.intent === "cancel"
    || item.intent === "amend"
    || item.orderType === "cancel"
    || item.orderType === "amend"
    || item.action === "cancel"
    || item.action === "amend";
}

function formatOpportunityExitKind(item: Pick<TradeOpportunity, "exitKind">) {
  switch (item.exitKind) {
    case "take_profit": return opportunityText("opportunityTakeProfitExit", "Take-profit exit", "止盈退出");
    case "stop_loss": return opportunityText("opportunityStopLossExit", "Stop-loss protection", "止损保护");
    case "emergency": return opportunityText("opportunityEmergencyExit", "Emergency exit", "紧急退出");
    case "strategy_exit": return opportunityText("opportunityStrategyExit", "Strategy exit", "策略退出");
    default: return item.exitKind || "--";
  }
}

function formatOpportunityDirection(item: Pick<TradeOpportunity, "direction" | "intent" | "action" | "orderType" | "ticketMode">) {
  if (item.intent === "cancel" || item.action === "cancel" || item.orderType === "cancel") return opportunityText("opportunityCancelOrder", "Cancel order", "撤单");
  if (item.intent === "amend" || item.action === "amend" || item.orderType === "amend") return opportunityText("opportunityAmendOrder", "Amend order", "改单");
  if (item.intent === "close") return item.direction === "short" ? i18n.t("trading:closeShort") : i18n.t("trading:closeLong");
  return item.direction === "short" ? i18n.t("trading:short") : i18n.t("trading:long");
}

function opportunityActionTone(item: Pick<TradeOpportunity, "direction" | "intent" | "action" | "orderType" | "ticketMode">) {
  if (item.intent === "cancel" || item.action === "cancel" || item.orderType === "cancel") return "warning";
  if (item.intent === "amend" || item.action === "amend" || item.orderType === "amend") return "neutral";
  return item.direction === "long" ? "up" : "down";
}

function formatOpportunityOrderTarget(item: Pick<TradeOpportunity, "orderId" | "algoId">) {
  return item.orderId || item.algoId || "--";
}

function formatOpportunityClientTarget(item: Pick<TradeOpportunity, "clientOrderId" | "algoClientOrderId">) {
  return item.clientOrderId || item.algoClientOrderId || "--";
}

function formatOpportunityPrimaryTarget(item: Pick<TradeOpportunity, "intent" | "orderType" | "action" | "ticketMode" | "orderId" | "clientOrderId" | "algoId" | "algoClientOrderId" | "size" | "lever">) {
  if (isManageOpportunity(item)) {
    const order = formatOpportunityOrderTarget(item);
    const client = formatOpportunityClientTarget(item);
    if (order !== "--") return order;
    if (client !== "--") return client;
    return opportunityText("opportunityTargetNotSpecified", "Target order not specified", "目标订单未指定");
  }
  return `${item.size || "--"} ${i18n.t("trading:contracts")} · ${item.lever ? `${item.lever}x` : "--"}`;
}

function formatOpportunityListSizing(item: Pick<TradeOpportunity, "intent" | "orderType" | "action" | "ticketMode" | "orderId" | "clientOrderId" | "algoId" | "algoClientOrderId" | "size" | "lever">) {
  if (!isManageOpportunity(item)) return `${item.size || "--"} ${i18n.t("trading:contracts")} · ${item.lever ? `${item.lever}x` : `${i18n.t("trading:leverage")} --`}`;
  const target = formatOpportunityPrimaryTarget(item);
  return target === opportunityText("opportunityTargetNotSpecified", "Target order not specified", "目标订单未指定") ? opportunityText("opportunityOrderManagement", "Order management", "订单管理") : opportunityText("opportunityTargetValue", "Target {{target}}", "目标 {{target}}", { target });
}

function formatOpportunityManageChange(item: Pick<TradeOpportunity, "intent" | "action" | "orderType" | "newPrice" | "newSize">) {
  if (item.intent === "cancel" || item.action === "cancel" || item.orderType === "cancel") return opportunityText("opportunityCancelTargetOrder", "Cancel target order", "撤销目标委托");
  const changes = [
    item.newPrice ? opportunityText("opportunityNewPrice", "New price {{price}}", "新价格 {{price}}", { price: item.newPrice }) : null,
    item.newSize ? opportunityText("opportunityNewQuantity", "New quantity {{size}} contracts", "新数量 {{size}} 张", { size: item.newSize }) : null
  ].filter(Boolean);
  return changes.length > 0 ? changes.join(" · ") : opportunityText("opportunityModifyTargetOrder", "Modify target order", "修改目标委托");
}

function formatOpportunityEntry(item: Pick<TradeOpportunity, "entryCondition" | "price" | "orderType">) {
  if (item.entryCondition) return item.entryCondition;
  if (item.price) return item.price;
  if (item.orderType === "cancel") return opportunityText("opportunityCancelTargetOrder", "Cancel target order", "撤销目标委托");
  if (item.orderType === "amend") return opportunityText("opportunityModifyTargetOrder", "Modify target order", "修改目标委托");
  return item.orderType === "market" ? i18n.t("trading:market") : "--";
}

function formatOrderType(value: string) {
  if (value === "market") return i18n.t("trading:market");
  if (value === "limit") return i18n.t("trading:limit");
  if (value === "trigger") return opportunityText("opportunityTriggerOrder", "Trigger order", "计划委托");
  if (value === "cancel") return opportunityText("opportunityCancelOrder", "Cancel order", "撤单");
  if (value === "amend") return opportunityText("opportunityAmendOrder", "Amend order", "改单");
  return value || "--";
}

function formatConfidence(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return "--";
  const numeric = Number(value);
  return numeric <= 1 ? `${Math.round(numeric * 100)}%` : `${Math.round(numeric)}%`;
}

function formatUsdt(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return "--";
  return `${formatLocalizedNumber(Number(value), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

function formatOpportunityListTime(value?: number | null) {
  if (!value) return "--";
  return formatLocalizedDate(value, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatExpiry(value?: number | null, detailed = false) {
  if (!value) return opportunityText("opportunityLongTerm", "No expiry", "长期有效");
  const delta = value - Date.now();
  if (delta <= 0) return detailed ? opportunityText("opportunityExpiredAt", "Expired at {{time}}", "已于 {{time}} 过期", { time: formatDateTime(value) }) : opportunityText("opportunityExpired", "Expired", "已过期");
  if (delta < 60_000) return opportunityText("opportunityExpiresUnderMinute", "Expires in under 1 minute", "不足 1 分钟失效");
  if (delta < 3_600_000) return opportunityText("opportunityExpiresMinutes", "Expires in {{count}} minutes", "{{count}} 分钟后失效", { count: Math.ceil(delta / 60_000) });
  if (delta < 86_400_000) return opportunityText("opportunityExpiresHours", "Expires in {{count}} hours", "{{count}} 小时后失效", { count: Math.ceil(delta / 3_600_000) });
  return detailed ? formatDateTime(value) : opportunityText("opportunityExpiresDays", "Expires in {{count}} days", "{{count}} 天后失效", { count: Math.ceil(delta / 86_400_000) });
}

function formatDateTime(value?: number | null) {
  if (!value) return "--";
  return formatLocalizedDate(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDuplicateResolution(item: TradeOpportunity) {
  const labels: Record<string, string> = {
    reuse: opportunityText("opportunityReuseOriginal", "Reuse original opportunity", "复用原机会"),
    revise: opportunityText("opportunityReviseOriginal", "Revise original opportunity", "修订原机会"),
    create_new: opportunityText("opportunityCreateNew", "Create a new opportunity", "明确新建")
  };
  const label = item.duplicateResolution ? labels[item.duplicateResolution] ?? item.duplicateResolution : i18n.t("common:none");
  return item.duplicateResolutionReason ? `${label} · ${item.duplicateResolutionReason}` : label;
}

function opportunityFilterLabel(filter: OpportunityFilter) {
  const labels: Record<OpportunityFilter, string> = {
    all: i18n.t("common:all"),
    pending: opportunityText("opportunityPending", "Pending", "待处理"),
    active: opportunityText("opportunityActive", "In progress", "执行中"),
    completed: i18n.t("common:completed"),
    attention: opportunityText("opportunityAttention", "Needs attention", "需关注")
  };
  return labels[filter];
}

function opportunityStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: opportunityText("opportunityStatusPending", "Pending approval", "待审批"),
    approved: opportunityText("opportunityStatusApproved", "Approved", "已通过"),
    executing: opportunityText("opportunityStatusExecuting", "Executing", "执行中"),
    submitted: opportunityText("opportunityStatusSubmitted", "Submitted", "已提交"),
    partially_filled: opportunityText("opportunityStatusPartiallyFilled", "Partially filled", "部分成交"),
    executed: opportunityText("opportunityStatusExecuted", "Executed", "已执行"),
    closed: opportunityText("opportunityStatusClosed", "Closed", "已关闭"),
    failed: i18n.t("common:failed"),
    pending_blocked: opportunityText("opportunityStatusPrecheckBlocked", "Precheck blocked", "预检阻塞"),
    recovery_blocked: opportunityText("opportunityStatusRecoveryBlocked", "Recovery blocked", "恢复阻塞"),
    rejected: opportunityText("opportunityStatusRejected", "Rejected", "已拒绝"),
    cancelled: opportunityText("opportunityStatusCancelled", "Canceled", "已取消"),
    expired: opportunityText("opportunityExpired", "Expired", "已过期")
  };
  return labels[status] ?? status;
}

function opportunityText(key: string, english: string, chinese: string, values: Record<string, unknown> = {}) {
  const locale = (i18n.resolvedLanguage || i18n.language || "en-US").toLowerCase();
  return i18n.t(`automation:${key}`, {
    defaultValue: locale.startsWith("zh") ? chinese : english,
    ...values
  });
}

export default TradeOpportunitiesPage;
