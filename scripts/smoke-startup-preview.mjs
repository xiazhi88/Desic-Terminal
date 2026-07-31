import { chromium } from "playwright";

const baseUrl = process.env.DESIC_STARTUP_PREVIEW_URL || "http://127.0.0.1:1420/startup-preview";

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 580 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/api/v5/public/time", (route) => route.abort("failed"));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".startup-original .stage", { timeout: 30_000 });
  await page.waitForSelector(".startup-check-inline.failed", { timeout: 30_000 });

  const failedState = await readStartupState(page);
  if (!failedState.stage || !failedState.brand || !failedState.marketCard || !failedState.loading || !failedState.percent) {
    throw new Error(`startup preview key elements missing: ${JSON.stringify(failedState)}`);
  }
  if (failedState.bodyOverflowX > 2 || failedState.bodyOverflowY > 2) {
    throw new Error(`startup preview has global overflow: ${JSON.stringify(failedState)}`);
  }
  if (failedState.checkPanelCount !== 0) {
    throw new Error(`startup preview should not render old check panel: ${JSON.stringify(failedState)}`);
  }
  if (failedState.stageRadius < 14 || failedState.stageShadow === "none") {
    throw new Error(`startup window should render rounded corners and shadow: ${JSON.stringify(failedState)}`);
  }
  if (!/(?:无法连接 OKX|OKX.*不可达)/.test(failedState.inlineText)) {
    throw new Error(`startup failure copy should identify the OKX network issue: ${JSON.stringify(failedState)}`);
  }
  if (failedState.headerProxyButtonText !== "配置代理" || failedState.failureProxyButtonText !== "代理" || failedState.retryButtonText !== "重试") {
    throw new Error(`startup proxy and retry actions are incomplete: ${JSON.stringify(failedState)}`);
  }
  if (failedState.headerProxyButtonRadius < 14 || failedState.retryButtonRadius < 14) {
    throw new Error(`startup actions should be rounded: ${JSON.stringify(failedState)}`);
  }
  if (rectsOverlap(failedState.percent, failedState.marketCard)) {
    throw new Error(`startup percent overlaps market sync card: ${JSON.stringify(failedState)}`);
  }
  if (rectsOverlap(failedState.loading, failedState.marketCard)) {
    throw new Error(`startup loading block overlaps market sync card: ${JSON.stringify(failedState)}`);
  }

  await page.locator(".startup-proxy-trigger").click();
  await page.waitForSelector(".startup-proxy-modal", { timeout: 5_000 });
  const proxyState = await readProxyState(page);
  if (proxyState.type !== "不使用代理" || proxyState.host !== "" || proxyState.port !== "0") {
    throw new Error(`startup proxy defaults are wrong: ${JSON.stringify(proxyState)}`);
  }
  if (proxyState.modalOverflowX > 1 || proxyState.modalOverflowY > 1 || !proxyState.withinViewport) {
    throw new Error(`startup proxy modal should stay usable inside the window: ${JSON.stringify(proxyState)}`);
  }

  await page.locator(".startup-proxy-modal .window-button").click();
  await page.locator(".startup-check-inline.failed button", { hasText: "重试" }).click();
  await page.waitForSelector(".startup-check-inline.failed", { timeout: 30_000 });

  const actionableConsoleErrors = consoleErrors.filter((text) => !/Failed to load resource|ERR_FAILED|startup check failed/i.test(text));
  if (pageErrors.length > 0 || actionableConsoleErrors.length > 0) {
    throw new Error(`startup preview errors: ${JSON.stringify({ pageErrors, consoleErrors: actionableConsoleErrors })}`);
  }

  await page.screenshot({ path: "design-qa-startup-preview.png", fullPage: false });
  await browser.close();
  process.stdout.write(
    `[smoke] startup preview ok: inline="${failedState.inlineText}", retry=${failedState.retryButtonText}, proxy=${proxyState.type}://${proxyState.host}:${proxyState.port}\n`
  );
}

async function readStartupState(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    const headerProxyButton = document.querySelector(".startup-proxy-trigger");
    const failureButtons = Array.from(document.querySelectorAll(".startup-check-inline.failed button"));
    const failureProxyButton = failureButtons.find((button) => button.textContent?.trim() === "代理");
    const retryButton = failureButtons.find((button) => button.textContent?.trim() === "重试");
    const headerProxyButtonStyle = headerProxyButton ? getComputedStyle(headerProxyButton) : null;
    const retryButtonStyle = retryButton ? getComputedStyle(retryButton) : null;
    const stage = document.querySelector(".startup-original .stage");
    const stageStyle = stage ? getComputedStyle(stage) : null;
    return {
      stage: rect(".startup-original .stage"),
      brand: rect(".startup-original .brand"),
      marketCard: rect(".startup-original .terminal"),
      loading: rect(".startup-original .loading"),
      percent: rect(".startup-original .percent"),
      inlineText: document.querySelector(".startup-check-inline")?.textContent?.trim() || "",
      headerProxyButtonText: headerProxyButton?.textContent?.trim() || "",
      failureProxyButtonText: failureProxyButton?.textContent?.trim() || "",
      retryButtonText: retryButton?.textContent?.trim() || "",
      headerProxyButtonRadius: headerProxyButtonStyle ? parseFloat(headerProxyButtonStyle.borderTopLeftRadius) || 0 : 0,
      retryButtonRadius: retryButtonStyle ? parseFloat(retryButtonStyle.borderTopLeftRadius) || 0 : 0,
      stageRadius: stageStyle ? parseFloat(stageStyle.borderTopLeftRadius) || 0 : 0,
      stageShadow: stageStyle?.boxShadow || "none",
      checkPanelCount: document.querySelectorAll(".check-card,.startup-panel").length,
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight
    };
  });
}

async function readProxyState(page) {
  return page.evaluate(() => {
    const modal = document.querySelector(".startup-proxy-modal");
    const modalBox = modal?.getBoundingClientRect();
    const activeType = document.querySelector(".startup-proxy-modal .proxy-type-row button.active");
    const inputs = Array.from(document.querySelectorAll(".startup-proxy-modal .proxy-form-grid input"));
    return {
      type: activeType?.textContent?.trim() || "",
      host: inputs[0]?.value || "",
      port: inputs[1]?.value || "",
      modalOverflowX: modal ? modal.scrollWidth - modal.clientWidth : -1,
      modalOverflowY: modal ? modal.scrollHeight - modal.clientHeight : -1,
      withinViewport: Boolean(
        modalBox
        && modalBox.left >= 0
        && modalBox.top >= 0
        && modalBox.right <= window.innerWidth
        && modalBox.bottom <= window.innerHeight
      )
    };
  });
}

main().catch((error) => {
  process.stderr.write(`[smoke] startup preview failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
