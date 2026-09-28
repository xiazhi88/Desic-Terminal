import { chromium } from "playwright";
import { buildReplayTheaterRun, detailPage } from "./replay-theater-fixture.mjs";
import { terrainFixture } from "./parameter-terrain-fixture.mjs";

const screenshotDir = process.env.DESIC_SYSTEMATIC_SCREENSHOT_DIR || "";
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
  // Replay theater: a deterministic run (25 rounds, partial exits, a losing streak and one
  // large winner) served page by page exactly like `systematic_backtest_detail`.
  const theater = buildReplayTheaterRun({ evaluationBars: barCount > 96 ? barCount : 1824 });
  const theaterRequests = [];
  data.overview.backtests = [theater.run];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("__desicTheaterDetail", (request) => {
      theaterRequests.push({ offset: request?.offset ?? null, limit: request?.limit ?? null });
      return detailPage(theater, request ?? {});
    });
    await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector(".workspace", { timeout: 30_000 });
    await page.evaluate(({ overview, detail, runtime, endAt: defaultEnd }) => {
      let callbackId = 1;
      window.__TAURI_INTERNALS__ = {
        transformCallback() { return callbackId++; },
        unregisterCallback() {},
        convertFileSrc(path) { return path; },
        async invoke(command, args) {
          if (command === "systematic_overview") return overview;
          if (command === "systematic_optimization_candidates") return window.__desicTerrainViews?.[args?.request?.optimizationId] ?? null;
          if (command === "systematic_backtest_detail") return window.__desicTheaterDetail(args?.request ?? {});
          if (command === "systematic_backtest_defaults") return { startAt: defaultEnd - 30 * 24 * 60 * 60 * 1000, endAt: defaultEnd };
          if (command === "systematic_python_prepare_environment") return runtime;
          if (command === "plugin:event|listen" || command === "plugin:event|unlisten") return 1;
          return null;
        },
      };
    }, { ...data, endAt });
    // Parameter terrain fixtures: one finished and one in-flight optimization run.
    const terrainDone = terrainFixture({ id: "optimization-fixture-done", strategyId: "strategy-fixture", instId: "BTC-USDT-SWAP", createdAt: endAt + 7_200_000 });
    const terrainLive = terrainFixture({ id: "optimization-fixture-live", strategyId: "strategy-fixture", instId: "BTC-USDT-SWAP", createdAt: endAt + 3_600_000, runningAt: 0.55 });
    await page.evaluate(({ views, optimizations }) => {
      window.__desicTerrainViews = views;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        const result = await invoke(command, args);
        return command === "systematic_overview" && result ? { ...result, optimizations } : result;
      };
    }, {
      views: { [terrainDone.optimization.id]: terrainDone, [terrainLive.optimization.id]: terrainLive },
      optimizations: [terrainDone.optimization, terrainLive.optimization],
    });

    await page.getByRole("button", { name: "Systematic Research" }).click();
    await page.waitForSelector(".systematic-strategy-lab", { timeout: 30_000 });
    const strategyLayout = await page.evaluate(() => {
      const documentOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const tuningLink = document.querySelector(".systematic-lab-strategy-inspector__tuning-link");
      const strategyList = document.querySelector(".systematic-lab-strategy-list__scroll");
      const firstStrategy = strategyList?.querySelector(".systematic-lab-strategy-row")?.getBoundingClientRect();
      const strategyListStyle = strategyList ? getComputedStyle(strategyList) : null;
      const strategySearchInput = document.querySelector(".systematic-lab-strategy-list__search input");
      const strategySearchStyle = strategySearchInput ? getComputedStyle(strategySearchInput) : null;
      return {
        documentOverflow,
        tuningLinkVisible: Boolean(tuningLink && tuningLink.getBoundingClientRect().width > 0),
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
    assert(strategyLayout.tuningLinkVisible, "strategy inspector must expose the tuning workbench entry point");
    assert(strategyLayout.strategySearchHasNoInnerFrame, "strategy search input must not paint an inner border over its wrapper");
    assert(strategyLayout.strategyListIsVertical, `desktop strategy rows must stay vertically stacked in the strategy list: ${JSON.stringify(strategyLayout)}`);

    await page.getByRole("button", { name: "Parameter optimization" }).click();
    await page.waitForSelector(".parameter-terrain .pt-side-scroll .pt-cd-head", { timeout: 10_000 });
    await page.waitForTimeout(400);
    const terrainPixels = () => page.evaluate(() => {
      const canvas = document.querySelector("[data-testid='terrain-canvas']");
      const context = canvas?.getContext("2d");
      if (!canvas || !context || canvas.width < 100 || canvas.height < 100) return { painted: 0, distinct: 0, warm: 0, hash: 0 };
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let painted = 0, warm = 0, hash = 0;
      const colors = new Set();
      for (let i = 0; i < data.length; i += 4 * 7) {
        if (data[i + 3] > 0) painted += 1;
        if (data[i] > data[i + 2] + 60 && data[i + 1] > data[i + 2] + 20) warm += 1;
        colors.add((data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4));
        hash = (hash * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
      }
      return { painted, distinct: colors.size, warm, hash };
    });
    const terrainBefore = await terrainPixels();
    assert(terrainBefore.painted > 20_000 && terrainBefore.distinct > 40, `parameter terrain canvas must be painted with a field: ${JSON.stringify(terrainBefore)}`);
    const terrainSelected = await page.locator(".pt-cd-head .id").innerText();
    assert(terrainSelected === "#57", `terrain must open on the best validation candidate: ${terrainSelected}`);
    assert(await page.locator(".pt-strip i").count() === 100, "terrain progress strip must show one cell per candidate");
    const hatch = page.getByTestId("terrain-hatch");
    await hatch.click();
    await page.waitForTimeout(150);
    const terrainHatched = await terrainPixels();
    assert(await hatch.getAttribute("aria-pressed") === "true", "overfit layer toggle must report its pressed state");
    assert(terrainHatched.hash !== terrainBefore.hash && terrainHatched.warm > terrainBefore.warm, `overfit layer must hatch the canvas in the warn colour: ${JSON.stringify({ terrainBefore, terrainHatched })}`);
    await hatch.click();
    await page.locator(".pt-strip i").nth(0).click();
    await page.waitForFunction(() => document.querySelector(".pt-cd-head .id")?.textContent === "#0", null, { timeout: 5_000 });
    const baselinePanel = await page.getByTestId("terrain-side").innerText();
    assert(/Baseline/.test(baselinePanel) && /train vs validation/i.test(baselinePanel), `selecting a candidate must update the side panel: ${baselinePanel.slice(0, 200)}`);
    const canvasBox = await page.getByTestId("terrain-canvas").boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.62, canvasBox.y + canvasBox.height * 0.55);
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.62 + 3, canvasBox.y + canvasBox.height * 0.55 + 2);
    await page.waitForSelector(".pt-tip.is-on", { timeout: 3_000 });
    await page.mouse.move(canvasBox.x + 4, canvasBox.y + 4);
    await page.locator(".pt-select--record .terminal-select-trigger").click();
    await page.getByRole("option").nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll(".pt-strip i.r").length > 0, null, { timeout: 5_000 });
    assert(await page.locator(".pt-badge.is-run").count() === 1, "an in-flight optimization must show the running badge");
    await page.getByRole("button", { name: "Configure tuning" }).click();
    await page.waitForSelector(".systematic-lab-tuning-view", { timeout: 10_000 });
    const tuningLayout = await page.evaluate(() => {
      const root = document.querySelector(".systematic-lab-tuning-view")?.getBoundingClientRect();
      const main = document.querySelector(".systematic-lab-tuning-main")?.getBoundingClientRect();
      const parameterRows = Array.from(document.querySelectorAll(".systematic-lab-tuning-parameter"));
      const budgets = Array.from(document.querySelectorAll(".systematic-lab-tuning-budget"));
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        workbenchVisible: Boolean(root && root.width > 600 && root.height > 300),
        parameterRows: parameterRows.length,
        selectedParameters: document.querySelectorAll(".systematic-lab-tuning-parameter.is-selected").length,
        budgetsFit: Boolean(main) && budgets.length === 3 && budgets.every((budget) => budget.getBoundingClientRect().right <= main.right + 1),
      };
    });
    assert(tuningLayout.documentOverflow <= 2, `tuning workbench has horizontal overflow: ${JSON.stringify(tuningLayout)}`);
    assert(tuningLayout.workbenchVisible, "parameter tuning workbench must occupy a usable canvas");
    assert(tuningLayout.parameterRows === 3 && tuningLayout.selectedParameters > 0, `tuning workbench must show numeric parameters and a default selection: ${JSON.stringify(tuningLayout)}`);
    assert(tuningLayout.budgetsFit, `tuning budgets must fit the workbench: ${JSON.stringify(tuningLayout)}`);

    await page.getByRole("button", { name: "Strategy" }).click();
    await page.waitForSelector(".systematic-python-editor", { timeout: 10_000 });
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

    await page.getByRole("button", { name: "Results & replay" }).click();
    await page.waitForSelector(".systematic-lab-review-main .rt canvas", { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll(".rt-row").length > 0, null, { timeout: 10_000 });
    await page.waitForTimeout(600);
    const theaterLayout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const canvas = document.querySelector(".rt-tracks canvas");
      let inkPixels = 0;
      let colours = 0;
      if (canvas instanceof HTMLCanvasElement) {
        const context = canvas.getContext("2d");
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const seen = new Set();
        for (let index = 0; index < pixels.length; index += 16) {
          if (pixels[index + 3] > 0) { inkPixels += 1; seen.add(`${pixels[index] >> 4}-${pixels[index + 1] >> 4}-${pixels[index + 2] >> 4}`); }
        }
        colours = seen.size;
        inkPixels /= pixels.length / 16;
      }
      const kpis = Array.from(document.querySelectorAll(".rt-kpi")).filter((kpi) => kpi.getBoundingClientRect().width > 0);
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tracks: rect(".rt-tracks"),
        side: rect(".rt-side"),
        oldBlocks: document.querySelectorAll(".systematic-lab-replay-stage, .systematic-lab-equity-stage, .systematic-lab-statistics-stage, .systematic-lab-trade-ledger").length,
        kpis: kpis.length,
        kpisTruncated: kpis.filter((kpi) => kpi.scrollWidth > kpi.clientWidth + 1).map((kpi) => kpi.textContent),
        calmarInferred: Boolean(document.querySelector(".rt-kpi__der")),
        rows: document.querySelectorAll(".rt-row").length,
        inkPixels,
        colours,
        hud: document.querySelector(".rt-hud")?.textContent ?? "",
        playheadClock: document.querySelector(".rt-clock__d")?.textContent ?? "",
      };
    });
    assert(theaterLayout.documentOverflow <= 2, `replay theater has horizontal overflow: ${JSON.stringify(theaterLayout)}`);
    assert(theaterLayout.oldBlocks === 0, "replay theater must replace the separate chart, equity, statistics and ledger blocks");
    assert(theaterLayout.tracks?.height > 300 && theaterLayout.tracks?.width > 500, `replay theater tracks must be usable: ${JSON.stringify(theaterLayout.tracks)}`);
    assert(theaterLayout.side?.width > 250, "replay theater must keep the trade card and round list");
    assert(theaterLayout.kpis >= 7 && theaterLayout.kpisTruncated.length === 0, `replay theater KPIs must be complete and untruncated: ${JSON.stringify(theaterLayout.kpisTruncated)}`);
    assert(theaterLayout.calmarInferred, "the frontend Calmar estimate must be labelled as inferred");
    assert(theaterLayout.rows === theater.rounds, `round list must show every round (${theaterLayout.rows} / ${theater.rounds})`);
    assert(theaterLayout.inkPixels > 0.08 && theaterLayout.colours > 12, `replay theater canvas is blank: ${theaterLayout.inkPixels} / ${theaterLayout.colours}`);
    assert(theaterLayout.hud.length > 10 && theaterLayout.playheadClock.length > 5, "replay theater HUD and clock must render");
    assert(theaterRequests.some((request) => request.limit === 5_000 && (barCount > 96 || request.offset === 0)), `replay theater must lazily load the uncovered page: ${JSON.stringify(theaterRequests)}`);

    await page.locator('.rt-row[data-round="7"]').click();
    await page.waitForFunction(() => document.querySelector(".rt-card__id")?.textContent === "#07", null, { timeout: 5_000 });
    const selection = await page.evaluate(() => ({
      selectedRows: Array.from(document.querySelectorAll(".rt-row.is-sel")).map((row) => row.getAttribute("data-round")),
      fills: document.querySelectorAll(".rt-fl > span").length / 5,
      actions: document.querySelectorAll(".rt-act").length,
    }));
    assert(selection.selectedRows.length === 1 && selection.selectedRows[0] === "7", `clicking a round must select it in the list: ${JSON.stringify(selection)}`);
    assert(selection.fills >= 2 && selection.actions >= 1, `selected trade card must list its fills and strategy actions: ${JSON.stringify(selection)}`);
    await page.locator(".rt-act").first().click();
    const afterActionSeek = await page.locator(".rt-clock__d").textContent();
    assert(afterActionSeek && afterActionSeek !== theaterLayout.playheadClock, "clicking a numbered action must move the playhead");
    await page.locator(".rt-list-h").getByRole("button", { name: "Wins", exact: true }).click();
    const winRows = await page.evaluate(() => Array.from(document.querySelectorAll(".rt-row .rt-row__pn > span")).map((cell) => cell.className));
    assert(winRows.length > 0 && winRows.length < theater.rounds && winRows.every((name) => name.includes("is-pos")), `win filter must keep only profitable rounds: ${JSON.stringify(winRows)}`);
    await page.locator(".rt-list-h").getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: "Clear selection (Esc)" }).click();
    assert(await page.locator(".rt-row.is-sel").count() === 0, "closing the trade card must clear the selection");

    const clockBefore = await page.locator(".rt-clock__d").textContent();
    await page.locator(".rt-play").click();
    await page.waitForTimeout(900);
    const clockAfter = await page.locator(".rt-clock__d").textContent();
    await page.locator(".rt-play").click();
    assert(clockBefore !== clockAfter, `play must advance the playhead: ${clockBefore} -> ${clockAfter}`);

    // 回放剧场模式下回测记录收在左侧抽屉里：默认收起、不占剧场宽度，标题栏按钮开合。
    const runDrawer = page.locator(".systematic-lab-review-view.is-theater > .systematic-lab-run-list");
    const drawerClosedState = await runDrawer.evaluate((node) => ({ visibility: getComputedStyle(node).visibility, hidden: node.getAttribute("aria-hidden") }));
    assert(drawerClosedState.visibility === "hidden" && drawerClosedState.hidden === "true", `backtest run drawer must start collapsed in theater mode: ${JSON.stringify(drawerClosedState)}`);
    const headHeight = await page.locator(".systematic-lab-review-main__head").evaluate((node) => node.getBoundingClientRect().height);
    assert(headHeight <= 42, `theater result head must be a single compact row: ${headHeight}`);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/theater-${barCount}.png` });
    await page.locator(".systematic-lab-run-drawer-toggle").click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".systematic-lab-review-view.is-theater > .systematic-lab-run-list")).visibility === "visible", null, { timeout: 5_000 });
    if (screenshotDir) { await page.waitForTimeout(260); await page.screenshot({ path: `${screenshotDir}/theater-drawer-${barCount}.png` }); }

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
    await page.locator(".systematic-lab-run-list .systematic-lab__pane-head").click();
    assert(await page.getByRole("menu", { name: "Actions: Multi-timeframe pullback" }).count() === 0, "backtest Actions menu should close on outside click");
    await actionsTrigger.click();
    assert(await page.getByRole("menu", { name: "Actions: Multi-timeframe pullback" }).count() === 1, "backtest Actions menu should reopen after outside click");
    await actionsTrigger.click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".systematic-lab-review-view.is-theater > .systematic-lab-run-list")).visibility === "hidden", null, { timeout: 5_000 });
    // 最高档 4K 根/秒：播放头应在 1 秒内推进数千根。
    await page.locator(".rt-transport .rt-seg button").last().click();
    const evaluatedBars = async () => {
      const label = await page.locator(".rt-clock__s").textContent();
      const match = /([\d,]+)\s*\//.exec(label ?? "");
      return match ? Number(match[1].replace(/,/g, "")) : null;
    };
    const fastBefore = await evaluatedBars();
    await page.locator(".rt-play").click();
    await page.waitForTimeout(1_000);
    const fastAfter = await evaluatedBars();
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/theater-fast-${barCount}.png` });
    await page.locator(".rt-play").click();
    if (fastBefore !== null && fastAfter !== null && barCount > 96) {
      assert(fastAfter - fastBefore > 1_500, `4K bars/s playback must advance quickly: ${fastBefore} -> ${fastAfter}`);
    }
    await page.locator(".rt-transport .rt-seg button").nth(1).click();

    if (barCount > 96) {
      // A long run must page lazily: the full-range view loads every page in view,
      // bounded at the backend page size, without blocking the timeline.
      await page.waitForFunction((expected) => document.querySelectorAll(".rt-row").length === expected, theater.rounds, { timeout: 20_000 });
      const pages = Math.ceil(barCount / 5_000);
      const startedAt = Date.now();
      while (new Set(theaterRequests.filter((request) => request.limit === 5_000).map((request) => request.offset)).size < pages && Date.now() - startedAt < 30_000) {
        await page.waitForTimeout(250);
      }
      const offsets = new Set(theaterRequests.filter((request) => request.limit === 5_000).map((request) => request.offset));
      assert(offsets.size >= pages, `month replay theater must load every page in the full view: ${offsets.size}/${pages}`);
      assert(theaterRequests.every((request) => request.limit === null || request.limit <= 5_000), "replay pages must stay bounded");
      const frameStats = await page.evaluate(async () => {
        document.querySelector(".rt-play")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const times = [];
        let last = performance.now();
        for (let index = 0; index < 60; index += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const now = performance.now();
          times.push(now - last);
          last = now;
        }
        document.querySelector(".rt-play")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        times.sort((a, b) => a - b);
        return { median: times[30], p90: times[54] };
      });
      assert(frameStats.median < 50, `month replay playback must stay smooth: ${JSON.stringify(frameStats)}`);
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const compactLayout = await page.evaluate(() => {
      const root = document.querySelector(".systematic-strategy-lab")?.getBoundingClientRect();
      const replay = document.querySelector(".rt-tracks")?.getBoundingClientRect();
      const side = document.querySelector(".rt-side")?.getBoundingClientRect();
      const kpis = Array.from(document.querySelectorAll(".rt-kpi")).filter((kpi) => kpi.getBoundingClientRect().width > 0);
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rootHeight: root?.height ?? 0,
        replayHeight: replay?.height ?? 0,
        tabsFit: Boolean(side && side.width > 240) && kpis.length >= 7 && kpis.every((kpi) => kpi.scrollWidth <= kpi.clientWidth + 1),
        truncated: kpis.filter((kpi) => kpi.scrollWidth > kpi.clientWidth + 1).map((kpi) => `${kpi.textContent} (${kpi.scrollWidth}/${kpi.clientWidth})`),
      };
    });
    assert(compactLayout.documentOverflow <= 2, `compact systematic view has horizontal overflow: ${compactLayout.documentOverflow}`);
    assert(compactLayout.rootHeight > 400 && compactLayout.replayHeight > 100, "compact systematic review must preserve a usable replay chart");
    assert(compactLayout.tabsFit, `compact replay theater must keep the trade list and untruncated KPIs: ${JSON.stringify(compactLayout.truncated)}`);

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
    process.stdout.write(`[systematic-preview] ok: bars=${barCount}, tuning=workbench+terrain, range=30d, theater-rounds=${theaterLayout.rows}, theater-pages=${new Set(theaterRequests.map((request) => request.offset)).size}, compact=1280x720, ai-panel=visible, profile-estimate=visible\n`);
  } finally {
    await browser.close();
  }
}

await main();
