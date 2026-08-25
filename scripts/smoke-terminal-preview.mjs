import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.DESIC_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview";
const accountPreviewUrl = process.env.DESIC_ACCOUNT_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview?accounts=demo&pendingOrder=1";
const notificationSeed = [
  { id: "smoke-trade", kind: "trade", title: "委托已成交", message: "BTC-USDT-SWAP 做多成交 0.01 张", ageMs: 0 },
  { id: "smoke-error", kind: "error", title: "前端代码异常", message: "smoke searchable error item", ageMs: 1000 },
  { id: "smoke-warning", kind: "warning", title: "K 线等待确认", message: "BTC-USDT-SWAP 5m 等待确认", ageMs: 2000 },
  { id: "smoke-info", kind: "info", title: "同步完成", message: "私有历史同步完成", ageMs: 3000 }
];

const marketAssetsSeed = {
  cacheDir: "cache/market-assets",
  instruments: [
    { instId: "BTC-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "BTC", instFamily: "BTC-USDT", listTime: "1704067200000", iconPath: "cache/market-assets/icons/BTC.png", iconCached: true },
    { instId: "ETH-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "ETH", instFamily: "ETH-USDT", listTime: "1706745600000", iconPath: "cache/market-assets/icons/ETH.png", iconCached: true },
    { instId: "SOL-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "SOL", instFamily: "SOL-USDT", listTime: "1709251200000", iconPath: "cache/market-assets/icons/SOL.png", iconCached: true },
    { instId: "BNB-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "BNB", instFamily: "BNB-USDT", listTime: "1711929600000", iconPath: "cache/market-assets/icons/BNB.png", iconCached: true },
    { instId: "XRP-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "XRP", instFamily: "XRP-USDT", listTime: "1714521600000", iconPath: "cache/market-assets/icons/XRP.png", iconCached: true },
    { instId: "DOGE-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "DOGE", instFamily: "DOGE-USDT", listTime: "1717200000000", iconPath: "cache/market-assets/icons/DOGE.png", iconCached: true },
    { instId: "AVAX-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "AVAX", instFamily: "AVAX-USDT", listTime: "1719792000000", iconPath: "cache/market-assets/icons/AVAX.png", iconCached: true },
    { instId: "AAPL-USDT-SWAP", instType: "SWAP", state: "live", settleCcy: "USDT", baseCcy: "AAPL", instFamily: "AAPL-USDT", instCategory: "3", listTime: "1609459200000", securityName: "Apple Inc. - Common Stock", securityNameZhHans: "苹果公司", securityNameZhHant: "蘋果公司", localizedSecurityName: "苹果公司", listingExchange: "NASDAQ", securityMetadataSource: "NASDAQ Trader Symbol Directory", securityLocalizationSource: "Wikidata", iconPath: "cache/market-assets/icons/AAPL.png", iconCached: true }
  ]
};

// Sub-pixel rendering can leave rects 0.001-0.01px "overlapping" on a shared
// edge; a half-pixel tolerance keeps the assertion about real layout overlap.
const RECT_OVERLAP_EPSILON = 0.5;

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x + RECT_OVERLAP_EPSILON ||
    b.x + b.width <= a.x + RECT_OVERLAP_EPSILON ||
    a.y + a.height <= b.y + RECT_OVERLAP_EPSILON ||
    b.y + b.height <= a.y + RECT_OVERLAP_EPSILON
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedMarketAssets(page);
  await page.route("**/cache/market-assets/icons/*.png", async (route) => {
    const fileName = path.basename(new URL(route.request().url()).pathname);
    try {
      const body = await readFile(path.resolve("cache", "market-assets", "icons", fileName));
      await route.fulfill({ status: 200, contentType: "image/png", body });
    } catch {
      const body = await readFile(path.resolve("src-tauri", "icons", "32x32.png"));
      await route.fulfill({ status: 200, contentType: "image/png", body });
    }
  });
  await seedNotificationHistory(page);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });
  const cacheHitRates = await page.evaluate(async () => {
    const { formatRunCacheHitRate } = await import("/src/ui/AiAutomationPanel.tsx");
    const summary = {
      reported: true,
      coverage: { inputOutput: true, cacheRead: true, cacheWrite: false, reasoning: false },
      usage: { inputTokens: 299_000, outputTokens: 8_500, cacheReadTokens: 263_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 307_500 }
    };
    return {
      valid: formatRunCacheHitRate(summary),
      unavailable: formatRunCacheHitRate({ ...summary, coverage: { ...summary.coverage, cacheRead: false } }),
      inconsistent: formatRunCacheHitRate({ ...summary, usage: { ...summary.usage, cacheReadTokens: 300_000 } })
    };
  });
  if (cacheHitRates.valid !== "88.0%" || cacheHitRates.unavailable !== null || cacheHitRates.inconsistent !== null) {
    throw new Error(`cache hit-rate formatting regressed: ${JSON.stringify(cacheHitRates)}`);
  }

  await verifyEpisodeReviewModal(browser);
  if (process.env.DESIC_EPISODE_REVIEW_ONLY === "1") {
    await browser.close();
    process.stdout.write("[smoke] episode review preview ok: layers=ok, desktop=ok, compact=ok\n");
    return;
  }

  const defaultPeriod = (await page.locator(".chart-toolbar .periods button.active").textContent())?.trim();
  if (defaultPeriod !== "30m") {
    throw new Error(`terminal should open with 30m candles, got ${JSON.stringify(defaultPeriod)}`);
  }

  const overflow = await page.evaluate(() => ({
    bodyX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    rootX: document.body.scrollWidth - window.innerWidth,
    rootY: document.body.scrollHeight - window.innerHeight
  }));
  if (overflow.bodyX > 2 || overflow.rootX > 2) {
    throw new Error(`terminal preview has global horizontal overflow: ${JSON.stringify(overflow)}`);
  }

  await verifyChartResizeHandles(page);

  const { rows, watchedRows, imageCount } = await verifyWatchlistRows(page, "desktop");
  await verifyWatchlistCollapse(page);
  const expectedPublicStreams = Number(await page.locator(".connection-status").getAttribute("data-expected-public-streams"));
  const expectedPublicStreamsFromRows = 1 + Math.ceil(watchedRows / 5);
  if (expectedPublicStreams !== expectedPublicStreamsFromRows) {
    throw new Error(`public stream count should match Meta + Books shards: ${JSON.stringify({ rows, watchedRows, expectedPublicStreams, expectedPublicStreamsFromRows })}`);
  }
  await verifyChartSymbolSwitch(page);
  await verifyChartTableExport(page);

  const depthCheck = await page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    const rows = Array.from(document.querySelectorAll(".orderbook .depth-row"));
    const asks = rows.filter((item) => item.classList.contains("ask"));
    const bids = rows.filter((item) => item.classList.contains("bid"));
    const heights = rows.map((item) => Math.round(item.getBoundingClientRect().height));
    const uniqueHeights = Array.from(new Set(heights));
    return {
      orderbook: rect(".orderbook"),
      pressure: rect(".pressure-panel"),
      trades: rect(".recent-trades"),
      asks: asks.length,
      bids: bids.length,
      uniqueHeights,
      pressureBattle: rect(".pressure-battle"),
      pressureFlow: rect(".pressure-flow"),
      pressureDot: rect(".pressure-balance-dot"),
      pressureTradeTrack: rect(".pressure-trade-track"),
      pressurePulseCount: document.querySelectorAll(".pressure-flow i").length,
      pressureMetaText: document.querySelector(".pressure-meta")?.textContent?.trim() || "",
      pressureHeadText: document.querySelector(".pressure-head strong")?.textContent?.trim() || ""
    };
  });
  if (!depthCheck.orderbook || depthCheck.asks !== 5 || depthCheck.bids !== 5) {
    throw new Error(`orderbook fixed depth check failed: ${JSON.stringify(depthCheck)}`);
  }
  if (!depthCheck.pressure || !depthCheck.pressureBattle || !depthCheck.pressureMetaText) {
    throw new Error(`pressure panel missing or empty: ${JSON.stringify(depthCheck)}`);
  }
  if (!depthCheck.pressureFlow || !depthCheck.pressureDot || !depthCheck.pressureTradeTrack || depthCheck.pressurePulseCount !== 7) {
    throw new Error(`pressure battle visualization missing live layers: ${JSON.stringify(depthCheck)}`);
  }
  if (!/买卖压力|买盘占优|卖盘占优|等待盘口数据/.test(depthCheck.pressureHeadText) || !/主动买/.test(depthCheck.pressureMetaText)) {
    throw new Error(`pressure battle labels are incomplete: ${JSON.stringify(depthCheck)}`);
  }
  if (depthCheck.orderbook.height < 278 || depthCheck.orderbook.height > 296 || depthCheck.pressure.height < 88 || depthCheck.pressure.height > 102) {
    throw new Error(`market depth panel heights are unstable: ${JSON.stringify(depthCheck)}`);
  }
  if (depthCheck.uniqueHeights.length !== 1 || depthCheck.uniqueHeights[0] !== 20) {
    throw new Error(`depth rows should keep a fixed 20px height: ${JSON.stringify(depthCheck)}`);
  }
  if (rectsOverlap(depthCheck.orderbook, depthCheck.pressure) || (depthCheck.trades && rectsOverlap(depthCheck.pressure, depthCheck.trades))) {
    throw new Error(`market depth sections overlap: ${JSON.stringify(depthCheck)}`);
  }
  const inactiveDepthTabs = await page.locator(".market-depth button", { hasText: /^(盘口|成交)$/ }).count();
  if (inactiveDepthTabs !== 0) throw new Error(`inactive market depth tabs should be removed, got ${inactiveDepthTabs}`);
  await page.getByRole("button", { name: "展开完整盘口" }).click();
  await page.waitForSelector(".depth-modal", { timeout: 5_000 });
  const fullDepthRows = await page.locator(".depth-modal-row").count();
  if (fullDepthRows < 48) {
    throw new Error(`full depth modal should show expanded order book rows: ${fullDepthRows}`);
  }
  await page.locator(".depth-modal .window-button[title='关闭']").click();

  await verifyTradeTicket(page);
  await verifyAccountModalFromEmptyState(page);
  await verifyHelpCenter(page);

  await page.locator(".notification-button").click();
  await page.waitForSelector(".notification-center", { timeout: 5_000 });
  await verifyNotificationCenter(page);
  const notificationBox = await page.locator(".notification-center").boundingBox();
  const controlsBox = await page.locator(".window-controls").boundingBox();
  if (!notificationBox || !controlsBox) throw new Error("notification center or window controls missing");
  if (rectsOverlap(notificationBox, controlsBox)) {
    throw new Error("notification center overlaps window controls");
  }

  const windowButtonCount = await page.locator(".window-controls .window-button").count();
  if (windowButtonCount !== 3) throw new Error(`expected 3 window buttons, got ${windowButtonCount}`);
  if (await page.getByRole("button", { name: "导出诊断日志" }).count()) throw new Error("diagnostic export button should not be shown in the top bar");
  if (!(await page.locator('.window-controls .window-button[title="最小化"] svg').count())) throw new Error("minimize control should use a standard icon");
  await page.locator(".window-controls .window-button").nth(0).click();
  await page.locator(".window-controls .window-button").nth(1).click();

  const aiFloat = page.locator(".ai-float");
  const aiBefore = await aiFloat.boundingBox();
  if (!aiBefore) throw new Error("AI floating entry is missing");
  await aiFloat.hover();
  await page.mouse.down();
  await page.mouse.move(420, 240, { steps: 8 });
  await page.mouse.up();
  const aiAfter = await aiFloat.boundingBox();
  if (!aiAfter || Math.abs(aiAfter.x - aiBefore.x) < 24 || Math.abs(aiAfter.y - aiBefore.y) < 24) {
    throw new Error(`AI floating entry did not move freely: ${JSON.stringify({ aiBefore, aiAfter })}`);
  }
  if (aiAfter.x < 0 || aiAfter.y < 0 || aiAfter.x + aiAfter.width > 1440 || aiAfter.y + aiAfter.height > 900) {
    throw new Error(`AI floating entry moved outside viewport: ${JSON.stringify(aiAfter)}`);
  }
  if (await page.locator(".ai-panel").count()) throw new Error("dragging the AI entry should not toggle the panel");
  await aiFloat.click();
  const aiPanel = await page.locator(".ai-panel").boundingBox();
  if (!aiPanel || aiPanel.x < 0 || aiPanel.y < 0 || aiPanel.x + aiPanel.width > 1440 || aiPanel.y + aiPanel.height > 900) {
    throw new Error(`AI panel should remain inside the viewport after dragging: ${JSON.stringify(aiPanel)}`);
  }
  const aiLayerState = await page.evaluate(() => {
    const dock = document.querySelector(".ai-dock");
    const chartControls = document.querySelector(".chart-control-bar");
    if (!dock || !chartControls) return null;
    return {
      aiZIndex: Number.parseInt(getComputedStyle(dock).zIndex, 10),
      chartZIndex: Number.parseInt(getComputedStyle(chartControls).zIndex, 10)
    };
  });
  if (!aiLayerState || !Number.isFinite(aiLayerState.aiZIndex) || !Number.isFinite(aiLayerState.chartZIndex)
    || aiLayerState.aiZIndex <= aiLayerState.chartZIndex) {
    throw new Error(`AI panel should render above chart controls: ${JSON.stringify(aiLayerState)}`);
  }
  await verifyAiModelConfigLiveUpdate(page);
  await page.locator('.ai-panel-head button[title="收起"]').click();

  await verifyMarketRadar(page);
  await verifySettingsConfigurationPage(page);

  const actionableConsoleErrors = consoleErrors.filter((text) => !/WebSocket|ERR_|Failed to load resource/i.test(text));
  if (pageErrors.length > 0 || actionableConsoleErrors.length > 0) {
    throw new Error(`terminal preview errors: ${JSON.stringify({ pageErrors, consoleErrors: actionableConsoleErrors })}`);
  }

  await verifyAccountModalWithPreviewAccounts(browser);
  const responsiveCount = await verifyResponsiveScenarios(browser);
  await browser.close();
  process.stdout.write(
    `[smoke] terminal preview ok: rows=${rows}, iconRows=${imageCount}, depthRows=${depthCheck.asks + depthCheck.bids}, accountModal=ok, responsive=${responsiveCount}, overflow=${JSON.stringify(overflow)}\n`
  );
}

async function verifyMarketRadar(page) {
  if (await page.locator(".notification-center").isVisible()) {
    await page.locator(".notification-button").click();
  }
  await page.locator('[data-workspace="radar"]').click();
  await page.waitForSelector(".market-radar-page", { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll(".market-radar-table__row").length >= 7);
  const rows = await page.locator(".market-radar-table__row").count();
  const detail = await page.locator(".market-radar-detail").boundingBox();
  const table = await page.locator(".market-radar-table").boundingBox();
  if (rows < 7 || !detail || !table || rectsOverlap(detail, table)) {
    throw new Error(`market radar desktop ranking layout failed: ${JSON.stringify({ rows, detail, table })}`);
  }
  const historyText = (await page.locator(".market-radar-page__history").textContent())?.trim() || "";
  if (!historyText.includes("低频研究历史")) {
    throw new Error(`market radar history readiness is not visible: ${JSON.stringify(historyText)}`);
  }
  const search = page.locator(".market-radar-page__search input");
  await search.fill("ETH");
  if (await page.locator(".market-radar-table__row").count() !== 1) {
    throw new Error("market radar all-market search did not narrow to ETH");
  }
  await search.fill("Apple");
  const equityDetail = (await page.locator(".market-radar-detail").textContent()) || "";
  if (await page.locator(".market-radar-table__row").count() !== 1
    || !equityDetail.includes("苹果公司")
    || !equityDetail.includes("Apple Inc.")
    || !equityDetail.includes("Wikidata")
    || !equityDetail.includes("NASDAQ Trader Symbol Directory")) {
    throw new Error(`market radar should expose localized and official equity metadata: ${JSON.stringify(equityDetail)}`);
  }
  await search.fill("苹果");
  if (await page.locator(".market-radar-table__row").count() !== 1) {
    throw new Error("market radar should search Chinese security names");
  }
  await search.fill("");
  await page.locator(".market-radar-page__tools button", { hasText: "筛选" }).click();
  const naturalFilter = page.locator(".market-radar-tools-panel__natural input");
  await naturalFilter.fill("股票，成交额至少 1，点差不超过 100bp");
  await page.locator(".market-radar-tools-panel__natural button", { hasText: "应用" }).click();
  const parsedClauses = (await page.locator(".market-radar-tools-panel__parse").textContent()) || "";
  if (!parsedClauses.includes("category=stock") || !parsedClauses.includes("turnover>=1") || await page.locator(".market-radar-table__row").count() !== 1) {
    throw new Error(`market radar deterministic natural filter failed: ${JSON.stringify(parsedClauses)}`);
  }
  await page.locator(".market-radar-saved-filters__save button", { hasText: "重置" }).click();
  await page.locator(".market-radar-page__tools button", { hasText: "比较" }).click();
  await page.locator(".market-radar-detail__actions button", { hasText: "比较" }).click();
  if (await page.locator(".market-radar-compare-grid article").count() !== 1) {
    throw new Error("market radar comparison did not add the selected market");
  }
  await page.locator(".market-radar-page__tools button", { hasText: "宽度" }).click();
  if (await page.locator(".market-radar-breadth-grid article").count() < 2
    || !(await page.locator(".market-radar-breadth-grid").textContent())?.includes("#1")) {
    throw new Error("market radar breadth and category strength ranking are not visible");
  }
  await page.locator(".market-radar-page__tools button", { hasText: "验证" }).click();
  if (!((await page.locator(".market-radar-tools-panel").textContent()) || "").includes("真实产品宇宙")) {
    throw new Error("market radar point-in-time validation boundary is not visible");
  }
  await page.locator(".market-radar-page__tabs button", { hasText: "高级模型" }).click();
  await page.waitForSelector(".market-radar-page__expert-host");
  await page.waitForFunction(() => document.querySelector(".market-radar-page__expert-host")?.textContent?.includes("仅在桌面运行时可用"));
  const expertText = (await page.locator(".market-radar-page__expert-host").textContent())?.trim() || "";
  if (!expertText.includes("高级模型仅在桌面运行时可用")) {
    throw new Error(`market radar expert layer did not load its runtime boundary: ${JSON.stringify(expertText)}`);
  }
  await page.locator('[data-workspace="terminal"]').click();
  await page.waitForSelector(".content-grid");
}

async function verifyAiModelConfigLiveUpdate(page) {
  const publish = (models) => page.evaluate((nextModels) => {
    const active = nextModels[0];
    window.dispatchEvent(new CustomEvent("desic:ai-config-updated", {
      detail: {
        provider: active.provider,
        model: active.model,
        baseUrl: active.baseUrl,
        apiKeyMasked: "configured",
        stream: true,
        configured: true,
        permissionMode: active.permissionMode,
        reasoningDepth: active.reasoningDepth,
        activeModelId: active.id,
        models: nextModels,
        systemPrompt: "",
        customRules: "",
        enabledSkills: [],
        skillDefinitions: []
      }
    }));
  }, models);
  const model = (id, name) => ({
    id,
    name,
    provider: "deepseek",
    model: `${id}-model`,
    baseUrl: "https://api.example.invalid/v1",
    apiKeyMasked: "configured",
    configured: true,
    permissionMode: "advisor",
    reasoningDepth: "medium"
  });
  await publish([model("model-a", "模型 A"), model("model-b", "模型 B")]);
  const select = page.getByRole("combobox", { name: "AI 模型" });
  await select.click();
  await page.locator(".terminal-select-option", { hasText: "模型 B" }).click();
  await publish([model("model-a", "模型 A"), model("model-b", "模型 B"), model("model-c", "模型 C")]);
  const selected = await select.getAttribute("data-value");
  await select.click();
  const options = await page.locator(".terminal-select-option").allTextContents();
  await page.keyboard.press("Escape");
  if (selected !== "model-b" || !options.some((text) => text.includes("模型 C"))) {
    throw new Error(`AI model options should update immediately without replacing a valid selection: ${JSON.stringify({ selected, options })}`);
  }
}

async function verifyEpisodeReviewModal(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await seedMarketAssets(page);
  const url = new URL(baseUrl);
  url.searchParams.set("episodeReview", "1");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".episode-detail-modal", { timeout: 30_000 });

  const state = await page.evaluate(() => {
    const backdrop = document.querySelector(".modal-backdrop:has(.episode-detail-modal)");
    const modal = document.querySelector(".episode-detail-modal");
    const chartControls = document.querySelector(".chart-control-bar");
    const aiDock = document.querySelector(".ai-dock");
    const topbar = document.querySelector(".topbar");
    const eventList = document.querySelector(".episode-event-list");
    const modalBox = modal?.getBoundingClientRect();
    const eventBox = eventList?.getBoundingClientRect();
    const z = (node) => node ? Number.parseInt(getComputedStyle(node).zIndex, 10) : Number.NaN;
    return {
      backdropZ: z(backdrop),
      chartZ: z(chartControls),
      aiZ: z(aiDock),
      topbarZ: z(topbar),
      modalBox: modalBox ? { x: modalBox.x, y: modalBox.y, width: modalBox.width, height: modalBox.height } : null,
      eventBox: eventBox ? { x: eventBox.x, y: eventBox.y, width: eventBox.width, height: eventBox.height } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      eventCards: document.querySelectorAll(".episode-event-card").length,
      resultTone: document.querySelector(".episode-result-primary")?.className || "",
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });

  if (!Number.isFinite(state.backdropZ) || !Number.isFinite(state.chartZ) || !Number.isFinite(state.aiZ) || !Number.isFinite(state.topbarZ)
    || state.backdropZ <= state.chartZ || state.backdropZ <= state.aiZ || state.backdropZ <= state.topbarZ) {
    throw new Error(`episode review modal layer order is invalid: ${JSON.stringify(state)}`);
  }
  if (!state.modalBox || state.modalBox.x < 0 || state.modalBox.y < 0
    || state.modalBox.x + state.modalBox.width > state.viewport.width
    || state.modalBox.y + state.modalBox.height > state.viewport.height) {
    throw new Error(`episode review modal leaves the viewport: ${JSON.stringify(state)}`);
  }
  if (!state.eventBox || state.eventBox.height < 180 || state.eventCards !== 5 || !state.resultTone.includes("negative") || state.bodyOverflowX > 2) {
    throw new Error(`episode review content hierarchy is incomplete: ${JSON.stringify(state)}`);
  }

  await page.setViewportSize({ width: 860, height: 720 });
  await page.waitForTimeout(150);
  const compactState = await page.evaluate(() => {
    const modal = document.querySelector(".episode-detail-modal")?.getBoundingClientRect();
    const eventList = document.querySelector(".episode-event-list")?.getBoundingClientRect();
    return {
      modal: modal ? { x: modal.x, y: modal.y, width: modal.width, height: modal.height } : null,
      eventList: eventList ? { x: eventList.x, y: eventList.y, width: eventList.width, height: eventList.height } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  if (!compactState.modal || !compactState.eventList || compactState.eventList.height < 140
    || compactState.modal.x < 0 || compactState.modal.y < 0
    || compactState.modal.x + compactState.modal.width > compactState.viewport.width
    || compactState.modal.y + compactState.modal.height > compactState.viewport.height
    || compactState.bodyOverflowX > 2) {
    throw new Error(`episode review compact layout is invalid: ${JSON.stringify(compactState)}`);
  }

  await page.keyboard.press("Escape");
  await page.waitForSelector(".episode-detail-modal", { state: "detached", timeout: 5_000 });
  await page.close();
}

async function verifyChartResizeHandles(page) {
  const readLayout = () => page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    return {
      center: rect(".center-panel"),
      depth: rect(".market-depth"),
      chart: rect(".chart-stage"),
      bottom: rect(".bottom-panel")
    };
  });

  const beforeWidth = await readLayout();
  const rightHandle = await page.getByRole("separator", { name: "调整 K 线图宽度" }).boundingBox();
  if (!rightHandle || !beforeWidth.center || !beforeWidth.depth) throw new Error(`chart width resize handle is missing: ${JSON.stringify(beforeWidth)}`);
  await page.mouse.move(rightHandle.x + rightHandle.width / 2, rightHandle.y + rightHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightHandle.x + rightHandle.width / 2 + 24, rightHandle.y + rightHandle.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterWidth = await readLayout();
  if (!afterWidth.center || !afterWidth.depth || afterWidth.center.width - beforeWidth.center.width < 12 || beforeWidth.depth.width - afterWidth.depth.width < 12) {
    throw new Error(`dragging the chart right edge did not resize adjacent panels: ${JSON.stringify({ beforeWidth, afterWidth })}`);
  }

  const beforeHeight = await readLayout();
  const bottomHandle = await page.getByRole("separator", { name: "调整 K 线图高度" }).boundingBox();
  if (!bottomHandle || !beforeHeight.chart || !beforeHeight.bottom) throw new Error(`chart height resize handle is missing: ${JSON.stringify(beforeHeight)}`);
  await page.mouse.move(bottomHandle.x + bottomHandle.width / 2, bottomHandle.y + bottomHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottomHandle.x + bottomHandle.width / 2, bottomHandle.y + bottomHandle.height / 2 + 24, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterHeight = await readLayout();
  if (!afterHeight.chart || !afterHeight.bottom || afterHeight.chart.height - beforeHeight.chart.height < 12 || beforeHeight.bottom.height - afterHeight.bottom.height < 12) {
    throw new Error(`dragging the chart bottom edge did not resize adjacent panels: ${JSON.stringify({ beforeHeight, afterHeight })}`);
  }

  const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("desictrade.chartWorkspaceLayout.v1") || "{}"));
  if (!Number.isFinite(saved.depthWidth) || !Number.isFinite(saved.bottomHeight)) {
    throw new Error(`chart layout resize was not persisted: ${JSON.stringify(saved)}`);
  }
  await page.getByRole("separator", { name: "调整 K 线图宽度" }).dblclick();
  await page.getByRole("separator", { name: "调整 K 线图高度" }).dblclick();
}

async function seedNotificationHistory(page) {
  await page.addInitScript((seed) => {
    const now = Date.now();
    window.localStorage.setItem(
      "desictrade.notificationHistory.v1",
      JSON.stringify(seed.map((item) => ({ ...item, createdAt: now - item.ageMs })))
    );
  }, notificationSeed);
}

async function seedMarketAssets(page) {
  await page.route("**/cache/market-assets/swap-instruments.json", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(marketAssetsSeed) });
  });
  await page.route("https://openapi.okx.com/api/v5/**", async (route) => {
    const url = new URL(route.request().url());
    const instId = url.searchParams.get("instId") || "BTC-USDT-SWAP";
    const price = instId.startsWith("ETH") ? "2400" : instId.startsWith("BTC") ? "65000" : "100";
    const now = String(Date.now());
    if (url.pathname === "/api/v5/public/time") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "0", data: [{ ts: now }] }) });
      return;
    }
    if (url.pathname === "/api/v5/market/ticker") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          code: "0",
          data: [{ instId, last: price, lastSz: "0.01", askPx: price, askSz: "1", bidPx: price, bidSz: "1", open24h: price, high24h: price, low24h: price, vol24h: "1", volCcy24h: price, ts: now }]
        })
      });
      return;
    }
    if (url.pathname === "/api/v5/market/tickers") {
      const data = marketAssetsSeed.instruments.map((instrument, index) => {
        const last = instrument.instId.startsWith("BTC") ? 65000 : instrument.instId.startsWith("ETH") ? 2400 : 100 + index * 5;
        const openFactors = [0.96, 1.03, 0.98, 1.05, 0.99, 1.08, 0.95, 1.02];
        const open = last * openFactors[index];
        return {
          instId: instrument.instId,
          last: String(last),
          lastSz: "1",
          askPx: String(last * 1.0005),
          askSz: "10",
          bidPx: String(last * 0.9995),
          bidSz: "10",
          open24h: String(open),
          high24h: String(last * 1.04),
          low24h: String(last * 0.95),
          vol24h: String(1000 + index * 100),
          volCcy24h: String(10000 - index * 500),
          ts: now
        };
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "0", data }) });
      return;
    }
    if (url.pathname === "/api/v5/public/funding-rate") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ code: "0", data: [{ instType: "SWAP", instId, fundingRate: "0.0001", nextFundingRate: "", fundingTime: now, nextFundingTime: String(Number(now) + 28_800_000), method: "current_period", ts: now }] })
      });
      return;
    }
    await route.fallback();
  });
}

async function openTerminalPreviewPage(browser, scenario) {
  const page = await browser.newPage({
    viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: scenario.deviceScaleFactor ?? 1
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedMarketAssets(page);
  await seedNotificationHistory(page);
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });

  // Search lives inside the title-bar market picker and spans every perpetual, so
  // a market can be starred without leaving the menu.
  await page.locator(".market-title__trigger").click();
  await page.waitForSelector(".market-picker", { timeout: 10_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".market-picker__snapshot-quote strong")).some((node) => node.textContent?.trim() !== "--"));
  const firstPickerBase = async () => (await page.locator(".market-picker__ident strong").first().textContent())?.trim();
  const activeCategory = page.locator('.market-picker__categories [role="tab"].is-active');
  if ((await activeCategory.textContent())?.trim() !== "热门" || await firstPickerBase() !== "BTC") {
    throw new Error(`market picker should default to turnover-ranked popular markets: ${JSON.stringify({ active: await activeCategory.textContent(), first: await firstPickerBase() })}`);
  }
  await page.getByRole("tab", { name: "涨幅" }).click();
  if (await firstPickerBase() !== "AVAX") throw new Error(`gainers should rank AVAX first, got ${await firstPickerBase()}`);
  await page.getByRole("tab", { name: "跌幅" }).click();
  if (await firstPickerBase() !== "DOGE") throw new Error(`losers should rank DOGE first, got ${await firstPickerBase()}`);
  await page.getByRole("tab", { name: "新币" }).click();
  if (await firstPickerBase() !== "AVAX") throw new Error(`new listings should rank AVAX first, got ${await firstPickerBase()}`);
  await page.getByRole("tab", { name: "自选" }).click();
  const watchlistCategoryState = await page.evaluate(() => ({
    rows: document.querySelectorAll(".market-picker__row").length,
    starred: document.querySelectorAll(".market-picker__star.is-on").length
  }));
  if (!watchlistCategoryState.rows || watchlistCategoryState.rows !== watchlistCategoryState.starred) {
    throw new Error(`watchlist category should contain only starred markets: ${JSON.stringify(watchlistCategoryState)}`);
  }
  const watchSearch = page.getByRole("textbox", { name: "搜索交易对" });
  await watchSearch.fill("DOGE");
  if (await firstPickerBase() !== "DOGE") throw new Error("market search should span the full universe from the watchlist category");
  await page.getByRole("tab", { name: "热门" }).click();
  await watchSearch.fill("ETH");
  await page.waitForTimeout(120);
  const filteredOptions = await page.locator(".market-picker__row").allTextContents();
  if (!filteredOptions.length || filteredOptions.some((text) => !/ETH/i.test(text))) {
    throw new Error(`market picker did not filter symbols: ${JSON.stringify(filteredOptions)}`);
  }
  if (!(await page.locator(".market-picker__star").count())) {
    throw new Error("market picker should expose star controls for search results");
  }
  await watchSearch.fill("Apple");
  const companyResult = (await page.locator(".market-picker__row").first().textContent()) || "";
  if (await firstPickerBase() !== "AAPL" || !companyResult.includes("苹果公司")) {
    throw new Error(`market picker should search English and display the localized security name: ${JSON.stringify(companyResult)}`);
  }
  await watchSearch.fill("苹果");
  if (await firstPickerBase() !== "AAPL") {
    throw new Error("market picker should find new securities by their Chinese name");
  }
  await watchSearch.fill("");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  if (await page.locator(".add-symbol").count()) throw new Error("legacy bottom add-watchlist button should be removed");
  const chartToolbarText = await page.locator(".chart-toolbar").textContent();
  if (/自研图表|低延迟/.test(chartToolbarText || "")) throw new Error(`legacy chart labels should be removed: ${chartToolbarText}`);

  return { page, consoleErrors, pageErrors };
}

async function verifyResponsiveScenarios(browser) {
  const scenarios = [
    { label: "low-height", width: 1360, height: 680, deviceScaleFactor: 1 },
    { label: "narrow", width: 1180, height: 720, deviceScaleFactor: 1 },
    { label: "high-dpi", width: 1440, height: 900, deviceScaleFactor: 2 }
  ];
  for (const scenario of scenarios) {
    const { page, consoleErrors, pageErrors } = await openTerminalPreviewPage(browser, scenario);
    try {
      await verifyResponsiveShell(page, scenario.label);
      await verifyHelpCenterLayout(page, scenario.label);
      const actionableConsoleErrors = consoleErrors.filter((text) => !/WebSocket|ERR_|Failed to load resource/i.test(text));
      if (pageErrors.length > 0 || actionableConsoleErrors.length > 0) {
        throw new Error(`responsive ${scenario.label} errors: ${JSON.stringify({ pageErrors, consoleErrors: actionableConsoleErrors })}`);
      }
    } finally {
      await page.close();
    }
  }
  return scenarios.length;
}

async function verifyHelpCenter(page) {
  const helpButton = page.getByRole("button", { name: "打开帮助中心" });
  if (await helpButton.count() !== 1 || !await helpButton.isVisible()) {
    throw new Error("top bar should expose one always-visible help entry");
  }
  await helpButton.click();
  await page.waitForSelector(".help-center-modal", { timeout: 5_000 });
  await verifyHelpCenterLayoutState(page, "desktop");

  const search = page.getByRole("textbox", { name: "搜索帮助" });
  if (!await search.evaluate((node) => node === document.activeElement)) throw new Error("help search should receive initial focus");
  const initialCopy = await page.locator(".help-center-modal").textContent();
  if (!initialCopy?.includes("第一次使用") || !initialCopy.includes("API Key") || !initialCopy.includes("反馈问题时保护凭据")) {
    throw new Error("help center should open with onboarding, credential and privacy guidance");
  }

  await page.locator(".help-category-list button", { hasText: "交易与账户" }).click();
  const tradeCopy = await page.locator(".help-question-pane").textContent();
  if (!tradeCopy?.includes("下单数量为什么使用“张”") || !tradeCopy.includes("提交后没有马上看到委托")) {
    throw new Error("help category navigation did not show trading questions");
  }

  await page.locator(".help-category-list button", { hasText: "快捷键" }).click();
  const shortcutState = await page.evaluate(() => ({
    rowCount: document.querySelectorAll(".help-shortcut-row:not(.help-shortcut-head)").length,
    keys: Array.from(document.querySelectorAll(".help-shortcut-keys")).map((item) => item.textContent?.replace(/\s+/g, "") || ""),
    copy: document.querySelector(".help-question-pane")?.textContent || "",
    platform: document.querySelector(".help-shortcut-table")?.getAttribute("data-shortcut-platform") || ""
  }));
  const expectedModifier = shortcutState.platform === "macos" ? "Option" : "Alt";
  if (shortcutState.rowCount !== 14
    || !shortcutState.keys.includes(`${expectedModifier}+B`)
    || !shortcutState.keys.includes(`${expectedModifier}+4`)
    || !shortcutState.keys.includes("Esc")
    || !shortcutState.copy.includes("开仓模式：做多；平仓模式：平空")
    || !shortcutState.copy.includes("关闭当前实盘下单确认弹窗")
    || !shortcutState.copy.includes("不会绕过账号权限、交易预检或实盘确认")) {
    throw new Error(`help center should expose the complete guarded trade shortcut reference: ${JSON.stringify(shortcutState)}`);
  }

  await search.fill("Insufficient Balance");
  await page.waitForTimeout(100);
  const searchState = await page.evaluate(() => ({
    questionCount: document.querySelectorAll(".help-question").length,
    copy: document.querySelector(".help-question-pane")?.textContent || "",
    expanded: document.querySelector(".help-question-trigger")?.getAttribute("aria-expanded")
  }));
  if (searchState.questionCount !== 1 || searchState.expanded !== "true"
    || !searchState.copy.includes("模型服务余额不足") || !searchState.copy.includes("不是 OKX 交易账户余额")) {
    throw new Error(`help search should find and expand the model balance answer: ${JSON.stringify(searchState)}`);
  }

  await page.keyboard.press("Escape");
  await page.waitForSelector(".help-center-modal", { state: "detached", timeout: 5_000 });
  await page.waitForTimeout(32);
  if (!await helpButton.evaluate((node) => node === document.activeElement)) throw new Error("closing help should restore focus to its top-bar entry");

  await helpButton.click();
  await page.getByRole("textbox", { name: "搜索帮助" }).fill("Insufficient Balance");
  await page.getByRole("button", { name: "检查 AI 模型" }).click();
  await page.waitForSelector(".settings-workspace .ai-settings-pane", { timeout: 5_000 });
  const activeSettingsTab = await page.locator(".settings-page-tabs button.active").textContent();
  if (!/AI 助手/.test(activeSettingsTab || "")) {
    throw new Error(`help action should navigate directly to AI settings: ${activeSettingsTab}`);
  }
  await page.getByRole("button", { name: "交易", exact: true }).click();
  await page.waitForSelector(".content-grid", { timeout: 5_000 });
  await verifyHelpShortcutPlatform(page, helpButton, "Win32", "windows", "Alt", "Option");
  await verifyHelpShortcutPlatform(page, helpButton, "MacIntel", "macos", "Option", "Alt");
}

async function verifyHelpShortcutPlatform(page, helpButton, navigatorPlatform, expectedPlatform, expectedModifier, unexpectedModifier) {
  await page.evaluate((platform) => {
    Object.defineProperty(window.navigator, "platform", { configurable: true, get: () => platform });
  }, navigatorPlatform);
  await helpButton.click();
  await page.locator(".help-category-list button", { hasText: "快捷键" }).click();
  const state = await page.evaluate(() => ({
    platform: document.querySelector(".help-shortcut-table")?.getAttribute("data-shortcut-platform") || "",
    heading: document.querySelector(".help-shortcut-head")?.textContent || "",
    keys: Array.from(document.querySelectorAll(".help-shortcut-keys")).map((item) => item.textContent?.replace(/\s+/g, "") || "")
  }));
  if (state.platform !== expectedPlatform
    || !state.heading.includes(expectedPlatform === "macos" ? "macOS" : "Windows")
    || !state.keys.includes(`${expectedModifier}+B`)
    || !state.keys.includes(`${expectedModifier}+4`)
    || state.keys.includes(`${unexpectedModifier}+B`)) {
    throw new Error(`help shortcut labels should adapt to ${navigatorPlatform}: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForSelector(".help-center-modal", { state: "detached", timeout: 5_000 });
}

async function verifyHelpCenterLayout(page, label) {
  await page.getByRole("button", { name: "打开帮助中心" }).click();
  await page.waitForSelector(".help-center-modal", { timeout: 5_000 });
  await verifyHelpCenterLayoutState(page, label);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".help-center-modal", { state: "detached", timeout: 5_000 });
}

async function verifyHelpCenterLayoutState(page, label) {
  // The modal entrance animation temporarily scales its shell; measure the settled layout.
  await page.waitForFunction(() => {
    const modal = document.querySelector(".help-center-modal");
    if (!modal) return false;
    const box = modal.getBoundingClientRect();
    return Math.abs(box.width - modal.offsetWidth) <= 1
      && Math.abs(box.height - modal.offsetHeight) <= 1
      && Number.parseFloat(getComputedStyle(modal).opacity) >= 0.99;
  }, { timeout: 2_000 });
  const state = await page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null;
    };
    const shell = document.querySelector(".help-center-modal");
    const pane = document.querySelector(".help-question-pane");
    const backdrop = document.querySelector(".modal-backdrop:has(.help-center-modal)");
    const topbar = document.querySelector(".topbar");
    const aiDock = document.querySelector(".ai-dock");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shell: rect(".help-center-modal"),
      toolbar: rect(".help-center-toolbar"),
      categories: rect(".help-category-nav"),
      pane: rect(".help-question-pane"),
      categoryCount: document.querySelectorAll(".help-category-list button").length,
      quickActionCount: document.querySelectorAll(".help-quick-actions button").length,
      layer: {
        backdrop: backdrop ? Number.parseInt(getComputedStyle(backdrop).zIndex, 10) : 0,
        topbar: topbar ? Number.parseInt(getComputedStyle(topbar).zIndex, 10) : 0,
        aiDock: aiDock ? Number.parseInt(getComputedStyle(aiDock).zIndex, 10) : 0
      },
      shellOverflowX: shell ? shell.scrollWidth - shell.clientWidth : 0,
      paneOverflowX: pane ? pane.scrollWidth - pane.clientWidth : 0,
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight
    };
  });
  if (!state.shell || !state.toolbar || !state.categories || !state.pane || state.categoryCount !== 8 || state.quickActionCount !== 4) {
    throw new Error(`help center is missing layout or navigation on ${label}: ${JSON.stringify(state)}`);
  }
  const expectedWidth = state.viewport.width <= 680 ? state.viewport.width - 24 : Math.min(1200, state.viewport.width - 40);
  const expectedHeight = state.viewport.height <= 660 ? state.viewport.height - 24 : Math.min(800, state.viewport.height - 40);
  if (Math.abs(state.shell.width - expectedWidth) > 3 || Math.abs(state.shell.height - expectedHeight) > 3) {
    throw new Error(`help center should use the enlarged responsive dimensions on ${label}: ${JSON.stringify({ expectedWidth, expectedHeight, shell: state.shell })}`);
  }
  if (state.shell.x < -2 || state.shell.y < -2 || state.shell.right > state.viewport.width + 2 || state.shell.bottom > state.viewport.height + 2
    || state.shellOverflowX > 2 || state.paneOverflowX > 2 || state.bodyOverflowX > 2 || state.bodyOverflowY > 2) {
    throw new Error(`help center overflows the viewport on ${label}: ${JSON.stringify(state)}`);
  }
  if (state.layer.backdrop <= state.layer.topbar || state.layer.backdrop <= state.layer.aiDock) {
    throw new Error(`help center should render above the top bar and AI dock on ${label}: ${JSON.stringify(state.layer)}`);
  }
  if (rectsOverlap(state.categories, state.pane)) {
    throw new Error(`help categories overlap answers on ${label}: ${JSON.stringify(state)}`);
  }
}

async function verifyResponsiveShell(page, label) {
  const state = await page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null;
    };
    const rects = (selector) =>
      Array.from(document.querySelectorAll(selector)).map((item) => {
        const box = item.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom, text: item.textContent?.trim() || "" };
      });
    const overflowStyle = (selector) => {
      const item = document.querySelector(selector);
      const style = item ? getComputedStyle(item) : null;
      return style ? { overflowX: style.overflowX, overflowY: style.overflowY } : null;
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      overflow: {
        htmlX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        htmlY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        bodyX: document.body.scrollWidth - window.innerWidth,
        bodyY: document.body.scrollHeight - window.innerHeight
      },
      overflowStyle: {
        html: overflowStyle("html"),
        body: overflowStyle("body"),
        root: overflowStyle("#root")
      },
      terminal: rect(".terminal"),
      workspace: rect(".workspace"),
      topbar: rect(".topbar"),
      contentGrid: rect(".content-grid"),
      windowControls: rect(".window-controls"),
      windowButtons: rects(".window-controls .window-button"),
      center: rect(".center-panel"),
      marketDepth: rect(".market-depth"),
      orderbook: rect(".orderbook"),
      pressure: rect(".pressure-panel"),
      recentTrades: rect(".recent-trades"),
      ticket: rect(".ticket"),
      ticketForm: rect(".ticket-form"),
      ticketFormScroll: (() => {
        const item = document.querySelector(".ticket-form");
        return item
          ? { scrollHeight: item.scrollHeight, clientHeight: item.clientHeight, scrollWidth: item.scrollWidth, clientWidth: item.clientWidth }
          : null;
      })(),
      tradeButtons: rects(".trade-buttons button"),
      depthRows: rects(".orderbook .depth-row").length
    };
  });

  // The watchlist rail was replaced by the title-bar market picker, so it is no
  // longer part of the persistent layout.
  const required = ["terminal", "workspace", "topbar", "contentGrid", "windowControls", "center", "marketDepth", "orderbook", "pressure", "recentTrades", "ticket"];
  for (const key of required) {
    const box = state[key];
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error(`responsive ${label} missing ${key}: ${JSON.stringify(state)}`);
    }
  }
  const overflowValues = Object.values(state.overflow);
  if (overflowValues.some((value) => value > 2)) {
    throw new Error(`responsive ${label} has global overflow: ${JSON.stringify(state.overflow)}`);
  }
  const viewport = state.viewport;
  for (const [key, box] of Object.entries({
    workspace: state.workspace,
    contentGrid: state.contentGrid,
    windowControls: state.windowControls,
    ticket: state.ticket,
    marketDepth: state.marketDepth
  })) {
    if (box.x < -2 || box.y < -2 || box.right > viewport.width + 2 || box.bottom > viewport.height + 2) {
      throw new Error(`responsive ${label} ${key} escapes viewport: ${JSON.stringify({ viewport, box, overflow: state.overflow })}`);
    }
  }
  if (state.windowButtons.length !== 3 || state.windowButtons.some((button) => button.width < 22 || button.height < 22)) {
    throw new Error(`responsive ${label} window controls are not usable: ${JSON.stringify(state.windowButtons)}`);
  }
  if (!state.ticketForm || state.ticketForm.x < state.ticket.x - 2 || state.ticketForm.right > state.ticket.right + 2 || state.ticketForm.bottom > state.ticket.bottom + 2) {
    throw new Error(`responsive ${label} ticket form should be constrained inside ticket: ${JSON.stringify({ ticket: state.ticket, ticketForm: state.ticketForm })}`);
  }
  if (state.ticketFormScroll && state.ticketFormScroll.scrollWidth - state.ticketFormScroll.clientWidth > 2) {
    throw new Error(`responsive ${label} ticket form has horizontal overflow: ${JSON.stringify(state.ticketFormScroll)}`);
  }
  if (state.tradeButtons.length !== 2 || state.tradeButtons.some((button) => button.width < 72 || button.height < 42 || button.right > state.ticket.right + 2)) {
    throw new Error(`responsive ${label} trade buttons are horizontally clipped or unstable: ${JSON.stringify({ ticket: state.ticket, tradeButtons: state.tradeButtons })}`);
  }
  if (state.depthRows !== 10) {
    throw new Error(`responsive ${label} orderbook should keep 10 fixed rows: ${JSON.stringify({ depthRows: state.depthRows })}`);
  }
  const overlapPairs = [
    ["ticket/marketDepth", state.ticket, state.marketDepth],
    ["ticket/orderbook", state.ticket, state.orderbook],
    ["orderbook/pressure", state.orderbook, state.pressure],
    ["pressure/recentTrades", state.pressure, state.recentTrades],
    ["windowControls/ticket", state.windowControls, state.ticket],
    ["windowControls/marketDepth", state.windowControls, state.marketDepth]
  ].filter(([, a, b]) => rectsOverlap(a, b));
  if (overlapPairs.length > 0) {
    throw new Error(`responsive ${label} panels overlap: ${overlapPairs.map(([name]) => name).join(", ")} ${JSON.stringify(state)}`);
  }
}

async function verifyNotificationCenter(page) {
  const state = await page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    return {
      search: rect(".notification-search"),
      filterCount: document.querySelectorAll(".notification-filters button").length,
      badgeCount: document.querySelectorAll(".notification-filters button b").length,
      itemCount: document.querySelectorAll(".notification-history-item").length,
      kindCount: document.querySelectorAll(".notification-kind").length,
      firstItemHeight: document.querySelector(".notification-history-item")?.getBoundingClientRect().height || 0,
      title: document.querySelector(".notification-center-head strong")?.textContent?.trim() || "",
      summary: document.querySelector(".notification-center-head span")?.textContent?.trim() || ""
    };
  });
  if (!state.search || state.filterCount !== 6 || state.badgeCount !== 6 || state.itemCount < 4 || state.kindCount < 4) {
    throw new Error(`notification center density/filter controls missing: ${JSON.stringify(state)}`);
  }
  if (state.firstItemHeight <= 0 || state.firstItemHeight > 86) {
    throw new Error(`notification center item is not compact enough: ${JSON.stringify(state)}`);
  }
  const expectedSummary = new RegExp(`${state.itemCount}\\s*/\\s*${state.itemCount}`);
  if (!/通知中心/.test(state.title) || !expectedSummary.test(state.summary)) {
    throw new Error(`notification center summary mismatch: ${JSON.stringify(state)}`);
  }

  await page.locator(".notification-search input").fill("searchable");
  await page.waitForTimeout(100);
  const searchState = await page.evaluate(() => ({
    itemCount: document.querySelectorAll(".notification-history-item").length,
    visibleText: document.querySelector(".notification-center-list")?.textContent || ""
  }));
  if (searchState.itemCount !== 1 || !searchState.visibleText.includes("smoke searchable error item")) {
    throw new Error(`notification search did not narrow results: ${JSON.stringify(searchState)}`);
  }

  await page.locator(".notification-center-actions button", { hasText: "清搜索" }).click();
  await page.locator(".notification-filters button", { hasText: "交易" }).click();
  await page.waitForTimeout(100);
  const tradeState = await page.evaluate(() => ({
    itemCount: document.querySelectorAll(".notification-history-item").length,
    visibleText: document.querySelector(".notification-center-list")?.textContent || ""
  }));
  if (tradeState.itemCount !== 1 || !tradeState.visibleText.includes("委托已成交")) {
    throw new Error(`notification trade filter did not narrow results: ${JSON.stringify(tradeState)}`);
  }
}

async function verifyAccountModalFromEmptyState(page) {
  await page.locator(".empty-account button", { hasText: /添加 OKX 账号|添加账号/ }).click();
  await page.waitForSelector(".modal-shell.account-modal", { timeout: 5_000 });
  const state = await readAccountModalState(page);
  if (state.title !== "账号管理" || !state.description.includes("仅保存在本机")) {
    throw new Error(`account modal copy mismatch from empty state: ${JSON.stringify(state)}`);
  }
  if (!state.emptyListVisible || state.accountRows !== 0) {
    throw new Error(`empty account modal should show empty list only: ${JSON.stringify(state)}`);
  }
  if (!state.guideOpen || !state.guideText.includes("读取") || !state.guideText.includes("交易") || !state.guideText.includes("禁止提现") || !state.guideHref.includes("/account/my-api")) {
    throw new Error(`empty account modal should open the OKX setup guide: ${JSON.stringify(state)}`);
  }
  assertAccountModalLayout(state, "empty-state");
  await page.locator(".modal-head .window-button").click();
  await page.waitForSelector(".modal-shell.account-modal", { state: "detached", timeout: 5_000 });
}

async function verifyAccountModalWithPreviewAccounts(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedMarketAssets(page);
  await page.goto(accountPreviewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });
  const topAccountText = await page.locator(".account-button").textContent();
  if (!/OKX 预览模拟盘|demo/.test(topAccountText || "")) {
    throw new Error(`preview account should be visible in top account button: ${topAccountText}`);
  }
  if (!topAccountText?.includes("模拟盘") || await page.locator(".account-environment-status").count() !== 0 || await page.locator(".mode-switch").count() !== 0) {
    throw new Error(`top account button should be the only environment indicator: ${topAccountText}`);
  }
  await page.locator(".bottom-tabs button", { hasText: "余额" }).click();
  await page.waitForSelector(".table-row.funds", { timeout: 5_000 });
  const balanceIconState = await page.evaluate(() => ({
    rows: document.querySelectorAll(".table-row.funds").length,
    labels: document.querySelectorAll(".table-row.funds > .symbol-label").length,
    icons: document.querySelectorAll(".table-row.funds > .symbol-label .symbol-icon").length
  }));
  if (balanceIconState.rows < 1 || balanceIconState.labels !== balanceIconState.rows || balanceIconState.icons !== balanceIconState.rows) {
    throw new Error(`each balance row should display its cached coin icon: ${JSON.stringify(balanceIconState)}`);
  }
  await verifyBottomPanelSymbolSwitch(page);
  await page.locator(".account-button").click();
  await page.waitForSelector(".modal-shell.account-modal", { timeout: 5_000 });
  const modalLayerState = await page.evaluate(() => {
    const z = (selector) => Number.parseInt(getComputedStyle(document.querySelector(selector)).zIndex, 10);
    return {
      backdrop: z(".modal-backdrop:has(.account-modal)"),
      chartControls: z(".chart-control-bar"),
      topbar: z(".topbar")
    };
  });
  if (!Number.isFinite(modalLayerState.backdrop) || modalLayerState.backdrop <= modalLayerState.chartControls || modalLayerState.backdrop <= modalLayerState.topbar) {
    throw new Error(`ordinary modals should render above chart controls and the top bar: ${JSON.stringify(modalLayerState)}`);
  }
  const state = await readAccountModalState(page);
  if (state.accountRows !== 3 || !state.activeAccountText.includes("OKX 预览模拟盘") || !state.formNameValue.includes("OKX 预览模拟盘")) {
    throw new Error(`account modal should render preview account list/form: ${JSON.stringify(state)}`);
  }
  if (!state.addButtonText.includes("新增账号") || !state.saveButtonText.includes("保存账号") || !state.testButtonText.includes("测试连接")) {
    throw new Error(`account modal missing expected account actions: ${JSON.stringify(state)}`);
  }
  if (!state.environmentText.includes("模拟盘") || !state.environmentText.includes("自动判断") || state.environmentSelectCount !== 0) {
    throw new Error(`account environment must be read-only and API-key-derived: ${JSON.stringify(state)}`);
  }
  if (state.withdrawChecked || !state.withdrawDisabled) {
    throw new Error(`withdraw permission must stay disabled/off: ${JSON.stringify(state)}`);
  }
  if (!state.guideText.includes("OKX API 配置指南") || !state.guideHref.includes("/account/my-api")) {
    throw new Error(`account modal should expose the OKX setup guide: ${JSON.stringify(state)}`);
  }
  assertAccountModalLayout(state, "preview-accounts");
  await page.locator(".account-list-row").nth(1).click();
  await page.waitForSelector(".confirm-dialog", { timeout: 5_000 });
  const liveConfirmText = await page.locator(".confirm-dialog").textContent();
  if (!liveConfirmText?.includes("实盘") || !liveConfirmText.includes("真实资金损失")) {
    throw new Error(`selecting an auto-detected live account must keep the risk acknowledgement: ${liveConfirmText}`);
  }
  await page.locator(".confirm-dialog .modal-actions button").first().click();
  await page.waitForSelector(".confirm-dialog", { state: "detached", timeout: 5_000 });
  const cancelledEnvironment = await page.locator(".account-button").textContent();
  if (!cancelledEnvironment?.includes("模拟盘")) {
    throw new Error(`cancelling live risk confirmation must keep the previous trading account: ${cancelledEnvironment}`);
  }
  await page.locator(".account-list-row").nth(1).click();
  await page.waitForSelector(".confirm-dialog", { timeout: 5_000 });
  await page.locator(".confirm-dialog .modal-actions button", { hasText: "已理解风险，进入实盘" }).click();
  await page.waitForSelector(".confirm-dialog", { state: "detached", timeout: 5_000 });
  const confirmedEnvironment = await page.locator(".account-button").textContent();
  if (!confirmedEnvironment?.includes("实盘")) {
    throw new Error(`confirming live risk did not switch the trading account: ${confirmedEnvironment}`);
  }
  await page.locator(".add-account-row").click();
  const newState = await readAccountModalState(page);
  if (newState.formNameValue !== "OKX 账号" || !newState.environmentText.includes("保存时自动识别") || newState.environmentSelectCount !== 0) {
    throw new Error(`new account draft should reset form: ${JSON.stringify(newState)}`);
  }
  if (!newState.readChecked || !newState.tradeChecked || newState.withdrawChecked) {
    throw new Error(`new account draft should default to read/trade without withdraw: ${JSON.stringify(newState)}`);
  }
  await page.locator(".modal-head .window-button").click();
  await page.waitForSelector(".modal-shell.account-modal", { state: "detached", timeout: 5_000 });
  const actionableConsoleErrors = consoleErrors.filter((text) => !/WebSocket|ERR_|Failed to load resource/i.test(text));
  if (pageErrors.length > 0 || actionableConsoleErrors.length > 0) {
    throw new Error(`account modal preview errors: ${JSON.stringify({ pageErrors, consoleErrors: actionableConsoleErrors })}`);
  }
  await page.close();
}

async function readAccountModalState(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    const cssNumber = (selector, prop) => {
      const item = document.querySelector(selector);
      return item ? parseFloat(getComputedStyle(item)[prop]) || 0 : 0;
    };
    const inputs = Array.from(document.querySelectorAll(".account-form input"));
    const permissionInputs = Array.from(document.querySelectorAll(".permission-row input"));
    const actions = Array.from(document.querySelectorAll(".account-actions button")).map((button) => button.textContent?.trim() || "");
    return {
      backdrop: rect(".modal-backdrop"),
      shell: rect(".modal-shell.account-modal"),
      head: rect(".modal-head"),
      list: rect(".account-list-panel"),
      form: rect(".account-form"),
      guide: rect(".account-config-guide"),
      closeButton: rect(".modal-head .window-button"),
      title: document.querySelector(".modal-head strong")?.textContent?.trim() || "",
      description: document.querySelector(".modal-head span")?.textContent?.trim() || "",
      guideOpen: document.querySelector(".account-config-guide-trigger")?.getAttribute("aria-expanded") === "true",
      guideText: document.querySelector(".account-config-guide")?.textContent?.trim() || "",
      guideHref: document.querySelector(".account-config-guide a")?.getAttribute("href") || "",
      shellRadius: cssNumber(".modal-shell.account-modal", "borderTopLeftRadius"),
      closeRadius: cssNumber(".modal-head .window-button", "borderTopLeftRadius"),
      accountRows: document.querySelectorAll(".account-list-row").length,
      emptyListVisible: Boolean(document.querySelector(".account-list-empty")),
      activeAccountText: document.querySelector(".account-list-row.active")?.textContent?.trim() || "",
      addButtonText: document.querySelector(".add-account-row")?.textContent?.trim() || "",
      formNameValue: inputs[0]?.value || "",
      environmentText: document.querySelector(".account-detected-environment")?.textContent?.trim() || "",
      environmentSelectCount: document.querySelectorAll(".account-form select").length,
      apiPlaceholder: inputs[1]?.getAttribute("placeholder") || "",
      secretType: inputs[2]?.getAttribute("type") || "",
      passphraseType: inputs[3]?.getAttribute("type") || "",
      readChecked: permissionInputs[0]?.checked ?? null,
      tradeChecked: permissionInputs[1]?.checked ?? null,
      withdrawChecked: permissionInputs[2]?.checked ?? null,
      withdrawDisabled: permissionInputs[2]?.disabled ?? null,
      saveButtonText: actions[0] || "",
      testButtonText: actions[1] || "",
      deleteButtonText: actions[2] || "",
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight
    };
  });
}

async function verifySettingsConfigurationPage(page) {
  await page.locator(".rail-item", { hasText: "配置" }).click();
  await page.waitForSelector(".settings-workspace", { timeout: 5_000 });

  await page.locator(".settings-page-tabs button", { hasText: "AI 助手" }).click();
  await page.waitForSelector(".ai-first-setup", { timeout: 5_000 });
  const aiState = await page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
    };
    const pane = document.querySelector(".ai-settings-pane");
    const firstSetup = document.querySelector(".ai-first-setup");
    return {
      paneHeight: pane?.getBoundingClientRect().height || 0,
      setupHeight: firstSetup?.getBoundingClientRect().height || 0,
      header: rect(".ai-settings-pane > .settings-section"),
      setup: rect(".ai-first-setup"),
      editor: rect(".ai-model-config-editor"),
      actions: rect(".ai-settings-pane > .modal-actions"),
      aiFloat: rect(".ai-float"),
      copy: firstSetup?.textContent?.trim() || "",
      // Counts both the legacy button rows and the current row markup, so the
      // "no implicit draft" guarantee survives changes to the row structure.
      modelDraftRows: document.querySelectorAll(".ai-model-config-list > button strong, .ai-model-config-row").length,
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  if (!aiState.copy.includes("选择供应商并建立连接") || aiState.editor || aiState.actions || aiState.modelDraftRows !== 0) {
    throw new Error(`AI first setup should present the provider entry without an implicit draft: ${JSON.stringify(aiState)}`);
  }
  const aiGaps = [];
  if (aiState.header && aiState.setup) aiGaps.push(aiState.setup.top - aiState.header.bottom);
  if (aiState.setup && aiState.editor) aiGaps.push(aiState.editor.top - aiState.setup.bottom);
  if (aiState.editor && aiState.actions) aiGaps.push(aiState.actions.top - aiState.editor.bottom);
  if (aiState.setupHeight <= 0 || aiState.setupHeight > 150 || aiGaps.some((gap) => gap < 0 || gap > 24) || aiState.bodyOverflowX > 2) {
    throw new Error(`AI first setup layout is not compact: ${JSON.stringify(aiState)}`);
  }
  if (aiState.actions && aiState.aiFloat && rectsOverlap(aiState.actions, aiState.aiFloat)) {
    throw new Error(`AI launcher overlaps first setup actions: ${JSON.stringify(aiState)}`);
  }
  await page.locator(".ai-first-setup-action").click();
  await page.waitForSelector(".ai-provider-grid");
  const providerChoiceState = await page.evaluate(() => ({
    options: document.querySelectorAll(".ai-provider-option").length,
    text: document.querySelector(".ai-provider-grid")?.textContent?.trim() || "",
    bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));
  if (providerChoiceState.options !== 11 || !/OpenAI/.test(providerChoiceState.text) || !/Anthropic/.test(providerChoiceState.text) || !/GLM（智谱）/.test(providerChoiceState.text) || !/自定义/.test(providerChoiceState.text) || providerChoiceState.bodyOverflowX > 2) {
    throw new Error(`AI provider templates are incomplete or overflow: ${JSON.stringify(providerChoiceState)}`);
  }
  await page.locator('[data-provider-template="openai"]').click();
  await page.waitForSelector(".ai-provider-form-grid");
  const openAiTemplateState = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll(".ai-provider-form-grid input"));
    return {
      provider: fields[1]?.value || "",
      model: document.querySelector('.ai-provider-model-field [role="combobox"]')?.getAttribute("data-value") || "",
      baseUrl: fields[2]?.value || "",
      providerReadOnly: fields[1]?.readOnly ?? false,
      guideText: document.querySelector(".ai-provider-guide")?.textContent || "",
      guideHref: document.querySelector(".ai-provider-guide a")?.getAttribute("href") || "",
      localDisabled: document.querySelectorAll(".ai-provider-auth-mode > button")[1]?.disabled ?? false
    };
  });
  if (openAiTemplateState.provider !== "openai-native" || openAiTemplateState.model !== "gpt-5.6-terra" || openAiTemplateState.baseUrl !== "https://api.openai.com/v1" || !openAiTemplateState.providerReadOnly
    || !openAiTemplateState.guideText.includes("订阅") || !openAiTemplateState.guideText.includes("API 用量") || !openAiTemplateState.guideHref.includes("platform.openai.com/api-keys") || !openAiTemplateState.localDisabled) {
    throw new Error(`OpenAI provider template was not updated to the current Cline/API mapping: ${JSON.stringify(openAiTemplateState)}`);
  }
  await page.locator('.ai-provider-model-field [role="combobox"]').click();
  const openAiModels = await page.locator(".terminal-select-option").allTextContents();
  if (!openAiModels.some((text) => text.includes("GPT-5.6 Sol")) || !openAiModels.some((text) => text.includes("GPT-5.6 Terra")) || !openAiModels.some((text) => text.includes("GPT-5.6 Luna"))) {
    throw new Error(`OpenAI current model options are incomplete: ${JSON.stringify(openAiModels)}`);
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "返回供应商列表" }).click();
  await page.locator('[data-provider-template="deepseek"]').click();
  await page.waitForSelector(".ai-provider-form-grid");
  const templateState = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll(".ai-provider-form-grid input"));
    return {
      name: fields[0]?.value || "",
      provider: fields[1]?.value || "",
      model: document.querySelector('.ai-provider-model-field [role="combobox"]')?.getAttribute("data-value") || "",
      baseUrl: fields[2]?.value || "",
      providerReadOnly: fields[1]?.readOnly ?? false,
      guideText: document.querySelector(".ai-provider-guide")?.textContent || "",
      guideHref: document.querySelector(".ai-provider-guide a")?.getAttribute("href") || ""
    };
  });
  if (templateState.name !== "DeepSeek" || templateState.provider !== "deepseek" || templateState.model !== "deepseek-v4-pro" || templateState.baseUrl !== "https://api.deepseek.com/v1" || !templateState.providerReadOnly
    || !templateState.guideText.includes("创建 API Key") || !templateState.guideHref.includes("platform.deepseek.com/api_keys")) {
    throw new Error(`DeepSeek provider template was not applied: ${JSON.stringify(templateState)}`);
  }
  await page.locator('.ai-provider-model-field [role="combobox"]').click();
  await page.locator(".terminal-select-option", { hasText: "自定义 Model ID" }).click();
  await page.locator('.ai-provider-model-field input[aria-label="Model ID"]').fill("deepseek-custom-model");
  await page.locator(".ai-provider-model-field button", { hasText: "选择推荐模型" }).click();
  const restoredModel = await page.locator('.ai-provider-model-field [role="combobox"]').getAttribute("data-value");
  if (restoredModel !== "deepseek-v4-pro") {
    throw new Error(`recommended model selection did not recover after custom input: ${JSON.stringify({ restoredModel })}`);
  }
  await page.getByRole("button", { name: "添加到配置列表" }).click();
  await page.waitForSelector(".ai-current-model-row");
  const multiModelState = await page.evaluate(() => ({
    modelRows: document.querySelectorAll(".ai-model-config-row").length,
    // The only configured model must be marked as the one the assistants use.
    activeRows: document.querySelectorAll(".ai-model-config-row.is-active").length,
    activeBadges: document.querySelectorAll(".ai-model-config-row__badge").length,
    selectedName: document.querySelector(".ai-model-config-editor input")?.value || "",
    firstSetupVisible: Boolean(document.querySelector(".ai-first-setup"))
  }));
  if (multiModelState.modelRows !== 1 || multiModelState.selectedName !== "DeepSeek" || multiModelState.firstSetupVisible) {
    throw new Error(`AI first setup did not enter multi-model editing: ${JSON.stringify(multiModelState)}`);
  }
  if (multiModelState.activeRows !== 1 || multiModelState.activeBadges !== 1) {
    throw new Error(`the configured model must be marked as currently used: ${JSON.stringify(multiModelState)}`);
  }
  if (!await page.locator(".ai-model-config-editor > .ai-provider-guide").count()) {
    throw new Error("selected AI model editor should retain its provider access guide");
  }
  if (await page.getByRole("button", { name: "测试选中模型" }).count() !== 1) {
    throw new Error("AI model connection action should explicitly target the selected model");
  }
  const notificationCenter = page.locator('.notification-center');
  if (await notificationCenter.isVisible()) {
    await page.getByTitle("关闭通知中心").click();
  }
  await page.getByRole("button", { name: "新增配置" }).click();
  await page.locator('[data-provider-template="deepseek"]').click();
  const duplicateName = await page.locator(".ai-provider-form-grid input").first().inputValue();
  if (duplicateName !== "DeepSeek-1") {
    throw new Error(`duplicate AI provider name should be disambiguated: ${JSON.stringify({ duplicateName })}`);
  }
  await page.getByRole("button", { name: "返回供应商列表" }).click();
  await page.locator('[data-provider-template="custom"]').click();
  const customState = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll(".ai-provider-form-grid input"));
    return {
      name: fields[0]?.value || "",
      provider: fields[1]?.value || "",
      providerReadOnly: fields[1]?.readOnly ?? true,
      modelInput: document.querySelector('.ai-provider-model-field input[aria-label="Model ID"]')?.value ?? null,
      baseUrl: fields[3]?.value || fields[2]?.value || ""
    };
  });
  if (customState.name !== "自定义模型" || customState.provider !== "openai-compatible" || customState.providerReadOnly || customState.modelInput === null || customState.baseUrl !== "") {
    throw new Error(`custom AI provider should preserve the manual form: ${JSON.stringify(customState)}`);
  }
  await page.getByRole("button", { name: "取消" }).last().click();

  await page.locator(".settings-page-tabs button", { hasText: "Skills" }).click();
  await page.waitForSelector(".skills-settings-pane", { timeout: 5_000 });
  const skillState = await page.evaluate(() => {
    const required = ["desic-core-operations", "trading-philosophy", "okx-market-intelligence", "desic-trade-operations"];
    return required.map((id) => {
      const item = Array.from(document.querySelectorAll(".skill-option")).find((node) => node.textContent?.includes(id));
      const checkbox = item?.querySelector("input[type='checkbox']");
      return { id, present: Boolean(item), checked: checkbox?.checked ?? false, disabled: checkbox?.disabled ?? false, text: item?.textContent?.trim() || "" };
    });
  });
  if (skillState.some((item) => !item.present || !item.checked || !item.disabled)) {
    throw new Error(`required Skills must be checked and locked: ${JSON.stringify(skillState)}`);
  }
  const tradingSkillState = skillState.find((item) => item.id === "trading-philosophy");
  if (!tradingSkillState?.text.includes("必需 · 可定制")) {
    throw new Error(`trading philosophy should be required and customizable: ${JSON.stringify(tradingSkillState)}`);
  }

  await page.locator(".settings-page-tabs button", { hasText: "账号" }).click();
  await page.waitForSelector(".account-config-guide", { timeout: 5_000 });
  const guideState = await page.evaluate(() => ({
    open: document.querySelector(".account-config-guide-trigger")?.getAttribute("aria-expanded") === "true",
    text: document.querySelector(".account-config-guide")?.textContent?.trim() || "",
    href: document.querySelector(".account-config-guide a")?.getAttribute("href") || "",
    readChecked: document.querySelectorAll(".permission-row input")[0]?.checked ?? false,
    tradeChecked: document.querySelectorAll(".permission-row input")[1]?.checked ?? false,
    withdrawChecked: document.querySelectorAll(".permission-row input")[2]?.checked ?? true,
    withdrawDisabled: document.querySelectorAll(".permission-row input")[2]?.disabled ?? false,
    bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));
  if (!guideState.open || !guideState.text.includes("API 交易") || !guideState.text.includes("暂不配置") || !guideState.href.includes("/account/my-api")) {
    throw new Error(`settings account guide is incomplete: ${JSON.stringify(guideState)}`);
  }
  if (!guideState.readChecked || !guideState.tradeChecked || guideState.withdrawChecked || !guideState.withdrawDisabled || guideState.bodyOverflowX > 2) {
    throw new Error(`settings account permission defaults are unsafe: ${JSON.stringify(guideState)}`);
  }
}

function assertAccountModalLayout(state, label) {
  if (!state.backdrop || !state.shell || !state.head || !state.list || !state.form || !state.closeButton) {
    throw new Error(`account modal missing layout parts on ${label}: ${JSON.stringify(state)}`);
  }
  if (state.shellRadius < 14 || state.closeRadius < 14) {
    throw new Error(`account modal should use rounded shell/buttons on ${label}: ${JSON.stringify(state)}`);
  }
  if (state.bodyOverflowX > 2) {
    throw new Error(`account modal creates global horizontal overflow on ${label}: ${JSON.stringify(state)}`);
  }
  if (rectsOverlap(state.list, state.form)) {
    throw new Error(`account modal list overlaps form on ${label}: ${JSON.stringify(state)}`);
  }
  if (!/保留原 Key|OK-ACCESS-KEY/.test(state.apiPlaceholder) || state.secretType !== "password" || state.passphraseType !== "password") {
    throw new Error(`account modal credential fields are not safe on ${label}: ${JSON.stringify(state)}`);
  }
}

async function verifyTradeTicket(page) {
  const forbiddenCopy = await page.evaluate(() => {
    const text = document.querySelector(".ticket")?.textContent || "";
    return [
      "下单前风控",
      "交易环境",
      "WebSocket",
      "business connected",
      "账户数据",
      "已同步",
      "本地合约规则已加载",
      "等待合约规则缓存"
    ].filter((item) => text.includes(item));
  });
  if (forbiddenCopy.length > 0) {
    throw new Error(`trade ticket still shows removed noisy copy: ${forbiddenCopy.join(", ")}`);
  }

  const openState = await readTradeTicketState(page);
  if (openState.activeTab !== "开仓") throw new Error(`trade ticket should default to open tab: ${JSON.stringify(openState)}`);
  assertTradeButtons(openState, ["做多", "做空"], ["平多", "平空"]);

  await page.locator(".ticket-tabs button", { hasText: "平仓" }).click();
  await page.waitForTimeout(100);
  const closeState = await readTradeTicketState(page);
  if (closeState.activeTab !== "平仓") throw new Error(`trade ticket did not switch to close tab: ${JSON.stringify(closeState)}`);
  assertTradeButtons(closeState, ["平多", "平空"], ["做多", "做空"]);

  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    return {
      ticket: rect(".ticket"),
      marketDepth: rect(".market-depth"),
      orderbook: rect(".orderbook"),
      aiFloat: rect(".ai-float"),
      emptyAccount: rect(".empty-account"),
      tradeButtons: Array.from(document.querySelectorAll(".trade-buttons button")).map((button) => {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          text: button.textContent?.trim() || "",
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          radius: parseFloat(style.borderTopLeftRadius) || 0,
          background: style.backgroundImage !== "none" ? style.backgroundImage : style.backgroundColor,
          repeatedDisabledReason: Boolean(button.querySelector(".trade-disabled-reason"))
        };
      })
    };
  });
  if (!layout.ticket || !layout.marketDepth || rectsOverlap(layout.ticket, layout.marketDepth)) {
    throw new Error(`trade ticket overlaps market depth: ${JSON.stringify(layout)}`);
  }
  if (!layout.orderbook || rectsOverlap(layout.ticket, layout.orderbook)) {
    throw new Error(`trade ticket overlaps orderbook: ${JSON.stringify(layout)}`);
  }
  if (layout.tradeButtons.length !== 2) {
    throw new Error(`trade ticket should render exactly 2 action buttons per mode: ${JSON.stringify(layout)}`);
  }
  if (!layout.emptyAccount || layout.emptyAccount.height > 72) {
    throw new Error(`trade ticket empty account state should stay compact: ${JSON.stringify(layout.emptyAccount)}`);
  }
  for (const button of layout.tradeButtons) {
    if (button.height < 48 || button.width < 80 || button.radius < 6 || button.radius > 10) {
      throw new Error(`trade action button is not visually stable/rounded enough: ${JSON.stringify(button)}`);
    }
    if (!/rgb/i.test(button.background) || /rgba\(0, 0, 0, 0\)/i.test(button.background)) {
      throw new Error(`trade action button has missing financial color background: ${JSON.stringify(button)}`);
    }
    if (button.repeatedDisabledReason) {
      throw new Error(`trade action button should not repeat the shared blocker reason: ${JSON.stringify(button)}`);
    }
    if (layout.aiFloat && rectsOverlap(button, layout.aiFloat)) {
      throw new Error(`AI launcher overlaps a trade action button: ${JSON.stringify({ button, aiFloat: layout.aiFloat })}`);
    }
  }
}

async function readTradeTicketState(page) {
  return page.evaluate(() => {
    const activeTab = document.querySelector(".ticket-tabs .active")?.textContent?.trim() || "";
    const buttons = Array.from(document.querySelectorAll(".trade-buttons button")).map((button) => {
      const box = button.getBoundingClientRect();
      return {
        text: button.querySelector(".trade-label")?.textContent?.trim() || button.textContent?.trim() || "",
        hint: button.querySelector(".trade-hint")?.textContent?.trim() || "",
        disabled: button.disabled,
        width: box.width,
        height: box.height
      };
    });
    const emptyAccount = document.querySelector(".empty-account")?.textContent?.trim() || "";
    return { activeTab, buttons, emptyAccount };
  });
}

function assertTradeButtons(state, expectedLabels, forbiddenLabels) {
  const labels = state.buttons.map((button) => button.text);
  for (const label of expectedLabels) {
    if (!labels.includes(label)) throw new Error(`trade ticket missing ${label}: ${JSON.stringify(state)}`);
  }
  for (const label of forbiddenLabels) {
    if (labels.includes(label)) throw new Error(`trade ticket should not show ${label} in current tab: ${JSON.stringify(state)}`);
  }
  if (labels.length !== expectedLabels.length) throw new Error(`trade ticket action count mismatch: ${JSON.stringify(state)}`);
  if (!/未配置账号|添加 OKX 账号/.test(state.emptyAccount)) {
    throw new Error(`trade ticket should explain missing account state: ${JSON.stringify(state)}`);
  }
}

async function openMarketPicker(page) {
  if (await page.locator(".market-picker").count()) return;
  await page.locator(".market-title__trigger").click();
  await page.waitForSelector(".market-picker", { timeout: 10_000 });
}

async function closeMarketPicker(page) {
  if (!(await page.locator(".market-picker").count())) return;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

async function verifyWatchlistRows(page, label) {
  // The watchlist moved out of a fixed rail and into the market picker that hangs
  // off the title bar, so it has to be opened before its rows can be inspected.
  await openMarketPicker(page);
  const rows = await page.locator(".market-picker__pick").count();
  if (rows < 1) throw new Error(`watchlist rows are missing on ${label}`);

  const rowChecks = await page.locator(".market-picker__pick").evaluateAll((nodes) =>
    nodes.slice(0, 8).map((node) => {
      const row = node;
      const icon = row.querySelector(".symbol-icon");
      const main = row.querySelector(".market-picker__ident");
      const name = row.querySelector(".market-picker__ident strong");
      const state = row.querySelector(".market-picker__ident small");
      const quote = row.querySelector(".symbol-quote");
      const price = row.querySelector(".symbol-quote strong");
      const change = row.querySelector(".symbol-quote em");
      const img = row.querySelector(".symbol-icon img");
      const rect = (item) => {
        const box = item?.getBoundingClientRect();
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      };
      return {
        row: rect(row),
        icon: rect(icon),
        main: rect(main),
        name: rect(name),
        state: rect(state),
        quote: rect(quote),
        price: rect(price),
        change: rect(change),
        hasImage: Boolean(img),
        naturalWidth: img?.naturalWidth || 0,
        naturalHeight: img?.naturalHeight || 0,
        nameText: name?.textContent?.trim() || "",
        stateText: state?.textContent?.trim() || "",
        priceText: price?.textContent?.trim() || "",
        changeText: change?.textContent?.trim() || ""
      };
    })
  );
  for (const [index, item] of rowChecks.entries()) {
    if (!item.row || !item.icon || !item.main || !item.name || !item.state || !item.quote || !item.price || !item.change) {
      throw new Error(`watchlist row ${index} missing layout parts on ${label}: ${JSON.stringify(item)}`);
    }
    const overlaps = [
      ["icon/name", item.icon, item.name],
      ["icon/state", item.icon, item.state],
      ["icon/quote", item.icon, item.quote],
      ["icon/price", item.icon, item.price],
      ["icon/change", item.icon, item.change],
      ["main/quote", item.main, item.quote],
      ["name/quote", item.name, item.quote],
      ["state/quote", item.state, item.quote],
      ["name/price", item.name, item.price],
      ["state/change", item.state, item.change],
      ["price/change", item.price, item.change],
      ["name/state", item.name, item.state]
    ].filter(([, a, b]) => rectsOverlap(a, b));
    if (overlaps.length > 0) {
      throw new Error(`watchlist row ${index} overlaps on ${label}: ${overlaps.map(([name]) => name).join(", ")} ${JSON.stringify(item)}`);
    }
    if (item.nameText.length === 0 || item.stateText.length === 0 || item.priceText.length === 0 || item.changeText.length === 0) {
      throw new Error(`watchlist row ${index} has empty text on ${label}: ${JSON.stringify(item)}`);
    }
    if (item.hasImage && (item.naturalWidth <= 0 || item.naturalHeight <= 0)) {
      throw new Error(`watchlist row ${index} image did not load on ${label}: ${JSON.stringify(item)}`);
    }
    if (!item.hasImage) {
      throw new Error(`watchlist row ${index} did not use cached/local icon image on ${label}: ${JSON.stringify(item)}`);
    }
  }

  const imageCount = rowChecks.filter((item) => item.hasImage && item.naturalWidth > 0 && item.naturalHeight > 0).length;
  const watchedRows = await page.locator(".market-picker__star.is-on").count();
  if (imageCount !== rowChecks.length) {
    throw new Error(`watchlist should render loaded cached/local icons for every checked row on ${label}: ${imageCount}/${rowChecks.length}`);
  }

  await page.setViewportSize({ width: 1180, height: 720 });
  await page.waitForTimeout(250);
  if (label !== "compact") await verifyWatchlistRows(page, "compact");
  if (label !== "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  return { rows, watchedRows, imageCount };
}

async function verifyWatchlistCollapse(page) {
  // There is no collapsible rail any more. The guarantee is that the chart owns
  // the full width and the watchlist is reachable from the title bar: opening the
  // market picker must not resize the layout underneath it.
  const layout = await page.evaluate(() => {
    const grid = document.querySelector(".content-grid");
    const center = document.querySelector(".center-panel");
    return {
      railPresent: Boolean(document.querySelector(".watchlist")),
      handlePresent: Boolean(document.querySelector(".watchlist-toggle")),
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      centerLeft: center ? Math.round(center.getBoundingClientRect().x) : -1,
      gridLeft: grid ? Math.round(grid.getBoundingClientRect().x) : -1
    };
  });
  if (layout.railPresent || layout.handlePresent || layout.columns !== 3 || layout.centerLeft !== layout.gridLeft) {
    throw new Error(`watchlist rail should be gone and the chart flush left: ${JSON.stringify(layout)}`);
  }

  const centerWidth = (await page.locator(".center-panel").boundingBox())?.width || 0;
  await openMarketPicker(page);
  const open = await page.evaluate(() => {
    const menu = document.querySelector(".market-picker");
    const trigger = document.querySelector(".market-title__trigger");
    const menuBox = menu?.getBoundingClientRect();
    const triggerBox = trigger?.getBoundingClientRect();
    return {
      rows: document.querySelectorAll(".market-picker__pick").length,
      starred: document.querySelectorAll(".market-picker__star.is-on").length,
      searchFocused: Boolean(document.activeElement?.closest(".market-picker__search")),
      // The menu hangs directly off the market name it belongs to.
      anchored: Boolean(menuBox && triggerBox && Math.abs(menuBox.x - triggerBox.x) < 12 && menuBox.y > triggerBox.y),
      expanded: trigger?.getAttribute("aria-expanded")
    };
  });
  const centerWidthWithMenu = (await page.locator(".center-panel").boundingBox())?.width || 0;
  if (open.rows < 1 || open.starred < 1 || !open.searchFocused || !open.anchored || open.expanded !== "true"
    || Math.abs(centerWidthWithMenu - centerWidth) > 1) {
    throw new Error(`market picker did not open as an anchored overlay: ${JSON.stringify({ open, centerWidth, centerWidthWithMenu })}`);
  }

  await closeMarketPicker(page);
  if (await page.locator(".market-picker").count()) {
    throw new Error("market picker did not close on Escape");
  }
}

async function verifyBottomPanelSymbolSwitch(page) {
  await page.locator(".bottom-tabs button", { hasText: "当前委托" }).click();
  await page.getByRole("tab", { name: /计划委托/ }).click();
  const ethButton = page.getByRole("button", { name: "切换到 ETH-USDT-SWAP" });
  if (await ethButton.count() !== 1) {
    throw new Error(`current order symbol should expose one ETH switch control, got ${await ethButton.count()}`);
  }
  await ethButton.click();
  await page.waitForFunction(() => {
    const text = document.querySelector(".ohlc-summary")?.textContent || "";
    const value = Number(text.match(/最新\s*([\d,.]+)/)?.[1]?.replaceAll(",", ""));
    return Number.isFinite(value) && value > 100 && value < 10_000;
  });
  await page.locator(".bottom-tabs button", { hasText: /^持仓/ }).first().click();
  const btcButton = page.getByRole("button", { name: "切换到 BTC-USDT-SWAP" });
  if (await btcButton.count() !== 1) {
    throw new Error(`position symbol should expose one BTC switch control, got ${await btcButton.count()}`);
  }
  await btcButton.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const text = document.querySelector(".ohlc-summary")?.textContent || "";
    const value = Number(text.match(/最新\s*([\d,.]+)/)?.[1]?.replaceAll(",", ""));
    return Number.isFinite(value) && value > 10_000;
  });
}

async function verifyChartSymbolSwitch(page) {
  // Switching markets now goes through the title-bar picker, which closes itself
  // on selection, so it is reopened for each switch.
  const symbolRow = async (base) => {
    await openMarketPicker(page);
    return page.locator(".market-picker__pick")
      .filter({ has: page.locator(".market-picker__ident strong", { hasText: base }) })
      .first();
  };
  const latestPrice = async () => {
    const text = await page.locator(".ohlc-summary").textContent();
    const match = text?.match(/最新\s*([\d,.]+)/);
    return Number(match?.[1]?.replaceAll(",", ""));
  };

  await (await symbolRow("ETH")).click();
  await page.waitForFunction(() => {
    const text = document.querySelector(".ohlc-summary")?.textContent || "";
    const value = Number(text.match(/最新\s*([\d,.]+)/)?.[1]?.replaceAll(",", ""));
    return Number.isFinite(value) && value > 100 && value < 10_000;
  });
  const ethPrice = await latestPrice();

  await (await symbolRow("BTC")).click();
  await page.waitForFunction(() => {
    const text = document.querySelector(".ohlc-summary")?.textContent || "";
    const value = Number(text.match(/最新\s*([\d,.]+)/)?.[1]?.replaceAll(",", ""));
    return Number.isFinite(value) && value > 10_000;
  });
  const btcPrice = await latestPrice();

  if (!(ethPrice > 100 && ethPrice < 10_000 && btcPrice > 10_000)) {
    throw new Error(`chart symbol switch retained stale candles: ${JSON.stringify({ ethPrice, btcPrice })}`);
  }
}

async function verifyChartTableExport(page) {
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await page.waitForSelector(".chart-data-table tbody tr", { timeout: 10_000 });
  const exportButton = page.getByRole("button", { name: "导出表格", exact: true });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10_000 }),
    exportButton.click()
  ]);
  const downloadPath = await download.path();
  const csv = downloadPath ? await readFile(downloadPath, "utf8") : "";
  if (!download.suggestedFilename().endsWith("-kline.csv") || !csv.includes('"时间","开","高","低","收","成交量"') || csv.length < 200) {
    throw new Error(`chart table CSV export is invalid: ${JSON.stringify({ suggestedFilename: download.suggestedFilename(), bytes: csv.length })}`);
  }
  if (!(await page.getByText(/已导出 .*kline\.csv/).count())) throw new Error("chart table export did not report completion");
  await page.getByRole("button", { name: "图表", exact: true }).click();
  await page.waitForSelector(".chart-kline-presentation:not(.is-hidden)", { timeout: 5_000 });
}

main().catch(async (error) => {
  process.stderr.write(`[smoke] terminal preview failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
