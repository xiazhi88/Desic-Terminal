import type { TradeOpportunity, TradeOpportunityStatus } from "../types";

const EXPIRABLE_STATUSES = new Set<TradeOpportunityStatus>(["pending", "approved"]);

export type TradeOpportunityStatusTone = "success" | "warning" | "danger" | "neutral";

export function effectiveTradeOpportunityStatus(
  item: Pick<TradeOpportunity, "status" | "expiresAt">,
  now = Date.now()
): TradeOpportunityStatus {
  if (item.expiresAt && item.expiresAt <= now && EXPIRABLE_STATUSES.has(item.status)) {
    return "expired";
  }
  return item.status;
}

export function tradeOpportunityStatusMeta(status: TradeOpportunityStatus | string): {
  label: string;
  tone: TradeOpportunityStatusTone;
  terminal: boolean;
} {
  const meta: Record<TradeOpportunityStatus, { label: string; tone: TradeOpportunityStatusTone; terminal: boolean }> = {
    pending: { label: "待审批", tone: "warning", terminal: false },
    approved: { label: "已批准", tone: "warning", terminal: false },
    executing: { label: "执行中", tone: "warning", terminal: false },
    submitted: { label: "已提交", tone: "warning", terminal: false },
    partially_filled: { label: "部分成交", tone: "warning", terminal: false },
    executed: { label: "已执行", tone: "success", terminal: true },
    closed: { label: "已关闭", tone: "success", terminal: true },
    rejected: { label: "已拒绝", tone: "neutral", terminal: true },
    failed: { label: "失败", tone: "danger", terminal: true },
    cancelled: { label: "已取消", tone: "neutral", terminal: true },
    expired: { label: "已过期", tone: "neutral", terminal: true },
    pending_blocked: { label: "预检阻塞", tone: "danger", terminal: false },
    recovery_blocked: { label: "恢复阻塞", tone: "danger", terminal: false }
  };
  return meta[status as TradeOpportunityStatus] ?? {
    label: status || "未知",
    tone: "neutral",
    terminal: false
  };
}
