import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listenSystematicEvents, loadSystematicOverview, type SystematicOverview } from "../lib/systematic";
import { logger } from "../lib/logger";
import { isTauriRuntime } from "../lib/tauri";
import type { MarketAssetsSummary } from "../types";
import { SystematicStrategyLab } from "./SystematicStrategyLab";
import { WorkspaceFrame } from "./WorkspaceFrame";

type AppNotification = {
  kind: "success" | "info" | "warning" | "error" | "trade";
  title: string;
  message: string;
};

type SystematicResearchPageProps = {
  selectedSymbol: string;
  watchlist: string[];
  marketAssets: MarketAssetsSummary | null;
  accounts: Array<{ id: string; name: string; environment: string }>;
  onNotify: (notification: AppNotification) => void;
  onReady?: () => void;
  openAiStrategyRequest?: { strategyId: string; runId?: string; optimizationId?: string } | null;
};

function isChineseLocale(locale: string) {
  return locale.toLowerCase().startsWith("zh");
}

/**
 * Backtest and optimization lifecycle events are a convenience, not a
 * guarantee: a busy WebView can miss one, and a missed `backtestFinished`
 * leaves a finished run rendered as "queued"/"running" forever, with the
 * elapsed-time readout counting up against `Date.now()`. Poll while any run is
 * in flight so a dropped event costs seconds of staleness instead of the whole
 * session.
 */
const IN_FLIGHT_POLL_MS = 2_500;
const IN_FLIGHT_RUN_STATES = new Set(["queued", "running", "cancelling"]);

function hasInFlightWork(overview: SystematicOverview | null) {
  if (!overview) return false;
  const runs = overview.backtestsPage?.items ?? overview.backtests ?? [];
  if (runs.some((run) => IN_FLIGHT_RUN_STATES.has(run.status))) return true;
  return (overview.optimizations ?? []).some((optimization) => IN_FLIGHT_RUN_STATES.has(optimization.status));
}

/**
 * Systematic research deliberately enters through strategy work, not contract
 * filtering. Factors and visual rules remain persisted compatibility assets;
 * this page makes the time-series strategy -> backtest -> replay workflow the
 * primary desktop experience.
 */
export function SystematicResearchPage({ selectedSymbol, watchlist, marketAssets, accounts, onNotify, onReady, openAiStrategyRequest }: SystematicResearchPageProps) {
  const { i18n } = useTranslation();
  const [overview, setOverview] = useState<SystematicOverview | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const nextRefreshAt = useRef(0);
  const desktop = isTauriRuntime();
  const chinese = isChineseLocale(i18n.resolvedLanguage ?? i18n.language);

  const refresh = useCallback(async () => {
    try {
      const next = await loadSystematicOverview();
      if (next) setOverview(next);
    } catch (error) {
      logger.error("systematic research refresh failed", error);
      onNotify({
        kind: "error",
        title: chinese ? "无法读取策略研究" : "Could not load strategy research",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }, [chinese, onNotify]);

  // The poll reads the newest `refresh` through a ref so its interval is not
  // torn down and recreated whenever the callback identity changes.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const inFlight = hasInFlightWork(overview);

  useEffect(() => {
    if (!inFlight) return;
    let active = true;
    let running = false;
    // A slow overview query must not stack requests; skip a tick that arrives
    // while the previous one is still in flight.
    const timer = window.setInterval(() => {
      if (!active || running) return;
      running = true;
      void refreshRef.current().finally(() => {
        running = false;
      });
    }, IN_FLIGHT_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [inFlight]);

  useEffect(() => {
    let active = true;
    void refresh().finally(() => {
      if (active) onReady?.();
    });
    let unlisten: (() => void) | null = null;
    void listenSystematicEvents((event) => {
      if (!active) return;
      if (event.type === "backtestDataSync") {
        const instrument = event.instId || "--";
        if (event.status === "running") {
          onNotify({
            kind: "info",
            title: chinese ? "正在补齐回测 K 线" : "Preparing backtest K-line data",
            message: chinese
              ? `${instrument} 正在校验并补齐本次回测所需的本地分钟 K 线。`
              : `${instrument} is checking and repairing the local one-minute bars required for this backtest.`
          });
        } else if (event.status === "completed") {
          onNotify({
            kind: "success",
            title: chinese ? "回测数据已准备好" : "Backtest data is ready",
            message: chinese
              ? `${instrument} 已同步 ${event.inserted ?? 0} 根 K 线，正在创建回测任务。`
              : `${instrument}: synchronized ${event.inserted ?? 0} K-lines and is now creating the backtest.`
          });
        } else if (event.status === "failed") {
          onNotify({
            kind: "error",
            title: chinese ? "无法补齐回测数据" : "Could not prepare backtest data",
            message: event.error || (chinese ? "请检查市场数据连接后重试。" : "Check the market-data connection and try again.")
          });
        }
      }
      if (event.type === "backtestFinished") {
        onNotify({
          kind: event.status === "completed" ? "success" : event.status === "cancelled" ? "warning" : "error",
          title: event.status === "completed"
            ? (chinese ? "回测已完成" : "Backtest completed")
            : event.status === "cancelled"
              ? (chinese ? "回测已取消" : "Backtest cancelled")
              : (chinese ? "回测失败" : "Backtest failed"),
          message: event.error || event.runId || "--"
        });
      }
      // Progress events are throttled, not debounced. A fast backtest or
      // optimization emits frequent updates, and rescheduling a 350 ms delay
      // on each arrival would leave the UI at 0% until the finished event.
      if (event.type === "backtestProgress") {
        if (refreshTimer.current !== null) return;
        const wait = Math.max(0, nextRefreshAt.current - Date.now());
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = null;
          nextRefreshAt.current = Date.now() + 350;
          void refresh();
        }, wait);
        return;
      }
      if (event.type === "optimizationProgress" || event.type === "optimizationRunning" || event.type === "optimizationCancelling") {
        if (refreshTimer.current !== null) return;
        const wait = Math.max(0, nextRefreshAt.current - Date.now());
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = null;
          nextRefreshAt.current = Date.now() + 350;
          void refresh();
        }, wait);
        return;
      }
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      nextRefreshAt.current = Date.now() + 350;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void refresh();
      }, 0);
    }).then((next) => {
      if (!active) next?.();
      else unlisten = next;
    });
    return () => {
      active = false;
      unlisten?.();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [chinese, onNotify, onReady, refresh]);

  return (
    <WorkspaceFrame className="systematic-research-workspace" tone="research">
      <SystematicStrategyLab
        overview={overview}
        selectedSymbol={selectedSymbol}
        watchlist={watchlist}
        marketAssets={marketAssets}
        accounts={accounts}
        desktop={desktop}
        chinese={chinese}
        refresh={refresh}
        onNotify={onNotify}
        openAiStrategyRequest={openAiStrategyRequest}
      />
    </WorkspaceFrame>
  );
}
