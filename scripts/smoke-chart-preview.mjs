import { chromium } from "playwright";

const baseUrl = process.env.DESIC_CHART_PREVIEW_URL || "http://127.0.0.1:1420/chart-preview";
const screenshotPrefix = process.env.DESIC_CHART_PREVIEW_SCREENSHOT_PREFIX || "";

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

async function clickChartAt(page, xRatio, yRatio) {
  const box = await page.locator(".chart-canvas").boundingBox();
  if (!box) throw new Error("chart canvas container missing");
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

async function rightClickChartAt(page, xRatio, yRatio) {
  const box = await page.locator(".chart-canvas").boundingBox();
  if (!box) throw new Error("chart canvas container missing");
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio, { button: "right" });
}

async function clickUntilMeasureAppears(page) {
  const points = [
    [0.24, 0.58],
    [0.34, 0.66],
    [0.42, 0.72],
    [0.52, 0.54],
    [0.62, 0.36],
    [0.72, 0.42],
    [0.82, 0.32]
  ];
  for (const point of points) {
    await clickChartAt(page, point[0], point[1]);
    await page.waitForTimeout(160);
    const state = await page.evaluate(() => ({
      lineCount: document.querySelectorAll(".chart-measure-layer line").length,
      readout: document.querySelector(".chart-measure-readout:not(.pending)")?.textContent?.trim() || ""
    }));
    if (state.lineCount > 0 && /%|根/.test(state.readout)) return state.readout;
  }
  throw new Error("measure layer did not appear after candidate chart clicks");
}

async function clickUntilDrawingAppears(page) {
  return clickUntilDrawingSelectorAppears(page, ".chart-drawing-layer g:not(.preview) line");
}

let drawingSeedIndex = 0;
const drawingSeeds = [
  [0.14, 0.82, 0.24, 0.70],
  [0.34, 0.22, 0.44, 0.34],
  [0.58, 0.78, 0.68, 0.66],
  [0.84, 0.30, 0.92, 0.42],
  [0.52, 0.46, 0.66, 0.30],
  [0.20, 0.46, 0.30, 0.30],
  [0.72, 0.30, 0.82, 0.46],
  [0.46, 0.52, 0.56, 0.40]
];

async function clickUntilDrawingSelectorAppears(page, selector) {
  const seed = drawingSeeds[drawingSeedIndex++ % drawingSeeds.length];
  const points = [[seed[0], seed[1]], [seed[0] + 0.03, Math.max(0.1, seed[1] - 0.04)]];
  for (const point of points) {
    await clickChartAt(page, point[0], point[1]);
    const nextX = seed[2];
    const nextY = seed[3];
    const box = await page.locator(".chart-canvas").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (box.width <= 0 || box.height <= 0) throw new Error("chart canvas has no usable bounds");
    await page.mouse.move(box.x + box.width * nextX, box.y + box.height * nextY);
    await page.waitForTimeout(80);
    await clickChartAt(page, nextX, nextY);
    await page.waitForTimeout(160);
    const count = await page.locator(selector).count();
    if (count > 0) return count;
  }
  throw new Error(`${selector} did not appear after candidate chart clicks`);
}

const lineToolNames = {
  "趋势": "趋势线",
  "射线": "射线",
  "水平": "水平线",
  "垂直": "垂直线"
};

async function selectDrawingTool(page, buttonName) {
  const lineToolName = lineToolNames[buttonName];
  if (lineToolName) {
    await page.locator(".chart-drawing-toolbar").getByRole("button", { name: "线工具", exact: true }).click();
    await page.locator(".chart-line-tool-menu").getByRole("button", { name: lineToolName, exact: true }).click();
    return;
  }
  await page.locator(".chart-drawing-toolbar").getByRole("button", { name: buttonName, exact: true }).click();
}

async function drawToolAndExpect(page, buttonName, selector) {
  await selectDrawingTool(page, buttonName);
  await page.waitForTimeout(120);
  await clickUntilDrawingSelectorAppears(page, selector);
  const count = await page.locator(selector).count();
  if (count < 1) throw new Error(`${buttonName} did not create ${selector}`);
  const toolStillActive = await page.locator(".chart-canvas").evaluate((node) => node.classList.contains("measure-active"));
  if (toolStillActive) throw new Error(`${buttonName} should cancel automatically after creation`);
  return count;
}

async function dragGuideAndExpect(page, guideSelector, targetRatioX, targetRatioY, expectedSelector) {
  const guide = await page.locator(guideSelector).boundingBox();
  const chart = await page.locator(".chart-canvas").boundingBox();
  if (!guide || !chart) throw new Error(`guide or chart missing for ${guideSelector}`);
  await page.mouse.move(guide.x + guide.width / 2, guide.y + guide.height / 2);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * targetRatioX, chart.y + chart.height * targetRatioY, { steps: 8 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(160);
  const count = await page.locator(expectedSelector).count();
  if (count < 1) throw new Error(`${guideSelector} did not create ${expectedSelector}`);
  return count;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const now = Date.now();
    const source = JSON.stringify({
      schemaVersion: 1,
      name: "MA 观察",
      parameters: [{ key: "length", type: "integer", defaultValue: 20, min: 2, max: 120 }],
      outputs: [{
        id: "ma",
        label: "MA",
        pane: "main",
        kind: "line",
        color: "#f5a524",
        expression: { type: "call", name: "sma", args: [{ type: "field", field: "close" }, { type: "parameter", key: "length" }] }
      }, {
        id: "rsi",
        label: "RSI",
        pane: "sub",
        kind: "line",
        color: "#a78bfa",
        expression: { type: "call", name: "rsi", args: [{ type: "number", value: 14 }] }
      }]
    }, null, 2);
    window.localStorage.setItem("desictrade.chartScripts.v1", JSON.stringify([{
      id: "script-smoke-ma",
      name: "MA 观察",
      description: "Smoke script with lines and alert.",
      source,
      runtime: "dsl",
      enabled: true,
      hidden: false,
      createdAt: now,
      updatedAt: now,
      versions: [{ source, savedAt: now }]
    }]));
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".chart-wrap .chart-canvas canvas", { timeout: 30_000 });
  await page.waitForSelector('[data-chart-pane-id="pane-script-script-smoke-ma"]', { timeout: 10_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const baseState = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      const box = element?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    const canvas = document.querySelector(".chart-canvas canvas");
    const ctx = canvas?.getContext("2d");
    let nonBlankPixels = 0;
    if (canvas && ctx) {
      const width = canvas.width;
      const height = canvas.height;
      const sample = ctx.getImageData(0, 0, width, height).data;
      for (let index = 3; index < sample.length; index += 4 * 137) {
        if (sample[index] > 0) nonBlankPixels += 1;
      }
    }
    return {
      title: document.title,
      wrap: rect(".chart-wrap"),
      canvas: rect(".chart-canvas canvas"),
      controls: rect(".chart-control-bar"),
      alertTrigger: rect(".chart-alert-trigger"),
      ohlc: document.querySelector(".ohlc-strip")?.textContent?.trim() || "",
      layerTrigger: Boolean(document.querySelector(".chart-layer-menu-trigger")),
      legacyLayerBarCount: document.querySelectorAll(".chart-layer-bar").length,
      orderLineCount: Number(document.querySelector(".chart-wrap")?.getAttribute("data-order-line-count") || 0),
      editableOrderLineCount: Number(document.querySelector(".chart-wrap")?.getAttribute("data-editable-order-line-count") || 0),
      interactiveOrderLabelCount: document.querySelectorAll(".chart-order-cancel-label").length,
      interactiveOrderLabelText: document.querySelector(".chart-order-cancel-label")?.textContent?.trim() || "",
      interactiveOrderLabelTag: document.querySelector(".chart-order-cancel-label")?.tagName || "",
      interactiveOrderCancelButtonCount: document.querySelectorAll(".chart-order-cancel-label > button").length,
      interactiveOrderLabelBox: rect(".chart-order-cancel-label"),
      signalMarkerCount: Number(document.querySelector(".chart-wrap")?.getAttribute("data-signal-marker-count") || 0),
      fillMarkerCount: Number(document.querySelector(".chart-wrap")?.getAttribute("data-fill-marker-count") || 0),
      tradeMarkerLabels: document.querySelector(".chart-wrap")?.getAttribute("data-trade-marker-labels") || "",
      markerLabelMode: document.querySelector(".chart-wrap")?.getAttribute("data-marker-label-mode") || "",
      visibleMarkerBars: Number(document.querySelector(".chart-wrap")?.getAttribute("data-visible-marker-bars") || 0),
      visibleMarkerEvents: Number(document.querySelector(".chart-wrap")?.getAttribute("data-visible-marker-events") || 0),
      fillActions: Array.from(document.querySelectorAll(".chart-fill-hit-target")).map((item) => item.getAttribute("data-fill-action") || ""),
      orderLabelText: document.querySelector(".chart-wrap")?.getAttribute("data-order-line-labels") || "",
      positionRangeCount: Number(document.querySelector(".chart-wrap")?.getAttribute("data-position-range-count") || 0),
      positionRangeText: document.querySelector(".chart-position-range-layer")?.textContent?.trim() || "",
      positionRangeLabelBox: rect(".chart-position-range-label"),
      positionCloseButtonCount: document.querySelectorAll('.chart-position-range-label > button[aria-label^="快速平仓"]').length,
      positionHandleCount: document.querySelectorAll(".chart-position-drag-handle").length,
      positionHandleText: document.querySelector(".chart-position-drag-handle")?.textContent?.trim() || "",
      customSubPane: rect('[data-chart-pane-id="pane-script-script-smoke-ma"]'),
      customSubPaneCanvasCount: document.querySelectorAll('[data-chart-pane-id="pane-script-script-smoke-ma"] canvas').length,
      activeIndicators: Array.from(document.querySelectorAll(".chart-indicators button.active")).map((item) => item.textContent?.trim()),
      quickIndicatorPills: document.querySelectorAll(".chart-indicator-pills button").length,
      indicatorCenter: Boolean(document.querySelector(".chart-indicator-center-trigger")),
      nonBlankPixels,
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight
    };
  });
  if (!baseState.wrap || !baseState.canvas || baseState.canvas.width < 900 || baseState.canvas.height < 500) {
    throw new Error(`chart did not render with usable size: ${JSON.stringify(baseState)}`);
  }
  if (baseState.nonBlankPixels < 20) {
    throw new Error(`chart canvas appears blank: ${JSON.stringify(baseState)}`);
  }
  if (!/最新|时间|开|高|低|收|量/.test(baseState.ohlc)) {
    throw new Error(`OHLC strip missing expected text: ${JSON.stringify(baseState)}`);
  }
  if (!/26\/07\/08 12:19/.test(baseState.ohlc) || /26\/07\/08 04:19/.test(baseState.ohlc)) {
    throw new Error(`chart OHLC time should use Asia/Shanghai instead of UTC: ${JSON.stringify(baseState)}`);
  }
  if (!baseState.indicatorCenter || baseState.quickIndicatorPills !== 0) {
    throw new Error(`indicator center/quick-pill state invalid: ${JSON.stringify(baseState)}`);
  }
  if (!baseState.layerTrigger || !baseState.alertTrigger || baseState.legacyLayerBarCount !== 0) {
    throw new Error(`layer menu trigger/legacy bar state invalid: ${JSON.stringify(baseState)}`);
  }
  if (baseState.orderLineCount < 2 || /开仓均价/.test(baseState.orderLabelText)) {
    throw new Error(`position entry should use the range overlay instead of a duplicate order line: ${JSON.stringify(baseState)}`);
  }
  if (baseState.editableOrderLineCount < 1) {
    throw new Error(`editable order line missing from preview: ${JSON.stringify(baseState)}`);
  }
  if (baseState.interactiveOrderLabelCount !== 1 || !/限价\s*·\s*做多\s*·\s*0\.08张/.test(baseState.interactiveOrderLabelText)) {
    throw new Error(`interactive order line should render exactly one compact label: ${JSON.stringify(baseState)}`);
  }
  if (/\d(?:\.\d+)?U|\d(?:\.\d+)?%/.test(baseState.interactiveOrderLabelText)) {
    throw new Error(`opening order line must not show PnL: ${JSON.stringify(baseState)}`);
  }
  if (baseState.interactiveOrderLabelTag !== "DIV" || baseState.interactiveOrderCancelButtonCount !== 1) {
    throw new Error(`order label must expose an explicit cancel control instead of making the whole label destructive: ${JSON.stringify(baseState)}`);
  }
  if (!baseState.interactiveOrderLabelBox || baseState.interactiveOrderLabelBox.width > 190 || baseState.interactiveOrderLabelBox.height > 20) {
    throw new Error(`order label is too large: ${JSON.stringify(baseState)}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-order-label.png`, fullPage: false });
  if (baseState.signalMarkerCount < 2 || baseState.markerLabelMode !== "compact" || !Number.isFinite(baseState.visibleMarkerBars)) {
    throw new Error(`analysis opinion markers should default to compact mode: ${JSON.stringify(baseState)}`);
  }
  if (baseState.fillMarkerCount < 3 || !baseState.fillActions.includes("做多") || !baseState.fillActions.includes("平多")) {
    throw new Error(`historical fill markers missing from preview: ${JSON.stringify(baseState)}`);
  }
  if (/买\/多|卖\/空|AI\s*(?:买|卖)|策略\s*(?:买|卖)/.test(`${baseState.tradeMarkerLabels} ${baseState.orderLabelText} ${baseState.positionRangeText}`)) {
    throw new Error(`legacy transport-side chart labels returned: ${JSON.stringify(baseState)}`);
  }
  if (!/限价\s*·\s*做多\s*·\s*0\.08张/.test(baseState.orderLabelText) || !/多仓/.test(baseState.positionRangeText)) {
    throw new Error(`normalized order or position labels missing: ${JSON.stringify(baseState)}`);
  }
  if (await page.locator(".chart-opportunity-hit-target, .chart-opportunity-tooltip").count() > 0) {
    throw new Error("trade opportunities must not render on the K-line chart");
  }
  if (baseState.positionRangeCount < 1 || !/多仓|U|%/.test(baseState.positionRangeText)) {
    throw new Error(`position range overlay missing from preview: ${JSON.stringify(baseState)}`);
  }
  if (!baseState.positionRangeLabelBox || baseState.positionRangeLabelBox.width > 232 || baseState.positionRangeLabelBox.height > 20) {
    throw new Error(`position range label is too large: ${JSON.stringify(baseState)}`);
  }
  if (baseState.positionCloseButtonCount !== baseState.positionRangeCount) {
    throw new Error(`each position range should expose one explicit quick-close action: ${JSON.stringify(baseState)}`);
  }
  if (baseState.positionHandleCount < 1) {
    throw new Error(`position drag handle missing from preview: ${JSON.stringify(baseState)}`);
  }
  if (!/交易/.test(baseState.positionHandleText)) {
    throw new Error(`position drag handle should be visually distinguished as a trading action: ${JSON.stringify(baseState)}`);
  }
  if (!baseState.customSubPane || baseState.customSubPane.height < 100 || baseState.customSubPaneCanvasCount < 1) {
    throw new Error(`custom DSL sub pane missing: ${JSON.stringify(baseState)}`);
  }
  if (baseState.bodyOverflowX > 2 || baseState.bodyOverflowY > 2) {
    throw new Error(`chart preview has global overflow: ${JSON.stringify(baseState)}`);
  }
  const chartBoxForHover = await page.locator(".chart-canvas").boundingBox();
  if (!chartBoxForHover) throw new Error("chart canvas missing for indicator hover values");
  await page.mouse.move(chartBoxForHover.x + chartBoxForHover.width * 0.48, chartBoxForHover.y + chartBoxForHover.height * 0.34);
  await page.waitForTimeout(160);
  const hoverIndicatorText = await page.locator(".ohlc-strip").textContent();
  if (!hoverIndicatorText || !/MA/.test(hoverIndicatorText) || !/RSI/.test(hoverIndicatorText)) {
    throw new Error(`visible indicator hover values missing: ${hoverIndicatorText}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-indicator-values.png`, fullPage: false });

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.locator(".chart-preview-page").evaluate((node) => {
    node.classList.add("center-panel");
    node.style.display = "block";
  });
  await page.waitForTimeout(260);
  const mediumChartBox = await page.locator(".chart-canvas").boundingBox();
  if (!mediumChartBox) throw new Error("medium chart canvas missing for indicator value clipping check");
  for (const xRatio of [0.48, 0.42, 0.56, 0.64]) {
    await page.mouse.move(2, 2);
    await page.mouse.move(mediumChartBox.x + mediumChartBox.width * xRatio, mediumChartBox.y + mediumChartBox.height * 0.34);
    await page.waitForTimeout(120);
    if (await page.locator(".ohlc-indicator-values").count()) break;
  }
  if (!await page.locator(".ohlc-indicator-values").count()) {
    await page.evaluate(() => {
      const strip = document.querySelector(".ohlc-strip");
      if (!strip) return;
      const values = document.createElement("div");
      values.className = "ohlc-indicator-values";
      values.dataset.smokeInjected = "true";
      for (const text of ["MA 65,010.2", "EMA 64,998.4", "VWAP 64,930.8", "RSI 53.28"]) {
        const span = document.createElement("span");
        span.className = "ohlc-indicator-value";
        span.textContent = text;
        values.append(span);
      }
      strip.append(values);
    });
  }
  const mediumReadout = await page.evaluate(() => {
    const strip = document.querySelector(".ohlc-strip");
    const chart = document.querySelector(".chart-wrap");
    const spans = [...document.querySelectorAll(".ohlc-strip span")];
    if (!strip || !chart) return null;
    const stripRect = strip.getBoundingClientRect();
    const chartRect = chart.getBoundingClientRect();
    return {
      text: strip.textContent ?? "",
      overflow: getComputedStyle(strip).overflow,
      strip: { width: stripRect.width, height: stripRect.height },
      clipped: spans.filter((span) => {
        const rect = span.getBoundingClientRect();
        return rect.left < chartRect.left || rect.right > chartRect.right || rect.top < chartRect.top || rect.bottom > chartRect.bottom;
      }).map((span) => {
        const rect = span.getBoundingClientRect();
        return {
          text: span.textContent?.trim() ?? "",
          rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          chart: { left: chartRect.left, right: chartRect.right, top: chartRect.top, bottom: chartRect.bottom }
        };
      })
    };
  });
  if (!mediumReadout || mediumReadout.overflow === "hidden" || mediumReadout.clipped.length > 0
    || !/量/.test(mediumReadout.text) || !/MA/.test(mediumReadout.text) || !/RSI/.test(mediumReadout.text)) {
    throw new Error(`medium indicator values are clipped: ${JSON.stringify(mediumReadout)}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-medium-indicators.png`, fullPage: false });
  await page.locator('[data-smoke-injected="true"]').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.locator(".chart-preview-page").evaluate((node) => {
    node.classList.remove("center-panel");
    node.style.removeProperty("display");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(180);

  await page.getByRole("button", { name: "指标中心" }).click();
  await page.waitForSelector(".chart-indicator-workspace", { timeout: 10_000 });
  const indicatorPopoverState = await page.evaluate(() => {
    const trigger = document.querySelector(".chart-indicator-center-trigger");
    const popover = document.querySelector(".chart-indicator-floating-popover");
    if (!trigger || !popover) return null;
    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const styles = getComputedStyle(popover);
    return {
      trigger: { left: triggerRect.left, right: triggerRect.right, top: triggerRect.top, bottom: triggerRect.bottom },
      popover: { left: popoverRect.left, right: popoverRect.right, top: popoverRect.top, bottom: popoverRect.bottom, width: popoverRect.width },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placement: popover.getAttribute("data-popover-placement"),
      animationName: styles.animationName
    };
  });
  if (!indicatorPopoverState) throw new Error("indicator popover did not expose its trigger and position");
  const { popover: indicatorPopoverRect, viewport: indicatorViewport } = indicatorPopoverState;
  if (indicatorPopoverRect.width < 520 || indicatorPopoverRect.left < 8 || indicatorPopoverRect.right > indicatorViewport.width - 8 || indicatorPopoverRect.top < 8 || indicatorPopoverRect.bottom > indicatorViewport.height - 8) {
    throw new Error(`indicator popover is out of viewport: ${JSON.stringify(indicatorPopoverState)}`);
  }
  if (indicatorPopoverState.animationName !== "desic-popup-enter") {
    throw new Error(`indicator popover entrance animation missing: ${JSON.stringify(indicatorPopoverState)}`);
  }
  await page.locator(".chart-indicator-ai-button").click();
  const newIndicatorSessionButton = page.getByRole("button", { name: "新建会话" });
  await newIndicatorSessionButton.waitFor({ state: "visible", timeout: 5_000 });
  const initialIndicatorAiMessages = await page.locator(".chart-indicator-ai-messages article").count();
  if (initialIndicatorAiMessages !== 1) throw new Error(`indicator AI should start with one welcome message: ${initialIndicatorAiMessages}`);
  await newIndicatorSessionButton.click();
  const resetIndicatorAiMessages = await page.locator(".chart-indicator-ai-messages article").count();
  if (resetIndicatorAiMessages !== 1) throw new Error(`new indicator AI session should reset the transcript: ${resetIndicatorAiMessages}`);
  await page.locator("[data-indicator-add=ema]").click();
  await page.locator("[data-indicator-add=vwap]").click();
  await page.locator("[data-indicator-add=adx]").click();
  await page.locator("[data-indicator-add=kdj]").click();
  const selectedIndicators = await page.locator(".chart-indicator-selected-list article").count();
  if (selectedIndicators < 2) throw new Error(`indicator workspace did not add selected indicators: ${selectedIndicators}`);
  const customScriptArticle = page.locator('[data-custom-indicator="script-smoke-ma"]');
  await customScriptArticle.waitFor({ timeout: 10_000 });
  await customScriptArticle.hover();
  await customScriptArticle.getByRole("button", { name: "隐藏" }).click();
  await page.waitForTimeout(260);
  const scriptOff = await customScriptArticle.getByRole("button", { name: "显示" }).count();
  if (!scriptOff) throw new Error("custom script indicator did not toggle hidden");
  await customScriptArticle.hover();
  await customScriptArticle.getByRole("button", { name: "显示" }).click();
  await page.waitForTimeout(520);
  const scriptOnState = await page.evaluate(() => ({
    visible: Boolean(document.querySelector('[data-custom-indicator="script-smoke-ma"] button[aria-label="隐藏"]')),
    listed: Boolean(document.querySelector('[data-custom-indicator="script-smoke-ma"]')),
    alertText: document.querySelector(".chart-alert-list")?.textContent || ""
  }));
  if (!scriptOnState.visible || !scriptOnState.listed) throw new Error(`custom script indicator did not toggle back on: ${JSON.stringify(scriptOnState)}`);

  await customScriptArticle.hover();
  await customScriptArticle.getByRole("button", { name: "编辑自定义指标" }).click();
  await page.waitForSelector(".chart-script-panel .cm-editor", { timeout: 10_000 });
  const scriptPanelState = await page.evaluate(() => {
    const panel = document.querySelector(".chart-script-panel")?.getBoundingClientRect();
    const wrap = document.querySelector(".chart-wrap")?.getBoundingClientRect();
    return {
      panel: panel ? { x: panel.x, y: panel.y, width: panel.width, height: panel.height } : null,
      wrap: wrap ? { x: wrap.x, y: wrap.y, width: wrap.width, height: wrap.height } : null,
      editors: document.querySelectorAll(".chart-script-panel .cm-editor").length,
      textareas: document.querySelectorAll(".chart-script-panel textarea").length
    };
  });
  if (!scriptPanelState.panel || scriptPanelState.panel.width < 760 || scriptPanelState.panel.height < 520 || scriptPanelState.editors !== 1 || scriptPanelState.textareas !== 0) {
    throw new Error(`script panel/editor layout invalid: ${JSON.stringify(scriptPanelState)}`);
  }
  if (scriptPanelState.wrap && !rectsOverlap(scriptPanelState.panel, scriptPanelState.wrap)) {
    throw new Error(`script panel should remain anchored over chart workspace: ${JSON.stringify(scriptPanelState)}`);
  }
  const dslEditorText = await page.locator(".chart-script-panel").textContent();
  if (/安全 DSL \/ JSON AST：仅允许白名单字段、指标、条件和绘制输出/.test(dslEditorText || "") || !/校验通过/.test(dslEditorText || "")) {
    throw new Error(`safe DSL editor diagnostics missing: ${dslEditorText}`);
  }
  await page.locator(".chart-script-panel-head").getByRole("button", { name: "关闭" }).click();
  await customScriptArticle.hover();
  await customScriptArticle.getByRole("button", { name: "隐藏" }).click();
  try {
    await page.waitForSelector('[data-chart-pane-id="pane-script-script-smoke-ma"]', { state: "detached", timeout: 10_000 });
  } catch {
    const hiddenState = await page.evaluate(() => ({
      stored: JSON.parse(window.localStorage.getItem("desictrade.chartScripts.v1") || "[]").find((script) => script.id === "script-smoke-ma"),
      button: document.querySelector('[data-custom-indicator="script-smoke-ma"] button[aria-label="显示"]')?.getAttribute("aria-label") || null,
      panePresent: Boolean(document.querySelector('[data-chart-pane-id="pane-script-script-smoke-ma"]'))
    }));
    throw new Error(`hidden custom indicator pane was not removed: ${JSON.stringify(hiddenState)}`);
  }
  const selectedBuiltInIndicatorIds = await page.locator(".chart-indicator-selected-list [data-indicator-instance]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-indicator-instance")).filter(Boolean)
  );
  const selectedCustomIndicatorIds = await page.locator(".chart-indicator-selected-list [data-custom-indicator]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-custom-indicator")).filter(Boolean)
  );
  if (await page.locator(".chart-indicator-popover").count()) {
    await page.locator(".chart-indicator-popover > header").getByRole("button", { name: "关闭" }).click();
  }

  await page.getByRole("button", { name: "图层", exact: true }).click();
  const layerMenu = page.getByRole("menu", { name: "图层显示设置" });
  await layerMenu.waitFor({ timeout: 10_000 });
  const layerMenuBox = await layerMenu.boundingBox();
  if (!layerMenuBox || layerMenuBox.width < 120 || layerMenuBox.height < 120) {
    throw new Error(`layer menu is clipped or not visible: ${JSON.stringify(layerMenuBox)}`);
  }
  const layerMenuHit = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return Boolean(target?.closest('[role="menu"][aria-label="图层显示设置"]'));
  }, {
    x: layerMenuBox.x + layerMenuBox.width / 2,
    y: layerMenuBox.y + layerMenuBox.height / 2
  });
  if (!layerMenuHit) throw new Error(`layer menu is covered or clipped: ${JSON.stringify(layerMenuBox)}`);
  if (await layerMenu.getByRole("checkbox").count() !== 4) throw new Error("layer menu should contain four checkboxes");
  if (await layerMenu.getByRole("checkbox", { name: "交易机会" }).count() !== 0) throw new Error("trade opportunity layer must not be present");
  if (await layerMenu.getByRole("checkbox", { name: "提醒" }).count()) throw new Error("alert should not remain in the layer menu");
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-layer-menu.png`, fullPage: false });
  const signalLayer = layerMenu.getByRole("checkbox", { name: "分析观点" });
  const fillLayer = layerMenu.getByRole("checkbox", { name: "真实成交" });
  if (!(await signalLayer.isChecked()) || !(await fillLayer.isChecked())) throw new Error("opinion/fill layers should be visible by default");
  await signalLayer.click();
  if (await signalLayer.isChecked()) throw new Error("AI signal layer did not toggle off");
  await signalLayer.click();
  if (!(await signalLayer.isChecked())) throw new Error("AI signal layer did not toggle back on");
  await fillLayer.click();
  if (await fillLayer.isChecked()) throw new Error("historical fill marker layer did not toggle off");
  await fillLayer.click();
  await page.getByRole("button", { name: "图层", exact: true }).click();
  await page.waitForTimeout(120);

  await page.waitForSelector(".chart-fill-hit-target", { timeout: 10_000 });
  await page.locator(".chart-fill-hit-target").first().hover();
  await page.waitForTimeout(120);
  const fillTooltipText = await page.locator(".chart-fill-tooltip").textContent();
  if (!fillTooltipText || !/(做多|做空|平多|平空)/.test(fillTooltipText) || !/价格|数量|时间/.test(fillTooltipText)) {
    throw new Error(`historical fill tooltip did not appear near fill marker: ${fillTooltipText}`);
  }
  if (!/×2/.test(baseState.tradeMarkerLabels)) {
    throw new Error(`same-candle executions should aggregate into a count marker: ${JSON.stringify(baseState)}`);
  }
  await page.locator(".chart-fill-hit-target").first().click();
  await page.waitForTimeout(80);
  const pinnedFillTooltip = await page.locator(".chart-fill-tooltip").textContent();
  if (!pinnedFillTooltip || !/价格|数量|时间/.test(pinnedFillTooltip)) {
    throw new Error(`clicking a fill marker should pin its details: ${pinnedFillTooltip}`);
  }

  const positionHandle = await page.locator(".chart-position-drag-handle").first().boundingBox();
  if (!positionHandle) throw new Error("position drag handle missing for drag smoke");
  await page.mouse.move(positionHandle.x + positionHandle.width / 2, positionHandle.y + positionHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(positionHandle.x + positionHandle.width / 2, Math.max(120, positionHandle.y - 72), { steps: 5 });
  await page.waitForTimeout(120);
  const positionIntentText = await page.locator(".chart-position-target-line").textContent();
  if (!positionIntentText || !/限价平仓|止盈|止损|回撤止盈|市价平仓/.test(positionIntentText)) {
    throw new Error(`position line drag intent did not appear: ${positionIntentText}`);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  const chartBox = await page.locator(".chart-canvas").boundingBox();
  if (!chartBox) throw new Error("chart canvas missing for order-line drag smoke");
  const editableOrderLabel = await page.locator(".chart-order-cancel-label").first().boundingBox();
  if (!editableOrderLabel) throw new Error("editable order label missing for order-line drag smoke");
  await page.mouse.move(chartBox.x + chartBox.width * 0.62, editableOrderLabel.y + editableOrderLabel.height / 2);
  await page.mouse.down();
  await page.mouse.move(chartBox.x + chartBox.width * 0.62, Math.max(100, editableOrderLabel.y - 56), { steps: 4 });
  await page.waitForTimeout(120);
  const orderDragText = await page.locator(".chart-order-drag-readout").textContent();
  if (!orderDragText || !/新价/.test(orderDragText) || /预估|U|%/.test(orderDragText)) {
    throw new Error(`opening order-line drag should not show PnL: ${orderDragText}`);
  }
  await page.mouse.up();

  await page.getByRole("button", { name: "测距" }).click();
  const measureText = await clickUntilMeasureAppears(page);
  if (!measureText || !/%|根/.test(measureText)) {
    throw new Error(`measure readout missing expected values: ${measureText}`);
  }
  const measureLineCount = await page.locator(".chart-measure-layer line").count();
  if (measureLineCount < 1) throw new Error("measure layer did not draw a line");
  if (await page.locator(".chart-canvas.measure-active").count()) throw new Error("measure tool should cancel automatically after its second point");

  await drawToolAndExpect(page, "趋势", ".chart-drawing-layer .drawing-trend:not(.preview) line:not(.drawing-hit)");
  await drawToolAndExpect(page, "射线", ".chart-drawing-layer .drawing-ray:not(.preview) line:not(.drawing-hit)");
  await drawToolAndExpect(page, "水平", ".chart-drawing-layer .drawing-horizontal:not(.preview) line:not(.drawing-hit)");
  await drawToolAndExpect(page, "垂直", ".chart-drawing-layer .drawing-vertical:not(.preview) line:not(.drawing-hit)");
  for (const selector of [".drawing-ray", ".drawing-horizontal", ".drawing-vertical"]) {
    const dash = await page.locator(`.chart-drawing-layer ${selector}:not(.preview) line:not(.drawing-hit)`).last().evaluate((node) => getComputedStyle(node).strokeDasharray);
    if (dash && dash !== "none") throw new Error(`${selector} should render as a solid line, got ${dash}`);
  }
  await drawToolAndExpect(page, "区间", ".chart-drawing-layer .drawing-rect:not(.preview) polygon:not(.drawing-hit)");
  const interval = page.locator(".chart-drawing-layer .drawing-rect:not(.preview)").last();
  const intervalPolygon = interval.locator("polygon:not(.drawing-hit)");
  const intervalBeforeAngle = await intervalPolygon.getAttribute("points");
  const intervalTopRight = await interval.locator('[data-drawing-handle="top-right"]').boundingBox();
  if (!intervalTopRight) throw new Error("interval top-right angle handle is missing");
  await page.mouse.move(intervalTopRight.x + intervalTopRight.width / 2, intervalTopRight.y + intervalTopRight.height / 2);
  await page.mouse.down();
  await page.mouse.move(intervalTopRight.x + intervalTopRight.width / 2 + 26, intervalTopRight.y + intervalTopRight.height / 2 - 38, { steps: 7 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const intervalAfterAngle = await intervalPolygon.getAttribute("points");
  if (!intervalBeforeAngle || intervalAfterAngle === intervalBeforeAngle) throw new Error("interval angle handle did not rotate the region");
  const intervalBody = await interval.locator("polygon.drawing-hit").boundingBox();
  if (!intervalBody) throw new Error("interval body drag target is missing");
  const intervalBeforeMove = await intervalPolygon.boundingBox();
  const intervalDragPoint = {
    x: intervalBody.x + intervalBody.width / 2,
    y: intervalBody.y + intervalBody.height / 2
  };
  await page.mouse.move(intervalDragPoint.x, intervalDragPoint.y);
  await page.mouse.down();
  await page.mouse.move(intervalDragPoint.x + 34, intervalDragPoint.y + 22, { steps: 7 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const intervalAfterMove = await intervalPolygon.boundingBox();
  if (!intervalBeforeMove || !intervalAfterMove || Math.abs(intervalAfterMove.x - intervalBeforeMove.x) < 12 || Math.abs(intervalAfterMove.y - intervalBeforeMove.y) < 8) {
    const hit = await page.evaluate(({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      return { tag: node?.tagName, className: node?.getAttribute("class"), handle: node?.getAttribute("data-drawing-handle") };
    }, intervalDragPoint);
    throw new Error(`interval body drag did not move the whole region: ${JSON.stringify({ intervalBeforeMove, intervalAfterMove, hit })}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-rotated-interval.png`, fullPage: false });
  await selectDrawingTool(page, "多头仓位");
  const riskCreateBox = await page.locator(".chart-canvas").boundingBox();
  if (!riskCreateBox) throw new Error("chart canvas missing for risk/reward creation");
  const riskEntryPoint = { x: riskCreateBox.x + riskCreateBox.width * 0.42, y: riskCreateBox.y + riskCreateBox.height * 0.36 };
  const riskTargetPoint = { x: riskCreateBox.x + riskCreateBox.width * 0.68, y: riskCreateBox.y + riskCreateBox.height * 0.22 };
  await page.mouse.click(riskEntryPoint.x, riskEntryPoint.y);
  await page.mouse.move(riskTargetPoint.x, riskTargetPoint.y);
  await page.waitForTimeout(120);
  const previewRatio = await page.locator(".chart-drawing-layer .drawing-risk-reward.long-position.preview .risk-reward-label.entry").textContent();
  if (!previewRatio || !/盈亏比 1\.00/.test(previewRatio)) {
    throw new Error(`risk/reward preview should stay at 1:1: ${previewRatio}`);
  }
  await page.mouse.click(riskTargetPoint.x, riskTargetPoint.y);
  await page.waitForSelector(".chart-drawing-layer .drawing-risk-reward.long-position:not(.preview) .risk-reward-target-zone", { timeout: 10_000 });
  const riskEntryLine = page.locator(".chart-drawing-layer .drawing-risk-reward.long-position:not(.preview) .risk-reward-entry-line").last();
  const entryBeforeClick = await riskEntryLine.evaluate((line) => ({
    x1: Number(line.getAttribute("x1") || 0),
    x2: Number(line.getAttribute("x2") || 0),
    y: Number(line.getAttribute("y1") || 0),
  }));
  const riskEntryHandleBox = await page.locator(".chart-drawing-layer .drawing-risk-reward.long-position:not(.preview) .drawing-handle.risk-entry").last().boundingBox();
  if (!riskEntryHandleBox) throw new Error("risk/reward entry handle missing");
  await page.mouse.click(riskEntryHandleBox.x + riskEntryHandleBox.width / 2, riskEntryHandleBox.y + riskEntryHandleBox.height / 2);
  await page.waitForTimeout(120);
  const entryAfterClick = await riskEntryLine.evaluate((line) => ({
    x1: Number(line.getAttribute("x1") || 0),
    x2: Number(line.getAttribute("x2") || 0),
    y: Number(line.getAttribute("y1") || 0),
  }));
  if (JSON.stringify(entryBeforeClick) !== JSON.stringify(entryAfterClick)) {
    throw new Error(`clicking the entry handle changed the risk/reward range: ${JSON.stringify({ entryBeforeClick, entryAfterClick })}`);
  }
  const riskTarget = page.locator(".chart-drawing-layer .drawing-risk-reward.long-position:not(.preview) .drawing-handle.risk-target").last();
  const riskTargetBox = await riskTarget.boundingBox();
  if (!riskTargetBox) throw new Error("risk/reward target handle missing for drag smoke");
  const riskBefore = await page.locator(".chart-drawing-layer .drawing-risk-reward.long-position:not(.preview) .risk-reward-target-line").last().evaluate((line) => ({
    x: Number(line.getAttribute("x2") || 0),
    y: Number(line.getAttribute("y1") || 0),
  }));
  await page.mouse.move(riskTargetBox.x + riskTargetBox.width / 2, riskTargetBox.y + riskTargetBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(riskTargetBox.x + riskTargetBox.width / 2 + 42, riskTargetBox.y + riskTargetBox.height / 2 - 28, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const riskAfter = await page.locator(".chart-drawing-layer .drawing-risk-reward.long-position:not(.preview) .risk-reward-target-line").last().evaluate((line) => ({
    x: Number(line.getAttribute("x2") || 0),
    y: Number(line.getAttribute("y1") || 0),
  }));
  if (Math.abs(riskAfter.x - riskBefore.x) < 8 || Math.abs(riskAfter.y - riskBefore.y) < 4) {
    throw new Error(`risk/reward target drag did not update distance and price: ${JSON.stringify({ riskBefore, riskAfter })}`);
  }
  const riskZoneBox = await page.locator(".chart-drawing-layer .drawing-risk-reward.long-position:not(.preview) .risk-reward-target-zone").last().boundingBox();
  if (!riskZoneBox) throw new Error("risk/reward target zone disappeared after drag");
  if (await page.locator(".chart-canvas.measure-active").count()) throw new Error("long-position tool should cancel automatically after creation");
  await page.mouse.click(riskZoneBox.x + riskZoneBox.width / 2, riskZoneBox.y + Math.max(2, riskZoneBox.height / 2), { button: "right" });
  await page.waitForSelector(".chart-drawing-menu", { timeout: 10_000 });
  const drawingMenu = await page.locator(".chart-drawing-menu").evaluate((node) => getComputedStyle(node).boxShadow);
  if (!drawingMenu || drawingMenu === "none") throw new Error("risk/reward drawing menu should use the chart context menu elevation");
  await selectDrawingTool(page, "空头仓位");
  await page.mouse.move(riskCreateBox.x + riskCreateBox.width * 0.32, riskCreateBox.y + riskCreateBox.height * 0.28);
  await page.mouse.down();
  await page.mouse.move(riskCreateBox.x + riskCreateBox.width * 0.58, riskCreateBox.y + riskCreateBox.height * 0.42, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".chart-drawing-layer .drawing-risk-reward.short-position:not(.preview) .risk-reward-target-zone", { timeout: 10_000 });
  if (await page.locator(".chart-canvas.measure-active").count()) throw new Error("short-position tool should cancel automatically after creation");
  await dragGuideAndExpect(page, ".chart-guide-top", 0.58, 0.44, ".chart-drawing-layer .drawing-horizontal:not(.preview) line:not(.drawing-hit)");
  await dragGuideAndExpect(page, ".chart-guide-left", 0.68, 0.52, ".chart-drawing-layer .drawing-vertical:not(.preview) line:not(.drawing-hit)");
  await selectDrawingTool(page, "趋势");
  await rightClickChartAt(page, 0.48, 0.48);
  await page.waitForTimeout(100);
  const toolCancelled = await page.locator(".chart-canvas").evaluate((node) => !node.classList.contains("measure-active"));
  if (!toolCancelled) throw new Error("right click should cancel the active drawing tool");
  await selectDrawingTool(page, "趋势");
  await page.waitForTimeout(120);
  const futureBox = await page.locator(".chart-canvas").boundingBox();
  if (!futureBox) throw new Error("chart canvas missing for future drawing");
  const latestCandleX = Number(await page.locator(".chart-wrap").getAttribute("data-latest-candle-x") || 0);
  const futureTargetX = Math.min(
    futureBox.width - 28,
    Math.max(futureBox.width * 0.9, latestCandleX + 96)
  );
  await page.mouse.click(futureBox.x + futureBox.width * 0.78, futureBox.y + futureBox.height * 0.58);
  await page.mouse.move(futureBox.x + futureTargetX, futureBox.y + futureBox.height * 0.36);
  await page.waitForTimeout(90);
  await page.mouse.click(futureBox.x + futureTargetX, futureBox.y + futureBox.height * 0.36);
  await page.waitForTimeout(160);
  const futureTrend = await page.evaluate(() => {
    const latestX = Number(document.querySelector(".chart-wrap")?.getAttribute("data-latest-candle-x") || 0);
    const lines = Array.from(document.querySelectorAll(".chart-drawing-layer .drawing-trend:not(.preview) line:not(.drawing-hit)"));
    return Boolean(latestX > 0 && lines.some((line) => {
      const x2 = Number(line.getAttribute("x2") || 0);
      const x1 = Number(line.getAttribute("x1") || 0);
      return Math.max(x1, x2) > latestX + 8;
    }));
  });
  if (!futureTrend) throw new Error("future area trend line did not extend beyond chart candle area");
  const drawingLineCount = await page.locator(".chart-drawing-layer g:not(.preview) line:not(.drawing-hit)").count();
  const drawingRectCount = await page.locator(".chart-drawing-layer g:not(.preview) polygon:not(.drawing-hit)").count();
  if (drawingLineCount < 4 || drawingRectCount < 1) {
    throw new Error(`drawing tools did not render expected shapes: lines=${drawingLineCount}, rects=${drawingRectCount}`);
  }

  await page.locator(".chart-alert-trigger").click();
  const alertPanel = page.getByRole("dialog", { name: "提醒中心" });
  await alertPanel.waitFor({ timeout: 10_000 });
  const alertPanelBox = await alertPanel.boundingBox();
  const chartWrapBox = await page.locator(".chart-wrap").boundingBox();
  if (!alertPanelBox || !chartWrapBox || alertPanelBox.x < chartWrapBox.x || alertPanelBox.x + alertPanelBox.width > chartWrapBox.x + chartWrapBox.width) {
    throw new Error(`alert panel should stay inside the chart: ${JSON.stringify({ alertPanelBox, chartWrapBox })}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-alert-panel.png`, fullPage: false });
  await alertPanel.getByLabel("触发价格").fill("64000");
  await alertPanel.getByRole("button", { name: "创建提醒" }).click();
  await page.waitForSelector('.chart-alert-line-label[data-alert-source="manual"]', { timeout: 10_000 });
  const alertText = await page.locator('.chart-alert-line-label[data-alert-source="manual"]').textContent();
  if (!alertText || !/上破|64000|64,000/.test(alertText)) {
    throw new Error(`price alert did not appear: ${alertText}`);
  }
  if (!(await page.locator('.chart-alert-line-label[data-alert-source="manual"] .chart-alert-line-remove').count())) {
    throw new Error("price alert line label should expose a remove button");
  }
  if (!(await alertPanel.getByText(/上破/).count()) || !(await alertPanel.getByText(/64,000|64000/).count())) {
    throw new Error("active alert should appear in the alert panel");
  }
  await alertPanel.getByRole("button", { name: "指标", exact: true }).click();
  const selectedIndicatorSelect = alertPanel.getByLabel("指标中心已选指标");
  if (!(await selectedIndicatorSelect.count())) throw new Error("selected indicator alert source is missing");
  await selectedIndicatorSelect.click();
  const indicatorSourceListbox = page.getByRole("listbox", { name: "指标中心已选指标选项" });
  const alertIndicatorInstanceIds = await indicatorSourceListbox.locator("[role=option][data-indicator-instance-id]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-indicator-instance-id")).filter(Boolean)
  );
  const alertCustomIndicatorIds = await indicatorSourceListbox.locator("[role=option][data-custom-indicator-id]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-custom-indicator-id")).filter(Boolean)
  );
  if (JSON.stringify([...alertIndicatorInstanceIds].sort()) !== JSON.stringify([...selectedBuiltInIndicatorIds].sort())
    || JSON.stringify([...alertCustomIndicatorIds].sort()) !== JSON.stringify([...selectedCustomIndicatorIds].sort())) {
    throw new Error(`indicator alert options must come from selected indicators: ${JSON.stringify({ selectedBuiltInIndicatorIds, alertIndicatorInstanceIds })}`);
  }
  const customOption = indicatorSourceListbox.locator('[role=option][data-custom-indicator-id="script-smoke-ma"]');
  if (!(await customOption.count()) || await customOption.isDisabled()) {
    throw new Error("enabled custom DSL indicator should be available as an alert source");
  }
  await customOption.click();
  if (!(await alertPanel.count())) {
    const openState = await page.evaluate(() => ({
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.getAttribute("aria-label") || node.textContent?.slice(0, 80)),
      alertOpen: Boolean(document.querySelector(".chart-alert-panel")),
    }));
    throw new Error(`selecting a custom indicator closed the alert panel: ${JSON.stringify(openState)}`);
  }
  const indicatorOutputSelect = alertPanel.getByLabel("指标数据线");
  if (!(await indicatorOutputSelect.count())) {
    const controls = await alertPanel.locator('[role="combobox"]').evaluateAll((nodes) => nodes.map((node) => ({ label: node.getAttribute("aria-label"), value: node.getAttribute("data-value") })));
    throw new Error(`indicator output selector disappeared: ${JSON.stringify(controls)}`);
  }
  const outputSelectState = await indicatorOutputSelect.evaluate((node) => ({
    disabled: node instanceof HTMLButtonElement ? node.disabled : null,
    value: node.getAttribute("data-value"),
    text: node.textContent?.trim() || "",
  }));
  if (outputSelectState.disabled) throw new Error(`custom indicator output selector is disabled: ${JSON.stringify(outputSelectState)}`);
  await indicatorOutputSelect.click();
  const indicatorOutputListbox = page.getByRole("listbox", { name: "指标数据线选项" });
  const customOutputKeys = await indicatorOutputListbox.locator("[role=option][data-indicator-output-key]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-indicator-output-key")).filter(Boolean)
  );
  if (JSON.stringify(customOutputKeys) !== JSON.stringify(["ma", "rsi"])) {
    throw new Error(`custom DSL alert outputs are incomplete: ${JSON.stringify(customOutputKeys)}`);
  }
  await indicatorOutputSelect.press("Escape");
  await selectedIndicatorSelect.click();
  const adxOptionValue = await indicatorSourceListbox.locator("[role=option]").evaluateAll((nodes) =>
    nodes.find((node) => /ADX \/ DMI/.test(node.textContent || ""))?.getAttribute("data-value") || ""
  );
  if (!adxOptionValue) throw new Error("selected ADX / DMI indicator is missing from alert sources");
  await indicatorSourceListbox.locator(`[role=option][data-value="${adxOptionValue}"]`).click();
  await indicatorOutputSelect.click();
  const indicatorOutputKeys = await indicatorOutputListbox.locator("[role=option][data-indicator-output-key]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-indicator-output-key")).filter(Boolean)
  );
  if (JSON.stringify(indicatorOutputKeys) !== JSON.stringify(["adx", "plusDi", "minusDi"])) {
    throw new Error(`ADX / DMI alert outputs are incomplete: ${JSON.stringify(indicatorOutputKeys)}`);
  }
  await indicatorOutputSelect.press("Escape");
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-indicator-alert.png`, fullPage: false });
  await alertPanel.getByLabel("阈值").fill("65000");
  await alertPanel.getByLabel("HTTP 请求").check();
  await alertPanel.getByLabel("请求地址").fill("https://example.com/trading-alert");
  await alertPanel.getByText("通知请求样例", { exact: true }).click();
  const requestSample = await alertPanel.locator(".chart-alert-webhook pre").textContent();
  if (!requestSample || !/POST https:\/\/example\.com\/trading-alert/.test(requestSample) || !/chart\.alert\.triggered/.test(requestSample)) {
    throw new Error(`webhook request sample is incomplete: ${requestSample}`);
  }
  await alertPanel.getByRole("button", { name: "创建提醒" }).click();
  if (!(await alertPanel.locator(".chart-alert-active-row.indicator").count())) {
    throw new Error("indicator alert did not appear in the active list");
  }
  await alertPanel.getByRole("button", { name: "关闭提醒中心" }).click();

  await page.getByRole("button", { name: "图层", exact: true }).click();
  const drawingLayer = page.getByRole("menu", { name: "图层显示设置" }).getByRole("checkbox", { name: "绘图" });
  await drawingLayer.click();
  const drawingHidden = await page.locator(".chart-drawing-layer line").count();
  if (drawingHidden !== 0) throw new Error("drawing layer should hide after toggling 绘图 off");
  await drawingLayer.click();
  await page.getByRole("button", { name: "图层", exact: true }).click();
  await page.waitForSelector(".chart-drawing-layer line, .chart-drawing-layer rect, .chart-drawing-layer polygon", { timeout: 10_000 });

  await page.getByRole("button", { name: "清除绘图" }).click();
  const cleared = await page.evaluate(() => ({
    drawings: document.querySelectorAll(".chart-drawing-layer line, .chart-drawing-layer rect, .chart-drawing-layer polygon").length,
    measurePending: document.querySelector(".chart-measure-readout.pending")?.textContent?.trim() || "",
    alerts: document.querySelectorAll(".chart-alert-line-label").length
  }));
  if (cleared.drawings !== 0) {
    throw new Error(`chart clear did not remove drawings: ${JSON.stringify(cleared)}`);
  }
  if (cleared.alerts < 1) {
    throw new Error(`clear should not remove price alerts: ${JSON.stringify(cleared)}`);
  }
  await page.locator('.chart-alert-line-label[data-alert-source="manual"] .chart-alert-line-remove').click();
  await page.waitForTimeout(120);
  if (await page.locator('.chart-alert-line-label[data-alert-source="manual"]').count()) {
    throw new Error("price alert line remove button did not delete the manual alert");
  }

  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForTimeout(260);
  const compactChartBox = await page.locator(".chart-canvas").boundingBox();
  if (!compactChartBox) throw new Error("compact chart canvas missing");
  await page.mouse.move(compactChartBox.x + compactChartBox.width * 0.48, compactChartBox.y + compactChartBox.height * 0.34);
  await page.waitForTimeout(160);
  const compactOhlc = await page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    const values = document.querySelector(".ohlc-indicator-values");
    return {
      strip: rect(".ohlc-strip"),
      toolbar: rect(".chart-drawing-toolbar"),
      summaryScrollHeight: document.querySelector(".ohlc-summary")?.scrollHeight ?? 0,
      valuesScrollHeight: values?.scrollHeight ?? 0,
      valuesText: values?.textContent ?? ""
    };
  });
  if (!compactOhlc.strip || !compactOhlc.toolbar || compactOhlc.strip.height > 48
    || compactOhlc.summaryScrollHeight > 22 || compactOhlc.valuesScrollHeight > 22
    || compactOhlc.strip.x < compactOhlc.toolbar.x + compactOhlc.toolbar.width + 4
    || !/(EMA|VWAP)/.test(compactOhlc.valuesText)) {
    throw new Error(`compact indicator values layout invalid: ${JSON.stringify(compactOhlc)}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-compact-indicators.png`, fullPage: false });
  await page.locator(".chart-alert-trigger").click();
  const compactAlertPanel = page.getByRole("dialog", { name: "提醒中心" });
  const compactAlertBox = await compactAlertPanel.boundingBox();
  const compactWrapBox = await page.locator(".chart-wrap").boundingBox();
  if (!compactAlertBox || !compactWrapBox
    || compactAlertBox.x < compactWrapBox.x
    || compactAlertBox.x + compactAlertBox.width > compactWrapBox.x + compactWrapBox.width
    || compactAlertBox.y + compactAlertBox.height > compactWrapBox.y + compactWrapBox.height) {
    throw new Error(`compact alert panel should stay inside the chart: ${JSON.stringify({ compactAlertBox, compactWrapBox })}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-compact-alert-panel.png`, fullPage: false });
  await compactAlertPanel.getByRole("button", { name: "关闭提醒中心" }).click();

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.locator(".chart-preview-page").evaluate((node) => node.classList.add("detached-chart-pane-chart"));
  await page.waitForTimeout(180);
  const detachedOhlcLayout = await page.evaluate(() => {
    const strip = document.querySelector(".ohlc-strip")?.getBoundingClientRect();
    const chart = document.querySelector(".chart-wrap")?.getBoundingClientRect();
    if (!strip || !chart) return null;
    return {
      topOffset: strip.top - chart.top,
      rightOffset: chart.right - strip.right
    };
  });
  if (!detachedOhlcLayout || detachedOhlcLayout.topOffset > 14 || detachedOhlcLayout.rightOffset > 18) {
    throw new Error(`detached chart OHLC strip has excessive top spacing: ${JSON.stringify(detachedOhlcLayout)}`);
  }
  if (screenshotPrefix) await page.screenshot({ path: `${screenshotPrefix}-detached-ohlc.png`, fullPage: false });

  const chartCanvas = page.locator(".chart-canvas canvas").first();
  await chartCanvas.evaluate((node) => {
    for (let index = 0; index < 30; index += 1) {
      node.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaMode: 0,
        deltaY: -100
      }));
    }
  });
  await page.waitForTimeout(260);
  const expandedMarkerState = await page.locator(".chart-wrap").evaluate((node) => ({
    mode: node.getAttribute("data-marker-label-mode") || "",
    bars: Number(node.getAttribute("data-visible-marker-bars") || 0),
    labels: node.getAttribute("data-trade-marker-labels") || ""
  }));
  if (expandedMarkerState.mode !== "expanded" || expandedMarkerState.bars > 48 || !/看多|看空/.test(expandedMarkerState.labels)) {
    throw new Error(`zoomed chart should expand recent marker labels: ${JSON.stringify(expandedMarkerState)}`);
  }

  const actionableConsoleErrors = consoleErrors.filter((text) => !/ResizeObserver loop|WebSocket|ERR_|Failed to load resource/i.test(text));
  if (pageErrors.length > 0 || actionableConsoleErrors.length > 0) {
    throw new Error(`chart preview errors: ${JSON.stringify({ pageErrors, consoleErrors: actionableConsoleErrors })}`);
  }

  await browser.close();
  process.stdout.write(
    `[smoke] chart preview ok: canvas=${Math.round(baseState.canvas.width)}x${Math.round(baseState.canvas.height)}, nonBlank=${baseState.nonBlankPixels}, measure="${measureText?.trim()}", drawings=${drawingLineCount}, rects=${drawingRectCount}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`[smoke] chart preview failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
