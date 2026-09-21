import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const baseUrl = process.env.DESIC_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview";
const automationUrl = process.env.DESIC_AUTOMATION_PREVIEW_URL || "http://127.0.0.1:1420/automation-preview";
const chartUrl = process.env.DESIC_CHART_PREVIEW_URL || "http://127.0.0.1:1420/chart-preview";
const aiUrl = process.env.DESIC_AI_PREVIEW_URL || "http://127.0.0.1:1420/ai-preview";
const languageCacheKey = "desic.ui.language.v1";

// 断言口径：rail 是"locale 真的生效了"的证据。期望文案取自 i18n 资源
// （src/i18n/resources.ts 的 navigation 命名空间），比对按**无序集合/子集**语义
// （期望集合 ⊆ 实际渲染的 rail label 集合），因此新增 rail 项或调整 rail 顺序
// 不再误红；只有"导航没有被重新渲染成目标语言"才会红。
// 下列 key 是终端 rail 渲染的导航项（src/ui/App.tsx 的 navItems，与顺序无关）。
const railNavigationKeys = ["aiResearch", "trading", "radar", "opportunities", "automation", "intelligence", "systematic", "data", "settings"];
const railItemSelector = ".rail-item";
const railLabelSelector = ".rail-item__label";
const i18nResourcesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/i18n/resources.ts");

// 读取一段花括号对象字面量的内部文本（跳过字符串字面量内的花括号）。
function readBalancedObject(source, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"') break;
        index += 1;
      }
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, index);
    }
  }
  return null;
}

function readStringPairs(objectSource) {
  const pairs = {};
  for (const match of objectSource.matchAll(/([A-Za-z0-9_]+)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) pairs[match[1]] = match[2];
  return pairs;
}

// 取某个 locale 常量声明的 region（到下一个顶层声明为止），再解析其中的 navigation 字面量。
function localeNavigationCopy(resourcesSource, identifier) {
  const anchor = `const ${identifier}`;
  const start = resourcesSource.indexOf(anchor);
  if (start < 0) return null;
  const boundaries = ["\nconst ", "\nfunction ", "\nexport "]
    .map((marker) => resourcesSource.indexOf(marker, start + anchor.length))
    .filter((index) => index >= 0);
  const region = resourcesSource.slice(start, boundaries.length > 0 ? Math.min(...boundaries) : resourcesSource.length);
  const navigationIndex = region.indexOf("navigation:");
  if (navigationIndex < 0) return null;
  const braceIndex = region.indexOf("{", navigationIndex);
  if (braceIndex < 0) return null;
  const objectSource = readBalancedObject(region, braceIndex);
  return objectSource === null ? null : readStringPairs(objectSource);
}

function loadI18nResources() {
  let source;
  try {
    source = fs.readFileSync(i18nResourcesPath, "utf8");
  } catch (error) {
    throw new Error(`i18n resource read failed for rail expectations (${i18nResourcesPath}): ${error.message}`);
  }
  const mapIndex = source.indexOf("export const I18N_RESOURCES");
  const braceIndex = mapIndex < 0 ? -1 : source.indexOf("{", mapIndex);
  const objectSource = braceIndex < 0 ? null : readBalancedObject(source, braceIndex);
  if (objectSource === null) throw new Error("i18n resource moved: I18N_RESOURCES map not found in src/i18n/resources.ts");
  const identifiers = new Map();
  for (const match of objectSource.matchAll(/"([A-Za-z-]+)"\s*:\s*([A-Za-z0-9_]+)/g)) identifiers.set(match[1], match[2]);
  return { source, identifiers };
}

// i18n 运行时用 fallbackLng=en-US，且西方语言目录整体 spread en-US：缺 key 时逐 key 回退英文。
function expectedRailLabels(locale) {
  const { source, identifiers } = loadI18nResources();
  const english = localeNavigationCopy(source, "enUS");
  const localized = locale === "en-US" ? english : localeNavigationCopy(source, identifiers.get(locale) ?? "");
  if (!english || !localized) throw new Error(`rail expectation source is stale: no navigation copy for ${locale} in src/i18n/resources.ts`);
  const merged = { ...english, ...localized };
  const labels = railNavigationKeys.map((key) => merged[key]).filter((label) => typeof label === "string" && label.trim().length > 0);
  // 防空跑：期望集合必须完整覆盖 rail 的导航项，否则断言会退化成"永远通过"。
  if (labels.length !== railNavigationKeys.length) {
    throw new Error(`rail expectation for ${locale} is incomplete: ${JSON.stringify(railNavigationKeys.filter((key) => !merged[key]))} missing in src/i18n/resources.ts`);
  }
  return labels;
}

async function readRailLabels(page) {
  return page.evaluate(({ itemSelector, labelSelector }) => [...document.querySelectorAll(itemSelector)]
    .map((item) => (item.querySelector(labelSelector)?.textContent ?? "").trim())
    .filter((label) => label.length > 0), { itemSelector: railItemSelector, labelSelector: railLabelSelector });
}

// 首屏默认工作区会变（当前默认落点是 AI Research），下面这些断言要的是"Trading 工作区"里的英文文案，
// 因此显式按 data-workspace 切过去，不再依赖"默认首屏 = Trading"或 rail 位置。
async function openTradingWorkspace(page) {
  await page.locator(`${railItemSelector}[data-workspace="terminal"]`).click();
  await page.waitForSelector(".ticket-shell", { timeout: 30_000 });
}

// Profile 协作 / Agent 选择区（`?view=config`）的"无中文系统文案"口径。
// Agent 名字与职责属于**数据**（与 Prompt / Skill / AI 输出一样不翻译），所以只跳过
// .agent-picker__row-copy；开关、标题、提示与本地化 chip 等系统文案全部保持在校验范围内。
async function readUntranslatedAgentPickerText(page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-agent-selector]");
    if (!root) return { missingRoot: true, values: [], scanned: 0 };
    const skip = ".agent-picker__row-copy,[data-i18n-skip],.ai-markdown";
    const values = new Set();
    let scanned = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.textContent?.trim() ?? "";
      if (value.length > 0 && !node.parentElement?.closest(skip)) {
        scanned += 1;
        if (/[\u3400-\u9fff]/.test(value)) values.add(value);
      }
      node = walker.nextNode();
    }
    for (const element of root.querySelectorAll("[title],[aria-label],[placeholder]")) {
      if (element.closest(skip)) continue;
      for (const attribute of ["title", "aria-label", "placeholder"]) {
        const value = element.getAttribute(attribute)?.trim() ?? "";
        if (/[\u3400-\u9fff]/.test(value)) values.add(`${attribute}=${value}`);
      }
    }
    return { missingRoot: false, values: [...values], scanned };
  });
}

// 返回 { missingRoot, values, scanned }：scanned 是真正扫到的**系统文案**文本节点数，
// 用于防止"作用域空了 / 选择器失效"导致断言变成空跑（missing-root 以前会被静默当成通过）。
async function readUntranslatedSystemText(page, rootSelector = "body", extraSkip = "") {
  return page.evaluate(({ selector, extra }) => {
    const root = document.querySelector(selector);
    if (!root) return { missingRoot: true, values: [], scanned: 0 };
    const skip = `[data-i18n-skip],.ai-markdown,.intelligence-article-body,.cm-editor,code,pre,[contenteditable='true']${extra ? `,${extra}` : ""}`;
    const values = new Set();
    let scanned = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.textContent?.trim() ?? "";
      if (value.length > 0 && !node.parentElement?.closest(skip)) {
        scanned += 1;
        if (/[\u3400-\u9fff]/.test(value)) values.add(value);
      }
      node = walker.nextNode();
    }
    for (const element of root.querySelectorAll("[title],[aria-label],[placeholder]")) {
      if (element.closest(skip)) continue;
      for (const attribute of ["title", "aria-label", "placeholder"]) {
        const value = element.getAttribute(attribute)?.trim() ?? "";
        if (/[\u3400-\u9fff]/.test(value)) values.add(`${attribute}=${value}`);
      }
    }
    return { missingRoot: false, values: [...values], scanned };
  }, { selector: rootSelector, extra: extraSkip });
}

function assertNoUntranslated(label, result, minScanned = 1) {
  if (result.missingRoot) throw new Error(`${label}: assertion root is missing, the selector scope is stale`);
  if (result.scanned < minScanned) throw new Error(`${label}: assertion scope is stale, only ${result.scanned} system text nodes scanned`);
  if (result.values.length > 0) throw new Error(`${label} contains untranslated system text: ${JSON.stringify(result.values.slice(0, 20))}`);
}

async function expectNoHanSystemText(browser, url, selector, label, options = {}) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ key }) => localStorage.setItem(key, "en-US"), { key: languageCacheKey });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(selector, { timeout: 30_000 });
  const result = await readUntranslatedSystemText(page, selector, options.extraSkip ?? "");
  await context.close();
  assertNoUntranslated(label, result, options.minScanned ?? 1);
}

async function expectNoHanAutomationReviewText(browser) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(({ key }) => localStorage.setItem(key, "en-US"), { key: languageCacheKey });
  await page.goto(`${automationUrl}?view=reviews`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".automation-review-page", { timeout: 30_000 });
  let result = await readUntranslatedSystemText(page, ".automation-review-page");
  assertNoUntranslated("English daily reviews", result);

  await page.getByRole("button", { name: /Position trade reviews/ }).click();
  await page.waitForSelector(".automation-reviews-view", { timeout: 30_000 });
  await page.waitForTimeout(150);
  result = await readUntranslatedSystemText(page, ".automation-review-page");
  await context.close();
  assertNoUntranslated("English position reviews", result);
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

  // 按 data-workspace 定位 rail 项：不依赖 rail 顺序，也不受同名按钮（AI 面板里也有 "Data"/"Market intelligence"）干扰。
  await page.locator(`${railItemSelector}[data-workspace="data"]`).click();
  await page.waitForSelector(".data-dashboard", { timeout: 30_000 });
  let result = await readUntranslatedSystemText(page, ".data-dashboard");
  assertNoUntranslated("English Data dashboard", result);

  await page.getByRole("button", { name: "Open help center" }).click();
  await page.waitForSelector(".help-center-modal", { timeout: 30_000 });
  result = await readUntranslatedSystemText(page, ".help-center-modal");
  assertNoUntranslated("English Help center", result);
  await page.locator(".help-center-modal .modal-head .window-button").click();

  await page.locator(".notification-button").click();
  await page.waitForSelector(".notification-center", { timeout: 30_000 });
  result = await readUntranslatedSystemText(page, ".notification-center");
  await context.close();
  assertNoUntranslated("English notification center", result);
}

async function expectNoHanIntelligenceText(browser) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ key }) => localStorage.setItem(key, "en-US"), { key: languageCacheKey });
  const url = new URL(baseUrl);
  url.searchParams.set("accounts", "demo");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .workspace", { timeout: 30_000 });
  await page.locator(`${railItemSelector}[data-workspace="intelligence"]`).click();
  await page.waitForSelector(".intelligence-page", { timeout: 30_000 });

  const check = async (label) => {
    await page.waitForTimeout(100);
    assertNoUntranslated(`English intelligence ${label}`, await readUntranslatedSystemText(page, ".intelligence-page"));
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

async function expectLocale(page, locale) {
  const expected = expectedRailLabels(locale);
  const waitForRenderedLocale = (expectedLocale, expectedLabels) => page.waitForFunction(({ expectedLocale: localeValue, expectedLabels: labels, itemSelector, labelSelector }) => {
    if (document.documentElement.lang !== localeValue) return false;
    const rendered = [...document.querySelectorAll(itemSelector)].map((item) => (item.querySelector(labelSelector)?.textContent ?? "").trim());
    return labels.every((label) => rendered.includes(label));
  }, { expectedLocale, expectedLabels: expected, itemSelector: railItemSelector, labelSelector: railLabelSelector }, { timeout: 30_000 });
  try {
    await waitForRenderedLocale(locale, expected);
  } catch (error) {
    const rendered = await readRailLabels(page);
    const lang = await page.evaluate(() => document.documentElement.lang);
    const missing = expected.filter((label) => !rendered.includes(label));
    throw new Error(`locale ${locale} rail navigation set mismatch (${error.name}, lang=${lang}): missing ${JSON.stringify(missing)} — expected ⊆ ${JSON.stringify(expected)}, rendered ${JSON.stringify(rendered)}`);
  }
  const rendered = await readRailLabels(page);
  const missing = expected.filter((label) => !rendered.includes(label));
  if (missing.length > 0) {
    throw new Error(`locale ${locale} rail navigation set mismatch after settle: missing ${JSON.stringify(missing)} — expected ⊆ ${JSON.stringify(expected)}, rendered ${JSON.stringify(rendered)}`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const french = await openTerminal(browser, "fr-FR");
    await expectLocale(french.page, "fr-FR");
    await french.context.close();

    const unsupported = await openTerminal(browser, "it-IT");
    await expectLocale(unsupported.page, "en-US");
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
    await openTradingWorkspace(accountEnglish.page);
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
    await accountEnglish.page.locator('.rail-item[data-workspace="settings"]').click();
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
    await automationPage.waitForSelector("[data-agent-selector]");
    const collaborationCheck = await readUntranslatedAgentPickerText(automationPage);
    if (collaborationCheck.missingRoot) {
      throw new Error("English Profile collaboration section is missing: [data-agent-selector] not found on ?view=config");
    }
    // 防空跑：口径必须是"真的扫到了系统文案"，否则把区块选空（或选择器失效）也会通过。
    if (collaborationCheck.scanned < 5) {
      throw new Error(`English Profile collaboration section scanned only ${collaborationCheck.scanned} system text nodes; the assertion scope is stale`);
    }
    if (collaborationCheck.values.length > 0) {
      throw new Error(`English Profile collaboration contains untranslated system text: ${JSON.stringify(collaborationCheck.values.slice(0, 20))}`);
    }
    await automationContext.close();

    await expectNoHanSystemText(browser, `${automationUrl}?view=optimization`, ".automation-optimization-view", "English optimization suggestions");
    await expectNoHanAutomationReviewText(browser);
    await expectNoHanTerminalAuxiliaryText(browser);
    await expectNoHanSystemText(browser, chartUrl, ".chart-wrap", "English chart preview");
    await expectNoHanSystemText(browser, aiUrl, ".ai-panel", "English AI preview", { extraSkip: ".ai-session-list,.ai-evidence-references", minScanned: 20 });
    await expectNoHanIntelligenceText(browser);

    const explicit = await openTerminal(browser, "de-DE", "ja-JP");
    await expectLocale(explicit.page, "ja-JP");
    await explicit.page.locator('.rail-item[data-workspace="settings"]').click();
    await explicit.page.waitForSelector(".language-preference-grid");
    await explicit.page.locator('input[name="desic-language"][value="ko-KR"]').click({ force: true });
    await expectLocale(explicit.page, "ko-KR");

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
    await expectLocale(explicit.page, "ko-KR");
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
