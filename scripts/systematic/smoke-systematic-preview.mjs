import { chromium } from "playwright";

const previewUrl = process.env.DESIC_SYSTEMATIC_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview?accounts=demo&marketConsistency=1";
const minute = 60_000;
const endAt = Date.UTC(2026, 7, 3, 8, 0, 0);
const requestedBarCount = process.argv.includes("--month")
  ? 31 * 24 * 60
  : Number.parseInt(process.env.DESIC_SYSTEMATIC_SMOKE_BAR_COUNT || "96", 10);
const barCount = Number.isFinite(requestedBarCount)
  ? Math.min(Math.max(Math.trunc(requestedBarCount), 96), 60_000)
  : 96;
const replayBarLimit = 1_500;
const replayEquityContextPointLimit = 2_400;

function projectReplayEquity(points, activeStartIndex) {
  const active = points.slice(activeStartIndex);
  if (points.length <= active.length + replayEquityContextPointLimit) return points;
  const context = [];
  const stride = Math.ceil(activeStartIndex / replayEquityContextPointLimit);
  for (let index = 0; index < activeStartIndex; index += stride) context.push(points[index]);
  const byTime = new Map([...context, ...active].map((point) => [point.timeMs, point]));
  return [...byTime.values()].sort((left, right) => left.timeMs - right.timeMs);
}

function fixture() {
  const bars = Array.from({ length: barCount }, (_, index) => {
    const open = 63_000 + Math.sin(index / 7) * 150 + index * 1.4;
    const close = open + Math.sin(index / 3) * 32;
    return {
      openTimeMs: endAt - (barCount - index) * minute,
      closeTimeMs: endAt - (barCount - index - 1) * minute,
      open,
      high: Math.max(open, close) + 22,
      low: Math.min(open, close) - 22,
      close,
      volume: 20 + (index % 10) * 2,
    };
  });
  const longReplayFixture = bars.length > 96;
  const fillStride = 12;
  const fills = longReplayFixture
    ? Array.from({ length: Math.floor((bars.length - 1) / fillStride) }, (_, index) => {
      const bar = bars[(index + 1) * fillStride];
      const buy = index % 2 === 0;
      return {
        timeMs: bar.openTimeMs,
        instId: "BTC-USDT-SWAP",
        side: buy ? "buy" : "sell",
        quantity: 1,
        rawPrice: bar.open,
        fillPrice: bar.open,
        notionalUsdt: bar.open * 0.01,
        feeUsdt: 0.04,
        marginDeltaUsdt: buy ? 64 : -64,
        marginAfterUsdt: buy ? 64 : 0,
        reason: buy ? "targetIncrease" : "targetDecrease",
      };
    })
    : [
      { timeMs: bars[36].openTimeMs, instId: "BTC-USDT-SWAP", side: "buy", quantity: 12, rawPrice: bars[36].open, fillPrice: bars[36].open, notionalUsdt: bars[36].open * 0.12, feeUsdt: 0.76, marginDeltaUsdt: 630, marginAfterUsdt: 630, reason: "targetIncrease" },
      { timeMs: bars[76].openTimeMs, instId: "BTC-USDT-SWAP", side: "sell", quantity: 12, rawPrice: bars[76].open, fillPrice: bars[76].open, notionalUsdt: bars[76].open * 0.12, feeUsdt: 0.76, marginDeltaUsdt: -630, marginAfterUsdt: 0, reason: "targetDecrease" },
    ];
  const closedTrades = longReplayFixture
    ? Array.from({ length: Math.floor(fills.length / 2) }, (_, index) => {
      const entry = fills[index * 2];
      const exit = fills[index * 2 + 1];
      return {
        strategyId: "strategy-fixture", instId: "BTC-USDT-SWAP", side: "long", quantity: 1,
        entryTimeMs: entry.timeMs, exitTimeMs: exit.timeMs,
        entryPrice: entry.fillPrice, exitPrice: exit.fillPrice,
        entryNotionalUsdt: entry.notionalUsdt, exitNotionalUsdt: exit.notionalUsdt,
        usedMarginUsdt: 64, leverage: 10, marginSafetyMultiplier: 1,
        grossPnlUsdt: exit.fillPrice - entry.fillPrice,
        entryFeeUsdt: entry.feeUsdt, exitFeeUsdt: exit.feeUsdt,
        fundingCashflowUsdt: 0,
        netPnlUsdt: exit.fillPrice - entry.fillPrice - entry.feeUsdt - exit.feeUsdt,
        exitReason: "targetDecrease",
      };
    })
    : [{ strategyId: "strategy-fixture", instId: "BTC-USDT-SWAP", side: "long", quantity: 12, entryTimeMs: bars[36].openTimeMs, exitTimeMs: bars[76].openTimeMs, entryPrice: bars[36].open, exitPrice: bars[76].open, entryNotionalUsdt: bars[36].open * 0.12, exitNotionalUsdt: bars[76].open * 0.12, usedMarginUsdt: 630, leverage: 10, marginSafetyMultiplier: 1, grossPnlUsdt: 185.52, entryFeeUsdt: 0.76, exitFeeUsdt: 0.76, fundingCashflowUsdt: 0, netPnlUsdt: 184, exitReason: "targetDecrease" }];
  const snapshots = bars.map((bar, index) => ({
    timeMs: bar.closeTimeMs,
    equityUsdt: 10_000 + index * 1.8 + Math.sin(index / 8) * 24,
    cashUsdt: 9_850 + index,
    unrealizedPnlUsdt: Math.sin(index / 7) * 18,
    usedMarginUsdt: longReplayFixture ? 0 : index >= 36 && index < 76 ? 630 : 0,
    availableMarginUsdt: longReplayFixture ? 10_000 : index >= 36 && index < 76 ? 9_460 : 10_000,
    fillCount: longReplayFixture ? Math.min(fills.length, Math.floor(index / fillStride)) : index >= 36 ? (index >= 76 ? 2 : 1) : 0,
    closedTradeCount: longReplayFixture ? Math.min(closedTrades.length, Math.floor(index / (fillStride * 2))) : index >= 76 ? 1 : 0,
    fundingPaymentCount: 0,
    position: !longReplayFixture && index >= 36 && index < 76 ? {
      strategyId: "strategy-fixture",
      instId: "BTC-USDT-SWAP",
      side: "long",
      quantity: 12,
      entryTimeMs: bars[36].openTimeMs,
      averageEntryPrice: bars[36].open,
      markedPrice: bar.close,
      contractValue: 0.01,
      notionalUsdt: bar.close * 0.12,
      usedMarginUsdt: 630,
      leverage: 10,
      marginSafetyMultiplier: 1,
      unrealizedPnlUsdt: (bar.close - bars[36].open) * 0.12,
      entryFeeUsdt: 0.76,
      fundingCashflowUsdt: 0,
      stopLoss: bars[36].open * 0.985,
      takeProfit: bars[36].open * 1.025,
    } : null,
  }));
  const replayStartIndex = Math.max(0, bars.length - replayBarLimit);
  const replayBars = bars.slice(replayStartIndex);
  const replaySnapshots = snapshots.slice(replayStartIndex);
  const replayEquityCurve = projectReplayEquity(
    snapshots.map(({ timeMs, equityUsdt, cashUsdt, unrealizedPnlUsdt }) => ({
      timeMs,
      equityUsdt,
      realizedCashUsdt: cashUsdt,
      unrealizedPnlUsdt,
    })),
    replayStartIndex,
  );
  const run = {
    id: "run-fixture",
    strategyId: "strategy-fixture",
    strategyName: "Multi-timeframe pullback",
    status: "completed",
    progressPct: 100,
    instId: "BTC-USDT-SWAP",
    dataSnapshotId: "fixture",
    barCount: bars.length,
    createdAt: endAt,
    startedAt: endAt,
    finishedAt: endAt + 1_000,
    metrics: {
      netReturnPct: 2.4,
      maxDrawdownPct: 3.2,
      annualizedSharpe: 1.4,
      closedTradeCount: closedTrades.length,
      winRate: 1,
      feesUsdt: 1.52,
      fundingCashflowUsdt: 0,
    },
    equityPreview: snapshots.slice(-24).map((item) => item.equityUsdt),
  };
  const report = {
    schemaVersion: "desic.systematic.backtest/v1",
    status: "completed",
    reproducibility: {
      preloadStartTimeMs: bars[0].openTimeMs - 60 * minute,
      preloadBarCount: 60,
      startTimeMs: bars[0].openTimeMs,
      endTimeMs: bars.at(-1).closeTimeMs,
      processedBarCount: bars.length,
    },
    execution: { entrySlippageBps: 2, exitSlippageBps: 2, entryFeeRate: 0.0005, exitFeeRate: 0.0005 },
    margin: { leverage: 10, marginSafetyMultiplier: 1 },
    metrics: {
      initialEquityUsdt: 10_000,
      finalEquityUsdt: 10_240,
      netPnlUsdt: 240,
      grossPnlUsdt: 241.52,
      realizedGrossPnlUsdt: 184,
      unrealizedPnlUsdt: 56,
      feesUsdt: 1.52,
      fundingCashflowUsdt: 0,
      maxDrawdownUsdt: 320,
      maxDrawdownPct: 3.2,
      closedTradeCount: 1,
      winRate: 1,
    },
    equityCurve: replayEquityCurve,
    replaySnapshots,
    statistics: {
      annualizedSharpe: 1.4,
      annualizedSortino: 1.9,
      annualizedVolatilityPct: 22,
      profitFactor: 1.8,
      expectancyUsdt: 184,
      averageWinUsdt: 184,
      averageLossUsdt: null,
      payoffRatio: null,
      averageHoldingMs: 2_400_000,
      exposurePct: 34,
      largestWinUsdt: 184,
      largestLossUsdt: null,
      maxConsecutiveWins: 1,
      maxConsecutiveLosses: 0,
    },
    fills,
    closedTrades,
    strategyActions: [
      { asOfMs: bars[35].closeTimeMs, action: { kind: "open_long", reason: "5m trend and 1m pullback" } },
      { asOfMs: bars[53].closeTimeMs, action: { kind: "set_protection", reason: "raise stop" } },
      { asOfMs: bars[75].closeTimeMs, action: { kind: "close_long", reason: "momentum exit" } },
    ].filter((event) => event.asOfMs >= replayBars[0].closeTimeMs && event.asOfMs <= replayBars.at(-1).closeTimeMs),
    reportHash: "fixture",
  };
  const runtime = {
    available: true,
    state: "ready",
    reason: "Python environment ready",
    setupRequired: false,
    environmentExists: true,
    interpreterLabel: "Python 3.12",
    sampleTestAvailable: true,
    sampleTestConfigured: true,
  };
  return {
    overview: {
      universe: { totalInstruments: 1, eligibleInstruments: 1, coveragePct: 100, coverage: "complete" },
      factors: [],
      factorDefinitions: [],
      strategies: [{
        id: "strategy-fixture",
        name: "Multi-timeframe pullback",
        kind: "python",
        runtime: "localPython",
        version: 3,
        status: "draft",
        description: "Uses a 5-minute trend filter with a 1-minute pullback entry.",
        sourceHash: "fixture",
        updatedAt: endAt,
        definition: {
          schemaVersion: "desic.systematic.strategy/v1",
          protocol: "desic.systematic.python/v1",
          entrypoint: "on_bar",
          source: "def on_bar(ctx):\n    fast = int(ctx.params.get('fastPeriod', 10))\n    bars_5m = ctx.market.bars(ctx.instrument_id, '5m', lookback=30)\n    if not bars_5m[-1].confirmed:\n        return ctx.no_action('wait for 5m close')\n    return ctx.no_action('fixture')\n",
          parameters: { fastPeriod: 10, slowPeriod: 30, riskPct: 0.8 },
          parameterTuning: {
            fastPeriod: { min: 5, max: 30, step: 1 },
            slowPeriod: { min: 20, max: 90, step: 5 },
            riskPct: { min: 0.2, max: 2, step: 0.1 },
          },
        },
      }],
      backtests: [run],
      optimizations: [],
      profiles: [],
      operations: { mode: "paper", paperPaused: true, status: "paused", activeStrategyCount: 0, targets: [] },
      registryPackages: [],
      workerCapacity: 2,
      pythonRuntime: runtime,
    },
    detail: { run, report, bars: replayBars, barOffset: replayStartIndex, totalBarCount: bars.length, preloadBarCount: 60, preloadStartAt: bars[0].openTimeMs - 60 * minute, evaluationStartAt: bars[0].openTimeMs },
    runtime,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const data = fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector(".workspace", { timeout: 30_000 });
    await page.evaluate(({ overview, detail, runtime, endAt: defaultEnd }) => {
      let callbackId = 1;
      window.__TAURI_INTERNALS__ = {
        transformCallback() { return callbackId++; },
        unregisterCallback() {},
        convertFileSrc(path) { return path; },
        async invoke(command) {
          if (command === "systematic_overview") return overview;
          if (command === "systematic_backtest_detail") return detail;
          if (command === "systematic_backtest_defaults") return { startAt: defaultEnd - 30 * 24 * 60 * 60 * 1000, endAt: defaultEnd };
          if (command === "systematic_python_prepare_environment") return runtime;
          if (command === "plugin:event|listen" || command === "plugin:event|unlisten") return 1;
          return null;
        },
      };
    }, { ...data, endAt });

    await page.getByRole("button", { name: "Systematic Research" }).click();
    await page.waitForSelector(".systematic-strategy-lab", { timeout: 30_000 });
    const strategyLayout = await page.evaluate(() => {
      const documentOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const table = document.querySelector(".systematic-lab-parameter-tuning__table")?.getBoundingClientRect();
      const fields = Array.from(document.querySelectorAll(".systematic-lab-parameter-tuning__row input"))
        .map((input) => input.getBoundingClientRect());
      const strategyList = document.querySelector(".systematic-lab-strategy-list__scroll");
      const firstStrategy = strategyList?.querySelector(".systematic-lab-strategy-row")?.getBoundingClientRect();
      const strategyListStyle = strategyList ? getComputedStyle(strategyList) : null;
      const strategySearchInput = document.querySelector(".systematic-lab-strategy-list__search input");
      const strategySearchStyle = strategySearchInput ? getComputedStyle(strategySearchInput) : null;
      return {
        documentOverflow,
        allTuningFieldsVisible: Boolean(table) && fields.length === 9 && fields.every((field) => field.left >= table.left && field.right <= table.right),
        strategySearchHasNoInnerFrame: Boolean(strategySearchStyle)
          && strategySearchStyle.borderTopWidth === "0px"
          && strategySearchStyle.backgroundColor === "rgba(0, 0, 0, 0)",
        strategyListIsVertical: Boolean(strategyList && firstStrategy && strategyListStyle)
          && strategyListStyle.display !== "flex"
          && strategyListStyle.overflowY !== "hidden"
          && firstStrategy.height < strategyList.getBoundingClientRect().height / 2,
      };
    });
    assert(strategyLayout.documentOverflow <= 2, `strategy view has horizontal overflow: ${strategyLayout.documentOverflow}`);
    assert(strategyLayout.allTuningFieldsVisible, "parameter tuning min/max/step fields must all fit the inspector");
    assert(strategyLayout.strategySearchHasNoInnerFrame, "strategy search input must not paint an inner border over its wrapper");
    assert(strategyLayout.strategyListIsVertical, `desktop strategy rows must stay vertically stacked in the strategy list: ${JSON.stringify(strategyLayout)}`);

    await page.getByRole("button", { name: "Development guide" }).click();
    await page.waitForSelector(".systematic-lab-strategy-docs", { timeout: 10_000 });
    const documentationLayout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const root = rect(".systematic-lab-strategy-view");
      const docs = rect(".systematic-lab-strategy-docs");
      const editor = rect(".systematic-python-editor");
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        docs: docs ? { width: docs.width, height: docs.height, right: docs.right, left: docs.left } : null,
        editor: editor ? { width: editor.width, height: editor.height, right: editor.right } : null,
        rootRight: root?.right ?? 0,
      };
    });
    assert(documentationLayout.documentOverflow <= 2, `development guide has horizontal overflow: ${JSON.stringify(documentationLayout)}`);
    assert(documentationLayout.docs?.width > 220 && documentationLayout.docs?.height > 180, "development guide must open as a usable side reference panel");
    assert(documentationLayout.editor?.width > 240 && documentationLayout.editor?.height > 180, "development guide must leave a usable strategy editor");
    assert(documentationLayout.docs && documentationLayout.docs.right <= documentationLayout.rootRight + 1, "development guide must remain inside the strategy workspace");
    assert(documentationLayout.docs && documentationLayout.editor && documentationLayout.docs.left >= documentationLayout.editor.right - 1, "development guide must occupy the right-side reference area");
    await page.getByRole("button", { name: "Close development guide" }).click();

    await page.getByRole("button", { name: "AI strategy assistant" }).click();
    await page.waitForSelector(".systematic-lab-strategy-ai-panel", { timeout: 10_000 });
    const aiPanelLayout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const root = rect(".systematic-lab-strategy-view");
      const editor = rect(".systematic-python-editor");
      const panel = rect(".systematic-lab-strategy-ai-panel");
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        editor: editor ? { width: editor.width, height: editor.height } : null,
        panel: panel ? { width: panel.width, height: panel.height, right: panel.right } : null,
        rootRight: root?.right ?? 0,
      };
    });
    assert(aiPanelLayout.documentOverflow <= 2, `AI strategy panel has horizontal overflow: ${aiPanelLayout.documentOverflow}`);
    assert(aiPanelLayout.editor?.width > 240 && aiPanelLayout.editor?.height > 180, "AI strategy panel must leave a usable source editor");
    assert(aiPanelLayout.panel?.width > 220 && aiPanelLayout.panel?.height > 180, "AI strategy panel must remain visible and usable");
    assert(aiPanelLayout.panel && aiPanelLayout.panel.right <= aiPanelLayout.rootRight + 1, "AI strategy panel must remain inside the strategy workspace");
    await page.getByRole("button", { name: "Close AI strategy assistant" }).click();

    await page.locator(".systematic-strategy-lab__tabs button").nth(1).click();
    await page.waitForSelector(".systematic-lab-backtest-view", { timeout: 10_000 });
    const range = await page.locator(".systematic-lab-backtest-view input[type='datetime-local']").evaluateAll((inputs) => inputs.map((input) => input.value));
    assert(range.length === 2 && range[0] && range[1], "backtest default range must be filled");
    assert(Math.abs(new Date(range[1]).getTime() - new Date(range[0]).getTime() - 30 * 24 * 60 * 60 * 1000) < 1_000, "backtest default range must span 30 days");
    const leverageValues = await page.locator(".systematic-lab-backtest-view input[type='number']").evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
    assert(leverageValues.includes(10) && leverageValues.includes(1), "backtest must expose default leverage and margin safety multiplier");

    await page.locator(".systematic-strategy-lab__tabs button").nth(2).click();
    await page.waitForSelector(".systematic-lab-review-main", { timeout: 20_000 });
    const reviewLayout = await page.evaluate(() => {
      const sizeOf = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height } : null;
      };
      return {
        chart: sizeOf(".systematic-lab-replay-stage"),
        equity: sizeOf(".systematic-lab-equity-stage"),
        statistics: sizeOf(".systematic-lab-statistics-stage"),
        accountTabs: Array.from(document.querySelectorAll(".systematic-lab-account-tabs button")).map((button) => {
          const tabList = button.parentElement?.getBoundingClientRect();
          const rect = button.getBoundingClientRect();
          return { label: button.getAttribute("aria-label"), fits: Boolean(tabList) && rect.left >= tabList.left && rect.right <= tabList.right };
        }),
      };
    });
    assert(reviewLayout.chart?.height > 100, "replay chart must have visible height");
    assert(reviewLayout.equity?.height > 60, "equity chart must have visible height");
    assert(reviewLayout.statistics?.height > 80, "statistics panel must have visible height");
    assert(reviewLayout.accountTabs.length === 3, "replay must expose fill, current-position, and position-history tabs");
    assert(reviewLayout.accountTabs.every((tab) => tab.fits && tab.label), "replay account tabs must remain accessible and fit their pane");

    const actionsTrigger = page.getByRole("button", { name: "Actions: Multi-timeframe pullback" });
    assert(await actionsTrigger.count() === 1, "backtest rows should expose one Actions trigger");
    assert(await page.getByRole("menu", { name: "Actions: Multi-timeframe pullback" }).count() === 0, "backtest actions stay collapsed initially");
    await actionsTrigger.click();
    const actionsMenu = page.getByRole("menu", { name: "Actions: Multi-timeframe pullback" });
    await actionsMenu.waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".systematic-lab-run-row__actions-trigger")).fontSize === "9px", null, { timeout: 5_000 });
    assert(await actionsMenu.count() === 1, "backtest Actions menu should open on demand");
    assert(await actionsMenu.getByRole("menuitem").count() === 3, "completed backtests expose edit, compare, and delete actions");
    const actionsMenuLayout = await actionsMenu.evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      return {
        portaled: menu.parentElement === document.body,
        insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      };
    });
    assert(actionsMenuLayout.portaled && actionsMenuLayout.insideViewport, `backtest Actions menu must escape scroll clipping: ${JSON.stringify(actionsMenuLayout)}`);
    assert(await actionsTrigger.evaluate((button) => getComputedStyle(button).fontSize) === "9px", "backtest Actions trigger should use compact text");
    await page.locator(".systematic-lab-review-main__head").click();
    assert(await page.getByRole("menu", { name: "Actions: Multi-timeframe pullback" }).count() === 0, "backtest Actions menu should close on outside click");
    await actionsTrigger.click();
    assert(await page.getByRole("menu", { name: "Actions: Multi-timeframe pullback" }).count() === 1, "backtest Actions menu should reopen after outside click");
    await actionsTrigger.click();

    if (barCount > 96) {
      const replayPerformance = await page.evaluate(async () => {
        const slider = document.querySelector(".systematic-lab-replay-controls input[type='range']");
        if (!(slider instanceof HTMLInputElement)) throw new Error("replay slider is unavailable");
        const max = Number(slider.max);
        const values = [max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 1, max];
        const startedAt = performance.now();
        for (const value of values) {
          slider.value = String(value);
          slider.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        return {
          durationMs: performance.now() - startedAt,
          sliderMax: max,
          chartCandleCount: Number(document.querySelector(".systematic-lab-replay-stage .chart-wrap")?.getAttribute("data-candle-count") ?? 0),
          ledgerRows: document.querySelectorAll(".systematic-lab-virtual-list .systematic-lab-ledger-row").length,
          ledgerHeight: document.querySelector(".systematic-lab-virtual-list__spacer")?.getBoundingClientRect().height ?? 0,
        };
      });
      assert(replayPerformance.sliderMax === barCount, `month replay timeline must expose the complete backtest: ${JSON.stringify(replayPerformance)}`);
      assert(replayPerformance.chartCandleCount > 0 && replayPerformance.chartCandleCount <= replayBarLimit, `month replay chart page must remain bounded: ${JSON.stringify(replayPerformance)}`);
      assert(replayPerformance.ledgerRows > 0 && replayPerformance.ledgerRows <= 20, `month replay ledger must render only the visible rows: ${JSON.stringify(replayPerformance)}`);
      assert(replayPerformance.ledgerHeight > 100_000, `month replay must retain the full scrollable ledger: ${JSON.stringify(replayPerformance)}`);
      assert(replayPerformance.durationMs < 4_000, `month replay slider updates are too slow: ${JSON.stringify(replayPerformance)}`);
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const compactLayout = await page.evaluate(() => {
      const root = document.querySelector(".systematic-strategy-lab")?.getBoundingClientRect();
      const replay = document.querySelector(".systematic-lab-replay-stage")?.getBoundingClientRect();
      const tabList = document.querySelector(".systematic-lab-account-tabs")?.getBoundingClientRect();
      const tabs = Array.from(document.querySelectorAll(".systematic-lab-account-tabs button")).map((button) => button.getBoundingClientRect());
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rootHeight: root?.height ?? 0,
        replayHeight: replay?.height ?? 0,
        tabsFit: Boolean(tabList) && tabs.length === 3 && tabs.every((tab) => tab.left >= tabList.left && tab.right <= tabList.right),
      };
    });
    assert(compactLayout.documentOverflow <= 2, `compact systematic view has horizontal overflow: ${compactLayout.documentOverflow}`);
    assert(compactLayout.rootHeight > 400 && compactLayout.replayHeight > 100, "compact systematic review must preserve a usable replay chart");
    assert(compactLayout.tabsFit, "compact replay account tabs must fit their pane");

    await page.locator(".systematic-strategy-lab__tabs button").nth(0).click();
    await page.waitForSelector(".systematic-python-editor", { timeout: 10_000 });
    await page.getByRole("button", { name: "AI strategy assistant" }).click();
    const compactAiLayout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const root = rect(".systematic-lab-strategy-view");
      const editor = rect(".systematic-python-editor");
      const panel = rect(".systematic-lab-strategy-ai-panel");
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        editor: editor ? { width: editor.width, height: editor.height } : null,
        panel: panel ? { width: panel.width, height: panel.height, right: panel.right } : null,
        rootRight: root?.right ?? 0,
      };
    });
    assert(compactAiLayout.documentOverflow <= 2, `compact AI strategy panel has horizontal overflow: ${compactAiLayout.documentOverflow}`);
    assert(compactAiLayout.editor?.width > 220 && compactAiLayout.editor?.height > 150, "compact AI strategy panel must preserve a usable source editor");
    assert(compactAiLayout.panel?.width > 210 && compactAiLayout.panel?.height > 150, "compact AI strategy panel must remain usable");
    assert(compactAiLayout.panel && compactAiLayout.panel.right <= compactAiLayout.rootRight + 1, "compact AI strategy panel must remain inside the strategy workspace");
    await page.getByRole("button", { name: "Profiles" }).click();
    await page.getByRole("button", { name: "New Profile" }).click();
    await page.waitForSelector(".systematic-lab-field__hint", { timeout: 10_000 });
    const profileEstimate = await page.locator(".systematic-lab-field__hint").innerText();
    const profileLayout = await page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hintRight: document.querySelector(".systematic-lab-field__hint")?.getBoundingClientRect().right ?? 0,
      editorRight: document.querySelector(".systematic-lab-profile-editor")?.getBoundingClientRect().right ?? 0,
    }));
    assert(profileEstimate.includes("One contract is approximately 651.23 USDT"), `Profile one-contract estimate is incorrect: ${profileEstimate}`);
    assert(profileEstimate.includes("The host converts this to contracts at execution"), `Profile budget explanation is missing: ${profileEstimate}`);
    assert(profileLayout.documentOverflow <= 2 && profileLayout.hintRight <= profileLayout.editorRight + 1, `Profile estimate must fit its editor: ${JSON.stringify(profileLayout)}`);
    assert(errors.length === 0, `systematic preview raised errors: ${errors.join(" | ")}`);
    process.stdout.write(`[systematic-preview] ok: bars=${barCount}, tuning=9, range=30d, review-tabs=${reviewLayout.accountTabs.length}, compact=1280x720, ai-panel=visible, profile-estimate=visible\n`);
  } finally {
    await browser.close();
  }
}

await main();
