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
        && mergedAlgoOrders[0]?.ordPx === "-1"
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
  const normalTab = page.getByRole("button", { name: "普通委托(1)" });
  const algoTab = page.getByRole("button", { name: "策略委托(1)" });
  await normalTab.waitFor({ state: "visible", timeout: 5_000 });
  await algoTab.click();
  const strategyRows = page.locator(".table-row.algo-orders");
  assert(await strategyRows.count() === 1, `snapshot trigger order is not uniquely visible in strategy orders: ${await page.locator(".positions-table").innerText()}`);
  const strategyText = await strategyRows.first().innerText();
  assert(strategyText.includes("65,000") && strategyText.includes("市价"), `trigger strategy order prices are missing: ${strategyText}`);
  const triggerEditButton = strategyRows.first().getByRole("button", { name: "修改" });
  assert(await triggerEditButton.count() === 1, "trigger strategy order is missing its edit action");
  await triggerEditButton.click();
  const triggerEditDialog = page.getByRole("dialog", { name: "修改策略单" });
  await triggerEditDialog.waitFor({ state: "visible", timeout: 5_000 });
  const triggerEditText = await triggerEditDialog.innerText();
  const triggerInputs = await triggerEditDialog.locator("input").evaluateAll((nodes) => nodes.map((node) => node.value));
  assert(triggerEditText.includes("触发") && triggerEditText.includes("执行"), `trigger amend controls are missing: ${triggerEditText}`);
  assert(triggerInputs.includes("65000"), `trigger amend price was not initialized: ${JSON.stringify(triggerInputs)}`);
  assert(await triggerEditDialog.getByRole("button", { name: "市价", exact: true }).getAttribute("class").then((value) => value?.includes("active")), "trigger amend market execution mode was not restored");
  await triggerEditDialog.getByRole("button", { name: "关闭" }).click();
  await normalTab.click();
  assert(await page.locator(".table-row.orders").count() === 1, "trigger order leaked back into ordinary orders");
  const amendButton = page.getByRole("button", { name: "修改委托价格" });
  await amendButton.waitFor({ state: "visible", timeout: 5_000 });
  await amendButton.click();
  await page.waitForSelector(".chart-order-edit-modal", { timeout: 5_000 });
  const editInput = page.locator(".chart-order-edit-modal input").first();
  assert(await editInput.inputValue() === "63400", `amend dialog did not preserve order price: ${await editInput.inputValue()}`);
  assert(await page.getByRole("button", { name: "确认修改" }).isEnabled(), "demo order amendment action should be enabled");

  assert(pageErrors.length === 0, `preview raised page errors: ${JSON.stringify(pageErrors)}`);
  await browser.close();
  process.stdout.write(`[smoke] market/order consistency ok: ${JSON.stringify({ displayed, amendPrice: "63400" })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
