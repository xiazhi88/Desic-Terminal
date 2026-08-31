import { Activity, ChevronDown, LayoutDashboard, Maximize2, Minus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AccountSummary, ChartWindowState, MarketAssetsSummary, Ticker } from "../types";
import {
  listChartWindows,
  loadAccounts,
  loadChartWorkspace,
  loadMarketAssetsCache,
  openChartWindow,
  registerMarketConsumer,
  saveChartWorkspace,
  unregisterMarketConsumer,
  updateChartWindowState,
} from "../lib/okx";
import { fmtPrice } from "../lib/format";
import { useBump } from "./useBump";
import { isTauriRuntime } from "../lib/tauri";
import { logger } from "../lib/logger";
import {
  createChartWorkspaceDocument,
  parseChartWorkspaceDocument,
  primaryChartWorkspaceSyncGroup,
  removeChartWorkspacePane,
  type ChartWorkspaceDocument,
  type ChartWorkspacePane,
} from "../lib/chartWorkspace";
import { ChartWorkspaceControls } from "./ChartWorkspaceControls";
import { DetachedChartPane } from "./DetachedChartPane";
import type { ChartCrosshairPosition } from "./chartAdapter";
import { ChartPaneLayoutComposer } from "./ChartPaneLayoutComposer";
import { ChartWorkspaceTemplateManager } from "./ChartWorkspaceTemplateManager";
import { defaultChartPaneLayoutSizing, loadDefaultChartLayout, saveDefaultChartLayout, type ChartPaneLayoutSizing } from "../lib/chartLayoutTemplates";

const DEFAULT_SYMBOL = "BTC-USDT-SWAP";
const DEFAULT_TIMEFRAME = "30m";

function getWindowId(initialWindowLabel?: string | null) {
  const url = new URL(window.location.href);
  const queryId = url.searchParams.get("chartWindowId") || url.searchParams.get("windowId");
  if (queryId) return queryId;
  if (initialWindowLabel?.startsWith("chart-")) return initialWindowLabel.slice("chart-".length);
  return "detached";
}

function workspaceStorageId(windowId: string) {
  return `detached-${windowId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
}

function applyPaneValue(
  document: ChartWorkspaceDocument,
  paneId: string,
  field: "symbol" | "timeframe",
  value: string,
): ChartWorkspaceDocument {
  const group = primaryChartWorkspaceSyncGroup(document);
  const shouldSync = group.paneIds.includes(paneId) && group.settings[field];
  return {
    ...document,
    panes: document.panes.map((pane) => shouldSync || pane.id === paneId ? { ...pane, [field]: value } : pane),
    activePaneId: paneId,
  };
}

function activePane(document: ChartWorkspaceDocument): ChartWorkspacePane {
  return document.panes.find((pane) => pane.id === document.activePaneId) ?? document.panes[0];
}

export function ChartWindowWorkspacePage({ initialWindowLabel }: { initialWindowLabel?: string | null }) {
  const windowId = useMemo(() => getWindowId(initialWindowLabel), [initialWindowLabel]);
  const storageId = useMemo(() => workspaceStorageId(windowId), [windowId]);
  const [backendState, setBackendState] = useState<ChartWindowState | null>(null);
  const [workspace, setWorkspace] = useState<ChartWorkspaceDocument>(() => createChartWorkspaceDocument({ id: storageId }));
  const [marketAssets, setMarketAssets] = useState<MarketAssetsSummary | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [environment, setEnvironment] = useState<"demo" | "live">("demo");
  const [ready, setReady] = useState(false);
  const [paneStatuses, setPaneStatuses] = useState<Record<string, string>>({});
  const [activeTicker, setActiveTicker] = useState<Ticker | null>(null);
  // 工作区图表窗主价跳动：activeTicker.last 为 OKX 字符串报价，取数值以获得涨跌方向。
  const marketPriceBump = useBump(Number(activeTicker?.last));
  const [synchronizedCrosshairPosition, setSynchronizedCrosshairPosition] = useState<ChartCrosshairPosition | null>(null);
  const [synchronizedVisibleRange, setSynchronizedVisibleRange] = useState<{ from: number; to: number } | null>(null);
  const [paneSizing, setPaneSizing] = useState<ChartPaneLayoutSizing>(() => defaultChartPaneLayoutSizing());
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const workspaceLoadEpochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const epoch = workspaceLoadEpochRef.current + 1;
    workspaceLoadEpochRef.current = epoch;
    void Promise.all([listChartWindows(), loadMarketAssetsCache(), loadAccounts(), loadChartWorkspace(storageId)])
      .then(([windows, assets, accounts, savedWorkspace]) => {
        if (cancelled || workspaceLoadEpochRef.current !== epoch) return;
        const matched = windows?.find((item) => item.id === windowId || item.label === `chart-${windowId}`) ?? null;
        const selectedAccount = matched?.accountId
          ? accounts.find((item) => item.id === matched.accountId) ?? null
          : accounts[0] ?? null;
        const seed = {
          id: storageId,
          name: "独立图表工作区",
          symbol: matched?.symbol || DEFAULT_SYMBOL,
          timeframe: matched?.timeframe || DEFAULT_TIMEFRAME,
        };
        const persisted = savedWorkspace ? parseChartWorkspaceDocument(savedWorkspace.layout, seed) : createChartWorkspaceDocument(seed);
        const restored = savedWorkspace
          ? { document: persisted, sizing: defaultChartPaneLayoutSizing() }
          : matched?.singlePane
            ? { document: createChartWorkspaceDocument(seed), sizing: defaultChartPaneLayoutSizing() }
            : loadDefaultChartLayout(persisted);
        setWorkspace(restored.document);
        setPaneSizing(restored.sizing);
        setBackendState(matched);
        setMarketAssets(assets);
        setAccountId(matched?.accountId ?? selectedAccount?.id ?? null);
        setAccount(selectedAccount);
        setEnvironment(matched?.environment === "live" || selectedAccount?.environment === "live" ? "live" : "demo");
      })
      .catch((error) => logger.error("failed to initialize detached chart workspace", error, { windowId }))
      .finally(() => {
        if (!cancelled && workspaceLoadEpochRef.current === epoch) setReady(true);
      });
    return () => { cancelled = true; };
  }, [storageId, windowId]);

  useEffect(() => {
    if (!ready) return;
    const handle = window.setTimeout(() => {
      // A pane popped out from another detached workspace is a temporary
      // inspection window. Its layout must not become a restorable workspace
      // or overwrite the user's primary detached-chart defaults.
      if (backendState?.singlePane) return;
      void saveChartWorkspace({
        id: storageId,
        name: "独立图表工作区",
        layout: workspace,
        indicators: { version: 1 },
        layers: { version: 1 },
      }).catch((error) => logger.error("failed to persist detached chart workspace", error, { storageId }));
      saveDefaultChartLayout(workspace, paneSizing);
      const primary = activePane(workspace);
      const state: ChartWindowState = {
        id: backendState?.id ?? windowId,
        label: backendState?.label ?? `chart-${windowId}`,
        symbol: primary.symbol,
        timeframe: primary.timeframe,
        accountId,
        environment,
        singlePane: backendState?.singlePane ?? false,
        panes: workspace.panes.map((pane) => ({ id: pane.id, symbol: pane.symbol, timeframe: pane.timeframe })),
        updatedAt: Date.now(),
      };
      setBackendState(state);
      void updateChartWindowState(state).catch((error) => logger.error("failed to persist detached chart window state", error, { windowId }));
    }, 500);
    return () => window.clearTimeout(handle);
  }, [accountId, backendState?.id, backendState?.label, environment, paneSizing, ready, storageId, windowId, workspace]);

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return;
    const consumerId = `chart-window:${windowId}`;
    void registerMarketConsumer({
      consumerId,
      symbols: [...new Set(workspace.panes.map((pane) => pane.symbol))],
      orderbookDepth: 400,
      includeTrades: true,
      includeOrderbook: true,
    }).catch((error) => logger.error("failed to register chart workspace consumer", error, { consumerId }));
    return () => {
      void unregisterMarketConsumer(consumerId).catch((error) => logger.error("failed to release chart workspace consumer", error, { consumerId }));
    };
  }, [ready, windowId, workspace.panes]);

  const selected = activePane(workspace);
  const syncGroup = primaryChartWorkspaceSyncGroup(workspace);
  const status = paneStatuses[selected?.id] ?? (ready ? "实时监听中" : "初始化图表窗口");
  const setPaneStatus = useCallback((paneId: string, next: string) => {
    setPaneStatuses((previous) => previous[paneId] === next ? previous : { ...previous, [paneId]: next });
  }, []);
  const updatePane = useCallback((paneId: string, field: "symbol" | "timeframe", value: string) => {
    setWorkspace((previous) => applyPaneValue(previous, paneId, field, value));
  }, []);

  const minimize = useCallback(() => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => void getCurrentWindow().minimize());
  }, []);
  const toggleMaximize = useCallback(() => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => void getCurrentWindow().toggleMaximize());
  }, []);
  const close = useCallback(() => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => void getCurrentWindow().close());
  }, []);
  const detachPane = useCallback((paneId: string) => {
    const pane = workspace.panes.find((item) => item.id === paneId);
    if (!pane) return;
    void openChartWindow({ symbol: pane.symbol, timeframe: pane.timeframe, accountId, environment, singlePane: true })
      .then((opened) => {
        if (!opened) return;
        setWorkspace((current) => {
          if (current.panes.length <= 1) {
            close();
            return current;
          }
          return removeChartWorkspacePane(current, paneId);
        });
      })
      .catch((error) => logger.error("failed to detach chart pane", error, { paneId }));
  }, [accountId, close, environment, workspace.panes]);
  const dragWindow = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select, input")) return;
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => void getCurrentWindow().startDragging().catch((error) => logger.error("failed to drag chart window", error)));
  }, []);

  return (
    <div className="chart-window-page chart-window-workspace-page">
      <header className="chart-window-header" onPointerDown={dragWindow}>
        <div className="chart-window-app-mark" data-tauri-drag-region><Activity size={17} /></div>
        <div className="chart-window-title" data-tauri-drag-region>
          <div data-tauri-drag-region><strong>{selected?.symbol || DEFAULT_SYMBOL}</strong><span className="chart-window-readonly">交易图表</span></div>
          <span data-tauri-drag-region>{workspace.layout} 图 · {selected?.timeframe || DEFAULT_TIMEFRAME} · 永续合约图表</span>
        </div>
        <div className="chart-window-market" data-tauri-drag-region>
          <strong className={`${Number(activeTicker?.last) >= Number(activeTicker?.open24h) ? "up" : "down"} ${marketPriceBump.className}`.trim()} onAnimationEnd={marketPriceBump.onAnimationEnd}>{fmtPrice(activeTicker?.last)}</strong>
          <span className="chart-window-live-state"><i />{status}</span>
        </div>
        <div className="chart-window-title-menus" onPointerDown={(event) => event.stopPropagation()}>
          <div className="chart-window-title-menu">
            <button type="button" className={layoutMenuOpen ? "is-active" : undefined} onClick={() => { setLayoutMenuOpen((open) => !open); setTemplateMenuOpen(false); }}>
              <LayoutDashboard size={14} /> 布局 <ChevronDown size={12} />
            </button>
            {layoutMenuOpen && <div className="chart-window-title-dropdown"><ChartWorkspaceControls document={workspace} onChange={(next) => { setWorkspace(next); setLayoutMenuOpen(false); }} disabled={!ready} vertical /></div>}
          </div>
          <div className="chart-window-title-menu">
            <button type="button" className={templateMenuOpen ? "is-active" : undefined} onClick={() => { setTemplateMenuOpen((open) => !open); setLayoutMenuOpen(false); }}>
              模板 <ChevronDown size={12} />
            </button>
            {templateMenuOpen && <div className="chart-window-title-dropdown chart-window-title-dropdown--template"><ChartWorkspaceTemplateManager document={workspace} sizing={paneSizing} storageKey="desic.detached-chart-layout-templates.v1" disabled={!ready} onDocumentChange={setWorkspace} onSizingChange={setPaneSizing} /></div>}
          </div>
        </div>
        <div className="chart-window-controls">
          <button onClick={minimize} title="最小化"><Minus size={16} /></button>
          <button onClick={toggleMaximize} title="最大化/还原"><Maximize2 size={15} /></button>
          <button className="danger" onClick={close} title="关闭"><X size={16} /></button>
        </div>
      </header>
      <main className="chart-window-workspace-grid">
        <ChartPaneLayoutComposer document={workspace} sizing={paneSizing} disabled={!ready} onDocumentChange={setWorkspace} onSizingChange={setPaneSizing} onDetachPane={detachPane} renderPane={(pane) => (
            <DetachedChartPane
              paneId={pane.id}
              workspaceId={`${storageId}-${pane.id}`}
              symbol={pane.symbol}
              timeframe={pane.timeframe}
              accountId={accountId}
              account={account}
              environment={environment}
              marketAssets={marketAssets}
              onSymbolChange={(value) => updatePane(pane.id, "symbol", value)}
              onTimeframeChange={(value) => updatePane(pane.id, "timeframe", value)}
              onStatusChange={(value) => setPaneStatus(pane.id, value)}
              onTickerChange={pane.id === workspace.activePaneId ? setActiveTicker : undefined}
              onCrosshairPosition={syncGroup.settings.crosshair && syncGroup.paneIds.includes(pane.id)
                ? (value) => setSynchronizedCrosshairPosition((previous) => previous?.time === value?.time && previous?.price === value?.price ? previous : value)
                : undefined}
              onVisibleRange={syncGroup.settings.timeRange && syncGroup.paneIds.includes(pane.id)
                ? (value) => setSynchronizedVisibleRange((previous) => sameVisibleRange(previous, value) ? previous : value)
                : undefined}
              synchronizedCrosshairPosition={syncGroup.settings.crosshair && syncGroup.paneIds.includes(pane.id) ? synchronizedCrosshairPosition : null}
              synchronizedVisibleRange={syncGroup.settings.timeRange && syncGroup.paneIds.includes(pane.id) ? synchronizedVisibleRange : null}
              indicatorIds={pane.indicatorIds}
              onIndicatorIdsChange={(indicatorIds) => setWorkspace((current) => ({ ...current, panes: current.panes.map((item) => item.id === pane.id ? { ...item, indicatorIds: [...indicatorIds] } : item) }))}
              onClosePane={workspace.panes.length > 1 ? () => setWorkspace((current) => removeChartWorkspacePane(current, pane.id)) : undefined}
            />
        )} />
      </main>
    </div>
  );
}

function sameVisibleRange(
  left: { from: number; to: number } | null,
  right: { from: number; to: number } | null,
) {
  return left === right || Boolean(left && right && left.from === right.from && left.to === right.to);
}
