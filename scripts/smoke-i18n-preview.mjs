import { chromium } from "playwright";

const baseUrl = process.env.DESIC_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview";
const automationUrl = process.env.DESIC_AUTOMATION_PREVIEW_URL || "http://127.0.0.1:1420/automation-preview";
const chartUrl = process.env.DESIC_CHART_PREVIEW_URL || "http://127.0.0.1:1420/chart-preview";
const aiUrl = process.env.DESIC_AI_PREVIEW_URL || "http://127.0.0.1:1420/ai-preview";
const languageCacheKey = "desic.ui.language.v1";

async function readUntranslatedSystemText(page, rootSelector = "body") {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [`missing-root=${selector}`];
    const skip = "[data-i18n-skip],.ai-markdown,.intelligence-article-body,.cm-editor,code,pre,[contenteditable='true']";
    const values = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.textContent?.trim() ?? "";
      if (/[\u3400-\u9fff]/.test(value) && !node.parentElement?.closest(skip)) values.add(value);
      node = walker.nextNode();
    }
    for (const element of root.querySelectorAll("[title],[aria-label],[placeholder]")) {
      if (element.closest(skip)) continue;
      for (const attribute of ["title", "aria-label", "placeholder"]) {
        const value = element.getAttribute(attribute)?.trim() ?? "";
        if (/[\u3400-\u9fff]/.test(value)) values.add(`${attribute}=${value}`);
      }
    }
    return [...values];
  }, rootSelector);
}

async function expectNoHanSystemText(browser, url, selector, label) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ key }) => localStorage.setItem(key, "en-US"), { key: languageCacheKey });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(selector, { timeout: 30_000 });
  const untranslated = await readUntranslatedSystemText(page, selector);
  await context.close();
  if (untranslated.length > 0) throw new Error(`${label} contains untranslated system text: ${JSON.stringify(untranslated.slice(0, 20))}`);
}

async function expectNoHanAutomationReviewText(browser) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(({ key }) => localStorage.setItem(key, "en-US"), { key: languageCacheKey });
  await page.goto(`${automationUrl}?view=reviews`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".automation-review-page", { timeout: 30_000 });
  let untranslated = await readUntranslatedSystemText(page, ".automation-review-page");
  if (untranslated.length > 0) throw new Error(`English daily reviews contain untranslated system text: ${JSON.stringify(untranslated.slice(0, 20))}`);

  await page.getByRole("button", { name: /Position trade reviews/ }).click();
  await page.waitForSelector(".automation-reviews-view", { timeout: 30_000 });
  await page.waitForTimeout(150);
  untranslated = await readUntranslatedSystemText(page, ".automation-review-page");
  await context.close();
  if (untranslated.length > 0) throw new Error(`English position reviews contain untranslated system text: ${JSON.stringify(untranslated.slice(0, 20))}`);
}

async function expectNoHanTerminalAuxiliaryText(browser) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, "en-US");
    const now = Date.now();
    localStorage.setItem("desictrade.notificationHistory.v1", JSON.stringify([
      { id: "i18n-run-record", kind: "info", title: "AI Automation notification", message: "AI 运行记录已持久化", createdAt: now },
      { id: "i18n-run-complete", kind: "success", title: "AI Automation completed", message: "后台 Agent Momentum Profile 已完成", createdAt: now - 1_000 },
      { id: "i18n-opportunity", kind: "trade", title: "AI 创建了交易机会", message: "BTC-USDT-SWAP 做空 0.02 张", createdAt: now - 2_000 },
      { id: "i18n-order", kind: "trade", title: "普通下单已提交", message: "Preview Account · BTC-USDT-SWAP 卖/空 0.02 @ 63,900.0，订单 preview-order，操作员 AI。", createdAt: now - 3_000 }
    ]));
  }, { key: languageCacheKey });
  const url = new URL(baseUrl);
  url.searchParams.set("accounts", "demo");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });

  await page.getByRole("button", { name: "Data", exact: true }).click();
  await page.waitForSelector(".data-dashboard", { timeout: 30_000 });
  let untranslated = await readUntranslatedSystemText(page, ".data-dashboard");
  if (untranslated.length > 0) throw new Error(`English Data dashboard contains untranslated system text: ${JSON.stringify(untranslated.slice(0, 20))}`);

  await page.getByRole("button", { name: "Open help center" }).click();
  await page.waitForSelector(".help-center-modal", { timeout: 30_000 });
  untranslated = await readUntranslatedSystemText(page, ".help-center-modal");
  if (untranslated.length > 0) throw new Error(`English Help center contains untranslated system text: ${JSON.stringify(untranslated.slice(0, 20))}`);
  await page.locator(".help-center-modal .modal-head .window-button").click();

  await page.locator(".notification-button").click();
  await page.waitForSelector(".notification-center", { timeout: 30_000 });
  untranslated = await readUntranslatedSystemText(page, ".notification-center");
  await context.close();
  if (untranslated.length > 0) throw new Error(`English notification center contains untranslated system text: ${JSON.stringify(untranslated.slice(0, 20))}`);
}

async function expectNoHanIntelligenceText(browser) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ key }) => localStorage.setItem(key, "en-US"), { key: languageCacheKey });
  const url = new URL(baseUrl);
  url.searchParams.set("accounts", "demo");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });
  await page.getByRole("button", { name: "Market Intelligence" }).click();
  await page.waitForSelector(".intelligence-page", { timeout: 30_000 });

  const check = async (label) => {
    await page.waitForTimeout(100);
    const untranslated = await readUntranslatedSystemText(page, ".intelligence-page");
    if (untranslated.length > 0) throw new Error(`English intelligence ${label} contains untranslated system text: ${JSON.stringify(untranslated.slice(0, 20))}`);
  };

  await check("news");
  await page.locator(".intelligence-feed > button").first().click();
  await check("event detail");
  await page.locator(".intelligence-tabs button").filter({ hasText: "Sentiment & Macro" }).click();
  await check("sentiment and calendar");
  await page.locator(".intelligence-tabs button").filter({ hasText: "Derivatives" }).click();
  await check("derivatives");
  await page.locator(".intelligence-tabs button").filter({ hasText: "Smart Money" }).click();
  await check("Smart Money");
  await page.locator(".intelligence-trader-list button").first().click();
  await check("trader details");
  await page.locator(".intelligence-tabs button").filter({ hasText: "History" }).click();
  await check("history");
  await page.getByRole("button", { name: "Market intelligence settings" }).click();
  await check("settings");
  await context.close();
}

async function openTerminal(browser, osLocale, preference, url = baseUrl) {
  const context = await browser.newContext({ locale: osLocale, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  if (preference) {
    await page.addInitScript(({ key, value }) => {
      if (sessionStorage.getItem("desic.i18n.smoke.seeded") === "1") return;
      localStorage.setItem(key, value);
      sessionStorage.setItem("desic.i18n.smoke.seeded", "1");
    }, {
      key: languageCacheKey,
      value: preference
    });
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });
  return { context, page };
}

async function expectLocale(page, locale, navigationLabel) {
  await page.waitForFunction(
    ({ expectedLocale, expectedLabel }) => document.documentElement.lang === expectedLocale
      && document.querySelector(".rail-item span")?.textContent?.trim() === expectedLabel,
    { expectedLocale: locale, expectedLabel: navigationLabel }
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const french = await openTerminal(browser, "fr-FR");
    await expectLocale(french.page, "fr-FR", "Trading");
    await french.context.close();

    const unsupported = await openTerminal(browser, "it-IT");
    await expectLocale(unsupported.page, "en-US", "Trading");
    const untranslatedSystemText = await unsupported.page.evaluate(() => document.body.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /[\u3400-\u9fff]/.test(line)));
    if (untranslatedSystemText.length > 0) {
      throw new Error(`English terminal preview contains untranslated system text: ${JSON.stringify(untranslatedSystemText.slice(0, 20))}`);
    }
    await unsupported.context.close();

    const accountPreviewUrl = new URL(baseUrl);
    accountPreviewUrl.searchParams.set("accounts", "demo");
    const accountEnglish = await openTerminal(browser, "en-US", "en-US", accountPreviewUrl.toString());
    const ticketText = await accountEnglish.page.locator(".ticket-shell").innerText();
    if (/[\u3400-\u9fff]/.test(ticketText)) {
      throw new Error(`English order ticket contains untranslated system text: ${JSON.stringify(ticketText.split("\n").filter((line) => /[\u3400-\u9fff]/.test(line)))}`);
    }
    for (const forbidden of ["已读取 OKX 杠杆", "请输入下单张数", "预估占用保证金", "最多可开"]) {
      if (ticketText.includes(forbidden)) throw new Error(`English order ticket contains untranslated text: ${forbidden}`);
    }
    await accountEnglish.page.locator(".chart-indicator-center-trigger").click();
    await accountEnglish.page.waitForSelector(".chart-indicator-popover");
    const untranslatedIndicatorText = await accountEnglish.page.locator(".chart-indicator-popover").evaluate((root) => {
      const values = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const value = node.textContent?.trim() ?? "";
        if (/[\u3400-\u9fff]/.test(value) && !node.parentElement?.closest("[data-i18n-skip]")) values.push(value);
        node = walker.nextNode();
      }
      return values;
    });
    if (untranslatedIndicatorText.length > 0) {
      throw new Error(`English indicator center contains untranslated system text: ${JSON.stringify(untranslatedIndicatorText)}`);
    }
    await accountEnglish.page.locator('.chart-indicator-popover button[title="Close"]').click();
    await accountEnglish.page.locator(".bottom-tabs button").filter({ hasText: "Open orders" }).click();
    const bottomPanelText = await accountEnglish.page.locator(".bottom-panel").innerText();
    if (!bottomPanelText.includes("Cancel all")) {
      throw new Error(`English open-orders panel is missing the localized emergency action: ${JSON.stringify(bottomPanelText.slice(0, 320))}`);
    }
    for (const forbidden of ["全部撤单", "普通委托", "策略委托", "当前没有普通挂单"]) {
      if (bottomPanelText.includes(forbidden)) throw new Error(`English open-orders panel contains untranslated text: ${forbidden}`);
    }
    await accountEnglish.page.locator(".connection-status").click();
    const connectionText = await accountEnglish.page.locator(".connection-tooltip").textContent() ?? "";
    if (!connectionText.includes("WSS connection status") || connectionText.includes("连接状态")) {
      throw new Error(`English connection status is not localized: ${JSON.stringify(connectionText.slice(0, 240))}`);
    }
    await accountEnglish.page.locator(".rail-item").last().click();
    await accountEnglish.page.waitForSelector(".settings-workspace");
    await accountEnglish.page.locator(".settings-page-tabs button").filter({ hasText: "Accounts" }).click();
    const accountSettingsText = await accountEnglish.page.locator(".settings-page-panel").innerText();
    for (const forbidden of ["OKX API 配置指南", "账号名称", "保存账号", "测试连接", "不填写则保留原"]) {
      if (accountSettingsText.includes(forbidden)) throw new Error(`English account settings contains untranslated text: ${forbidden}`);
    }
    await accountEnglish.context.close();

    const automationContext = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    const automationPage = await automationContext.newPage();
    await automationPage.addInitScript(({ key }) => localStorage.setItem(key, "en-US"), { key: languageCacheKey });
    await automationPage.goto(`${automationUrl}?view=config`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await automationPage.waitForSelector(".automation-collaboration-section");
    const collaborationText = await automationPage.locator(".automation-collaboration-section").innerText();
    if (/[\u3400-\u9fff]/.test(collaborationText)) {
      throw new Error(`English Profile collaboration contains untranslated system text: ${JSON.stringify(collaborationText.split("\n").filter((line) => /[\u3400-\u9fff]/.test(line)))}`);
    }
    await automationContext.close();

    await expectNoHanSystemText(browser, `${automationUrl}?view=optimization`, ".automation-optimization-view", "English optimization suggestions");
    await expectNoHanAutomationReviewText(browser);
    await expectNoHanTerminalAuxiliaryText(browser);
    await expectNoHanSystemText(browser, chartUrl, ".chart-wrap", "English chart preview");
    await expectNoHanSystemText(browser, aiUrl, ".ai-panel", "English AI preview");
    await expectNoHanIntelligenceText(browser);

    const explicit = await openTerminal(browser, "de-DE", "ja-JP");
    await expectLocale(explicit.page, "ja-JP", "取引");
    await explicit.page.locator(".rail-item").last().click();
    await explicit.page.waitForSelector(".language-preference-grid");
    await explicit.page.locator('input[name="desic-language"][value="ko-KR"]').click({ force: true });
    await expectLocale(explicit.page, "ko-KR", "거래");

    await explicit.page.evaluate(() => {
      const translated = document.createElement("span");
      translated.id = "i18n-smoke-translated";
      translated.textContent = "保存";
      const preserved = document.createElement("span");
      preserved.id = "i18n-smoke-preserved";
      preserved.dataset.i18nSkip = "";
      preserved.textContent = "保存";
      document.body.append(translated, preserved);
    });
    await explicit.page.waitForFunction(() => document.querySelector("#i18n-smoke-translated")?.textContent === "저장");
    const preserved = await explicit.page.locator("#i18n-smoke-preserved").textContent();
    if (preserved !== "保存") throw new Error(`data-i18n-skip content changed: ${JSON.stringify(preserved)}`);

    await explicit.page.reload({ waitUntil: "domcontentloaded" });
    await explicit.page.waitForSelector(".terminal .workspace", { timeout: 30_000 });
    await expectLocale(explicit.page, "ko-KR", "거래");
    const overflow = await explicit.page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight
    }));
    if (overflow.x > 2 || overflow.y > 2) throw new Error(`localized terminal overflow: ${JSON.stringify(overflow)}`);
    await explicit.context.close();
  } finally {
    await browser.close();
  }
  process.stdout.write("[smoke] i18n preview ok: os=fr-FR, fallback=en-US, trade+settings+profile+reviews+suggestions+data+help+notifications+chart+ai+intelligence=en-US, explicit=ja-JP, switch+persist=ko-KR, skip=verified\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
