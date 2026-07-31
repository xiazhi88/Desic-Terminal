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
    return {
      tickerLast: next.ticker?.last,
      tickerTs: next.ticker?.ts,
      bookTs: next.book?.ts,
      latestTrade: next.trades[0]?.px,
      candleClose: patched.at(-1)?.close,
      tickerAdvancedByTrade: next.ticker?.ts === now + 10,
      bookRejectedOlderSnapshot: next.book?.ts === now
    };
  });

  assert(storeResult.tickerLast === "65123.4", `latest trade did not become canonical ticker: ${JSON.stringify(storeResult)}`);
  assert(storeResult.latestTrade === "65123.4", `latest trade ordering regressed: ${JSON.stringify(storeResult)}`);
  assert(storeResult.candleClose === 65123.4, `live candle close did not follow canonical price: ${JSON.stringify(storeResult)}`);
  assert(storeResult.tickerAdvancedByTrade, `newer trade timestamp did not win: ${JSON.stringify(storeResult)}`);
  assert(storeResult.bookRejectedOlderSnapshot, `older order-book snapshot overwrote current depth: ${JSON.stringify(storeResult)}`);

  await page.waitForTimeout(500);

  const displayed = await page.evaluate(() => ({
    top: document.querySelector(".price-strip > strong")?.textContent,
    middle: document.querySelector(".mid-price")?.getAttribute("data-market-price"),
    recent: document.querySelector(".recent-trades .trade-row:not([hidden]) span")?.textContent,
    chart: document.querySelector(".ohlc-summary > span")?.textContent
  }));
  for (const [surface, value] of Object.entries(displayed)) {
    assert(numericText(value) === 65123.4, `${surface} price is inconsistent: ${JSON.stringify(displayed)}`);
  }

  await page.getByRole("button", { name: /^当前委托\(/ }).click();
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
