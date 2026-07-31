import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const configuredUrl = process.env.DESIC_TRADE_TICKET_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview";
const previewUrl = new URL(configuredUrl);
if (!previewUrl.searchParams.has("accounts")) previewUrl.searchParams.set("accounts", "demo");

const viewports = [
  { label: "desktop", width: 1440, height: 900 },
  { label: "compact", width: 1280, height: 720 },
];

const instrumentDefaults = {
  instType: "SWAP",
  state: "live",
  settleCcy: "USDT",
  tickSz: "0.1",
  minSz: "0.01",
  lotSz: "0.01",
  maxLmtSz: "100000",
  maxMktSz: "100000",
  ctVal: "0.01",
  lever: "100",
};

const marketAssetsSeed = {
  cacheDir: "cache/market-assets",
  instruments: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "AVAX"].map((baseCcy) => ({
    ...instrumentDefaults,
    instId: `${baseCcy}-USDT-SWAP`,
    baseCcy,
    instFamily: `${baseCcy}-USDT`,
    iconPath: `cache/market-assets/icons/${baseCcy}.png`,
    iconCached: true,
  })),
};

const ordinaryOrderTypes = ["limit", "market", "post_only", "ioc", "fok"];
const orderTypeCases = [
  { value: "limit", label: "限价", priceLabel: "价格（USDT）", attachedExits: true },
  { value: "market", label: "市价委托", priceLabel: "价格（USDT）", attachedExits: true },
  { value: "post_only", label: "Post Only", priceLabel: "价格（USDT）", attachedExits: true },
  { value: "ioc", label: "IOC", priceLabel: "价格（USDT）", attachedExits: true },
  { value: "fok", label: "FOK", priceLabel: "价格（USDT）", attachedExits: true },
  { value: "trigger", label: "计划委托", priceLabel: "触发价（USDT）", attachedExits: false },
  { value: "trailing", label: "追踪止损", priceLabel: "激活价（USDT，可选）", attachedExits: false },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rectsOverlap(a, b, tolerance = 1) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > tolerance && height > tolerance;
}

function actionableConsoleErrors(consoleErrors) {
  return consoleErrors.filter((text) => !/WebSocket|ERR_|Failed to load resource|NetworkError|Load failed|fetch.*failed/i.test(text));
}

async function installPreviewFixtures(page) {
  await page.route("**/cache/market-assets/swap-instruments.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(marketAssetsSeed),
  }));
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
}

async function openPreviewPage(browser, viewport, url = previewUrl.href) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  await installPreviewFixtures(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".terminal .ticket-shell", { timeout: 30_000 });
  await page.waitForFunction(() => {
    const orderType = document.querySelector('.ticket-form [role="combobox"][aria-label="委托类型"]');
    return orderType instanceof HTMLButtonElement && orderType.dataset.value === "limit";
  });
  await page.waitForFunction(() => {
    const select = document.querySelector('.ticket-form [role="combobox"][aria-label="杠杆"]');
    return select instanceof HTMLButtonElement && !select.disabled;
  });
  if (await page.locator("select").count()) throw new Error("trade ticket preview rendered a native select");
  return { page, consoleErrors, pageErrors };
}

async function assertInputsAccessible(page, stateLabel) {
  const controls = await page.locator('.ticket-shell input, .ticket-shell [role="combobox"], .ticket-shell textarea').evaluateAll((nodes) =>
    nodes
      .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden")
      .map((node) => {
        const labelledBy = (node.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() || "")
          .filter(Boolean)
          .join(" ");
        const labels = "labels" in node
          ? [...(node.labels || [])].map((label) => label.textContent?.trim() || "").filter(Boolean).join(" ")
          : "";
        const name = node.getAttribute("aria-label")?.trim() || labelledBy || labels;
        return {
          tag: node.tagName.toLowerCase(),
          type: node.getAttribute("type") || "",
          id: node.id,
          name,
        };
      })
  );
  const unnamed = controls.filter((control) => !control.name);
  assert(controls.length > 0, `trade ticket has no form controls in ${stateLabel}`);
  assert(unnamed.length === 0, `trade ticket inputs need label/aria in ${stateLabel}: ${JSON.stringify(unnamed)}`);
}

async function selectOrderType(page, value) {
  const select = page.getByLabel("委托类型", { exact: true });
  await select.click();
  await page.getByRole("listbox", { name: "委托类型选项" }).locator(`[data-value="${value}"]`).click();
  await page.waitForFunction((nextValue) => {
    const item = document.querySelector('.ticket-form [role="combobox"][aria-label="委托类型"]');
    return item instanceof HTMLButtonElement && item.dataset.value === nextValue;
  }, value);
}

async function verifyOrderTypesAndAttachedExits(page) {
  await page.getByRole("button", { name: "开仓", exact: true }).click();
  for (const orderType of orderTypeCases) {
    await selectOrderType(page, orderType.value);
    const selectedText = await page.getByLabel("委托类型", { exact: true }).locator(".terminal-select-value").textContent();
    assert(selectedText?.trim() === orderType.label, `order type ${orderType.value} did not select: ${selectedText}`);
    assert(await page.getByLabel(orderType.priceLabel, { exact: true }).count() === 1, `order type ${orderType.value} is missing ${orderType.priceLabel}`);
    const exitPanels = await page.locator(".attached-exits-panel").count();
    assert(exitPanels === Number(orderType.attachedExits), `TP/SL visibility is wrong for open ${orderType.value}: ${exitPanels}`);
    if (orderType.value === "limit") {
      const attachedExits = page.getByLabel("止盈/止损", { exact: true });
      assert(await attachedExits.count() === 1 && await attachedExits.isChecked() === false, "TP/SL master switch must default off");
      assert(await page.getByLabel("触发止盈", { exact: true }).count() === 0, "TP input must stay collapsed while TP/SL is off");
      await attachedExits.check();
      assert(await page.getByLabel("触发止盈", { exact: true }).count() === 1, "TP input did not expand with TP/SL");
      assert(await page.getByLabel("止损价格", { exact: true }).count() === 1, "SL input did not expand with TP/SL");
      await page.getByLabel("触发止盈", { exact: true }).fill("55000");
      await attachedExits.uncheck();
      await attachedExits.check();
      assert(await page.getByLabel("触发止盈", { exact: true }).inputValue() === "", "disabling TP/SL must clear stale trigger prices");
      await attachedExits.uncheck();
    }

    if (orderType.value === "market") {
      const marketPrice = page.getByLabel(orderType.priceLabel, { exact: true });
      assert(await marketPrice.isEditable() === false, "market price must be read-only");
      assert(await marketPrice.inputValue() === "市价", "market price should explain market execution");
    }
    if (orderType.value === "trigger") {
      assert(await page.getByLabel("触发价来源", { exact: true }).count() === 1, "trigger source is missing");
      const executionGroup = page.getByRole("group", { name: "触发后执行" });
      await executionGroup.getByRole("button", { name: "限价", exact: true }).click();
      assert(await page.getByLabel("触发后限价(USDT)", { exact: true }).count() === 1, "trigger limit price is missing");
      await assertInputsAccessible(page, "trigger-limit");
      await executionGroup.getByRole("button", { name: "市价", exact: true }).click();
      assert(await page.getByLabel("触发后限价(USDT)", { exact: true }).count() === 0, "trigger limit price should hide for market execution");
    }
    if (orderType.value === "trailing") {
      assert(await page.getByLabel("回调幅度(%)", { exact: true }).count() === 1, "trailing callback input is missing");
    }
    await assertInputsAccessible(page, `open-${orderType.value}`);
  }

  await page.getByRole("button", { name: "平仓", exact: true }).click();
  for (const value of ordinaryOrderTypes) {
    await selectOrderType(page, value);
    assert(await page.locator(".attached-exits-panel").count() === 0, `TP/SL must stay hidden for close ${value}`);
    await assertInputsAccessible(page, `close-${value}`);
  }
  await page.getByRole("button", { name: "开仓", exact: true }).click();
}

async function verifyContractsOnly(page) {
  await selectOrderType(page, "limit");
  assert(await page.getByText("按风险定额", { exact: true }).count() === 0, "removed risk-budget sizing control is still visible");
  assert(await page.getByLabel("测算止损价(USDT)", { exact: true }).count() === 0, "removed sizing-only stop field is still visible");
  const contracts = page.getByLabel("数量（张）", { exact: true });
  assert(await contracts.count() === 1 && await contracts.isEditable(), "contract quantity must be the only editable sizing input");
  await contracts.fill("2");
  assert(await contracts.inputValue() === "2", "contract quantity did not accept direct input");
  await assertInputsAccessible(page, "contracts-only");
}

async function verifyEmergencyOperationPreviewBoundary(page) {
  await page.getByRole("button", { name: /^持仓\(/ }).click();
  const positionsSection = page.getByRole("region", { name: "持仓紧急操作" });
  assert(await positionsSection.count() === 1 && await positionsSection.isVisible(), "flatten action is missing from the positions tab");
  const flattenPositions = positionsSection.getByRole("button", { name: "市价全平当前合约持仓", exact: true });
  assert(await flattenPositions.count() === 1, "positions tab is missing current-instrument flatten");
  assert(await positionsSection.getByRole("button", { name: "撤销当前合约全部委托", exact: true }).count() === 0, "cancel-all leaked into the positions tab");
  assert((await flattenPositions.getAttribute("title"))?.includes("不会撤销委托"), "flatten control must say it will not cancel orders");
  const flattenDisabled = await flattenPositions.isDisabled();

  await page.getByRole("button", { name: /^当前委托\(/ }).click();
  const ordersSection = page.getByRole("region", { name: "当前委托紧急操作" });
  assert(await ordersSection.count() === 1 && await ordersSection.isVisible(), "cancel-all action is missing from the current-orders tab");
  const cancelOrders = ordersSection.getByRole("button", { name: "撤销当前合约全部委托", exact: true });
  assert(await cancelOrders.count() === 1, "current-orders tab is missing current-instrument cancel-all");
  assert(await ordersSection.getByRole("button", { name: "市价全平当前合约持仓", exact: true }).count() === 0, "flatten leaked into the current-orders tab");
  assert((await cancelOrders.getAttribute("title"))?.includes("不会平仓"), "cancel-all control must say it will not flatten positions");
  const cancelDisabled = await cancelOrders.isDisabled();

  const nonDesktopPreview = await page.evaluate(() => !("__TAURI_INTERNALS__" in window));
  assert(nonDesktopPreview, "terminal preview unexpectedly exposes a desktop IPC runtime");
  if (cancelDisabled || flattenDisabled) {
    return {
      status: "fixture-blocked",
      detail: `emergency controls disabled: cancel=${cancelDisabled}, flatten=${flattenDisabled}`,
    };
  }

  await cancelOrders.click();
  const cancelState = ordersSection.locator('.instrument-operation-state[data-stage="failed"]');
  await cancelState.waitFor({ state: "visible", timeout: 5_000 });
  assert((await cancelState.textContent())?.includes("预览失败"), `cancel-all preview did not fail closed in browser preview: ${await cancelState.textContent()}`);
  assert(await page.locator(".instrument-operation-dialog").count() === 0, "cancel-all browser preview reached an execution confirmation");

  await page.getByRole("button", { name: /^持仓\(/ }).click();
  await flattenPositions.click();
  const flattenState = positionsSection.locator('.instrument-operation-state[data-stage="failed"]');
  await flattenState.waitFor({ state: "visible", timeout: 5_000 });
  assert((await flattenState.textContent())?.includes("预览失败"), `flatten preview did not fail closed in browser preview: ${await flattenState.textContent()}`);
  assert(await page.locator(".instrument-operation-dialog").count() === 0, "flatten browser preview reached an execution confirmation");
  assert(await page.locator(".trade-last-order").count() === 0, "emergency preview created a normal order state");
  return { status: "preview-only-verified", detail: "both controls failed closed at preview without confirmation or execute" };
}

async function prepareEnabledDemoOrder(page) {
  await page.getByRole("button", { name: "开仓", exact: true }).click();
  await selectOrderType(page, "limit");
  await page.getByLabel("价格（USDT）", { exact: true }).fill("50000");
  await page.getByLabel("数量（张）", { exact: true }).fill("0.1");
  try {
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll(".trade-buttons button")];
      return buttons.length === 2 && buttons.every((button) => !button.disabled);
    }, undefined, { timeout: 5_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      account: document.querySelector(".account-button")?.textContent?.trim() || "",
      permission: document.querySelector(".account-permission-note")?.textContent?.trim() || "",
      buttons: [...document.querySelectorAll(".trade-buttons button")].map((button) => ({
        disabled: button.disabled,
        title: button.getAttribute("title"),
        text: button.textContent?.trim() || ""
      }))
    }));
    throw new Error(`demo order actions did not become enabled: ${JSON.stringify(state)}; ${error.message}`);
  }
}

async function selectPreviewAccount(page, accountName, { liveRiskAction = "confirm" } = {}) {
  await page.locator(".account-button").click();
  await page.waitForSelector(".modal-shell.account-modal", { timeout: 5_000 });
  await page.locator(".account-list-row", { hasText: accountName }).click();
  const liveRiskDialog = page.locator(".confirm-dialog", { hasText: "切换到实盘" });
  const liveRiskShown = await liveRiskDialog.count() > 0;
  if (liveRiskShown) {
    const actionName = liveRiskAction === "cancel" ? "取消" : "已理解风险，进入实盘";
    await liveRiskDialog.getByRole("button", { name: actionName, exact: true }).click();
    await liveRiskDialog.waitFor({ state: "detached", timeout: 5_000 });
  }
  await page.locator(".account-modal .modal-head .window-button[title='关闭']").click();
  await page.waitForSelector(".modal-shell.account-modal", { state: "detached", timeout: 5_000 });
  if (liveRiskAction !== "cancel") {
    await page.waitForFunction((name) => document.querySelector(".account-button")?.textContent?.includes(name), accountName);
  }
  return { liveRiskShown };
}

async function verifyLiveRiskCancellationBoundary(page) {
  const beforeAccount = (await page.locator(".account-button").textContent())?.trim() || "";
  const result = await selectPreviewAccount(page, "OKX 只读观察", { liveRiskAction: "cancel" });
  assert(result.liveRiskShown, "selecting an unacknowledged live account did not open the first-entry risk confirmation");
  const afterAccount = (await page.locator(".account-button").textContent())?.trim() || "";
  assert(afterAccount === beforeAccount, `cancelling live risk confirmation changed the trading account: ${beforeAccount} -> ${afterAccount}`);
  assert(await page.locator(".live-risk-note").count() === 0, "cancelling live risk confirmation still entered live trading mode");
}

async function verifySameAccountEnvironmentFlipBoundary(browser) {
  const flipUrl = new URL(previewUrl);
  flipUrl.searchParams.set("accountEnvironmentFlip", "1");
  const preview = await openPreviewPage(browser, viewports[0], flipUrl.href);
  try {
    const accountButton = preview.page.locator(".account-button");
    assert((await accountButton.textContent())?.includes("OKX 预览模拟盘"), "environment-flip fixture did not start on the demo account");
    await preview.page.evaluate(() => window.dispatchEvent(new Event("desic:preview-account-environment-flip")));
    const liveRiskDialog = preview.page.locator(".confirm-dialog", { hasText: "切换到实盘" });
    await liveRiskDialog.waitFor({ state: "visible", timeout: 5_000 });
    assert((await accountButton.textContent())?.includes("未配置账号"), "same-ID demo-to-live change exposed the live account before confirmation");
    assert(await preview.page.locator(".live-risk-note").count() === 0, "same-ID demo-to-live change rendered live trading controls before confirmation");

    await liveRiskDialog.getByRole("button", { name: "取消", exact: true }).click();
    await liveRiskDialog.waitFor({ state: "detached", timeout: 5_000 });
    await preview.page.waitForTimeout(250);
    assert(await preview.page.locator(".confirm-dialog", { hasText: "切换到实盘" }).count() === 0, "same-ID environment cancellation reopened the live risk dialog");
    assert((await accountButton.textContent())?.includes("未配置账号"), "same-ID environment cancellation retained the newly-live account");
    assert(await preview.page.locator(".live-risk-note").count() === 0, "same-ID environment cancellation entered live trading mode");
    return assertPageErrors("same-account-environment-flip", preview.consoleErrors, preview.pageErrors);
  } finally {
    await preview.page.close();
  }
}

async function verifyVisibleDialogHotkeyGuard(page) {
  await prepareEnabledDemoOrder(page);
  await page.locator(".account-button").click();
  await page.waitForSelector(".modal-shell.account-modal", { timeout: 5_000 });
  await page.keyboard.press("Alt+KeyB");
  await page.keyboard.press("Alt+KeyS");
  await page.waitForTimeout(100);
  assert(await page.locator(".modal-shell.account-modal").count() === 1, "visible dialog should remain open after trade hotkeys");
  assert(await page.locator(".trade-last-order").count() === 0, "trade hotkey submitted while a dialog was visible");
  assert(await page.locator(".confirm-dialog").count() === 0, "trade hotkey opened a trade confirmation behind a visible dialog");
  await page.locator(".account-modal .modal-head .window-button[title='关闭']").click();
}

async function verifyInputHotkeyGuard(page) {
  await prepareEnabledDemoOrder(page);
  const price = page.getByLabel("价格（USDT）", { exact: true });
  await price.focus();
  assert(await price.evaluate((node) => document.activeElement === node), "price input should be focused before the hotkey check");
  await page.keyboard.press("Alt+KeyB");
  await page.keyboard.press("Alt+KeyS");
  await page.waitForTimeout(150);
  assert(await page.locator(".trade-last-order").count() === 0, "trade hotkey submitted while a ticket input was focused");
  assert(await page.locator(".confirm-dialog").count() === 0, "trade hotkey opened confirmation while a ticket input was focused");
}

async function verifyOnboardingHotkeyGuard(browser) {
  const onboardingUrl = new URL(previewUrl);
  onboardingUrl.searchParams.set("onboarding", "trade");
  const preview = await openPreviewPage(browser, viewports[0], onboardingUrl.href);
  try {
    await preview.page.waitForSelector(".first-launch-onboarding", { timeout: 5_000 });
    const closeTab = preview.page.getByRole("button", { name: "平仓", exact: true });
    assert(await closeTab.getAttribute("aria-pressed") === "false", "trade preview must begin on the open tab");
    await preview.page.keyboard.press("Alt+KeyC");
    await preview.page.waitForTimeout(100);
    assert(await closeTab.getAttribute("aria-pressed") === "false", "onboarding overlay allowed Alt+C to switch the ticket mode");

    const sizeInput = preview.page.locator('[data-trade-hotkey-input="size"]');
    await preview.page.keyboard.press("Alt+KeyQ");
    await preview.page.waitForTimeout(100);
    assert(await sizeInput.evaluate((node) => document.activeElement !== node), "onboarding overlay allowed Alt+Q to focus the size input");
    return assertPageErrors("onboarding-hotkey", preview.consoleErrors, preview.pageErrors);
  } finally {
    await preview.page.close();
  }
}

async function verifyLiveConfirmationBoundary(page) {
  const selection = await selectPreviewAccount(page, "OKX 只读观察");
  assert(selection.liveRiskShown, "live account selection bypassed the first-entry risk confirmation");
  assert(await page.locator(".live-risk-note").count() === 0, "removed persistent live-account note is still rendered");
  const permissionCopy = await page.locator(".account-permission-note").textContent();
  assert(permissionCopy?.includes("未开启交易权限"), `preview live fixture should expose its read-only boundary: ${permissionCopy}`);

  await page.getByRole("button", { name: "开仓", exact: true }).click();
  await selectOrderType(page, "limit");
  await page.getByLabel("价格（USDT）", { exact: true }).fill("50000");
  await page.getByLabel("数量（张）", { exact: true }).fill("1");
  const action = page.locator(".trade-buttons button").first();
  const disabled = await action.isDisabled();

  if (disabled) {
    const title = await action.getAttribute("title");
    assert(
      title?.includes("账号未开启交易权限") || title?.includes("未决紧急操作恢复失败") || title?.includes("未决交易执行恢复失败"),
      `live fixture must explain why confirmation is unreachable: ${title}`,
    );
    await action.evaluate((button) => button.click());
    await page.waitForTimeout(100);
    assert(await page.locator(".confirm-dialog").count() === 0, "disabled live action unexpectedly opened confirmation");
    assert(await page.locator(".trade-last-order").count() === 0, "disabled live action unexpectedly submitted an order");
    return {
      status: "fixture-blocked",
      detail: "the browser-only fixture has no desktop execution ledger (and may expose a non-trading live account), so fail-closed guards keep confirmation unreachable",
    };
  }

  await action.click();
  await page.waitForSelector(".modal-shell.confirm-dialog", { timeout: 5_000 });
  const title = await page.locator(".confirm-dialog .modal-head strong").textContent();
  const frozenMessage = (await page.locator(".confirm-dialog p").textContent())?.trim() || "";
  assert(title?.trim() === "确认实盘下单", `live action should only open the trade confirmation: ${title}`);
  for (const token of ["BTC-USDT-SWAP", "做多", "限价", "数量 1 张", "价格 50000", "杠杆 20X", "全仓", "冻结快照"]) {
    assert(frozenMessage.includes(token), `live confirmation is missing frozen parameter ${token}: ${frozenMessage}`);
  }
  assert(await page.locator(".trade-last-order").count() === 0, "opening live confirmation must not submit the order");
  await page.getByLabel("价格（USDT）", { exact: true }).fill("51000", { force: true });
  await page.getByLabel("数量（张）", { exact: true }).fill("2", { force: true });
  assert((await page.locator(".confirm-dialog p").textContent())?.trim() === frozenMessage, "confirmation parameters changed after the underlying draft changed");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert(await page.locator(".trade-last-order").count() === 0, "cancelling live confirmation must not submit the order");
  return { status: "verified", detail: "confirmation opened without submission and kept a frozen parameter snapshot" };
}

async function readControlOverlapState(page) {
  return page.evaluate(() => {
    const form = document.querySelector(".ticket-form");
    const sticky = document.querySelector(".trade-submit-zone");
    if (!form || !sticky) return null;
    const formRect = form.getBoundingClientRect();
    const stickyRect = sticky.getBoundingClientRect();
    const clipTop = formRect.top;
    const clipBottom = Math.min(formRect.bottom, stickyRect.top);
    const controls = [...form.querySelectorAll('input, button, [role="combobox"]')]
      .filter((node) => !node.closest(".trade-submit-zone"))
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          name: node.getAttribute("aria-label") || node.textContent?.trim() || node.id || node.tagName,
          left: Math.max(box.left, formRect.left),
          right: Math.min(box.right, formRect.right),
          top: Math.max(box.top, clipTop),
          bottom: Math.min(box.bottom, clipBottom),
        };
      })
      .filter((box) => box.right - box.left > 2 && box.bottom - box.top > 2);
    return { controls, scrollTop: form.scrollTop, scrollHeight: form.scrollHeight, clientHeight: form.clientHeight };
  });
}

async function verifyLayout(page, label) {
  await page.getByRole("button", { name: "开仓", exact: true }).click();
  await selectOrderType(page, "limit");
  await page.getByLabel("止盈/止损", { exact: true }).check();

  const state = await page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
    };
    const scroll = (selector) => {
      const node = document.querySelector(selector);
      return node ? { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth } : null;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overflow: {
        html: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - innerWidth,
        root: document.getElementById("root").scrollWidth - innerWidth,
      },
      ticket: rect(".ticket"),
      shell: rect(".ticket-shell"),
      form: rect(".ticket-form"),
      marketDepth: rect(".market-depth"),
      orderbook: rect(".orderbook"),
      windowControls: rect(".window-controls"),
      tradeButtons: [...document.querySelectorAll(".trade-buttons button")].map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      }),
      horizontalScroll: {
        ticket: scroll(".ticket"),
        shell: scroll(".ticket-shell"),
        form: scroll(".ticket-form"),
      },
    };
  });

  assert(state.ticket && state.shell && state.form && state.marketDepth && state.orderbook && state.windowControls, `missing layout regions at ${label}: ${JSON.stringify(state)}`);
  assert(Object.values(state.overflow).every((value) => value <= 2), `global horizontal overflow at ${label}: ${JSON.stringify(state.overflow)}`);
  for (const [name, scroll] of Object.entries(state.horizontalScroll)) {
    assert(scroll && scroll.scrollWidth - scroll.clientWidth <= 2, `${name} has horizontal overflow at ${label}: ${JSON.stringify(scroll)}`);
  }
  assert(!rectsOverlap(state.ticket, state.marketDepth), `ticket overlaps market depth at ${label}`);
  assert(!rectsOverlap(state.ticket, state.orderbook), `ticket overlaps orderbook at ${label}`);
  assert(!rectsOverlap(state.ticket, state.windowControls), `ticket overlaps window controls at ${label}`);
  assert(state.ticket.left >= -2 && state.ticket.right <= state.viewport.width + 2 && state.ticket.bottom <= state.viewport.height + 2, `ticket escapes viewport at ${label}: ${JSON.stringify(state.ticket)}`);
  assert(state.tradeButtons.length === 2, `trade actions are missing at ${label}`);
  assert(!rectsOverlap(state.tradeButtons[0], state.tradeButtons[1]), `trade action buttons overlap at ${label}`);
  assert(state.tradeButtons.every((button) => button.width >= 70 && button.height >= 42 && button.right <= state.ticket.right + 2), `trade actions are clipped at ${label}: ${JSON.stringify(state.tradeButtons)}`);

  const maxScroll = await page.locator(".ticket-form").evaluate((node) => Math.max(0, node.scrollHeight - node.clientHeight));
  for (const scrollTop of [0, Math.round(maxScroll / 2), maxScroll]) {
    await page.locator(".ticket-form").evaluate((node, nextScrollTop) => { node.scrollTop = nextScrollTop; }, scrollTop);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const overlapState = await readControlOverlapState(page);
    assert(overlapState, `could not read ticket controls at ${label}`);
    const overlaps = [];
    for (let left = 0; left < overlapState.controls.length; left += 1) {
      for (let right = left + 1; right < overlapState.controls.length; right += 1) {
        if (rectsOverlap(overlapState.controls[left], overlapState.controls[right])) {
          overlaps.push(`${overlapState.controls[left].name}/${overlapState.controls[right].name}`);
        }
      }
    }
    assert(overlaps.length === 0, `visible ticket controls overlap at ${label} scroll=${overlapState.scrollTop}: ${overlaps.join(", ")}`);
  }
  await page.locator(".ticket-form").evaluate((node) => { node.scrollTop = 0; });
  await page.getByLabel("止盈/止损", { exact: true }).uncheck();
}

function assertPageErrors(label, consoleErrors, pageErrors) {
  const actionable = actionableConsoleErrors(consoleErrors);
  assert(pageErrors.length === 0 && actionable.length === 0, `${label} preview errors: ${JSON.stringify({ pageErrors, consoleErrors: actionable })}`);
  return consoleErrors.length - actionable.length;
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  let liveCoverage = { status: "not-run", detail: "" };
  let emergencyCoverage = { status: "not-run", detail: "" };
  let ignoredNetworkErrors = 0;
  try {
    const primary = await openPreviewPage(browser, viewports[0]);
    try {
      assert(await primary.page.locator(".ticket").isVisible(), "trade ticket is not visible");
      await assertInputsAccessible(primary.page, "initial");
      await verifyOrderTypesAndAttachedExits(primary.page);
      await verifyContractsOnly(primary.page);
      await verifyLayout(primary.page, viewports[0].label);
      emergencyCoverage = await verifyEmergencyOperationPreviewBoundary(primary.page);
      await verifyLiveRiskCancellationBoundary(primary.page);
      liveCoverage = await verifyLiveConfirmationBoundary(primary.page);
      await selectPreviewAccount(primary.page, "OKX 预览模拟盘");
      await verifyVisibleDialogHotkeyGuard(primary.page);
      await verifyInputHotkeyGuard(primary.page);
      ignoredNetworkErrors += assertPageErrors(viewports[0].label, primary.consoleErrors, primary.pageErrors);
    } finally {
      await primary.page.close();
    }

    const compact = await openPreviewPage(browser, viewports[1]);
    try {
      await assertInputsAccessible(compact.page, "compact-initial");
      await verifyLayout(compact.page, viewports[1].label);
      ignoredNetworkErrors += assertPageErrors(viewports[1].label, compact.consoleErrors, compact.pageErrors);
    } finally {
      await compact.page.close();
    }
    ignoredNetworkErrors += await verifyOnboardingHotkeyGuard(browser);
    ignoredNetworkErrors += await verifySameAccountEnvironmentFlipBoundary(browser);
  } finally {
    await browser.close();
  }

  if (liveCoverage.status === "fixture-blocked") {
    process.stderr.write(`[smoke] trade ticket coverage gap: ${liveCoverage.detail}\n`);
  }
  if (emergencyCoverage.status === "fixture-blocked") {
    process.stderr.write(`[smoke] trade ticket coverage gap: ${emergencyCoverage.detail}\n`);
  }
  process.stdout.write(
    `[smoke] trade ticket preview ok: viewports=${viewports.map(({ width, height }) => `${width}x${height}`).join(",")}, orderTypes=${orderTypeCases.length}, inputs=labelled, hotkeys=guarded, onboardingHotkeys=guarded, liveRiskCancel=guarded, sameIdEnvironmentFlip=guarded, emergency=${emergencyCoverage.status}, liveConfirmation=${liveCoverage.status}, ignoredPreviewNetworkErrors=${ignoredNetworkErrors}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`[smoke] trade ticket preview failed: ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
