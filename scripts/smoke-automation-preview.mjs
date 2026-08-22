import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.DESIC_AUTOMATION_PREVIEW_URL || "http://127.0.0.1:1420/automation-preview";
const artifactDir = path.resolve("artifacts", "automation-preview");
const scenarios = [
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1280x720", width: 1280, height: 720 }
];

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function assertNoPairwiseOverlap(items, label) {
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (rectsOverlap(items[left], items[right])) {
        throw new Error(`${label}: elements overlap: ${JSON.stringify({ left: items[left], right: items[right] })}`);
      }
    }
  }
}

function assertInsideViewport(box, scenario, label) {
  if (!box || box.width <= 0 || box.height <= 0
    || box.x < -1 || box.y < -1
    || box.x + box.width > scenario.width + 1
    || box.y + box.height > scenario.height + 1) {
    throw new Error(`${label}: core element is outside viewport: ${JSON.stringify({ box, scenario })}`);
  }
}

async function readPageState(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".automation-preview-page");
    return {
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      rootOverflowX: root ? root.scrollWidth - root.clientWidth : null,
      rootHeight: root?.getBoundingClientRect().height ?? 0
    };
  });
}

function assertNoGlobalOverflow(state, label) {
  if (state.documentOverflowX > 1 || state.bodyOverflowX > 1 || (state.rootOverflowX ?? 0) > 1) {
    throw new Error(`${label}: global horizontal overflow: ${JSON.stringify(state)}`);
  }
}

async function boxesFor(page, selector) {
  return page.locator(selector).evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
}

async function verifyConfig(page, scenario) {
  await page.goto(`${baseUrl}?view=config`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="config"] .automation-agent-row', { timeout: 30_000 });

  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/config`);
  if (state.rootHeight < scenario.height - 1 || state.rootHeight > scenario.height + 1) {
    throw new Error(`${scenario.label}/config: preview root height is unstable: ${JSON.stringify(state)}`);
  }

  const rows = page.locator(".automation-agent-row");
  if (await rows.count() !== 4) throw new Error(`${scenario.label}/config: expected four configured Agents`);
  const names = await rows.locator(".automation-agent-row-copy strong").allTextContents();
  for (const expected of ["市场结构", "情报资金", "账户风险", "反方审查"]) {
    if (!names.includes(expected)) throw new Error(`${scenario.label}/config: missing template Agent ${expected}: ${JSON.stringify(names)}`);
  }
  if (!(await page.locator('.automation-collaboration-mode button[aria-checked="true"]', { hasText: "自定义" }).count())) {
    throw new Error(`${scenario.label}/config: custom mode is not selected`);
  }
  const schemeSelect = page.getByRole("combobox", { name: "Agent 方案", exact: true });
  if (await schemeSelect.getAttribute("data-value") !== "builtin-perpetual-decision-desk") {
    throw new Error(`${scenario.label}/config: built-in Agent scheme is not selected`);
  }
  await schemeSelect.click();
  if (!(await page.getByRole("option", { name: /永续合约决策台/ }).count())) {
    throw new Error(`${scenario.label}/config: built-in perpetual scheme is missing`);
  }
  const schemeMenuBox = await page.getByRole("listbox", { name: "Agent 方案选项" }).boundingBox();
  assertInsideViewport(schemeMenuBox, scenario, `${scenario.label}/config Agent scheme menu`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-select-open.png`),
    fullPage: false
  });
  await schemeSelect.press("Escape");

  await page.getByRole("button", { name: "保存当前团队为方案" }).click();
  await page.getByLabel("方案名称").fill(`视觉回归方案 ${scenario.label}`);
  await page.getByLabel("说明", { exact: true }).fill("验证方案保存、选择与快照关联");
  await page.getByRole("button", { name: "确认保存" }).click();
  await page.waitForFunction(() => {
    const select = document.querySelector('.automation-scheme-picker [role="combobox"][aria-label="Agent 方案"]');
    return select instanceof HTMLButtonElement && (select.dataset.value || "").startsWith("preview-scheme-");
  });
  await schemeSelect.click();
  if (!(await page.getByRole("option", { name: `视觉回归方案 ${scenario.label}`, exact: true }).count())) {
    throw new Error(`${scenario.label}/config: saved Agent scheme is not selectable`);
  }
  await schemeSelect.press("Escape");
  if (await page.locator("select").count()) throw new Error(`${scenario.label}/config: native select must not be rendered`);

  const leadBox = await page.locator(".automation-topology-lead").boundingBox();
  const rowBoxes = await boxesFor(page, ".automation-agent-row");
  assertInsideViewport(leadBox, scenario, `${scenario.label}/config lead`);
  rowBoxes.forEach((box, index) => assertInsideViewport(box, scenario, `${scenario.label}/config Agent ${index + 1}`));
  assertNoPairwiseOverlap(rowBoxes, `${scenario.label}/config Agent rows`);

  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-config.png`),
    fullPage: false
  });

  await page.getByRole("radio", { name: "自动分配" }).click();
  const increaseAgent = page.getByRole("button", { name: "增加 Agent" });
  for (let index = 0; index < 4; index += 1) await increaseAgent.click();
  if (await page.locator(".automation-auto-agent-slot").count() !== 8) {
    throw new Error(`${scenario.label}/config-auto: expected eight automatic Agent slots`);
  }
  const autoState = await readPageState(page);
  assertNoGlobalOverflow(autoState, `${scenario.label}/config-auto`);
  const autoSlots = await boxesFor(page, ".automation-auto-agent-slot");
  autoSlots.forEach((box, index) => assertInsideViewport(box, scenario, `${scenario.label}/config-auto Agent ${index + 1}`));
  assertNoPairwiseOverlap(autoSlots, `${scenario.label}/config-auto Agent slots`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-config-auto-8.png`),
    fullPage: false
  });
  await page.getByRole("radio", { name: "自定义" }).click();

  await rows.first().locator(".automation-agent-row-summary").click();
  await page.waitForSelector(".automation-agent-inline-editor");
  const editor = page.locator(".automation-agent-inline-editor");
  await editor.scrollIntoViewIfNeeded();
  const editorState = await readPageState(page);
  assertNoGlobalOverflow(editorState, `${scenario.label}/config-editor`);
  if (await editor.locator("input").count() < 4 || await editor.locator("textarea").count() !== 1) {
    throw new Error(`${scenario.label}/config-editor: inline Agent fields are incomplete`);
  }
  if (await editor.locator(".automation-agent-scopes button").count() !== 0) {
    throw new Error(`${scenario.label}/config-editor: user data scope controls should be absent`);
  }
  if (await editor.locator(".automation-agent-scope-note").count() !== 1) {
    throw new Error(`${scenario.label}/config-editor: Profile data inheritance note is missing`);
  }
  assertInsideViewport(await editor.boundingBox(), scenario, `${scenario.label}/config editor`);

  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-config-editor.png`),
    fullPage: false
  });
}

async function verifyRun(page, scenario) {
  await page.goto(`${baseUrl}?view=run`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="run"] .automation-agent-trace-section', { timeout: 30_000 });
  const trace = page.locator(".automation-agent-trace-section");
  await trace.scrollIntoViewIfNeeded();

  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/run`);
  const tokenBreakdown = await page.locator(".automation-run-token-breakdown").innerText();
  if (!tokenBreakdown.includes("缓存命中率 35.9%") || !tokenBreakdown.includes("读取 65.5K")) {
    throw new Error(`${scenario.label}/run: cache hit rate is missing from run details: ${tokenBreakdown}`);
  }
  const lanes = page.locator(".automation-agent-trace-lane");
  if (await lanes.count() !== 4) throw new Error(`${scenario.label}/run: expected four Agent lanes`);
  if (!(await page.locator(".automation-agent-trace-lane.status-done").count())) throw new Error(`${scenario.label}/run: completed Agent state missing`);
  if (!(await page.locator(".automation-agent-trace-lane.status-running").count())) throw new Error(`${scenario.label}/run: running Agent state missing`);
  if (!(await page.locator(".automation-agent-trace-lane.status-failed").count())) throw new Error(`${scenario.label}/run: failed Agent state missing`);
  if (await page.locator(".automation-agent-trace-tool").count() < 6) throw new Error(`${scenario.label}/run: Agent tool lifecycle rows missing`);
  if (await page.locator(".automation-agent-trace-tool", { hasText: "account.readSnapshot" }).count() !== 1) {
    throw new Error(`${scenario.label}/run: tool call/result without toolCallId were not merged`);
  }
  const riskLane = page.locator(".automation-agent-trace-lane", { hasText: "账户风险" });
  const riskToolText = await riskLane.locator(".automation-agent-trace-tool", { hasText: "account.readSnapshot" }).textContent() || "";
  if (!/已返回 · 4s/.test(await riskLane.locator(":scope > summary").textContent() || "")
    || !/执行 150ms · 排队 1s/.test(riskToolText)) {
    throw new Error(`${scenario.label}/run: Agent and tool durations are missing`);
  }
  const marketLane = page.locator(".automation-agent-trace-lane", { hasText: "市场结构" });
  if (!/3 工具/.test(await marketLane.locator(":scope > summary").textContent() || "")) {
    throw new Error(`${scenario.label}/run: successfulTools fallback did not repair the Agent tool count`);
  }
  const phases = await page.locator(".automation-agent-trace-phase").allTextContents();
  if (phases.length !== 2 || !phases[0].includes("并行取证") || !phases[1].includes("反方审查")) {
    throw new Error(`${scenario.label}/run: two-stage collaboration labels missing: ${JSON.stringify(phases)}`);
  }

  const lead = await page.locator(".automation-agent-trace-stage.stage-lead").boundingBox();
  const laneGroup = await page.locator(".automation-agent-trace-lanes").boundingBox();
  const merge = await page.locator(".automation-agent-trace-stage.stage-merge").boundingBox();
  assertInsideViewport(lead, scenario, `${scenario.label}/run assignment stage`);
  assertInsideViewport(laneGroup, scenario, `${scenario.label}/run Agent lanes`);
  assertInsideViewport(merge, scenario, `${scenario.label}/run merge stage`);
  assertNoPairwiseOverlap([lead, laneGroup, merge], `${scenario.label}/run topology stages`);

  const laneBoxes = await boxesFor(page, ".automation-agent-trace-lane");
  assertNoPairwiseOverlap(laneBoxes, `${scenario.label}/run Agent lanes`);
  const runText = await trace.textContent();
  if (!/任务分配/.test(runText || "") || !/证据汇总/.test(runText || "") || !/4 Agent/.test(runText || "")) {
    throw new Error(`${scenario.label}/run: collaboration topology labels missing`);
  }
  const opportunityFacts = await page.locator(".automation-tool-step.opportunity .automation-run-action-facts").textContent();
  if (!/BTC-USDT-SWAP/.test(opportunityFacts || "")
    || !/做空/.test(opportunityFacts || "")
    || !/0\.02 张/.test(opportunityFacts || "")
    || !/65,?800/.test(opportunityFacts || "")) {
    throw new Error(`${scenario.label}/run: result-backed opportunity facts are incomplete: ${opportunityFacts}`);
  }

  await marketLane.locator(":scope > summary").click();
  await marketLane.locator(".automation-agent-result > summary").click();
  if (await marketLane.locator(".automation-agent-report").count() !== 1
    || await marketLane.locator(".automation-agent-report-facts").count() !== 1
    || await marketLane.locator(".automation-agent-report-conclusion").count() !== 1
    || await marketLane.locator(".automation-agent-report-list").count() !== 4
    || !(await marketLane.locator(".automation-agent-report").isVisible())) {
    throw new Error(`${scenario.label}/run: structured Agent report is incomplete`);
  }
  if (!/证据完整/.test(await marketLane.locator(".automation-agent-report").textContent() || "")
    || !/偏空/.test(await marketLane.locator(".automation-agent-report").textContent() || "")
    || !/72%/.test(await marketLane.locator(".automation-agent-report").textContent() || "")) {
    throw new Error(`${scenario.label}/run: structured Agent report summary is missing`);
  }
  if (await marketLane.locator(".automation-agent-report-raw[open]").count() !== 0) {
    throw new Error(`${scenario.label}/run: raw Agent JSON should remain collapsed by default`);
  }

  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-run.png`),
    fullPage: false
  });
}

async function verifySingleRun(page, scenario) {
  await page.goto(`${baseUrl}?view=single-run`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="single-run"] .automation-run-decision-summary', { timeout: 30_000 });

  const summary = page.locator(".automation-run-decision-summary");
  if (!(await summary.getByText("本轮决策", { exact: true }).count())
    || !(await summary.getByText("放弃本轮", { exact: true }).count())
    || !(await summary.getByText("未形成新交易候选，无需复核", { exact: true }).count())) {
    throw new Error(`${scenario.label}/single-run: single-Agent decision summary is incomplete`);
  }
  if (await page.locator(".automation-run-decision-flow").count()) {
    throw new Error(`${scenario.label}/single-run: no-candidate result must not render a three-stage review flow`);
  }
  if (await page.locator(".automation-agent-trace-section").count()) {
    throw new Error(`${scenario.label}/single-run: single-Agent detail must not render collaboration topology`);
  }
  if (!(await page.getByText("单 Agent Profile", { exact: true }).count())) {
    throw new Error(`${scenario.label}/single-run: preview still labels the run as multi-Agent`);
  }

  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/single-run`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-single-run.png`),
    fullPage: false
  });
}

async function verifyModelError(page, scenario) {
  await page.goto(`${baseUrl}?view=model-error`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="model-error"] .automation-agent-trace-section', { timeout: 30_000 });

  const marketLane = page.locator(".automation-agent-trace-lane", { hasText: "市场结构" });
  await marketLane.locator(":scope > summary").click();
  const failureText = await marketLane.locator(".automation-agent-trace-error").textContent();
  if (!/模型服务错误/.test(failureText || "") || !/Insufficient Balance/.test(failureText || "")) {
    throw new Error(`${scenario.label}/model-error: provider error is not identified clearly: ${failureText}`);
  }
  if (/未通过校验|Agent 报告不是有效 JSON/.test(failureText || "")) {
    throw new Error(`${scenario.label}/model-error: provider error is still presented as report validation: ${failureText}`);
  }

  const runFailure = await page.locator(".automation-run-summary-surface.error").textContent();
  if (!/必需分析 Agent“市场结构”失败：Insufficient Balance/.test(runFailure || "")) {
    throw new Error(`${scenario.label}/model-error: historical run summary was not repaired: ${runFailure}`);
  }
  if (/Agent 报告不是有效 JSON/.test(await page.locator(".automation-run-detail").textContent() || "")) {
    throw new Error(`${scenario.label}/model-error: stale JSON validation error remains visible`);
  }
  if (!(await marketLane.getByText("原始响应", { exact: true }).count())) {
    throw new Error(`${scenario.label}/model-error: provider response diagnostic is missing`);
  }

  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/model-error`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-model-error.png`),
    fullPage: false
  });
}

async function verifyRunRefresh(page, scenario) {
  // This fixture completes after 1.2s. Waiting for network idle can consume that
  // entire window before the assertion observes the running state.
  await page.goto(`${baseUrl}?view=refresh`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  try {
    await page.waitForSelector('.automation-preview-page[data-preview-view="refresh"]', { timeout: 30_000 });
    await page.waitForSelector(".automation-run-modal", { timeout: 30_000 });
  } catch (error) {
    const currentView = await page.locator(".automation-preview-page").getAttribute("data-preview-view").catch(() => null);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    throw new Error(`${scenario.label}/refresh: detail modal missing; view=${currentView}; text=${bodyText.slice(0, 240)}; ${error.message}`);
  }
  await page.getByText("Agent 正在分析", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
  await page.getByText("分析已完成", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
  if (await page.getByText("Agent 正在分析", { exact: true }).count()) {
    throw new Error(`${scenario.label}/refresh: stale running detail remained after the list completed`);
  }
  if (await page.locator(".automation-agent-trace-lane.status-running").count()) {
    throw new Error(`${scenario.label}/refresh: Agent trace still contains a running lane`);
  }
  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/refresh`);
}

async function verifyOptimizationDiff(page, scenario) {
  await page.goto(`${baseUrl}?view=optimization`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="optimization"] .automation-suggestion-card', { timeout: 30_000 });
  if (await page.getByText("开始验证并创建草稿", { exact: true }).count()) {
    throw new Error(`${scenario.label}/optimization: legacy draft workflow is still visible`);
  }
  await page.getByRole("button", { name: "预览变更" }).click();
  const modal = page.locator(".automation-skill-diff-modal");
  await modal.waitFor({ state: "visible", timeout: 10_000 });
  assertInsideViewport(await modal.boundingBox(), scenario, `${scenario.label}/optimization diff modal`);
  if (await modal.locator(".automation-skill-diff-columns strong").count() !== 2) {
    throw new Error(`${scenario.label}/optimization: before/after columns are incomplete`);
  }
  if (!(await modal.locator(".automation-skill-diff-row.added").count())
    || !(await modal.locator(".automation-skill-diff-row.removed").count())) {
    throw new Error(`${scenario.label}/optimization: added or removed diff rows are missing`);
  }
  if (!(await modal.getByRole("button", { name: "采用此版本" }).count())
    || !(await modal.getByRole("button", { name: "拒绝" }).count())) {
    throw new Error(`${scenario.label}/optimization: direct apply/reject actions are incomplete`);
  }
  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/optimization`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-skill-diff.png`),
    fullPage: false
  });
  await modal.getByRole("button", { name: "采用此版本" }).click();
  await modal.waitFor({ state: "detached", timeout: 5_000 });
  if (!(await page.getByText("已采用", { exact: true }).count())) {
    throw new Error(`${scenario.label}/optimization: direct apply did not update the suggestion state`);
  }
}

async function verifyScenario(browser, scenario) {
  const page = await browser.newPage({
    viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: 1
  });
  const consoleErrors = [];
  const pageErrors = [];
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await verifyConfig(page, scenario);
  await verifyRun(page, scenario);
  await verifySingleRun(page, scenario);
  await verifyModelError(page, scenario);
  await verifyRunRefresh(page, scenario);
  await verifyOptimizationDiff(page, scenario);

  const actionableConsoleErrors = consoleErrors.filter((text) => !/Failed to load resource|ERR_/i.test(text));
  if (pageErrors.length > 0 || actionableConsoleErrors.length > 0) {
    throw new Error(`${scenario.label}: preview errors: ${JSON.stringify({ pageErrors, consoleErrors: actionableConsoleErrors })}`);
  }
  await page.close();
  return scenario.label;
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const verified = [];
    for (const scenario of scenarios) verified.push(await verifyScenario(browser, scenario));
    process.stdout.write(`[smoke] automation preview ok: ${verified.join(", ")}; screenshots=${artifactDir}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke] automation preview failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
