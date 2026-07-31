import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const baseUrl = process.env.DESIC_INTELLIGENCE_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview?accounts=demo";
const marketAssetsSeed = {
  cacheDir: "cache/market-assets",
  instruments: [
    { instId: "BTC-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "BTC", instFamily: "BTC-USDT", iconPath: "cache/market-assets/icons/BTC.png", iconCached: true },
    { instId: "ETH-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "ETH", instFamily: "ETH-USDT", iconPath: "cache/market-assets/icons/ETH.png", iconCached: true },
    { instId: "XRP-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "XRP", instFamily: "XRP-USDT", iconPath: "cache/market-assets/icons/XRP.png", iconCached: true },
    { instId: "USDC-USDS-SWAP", instType: "SWAP", state: "live", settleCcy: "USDS", baseCcy: "USDC", instFamily: "USDC-USDS", iconPath: "cache/market-assets/icons/USDC.png", iconCached: true }
  ]
};

async function verifyViewport(browser, width, height, label) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/cache/market-assets/swap-instruments.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(marketAssetsSeed)
  }));
  await page.route("**/cache/market-assets/icons/*.png", async (route) => {
    const body = await readFile(path.resolve("src-tauri", "icons", "32x32.png"));
    await route.fulfill({ status: 200, contentType: "image/png", body });
  });

  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByRole("button", { name: "市场情报" }).click();
  await page.waitForSelector(".intelligence-page", { timeout: 20_000 });

  const title = await page.title();
  if (!title) throw new Error(`${label}: page title missing`);
  if (!(await page.getByText("市场情报", { exact: true }).count())) throw new Error(`${label}: market intelligence identity missing`);
  if ((await page.locator(".intelligence-feed > button").count()) !== 4) throw new Error(`${label}: all-news filter omitted preview events`);
  if (!(await page.getByText("单源跟踪", { exact: true }).count())) throw new Error(`${label}: single-source event status is not explained`);
  const importanceSelect = page.getByRole("combobox", { name: "新闻重要程度", exact: true });
  if (await importanceSelect.getAttribute("data-value") !== "all") throw new Error(`${label}: all-news filter is not the default`);
  await importanceSelect.click();
  await page.locator('[role="option"][data-value="high"]').click();
  await page.locator(".intelligence-toolbar").getByRole("button", { name: "查询" }).click();
  if ((await page.locator(".intelligence-feed > button").count()) !== 3 || await page.getByText("ETH 链上活跃度连续三日改善", { exact: true }).count()) {
    throw new Error(`${label}: important-news filter did not exclude low-importance events`);
  }
  await importanceSelect.click();
  await page.locator('[role="option"][data-value="all"]').click();
  await page.locator(".intelligence-toolbar").getByRole("button", { name: "查询" }).click();
  if ((await page.locator(".intelligence-feed > button").count()) !== 4) throw new Error(`${label}: all-news filter did not restore every event`);

  const accountSelect = page.getByRole("combobox", { name: "情报账户", exact: true });
  await accountSelect.click();
  await page.locator('[role="option"][data-value="preview-okx-research"]').click();
  if (await accountSelect.getAttribute("data-value") !== "preview-okx-research") throw new Error(`${label}: account switch did not persist`);
  if (await page.locator("select").count()) throw new Error(`${label}: native select must not be rendered`);

  await page.locator(".intelligence-feed > button").first().click();
  await page.waitForSelector(".intelligence-detail-pane h2", { timeout: 5_000 });
  if (!(await page.getByText("覆盖 2/3 个币种", { exact: true }).count())) throw new Error(`${label}: multi-coin reaction coverage missing`);
  if (!(await page.getByText("未覆盖 NVDA", { exact: true }).count())) throw new Error(`${label}: unsupported reaction coin missing`);
  await page.getByRole("tab", { name: "ETH", exact: true }).click();
  if (!(await page.getByText("+0.11%", { exact: true }).count())) throw new Error(`${label}: per-coin ETH reaction missing`);
  const newsScreenshot = path.join(os.tmpdir(), `desic-intelligence-${label}-news.png`);
  await page.screenshot({ path: newsScreenshot, fullPage: false });
  if (await page.getByText("交给 AI 分析", { exact: true }).count() || await page.locator('[title="交给 AI 分析"]').count()) {
    throw new Error(`${label}: removed AI analysis entry is still visible`);
  }
  await page.locator(".intelligence-feed > button", { hasText: "全球风险资产波动加剧" }).click();
  if (!(await page.getByText("BTC 市场代理", { exact: true }).count())) throw new Error(`${label}: all-market BTC proxy label missing`);

  await page.getByRole("button", { name: /情绪与宏观/ }).click();
  if (!(await page.getByText("经济日历", { exact: true }).count())) throw new Error(`${label}: calendar tab did not render`);
  if ((await page.locator(".intelligence-calendar-week-day").count()) !== 7) throw new Error(`${label}: week calendar must render seven days by default`);
  if (!(await page.locator(".intelligence-calendar-event-table").count())) throw new Error(`${label}: calendar agenda table missing`);
  if ((await page.locator(".intelligence-sentiment-grid .symbol-label").count()) < 3) throw new Error(`${label}: sentiment symbols are missing icons`);
  const weekEventDay = page.locator(".intelligence-calendar-week-day").filter({ has: page.locator("i:not(:empty)") }).first();
  await weekEventDay.click();
  if (!(await page.locator(".intelligence-calendar-event-table tbody tr").count())) throw new Error(`${label}: week calendar did not reveal the selected day's events`);
  const importantToggle = page.getByRole("checkbox", { name: "仅显示重要事件" });
  await importantToggle.check();
  if (!(await importantToggle.isChecked())) throw new Error(`${label}: important-event filter did not activate`);
  await importantToggle.uncheck();
  const weekCalendarScreenshot = path.join(os.tmpdir(), `desic-intelligence-${label}-calendar-week.png`);
  await page.screenshot({ path: weekCalendarScreenshot, fullPage: false });
  await page.getByRole("group", { name: "经济日历视图" }).getByRole("button", { name: "月历", exact: true }).click();
  if ((await page.locator(".intelligence-calendar-day").count()) !== 42) throw new Error(`${label}: month calendar must render a stable 6-week grid`);
  const eventDay = page.locator(".intelligence-calendar-day").filter({ has: page.locator("b") }).first();
  await eventDay.hover();
  if (!(await page.locator(".intelligence-calendar-event-table tbody tr").count())) throw new Error(`${label}: calendar hover preview did not reveal events`);
  const hoveredDayLabel = await eventDay.getAttribute("aria-label");
  await eventDay.click();
  await page.mouse.move(2, 2);
  if (!(await eventDay.getAttribute("aria-pressed") === "true") || !(await page.locator(".intelligence-calendar-event-table tbody tr").count())) {
    throw new Error(`${label}: calendar click did not pin the selected day (${hoveredDayLabel})`);
  }
  const monthHeading = await page.locator(".intelligence-calendar-period-title").textContent();
  await page.getByRole("button", { name: "下个月" }).click();
  if ((await page.locator(".intelligence-calendar-period-title").textContent()) === monthHeading) throw new Error(`${label}: calendar month navigation did not update`);
  await page.getByRole("button", { name: "上个月" }).click();
  const sentimentScreenshot = path.join(os.tmpdir(), `desic-intelligence-${label}-sentiment.png`);
  await page.screenshot({ path: sentimentScreenshot, fullPage: false });
  await page.getByRole("button", { name: /衍生品/ }).click();
  const derivativesSearch = page.getByRole("textbox", { name: "搜索衍生品交易对" });
  await derivativesSearch.fill("");
  const visibleOptionIcons = page.locator(".intelligence-symbol-menu [role='option'] .symbol-icon img");
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(".intelligence-symbol-menu [role='option'] .symbol-icon img")];
    return images.length >= 3 && images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0);
  }, { timeout: 5_000 });
  if ((await visibleOptionIcons.count()) < 3) throw new Error(`${label}: derivatives dropdown icons missing`);
  const symbolMenuScreenshot = path.join(os.tmpdir(), `desic-intelligence-${label}-symbol-menu.png`);
  await page.screenshot({ path: symbolMenuScreenshot, fullPage: false });
  await derivativesSearch.fill("XRP");
  const xrpOption = page.getByRole("option", { name: /XRP-USDT-SWAP/ });
  const xrpIcon = xrpOption.locator(".symbol-icon img");
  await xrpIcon.waitFor({ state: "visible", timeout: 5_000 });
  if (!(await xrpIcon.evaluate((image) => image.complete && image.naturalWidth > 0))) throw new Error(`${label}: derivatives option icon did not load`);
  await xrpOption.click();
  if (await derivativesSearch.inputValue() !== "XRP-USDT-SWAP") throw new Error(`${label}: derivatives symbol search did not select XRP`);
  const selectedIcon = page.locator(".intelligence-symbol-input .symbol-icon img");
  await page.waitForFunction(() => {
    const image = document.querySelector(".intelligence-symbol-input .symbol-icon img");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  }, { timeout: 5_000 });
  if (!(await selectedIcon.evaluate((image) => image.complete && image.naturalWidth > 0))) throw new Error(`${label}: selected derivatives icon did not load`);
  await page.waitForSelector('.intelligence-evidence-chart[data-chart-ready="true"]', { timeout: 10_000 });
  await page.getByRole("group", { name: "衍生品时间粒度" }).getByRole("button", { name: "1H", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="衍生品时间粒度"] button.active')?.textContent?.trim() === "1H");
  if (await page.getByRole("button", { name: /刷新/ }).last().isDisabled()) throw new Error(`${label}: derivatives did not finish its automatic 1H reload`);
  if ((await page.locator(".intelligence-derivative-panel").count()) !== 5) throw new Error(`${label}: derivatives workbench must contain five evidence panels`);
  if ((await page.locator(".intelligence-evidence-chart canvas").count()) < 4) throw new Error(`${label}: derivatives charts did not render canvases`);
  for (const requiredText of ["仓位状态推断仅描述", "净主动流", "平台爆仓事件样本", "数据覆盖度"]) {
    if (!(await page.getByText(requiredText, { exact: false }).count())) throw new Error(`${label}: missing derivatives terminology ${requiredText}`);
  }
  const nonBlankCharts = await page.locator(".intelligence-evidence-chart").evaluateAll((containers) => containers.filter((container) => {
    const canvases = [...container.querySelectorAll("canvas")];
    return canvases.some((canvas) => {
      const context = canvas.getContext("2d");
      if (!context || canvas.width === 0 || canvas.height === 0) return false;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 160) if (pixels[index] > 0) return true;
      return false;
    });
  })).length;
  if (nonBlankCharts < 4) throw new Error(`${label}: derivatives chart pixels are blank (${nonBlankCharts})`);
  const firstChart = page.locator(".intelligence-evidence-chart").first();
  const firstChartBox = await firstChart.boundingBox();
  if (!firstChartBox) throw new Error(`${label}: positioning chart missing`);
  await page.mouse.move(firstChartBox.x + firstChartBox.width * 0.62, firstChartBox.y + firstChartBox.height * 0.5);
  await page.waitForTimeout(100);
  if (!(await firstChart.locator(".intelligence-chart-tooltip:not([hidden])").count())) throw new Error(`${label}: chart hover tooltip missing`);
  const positioningTooltip = await firstChart.locator(".intelligence-chart-tooltip:not([hidden])").textContent();
  if (/价格\s+0(?:\D|$)/.test(positioningTooltip || "")) throw new Error(`${label}: missing positioning prices are rendered as zero`);
  const derivativesScreenshot = path.join(os.tmpdir(), `desic-intelligence-${label}-derivatives.png`);
  await page.screenshot({ path: derivativesScreenshot, fullPage: false });
  await page.getByRole("button", { name: /聪明钱/ }).click();
  if (!(await page.getByText("聪明钱共识", { exact: true }).count())) throw new Error(`${label}: smart money tab did not render`);
  if (!(await page.getByText("58.000%", { exact: true }).count())) throw new Error(`${label}: smart ratio precision is not three decimals`);
  if (!(await page.getByText("+3,800,000.000", { exact: true }).count())) throw new Error(`${label}: net notional precision is not three decimals`);
  if (!(await page.locator(".intelligence-signals-band .symbol-label").count())) throw new Error(`${label}: smart-money symbols are missing icons`);
  const signalBox = await page.locator(".intelligence-signals-band").boundingBox();
  const traderBox = await page.locator(".intelligence-traders-band").boundingBox();
  if (!signalBox || !traderBox || signalBox.width < 500 || traderBox.width < 300) {
    throw new Error(`${label}: smart money columns are too narrow ${JSON.stringify({ signalBox, traderBox })}`);
  }
  await page.locator(".intelligence-trader-list > div > button:first-child").first().click();
  await page.waitForSelector(".intelligence-trader-detail", { timeout: 5_000 });
  if (!(await page.getByText("当前持仓", { exact: true }).count()) || !(await page.getByText("最近成交", { exact: true }).count())) {
    throw new Error(`${label}: structured trader evidence missing`);
  }
  if ((await page.locator(".intelligence-position-list article").count()) !== 2) throw new Error(`${label}: visual position rows missing`);
  if (!(await page.locator(".intelligence-position-balance").count())) throw new Error(`${label}: position exposure visualization missing`);
  if (await page.locator(".intelligence-trader-detail pre").count()) throw new Error(`${label}: raw JSON still exposed in trader detail`);
  const trendAlignment = await page.evaluate(() => {
    const bars = [...document.querySelectorAll(".intelligence-smart-trend .intelligence-trend-plot > button")];
    const ticks = [...document.querySelectorAll(".intelligence-smart-trend .intelligence-trend-axis > span")];
    return bars.map((bar, index) => {
      const barBox = bar.getBoundingClientRect();
      const tickBox = ticks[index]?.getBoundingClientRect();
      return tickBox ? Math.abs((barBox.left + barBox.width / 2) - (tickBox.left + tickBox.width / 2)) : 999;
    });
  });
  if (!trendAlignment.length || Math.max(...trendAlignment) > 1) throw new Error(`${label}: smart trend bars and x-axis are misaligned ${JSON.stringify(trendAlignment)}`);
  const smartScreenshot = path.join(os.tmpdir(), `desic-intelligence-${label}-smart.png`);
  await page.screenshot({ path: smartScreenshot, fullPage: false });
  await page.locator('.intelligence-trader-detail button[title="关闭"]').click();
  await page.getByRole("button", { name: /^历史/ }).click();
  if (!(await page.getByRole("button", { name: "查询本地库" }).count())) throw new Error(`${label}: history tab did not render`);

  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    bodyX: document.body.scrollWidth - window.innerWidth,
    bodyY: document.body.scrollHeight - window.innerHeight
  }));
  if (overflow.x > 2 || overflow.bodyX > 2 || overflow.y > 2 || overflow.bodyY > 2) {
    throw new Error(`${label}: global overflow ${JSON.stringify(overflow)}`);
  }

  const screenshot = path.join(os.tmpdir(), `desic-intelligence-${label}-history.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  const actionableErrors = consoleErrors.filter((message) => !/WebSocket|ERR_|Failed to load resource/i.test(message));
  if (pageErrors.length || actionableErrors.length) {
    throw new Error(`${label}: runtime errors ${JSON.stringify({ pageErrors, consoleErrors: actionableErrors })}`);
  }
  await page.close();
  return { label, width, height, newsScreenshot, weekCalendarScreenshot, sentimentScreenshot, symbolMenuScreenshot, derivativesScreenshot, smartScreenshot, screenshot, overflow, nonBlankCharts, trendAlignment };
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const results = [];
    results.push(await verifyViewport(browser, 1440, 900, "1440x900"));
    results.push(await verifyViewport(browser, 1280, 720, "1280x720"));
    process.stdout.write(`[smoke] intelligence preview ok: ${JSON.stringify(results)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke] intelligence preview failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
