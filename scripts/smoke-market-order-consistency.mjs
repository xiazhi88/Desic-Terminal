import { chromium } from "playwright";

const baseUrl = process.env.DESIC_MARKET_ORDER_PREVIEW_URL
  || "http://127.0.0.1:1420/terminal-preview?accounts=demo&pendingOrder=1&marketConsistency=1";

const marketAssetsSeed = {
  cacheDir: "cache/market-assets",
  instruments: [{
    instId: "BTC-USDT-SWAP",
    instType: "SWAP",
    state: "live",
    settleCcy: "USDT",
    baseCcy: "BTC",
    instFamily: "BTC-USDT",
    tickSz: "0.1",
    lotSz: "0.01",
    minSz: "0.01",
    maxLmtSz: "100000",
    maxMktSz: "100000",
    ctVal: "0.01",
    lever: "100",
    iconCached: false
  }]
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function numericText(value) {
  return Number(String(value || "").replaceAll(",", "").match(/[\d.]+/)?.[0] || Number.NaN);
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  await page.route("**/cache/market-assets/swap-instruments.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(marketAssetsSeed)
  }));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });
  await page.waitForFunction(() => Number(document.querySelector(".chart-wrap")?.getAttribute("data-candle-count") || 0) > 0, null, { timeout: 10_000 });

  const storeResult = await page.evaluate(async () => {
    const market = await import("/src/lib/marketHotStore.ts");
    const orderClassification = await import("/src/lib/pendingOrderClassification.ts");
    const current = market.getMarketHotState();
    const now = Date.now();
    const candleTime = Math.floor(now / 1_000 / 1_800) * 1_800;
    const fixtureCandles = current.candles.length > 0 ? current.candles : [
      { time: candleTime - 1_800, open: 64_800, high: 65_050, low: 64_700, close: 64_950, volume: 120, confirm: true },
      { time: candleTime, open: 64_950, high: 65_050, low: 64_900, close: 65_000, volume: 90, confirm: false }
    ];
    const lastCandle = fixtureCandles.at(-1);
    const ticker = current.ticker ?? {
      instId: "BTC-USDT-SWAP",
      last: "65000",
      lastSz: "0.01",
      askPx: "65000.1",
      askSz: "1",
      bidPx: "64999.9",
      bidSz: "1",
      open24h: "64000",
      high24h: "66000",
      low24h: "63000",
      vol24h: "1000",
      volCcy24h: "65000000",
      ts: now - 1_000
    };
    const book = current.book ?? {
      asks: Array.from({ length: 8 }, (_, index) => ({ px: String(65124 + index / 10), sz: String(index + 1) })),
      bids: Array.from({ length: 8 }, (_, index) => ({ px: String(65122.9 - index / 10), sz: String(index + 1) })),
      ts: now - 1_000,
      seqId: "preview-book"
    };

    market.replaceMarketCandles([
      ...fixtureCandles.slice(0, -1),
      { ...lastCandle, close: 65_000, high: Math.max(lastCandle.high, 65_000), low: Math.min(lastCandle.low, 65_000), confirm: false }
    ]);
    market.hydrateMarketHotState({
      ticker: { ...ticker, last: "65120.0", ts: now },
      book: { ...book, ts: now },
      trades: [{ instId: "BTC-USDT-SWAP", tradeId: "consistency-latest", px: "65123.4", sz: "0.25", side: "buy", ts: now + 10 }]
    });
    market.queueMarketTicker({ ...ticker, last: "64000.0", ts: now - 100 });
    market.queueOrderBook({ ...book, ts: now - 100 });
    market.flushMarketFrame();

    const next = market.getMarketHotState();
    const patched = market.applyLivePriceToLatestCandle(next.candles, next.ticker?.last);
    const historyCurrent = Array.from({ length: 2_000 }, (_, index) => ({
      time: 10_000 + index,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      confirm: true
    }));
    const historyOlder = Array.from({ length: 300 }, (_, index) => ({
      ...historyCurrent[0],
      time: 9_700 + index
    }));
    const mergedHistory = market.mergeMarketCandles(historyCurrent, historyOlder);
    const snapshotTriggerOrder = {
      instId: "BTC-USDT-SWAP",
      instType: "SWAP",
      ordId: "algo-trigger-1",
      clOrdId: "",
      algoId: "algo-trigger-1",
      algoClOrdId: "",
      isAlgo: true,
      side: "buy",
      posSide: "long",
      tdMode: "cross",
      ordType: "trigger",
      px: "",
      triggerPx: "65000",
      triggerPxType: "last",
      ordPx: "-1",
      sz: "1",
      accFillSz: "0",
      avgPx: "",
      state: "live",
      lever: "20",
      reduceOnly: "false",
      cTime: "1",
      uTime: "1"
    };
    const mergedAlgoOrders = orderClassification.mergePendingAlgoOrders([], [snapshotTriggerOrder], "account-1", "demo");
    const stopLossPurpose = orderClassification.classifyAlgoTriggerPurpose(
      { instId: "BTC-USDT-SWAP", ordType: "trigger", side: "sell", posSide: "long", reduceOnly: "false", triggerPx: "63100" },
      [{ instId: "BTC-USDT-SWAP", posSide: "long", pos: "0.04", markPx: "63625", avgPx: "63550" }]
    );
    const entryPurpose = orderClassification.classifyAlgoTriggerPurpose(
      { instId: "ETH-USDT-SWAP", ordType: "trigger", side: "buy", posSide: "long", reduceOnly: "false", triggerPx: "1912.5" },
      []
    );
    const orderGroups = {
      limit: orderClassification.classifyOrdinaryPendingOrderGroup("limit"),
      advanced: orderClassification.classifyOrdinaryPendingOrderGroup("post_only"),
      takeProfitStopLoss: orderClassification.classifyAlgoPendingOrderGroup("oco"),
      trailing: orderClassification.classifyAlgoPendingOrderGroup("move_order_stop"),
      planned: orderClassification.classifyAlgoPendingOrderGroup("trigger"),
      other: orderClassification.classifyAlgoPendingOrderGroup("twap")
    };
    return {
      tickerLast: next.ticker?.last,
      tickerTs: next.ticker?.ts,
      bookTs: next.book?.ts,
      latestTrade: next.trades[0]?.px,
      candleClose: patched.at(-1)?.close,
      tickerAdvancedByTrade: next.ticker?.ts === now + 10,
      bookRejectedOlderSnapshot: next.book?.ts === now,
      mergedHistoryCount: mergedHistory.length,
      mergedHistoryFirstTime: mergedHistory[0]?.time,
      ordinaryLimitClassified: orderClassification.isOrdinaryPendingOrder({ isAlgo: false, algoId: "", algoClOrdId: "", ordType: "limit" }),
      explicitAlgoExcluded: !orderClassification.isOrdinaryPendingOrder({ isAlgo: true, algoId: "algo-1", algoClOrdId: "", ordType: "trigger" }),
      legacyTriggerExcluded: !orderClassification.isOrdinaryPendingOrder({ isAlgo: false, algoId: "", algoClOrdId: "", ordType: "trigger" }),
      snapshotTriggerMerged: mergedAlgoOrders.length === 1
        && mergedAlgoOrders[0]?.algoId === "algo-trigger-1"
        && mergedAlgoOrders[0]?.triggerPx === "65000"
        && mergedAlgoOrders[0]?.ordPx === "-1",
      stopLossPurpose,
      entryPurpose,
      orderGroups
    };
  });

  assert(storeResult.tickerLast === "65123.4", `latest trade did not become canonical ticker: ${JSON.stringify(storeResult)}`);
  assert(storeResult.latestTrade === "65123.4", `latest trade ordering regressed: ${JSON.stringify(storeResult)}`);
  assert(storeResult.candleClose === 65123.4, `live candle close did not follow canonical price: ${JSON.stringify(storeResult)}`);
  assert(storeResult.tickerAdvancedByTrade, `newer trade timestamp did not win: ${JSON.stringify(storeResult)}`);
  assert(storeResult.bookRejectedOlderSnapshot, `older order-book snapshot overwrote current depth: ${JSON.stringify(storeResult)}`);
  assert(storeResult.mergedHistoryCount === 2_300 && storeResult.mergedHistoryFirstTime === 9_700,
    `historical prepend was discarded at the previous 2,000-candle boundary: ${JSON.stringify(storeResult)}`);
  assert(storeResult.ordinaryLimitClassified && storeResult.explicitAlgoExcluded && storeResult.legacyTriggerExcluded,
    `ordinary/algo pending-order classification regressed: ${JSON.stringify(storeResult)}`);
  assert(storeResult.snapshotTriggerMerged,
    `snapshot trigger order was not merged into the strategy-order source: ${JSON.stringify(storeResult)}`);
  assert(storeResult.stopLossPurpose === "stopLoss" && storeResult.entryPurpose === "entry",
    `trigger-order purpose classification regressed: ${JSON.stringify(storeResult)}`);
  assert(JSON.stringify(storeResult.orderGroups) === JSON.stringify({
    limit: "limitMarket", advanced: "advancedLimit", takeProfitStopLoss: "takeProfitStopLoss",
    trailing: "trailing", planned: "planned", other: "other"
  }), `open-order tab classification regressed: ${JSON.stringify(storeResult)}`);

  await page.waitForTimeout(500);

  const displayed = await page.evaluate(() => ({
    top: document.querySelector(".price-strip-values > strong")?.textContent,
    middle: document.querySelector(".mid-price")?.getAttribute("data-market-price"),
    recent: document.querySelector(".recent-trades .trade-row:not([hidden]) span")?.textContent,
    chart: document.querySelector(".ohlc-summary > span")?.textContent
  }));
  for (const [surface, value] of Object.entries(displayed)) {
    assert(numericText(value) === 65123.4, `${surface} price is inconsistent: ${JSON.stringify(displayed)}`);
  }

  await page.getByRole("button", { name: /^当前委托\(/ }).click();
  const orderTypeTabs = page.getByRole("tablist", { name: "当前委托类型" });
  const limitMarketTab = orderTypeTabs.getByRole("tab", { name: "限价 | 市价(1)", exact: true });
  const plannedTab = orderTypeTabs.getByRole("tab", { name: "计划委托(2)", exact: true });
  for (const label of ["高级限价委托", "止盈止损", "移动止盈止损"]) {
    assert(await orderTypeTabs.getByRole("tab", { name: label, exact: true }).count() === 1, `missing open-order type tab: ${label}`);
  }
  assert(await orderTypeTabs.getByRole("tab", { name: "其他策略", exact: true }).count() === 0, "empty fallback strategy tab should stay hidden");
  await limitMarketTab.waitFor({ state: "visible", timeout: 5_000 });
  assert(await limitMarketTab.getAttribute("aria-selected") === "true", "limit/market tab should be selected by default");
  await plannedTab.click();
  assert(await plannedTab.getAttribute("aria-selected") === "true", "planned orders did not switch to their dedicated tab");
  const strategyRows = page.locator(".table-row.algo-orders");
  assert(await strategyRows.count() === 2, `snapshot trigger orders are not uniquely visible in strategy orders: ${await page.locator(".positions-table").innerText()}`);
  const stopLossRow = strategyRows.filter({ hasText: "BTC-USDT-SWAP" });
  const entryRow = strategyRows.filter({ hasText: "ETH-USDT-SWAP" });
  assert(await stopLossRow.getAttribute("data-trigger-purpose") === "stopLoss", `protective close was not classified as stop loss: ${await stopLossRow.innerText()}`);
  assert(await entryRow.getAttribute("data-trigger-purpose") === "entry", `entry trigger was not classified as entry: ${await entryRow.innerText()}`);
  const stopLossCells = await stopLossRow.locator(":scope > span").allTextContents();
  const entryCells = await entryRow.locator(":scope > span").allTextContents();
  assert(stopLossCells[4]?.trim().startsWith("--") && stopLossCells[5]?.includes("63,100") && stopLossCells[5]?.includes("止损") && stopLossCells[5]?.includes("市价"),
    `protective close trigger rendered in the wrong strategy-price field: ${JSON.stringify(stopLossCells)}`);
  assert(entryCells[4]?.includes("1,912.5") && entryCells[5]?.includes("市价") && !entryCells[4]?.includes("止盈") && !entryCells[5]?.includes("止损"),
    `entry trigger inherited take-profit/stop-loss semantics: ${JSON.stringify(entryCells)}`);
  const triggerEditButton = entryRow.getByRole("button", { name: "修改" });
  assert(await triggerEditButton.count() === 1, "trigger strategy order is missing its edit action");
  await triggerEditButton.click();
  const triggerEditDialog = page.getByRole("dialog", { name: "修改策略单" });
  await triggerEditDialog.waitFor({ state: "visible", timeout: 5_000 });
  const triggerEditText = await triggerEditDialog.innerText();
  const triggerInputs = await triggerEditDialog.locator("input").evaluateAll((nodes) => nodes.map((node) => node.value));
  assert(triggerEditText.includes("触发") && triggerEditText.includes("执行"), `trigger amend controls are missing: ${triggerEditText}`);
  assert(triggerInputs.includes("1912.5"), `trigger amend price was not initialized: ${JSON.stringify(triggerInputs)}`);
  assert(await triggerEditDialog.getByRole("button", { name: "市价", exact: true }).getAttribute("class").then((value) => value?.includes("active")), "trigger amend market execution mode was not restored");
  await triggerEditDialog.getByRole("button", { name: "关闭" }).click();
  await limitMarketTab.click();
  assert(await page.locator(".table-row.orders").count() === 1, "trigger order leaked back into ordinary orders");
  const amendButton = page.getByRole("button", { name: "修改委托价格" });
  await amendButton.waitFor({ state: "visible", timeout: 5_000 });
  await amendButton.click();
  await page.waitForSelector(".chart-order-edit-modal", { timeout: 5_000 });
  const editInput = page.locator(".chart-order-edit-modal input").first();
  assert(await editInput.inputValue() === "63400", `amend dialog did not preserve order price: ${await editInput.inputValue()}`);
  assert(await page.getByRole("button", { name: "确认修改" }).isEnabled(), "demo order amendment action should be enabled");
  await page.keyboard.press("Escape");
  await page.locator(".chart-order-edit-modal").waitFor({ state: "hidden", timeout: 5_000 });

  await page.locator(".bottom-tabs").getByRole("button", { name: "历史委托", exact: true }).click();
  const historicalOrderTypeTabs = page.getByRole("tablist", { name: "历史委托类型" });
  for (const label of ["限价 | 市价", "高级限价委托", "止盈止损", "移动止盈止损", "计划委托"]) {
    assert(await historicalOrderTypeTabs.getByRole("tab", { name: label, exact: true }).count() === 1, `missing historical order type tab: ${label}`);
  }
  const historicalPlannedTab = historicalOrderTypeTabs.getByRole("tab", { name: "计划委托", exact: true });
  await historicalPlannedTab.click();
  assert(await historicalPlannedTab.getAttribute("aria-selected") === "true", "historical planned orders did not switch to their dedicated tab");
  assert((await page.locator(".positions-table").innerText()).includes("当前没有计划委托"), "empty historical planned-order state is missing");

  assert(pageErrors.length === 0, `preview raised page errors: ${JSON.stringify(pageErrors)}`);
  await browser.close();
  process.stdout.write(`[smoke] market/order consistency ok: ${JSON.stringify({ displayed, amendPrice: "63400" })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
