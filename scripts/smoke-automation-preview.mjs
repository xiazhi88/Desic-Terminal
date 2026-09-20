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

const C20_DEFAULT_AGENT_IDS = ["desic-data-digest", "desic-account-state", "desic-decision-proposal", "desic-contrarian-review"];

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

// C13：Profile 勾选器（勾选制，无方案模板）。预览夹具 = 7 个 Agent（5 内置 / 1 自定义 /
// 1 AI 创建），初始勾选前 4 个。断言：渲染、可勾选/取消、清空后出现空态提示、全选内置。
async function verifyAgentSelection(page, scenario) {
  await page.goto(`${baseUrl}?view=config&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="config"] [data-agent-selector]', { timeout: 30_000 });
  // 慢放开关自检：所有预览夹具定时器都按 slow 放大，保证"进行中"窗口足够断言（见 pending 记录）。
  const previewSlow = await page.locator(".automation-preview-page").first().getAttribute("data-preview-slow");
  if (previewSlow !== "6") {
    throw new Error(`${scenario.label}/config: 预览慢放参数未生效（data-preview-slow=${previewSlow}）`);
  }

  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/config`);
  if (state.rootHeight < scenario.height - 1 || state.rootHeight > scenario.height + 1) {
    throw new Error(`${scenario.label}/config: preview root height is unstable: ${JSON.stringify(state)}`);
  }

  const selector = page.locator("[data-agent-selector]");
  const items = selector.locator("[data-agent-selector-item][data-agent-id]");
  // C20：默认启用集 = 新 4 个流程角色（+ 预览夹具里的 1 自定义 + 1 AI 创建）；
  // 旧 7 个收进"已停用（历史角色）"折叠组，默认不挂载。
  if (await items.count() !== 6) {
    throw new Error(`${scenario.label}/config: expected six selectable Agents, got ${await items.count()}`);
  }
  const ids = await items.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-agent-id")));
  const builtinIds = await items.evaluateAll((nodes) => nodes
    .filter((node) => node.getAttribute("data-agent-source") === "builtin")
    .map((node) => node.getAttribute("data-agent-id")));
  if (builtinIds.length !== 4) {
    throw new Error(`${scenario.label}/config: expected four builtin Agents, got ${JSON.stringify(builtinIds)}`);
  }
  for (const expected of C20_DEFAULT_AGENT_IDS) {
    if (!ids.includes(expected)) {
      throw new Error(`${scenario.label}/config: missing default builtin Agent ${expected}: ${JSON.stringify(ids)}`);
    }
  }
  // C20.5（改写版）：旧专家**彻底隐藏**——页面里根本不存在停用分组，也不应出现任何 deprecated 钩子。
  if (await selector.locator("[data-agent-deprecated-group]").count() !== 0) {
    throw new Error(`${scenario.label}/config: 停用分组应已彻底移除`);
  }
  if (await page.locator('[data-agent-deprecated], [data-agent-deprecated-group]').count() !== 0) {
    throw new Error(`${scenario.label}/config: 不应存在任何 deprecated 钩子`);
  }
  if (/已停用|历史角色/.test(await selector.innerText())) {
    throw new Error(`${scenario.label}/config: 页面上不应再出现"已停用/历史角色"字样`);
  }
  // 董事会改为「旧 Profile 强制迁移」（Rust 侧改写名单），因此不再有"已忽略已下线专家"提示行。
  if (await page.locator("[data-agent-ignored-legacy]").count() !== 0) {
    throw new Error(`${scenario.label}/config: 不应再出现"已忽略已下线专家"提示（已改为强制迁移）`);
  }

  const checkboxes = selector.locator("[data-agent-selector-item] input[type=checkbox]");
  const checkedCount = () => selector.locator("[data-agent-selector-item] input[type=checkbox]:checked").count();
  // 初始勾选：迁移后的形态 = 默认 4 个角色（可能还带用户自定义），因此断言"≥4 且四个默认角色都在"。
  const initialChecked = await checkedCount();
  if (initialChecked < C20_DEFAULT_AGENT_IDS.length) {
    throw new Error(`${scenario.label}/config: 初始勾选应至少包含默认 ${C20_DEFAULT_AGENT_IDS.length} 个角色，实际 ${initialChecked}`);
  }
  const initialCheckedIds = await selector.locator("[data-agent-selector-item] input[type=checkbox]:checked").evaluateAll((nodes) =>
    nodes.map((node) => node.closest("[data-agent-selector-item]")?.getAttribute("data-agent-id")));
  for (const expected of C20_DEFAULT_AGENT_IDS) {
    if (!initialCheckedIds.includes(expected)) {
      throw new Error(`${scenario.label}/config: 初始勾选缺少默认角色 ${expected}：${JSON.stringify(initialCheckedIds)}`);
    }
  }
  // 勾选/取消勾选（点标签而非复选框，走真实用户路径）——用相对计数，避免绑死夹具总数。
  const beforeSelect = await checkedCount();
  await items.filter({ has: page.locator("input[type=checkbox]:not(:checked)") }).first().locator("input").check();
  if (await checkedCount() !== beforeSelect + 1) throw new Error(`${scenario.label}/config: selecting an Agent did not update the checkbox state`);
  await selector.locator("[data-agent-selector-item][data-agent-id=desic-account-state] input[type=checkbox]").uncheck();
  if (await checkedCount() !== beforeSelect) throw new Error(`${scenario.label}/config: unselecting an Agent did not update the checkbox state`);
  if (await checkboxes.count() !== 6) throw new Error(`${scenario.label}/config: checkbox count changed unexpectedly（C20 默认集 = 4 内置 + 1 自定义 + 1 AI 创建，停用 7 个折叠）`);

  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agent-selector.png`),
    fullPage: false
  });

  // 清空 → 空态提示；全选内置 → **只选默认 4 个角色**（C20：停用项不被全选选中）。
  await selector.locator("[data-agent-select-clear]").click();
  if (await checkedCount() !== 0) throw new Error(`${scenario.label}/config: clear did not empty the selection`);
  const emptyHint = selector.locator("[data-agent-selector-empty]");
  if (await emptyHint.count() !== 1 || !(await emptyHint.isVisible())) {
    throw new Error(`${scenario.label}/config: empty-selection state is missing after clearing`);
  }
  if (!String(await emptyHint.textContent() || "").trim()) {
    throw new Error(`${scenario.label}/config: empty-selection state has no copy`);
  }
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agent-selector-empty.png`),
    fullPage: false
  });
  await selector.locator("[data-agent-select-all]").click();
  if (await checkedCount() !== C20_DEFAULT_AGENT_IDS.length) {
    throw new Error(`${scenario.label}/config: select-all-builtin 应只选中默认 ${C20_DEFAULT_AGENT_IDS.length} 个角色，实际 ${await checkedCount()}`);
  }
  const checkedIds = await selector.locator("[data-agent-selector-item] input[type=checkbox]:checked").evaluateAll((nodes) =>
    nodes.map((node) => node.closest("[data-agent-selector-item]")?.getAttribute("data-agent-id")));
  for (const expected of C20_DEFAULT_AGENT_IDS) {
    if (!checkedIds.includes(expected)) {
      throw new Error(`${scenario.label}/config: 全选后缺少默认角色 ${expected}：${JSON.stringify(checkedIds)}`);
    }
  }

  // 输出契约标签（C20.4）：四类都要在勾选器里出现过。
  for (const kind of ["summary", "state", "proposal", "rebuttal"]) {
    if (await selector.locator(`[data-agent-output="${kind}"]`).count() < 1) {
      throw new Error(`${scenario.label}/config: 缺少输出契约标签 ${kind}`);
    }
  }
  if (await emptyHint.count() !== 0) {
    throw new Error(`${scenario.label}/config: empty-selection state must disappear once Agents are selected again`);
  }

  // C20 新增分组/说明后布局变高：断言前先把列表滚进视野，避免"容器顶部恰好在视口外"这类假失败。
  await selector.locator(".agent-picker__list").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  const selectorBox = await selector.locator(".agent-picker__list").first().boundingBox();
  assertInsideViewport(selectorBox, scenario, `${scenario.label}/config Agent selector list`);
  // 只对**默认角色**做视口断言：停用组是否处于展开状态不应影响这条检查。
  const itemBoxes = await boxesFor(page, '[data-agent-selector-item][data-agent-deprecated="false"]');
  itemBoxes.forEach((box, index) => assertInsideViewport(box, scenario, `${scenario.label}/config Agent option ${index + 1}`));
  assertNoPairwiseOverlap(itemBoxes, `${scenario.label}/config Agent options`);

  // C14 + 布局整改：协作编排是**总开关**（在"参与 Agent"之上）。
  // 关闭 → 列表与全选/清空**不渲染**（不是 disabled），只剩开关 + 一句提示；
  // 且**已选名单不被清空**。重新开启 → 列表展开并恢复原名单；"清空"不得关闭开关。
  const collaborationToggle = selector.locator("[data-agent-collaboration-toggle]");
  if (await collaborationToggle.count() !== 1) {
    throw new Error(`${scenario.label}/config: collaboration toggle is missing`);
  }
  if (!(await collaborationToggle.isVisible())) {
    throw new Error(`${scenario.label}/config: collaboration toggle must stay visible`);
  }
  const checkedBeforeToggle = await checkedCount();
  if (String(await selector.getAttribute("data-collaboration-enabled")) !== "true") {
    throw new Error(`${scenario.label}/config: collaboration must start enabled in the preview fixture`);
  }
  // 开关必须排在列表之前（DOM 顺序），即"协作编排在上、参与 Agent 在下"。
  const toggleBeforeList = await selector.evaluate((node) => {
    const toggle = node.querySelector("[data-agent-collaboration-toggle]");
    const list = node.querySelector("[data-agent-selector-item]");
    if (!toggle || !list) return null;
    return Boolean(toggle.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (toggleBeforeList !== true) {
    throw new Error(`${scenario.label}/config: the collaboration toggle must precede the Agent list`);
  }

  if (await collaborationToggle.isChecked()) await collaborationToggle.uncheck();
  await page.waitForTimeout(120);
  if (String(await selector.getAttribute("data-collaboration-enabled")) !== "false") {
    throw new Error(`${scenario.label}/config: disabling collaboration must flip data-collaboration-enabled`);
  }
  // "隐藏"接受两种实现：不在 DOM，或存在但不可见；无论哪种，用户都不能看到/勾选。
  const notVisible = async (locator, label) => {
    const count = await locator.count();
    if (count === 0) return;
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible()) {
        throw new Error(`${scenario.label}/config: ${label} must be hidden while collaboration is off`);
      }
    }
  };
  await notVisible(selector.locator("[data-agent-selector-item]"), "the Agent list");
  await notVisible(selector.locator("[data-agent-select-all]"), "select-all");
  await notVisible(selector.locator("[data-agent-select-clear]"), "clear");
  await notVisible(selector.locator("[data-agent-selector-empty]"), "the empty-selection state");
  // C24：单 Agent 模式下才提供"标准 / 极简"选择（协作开启时该字段被后端忽略，UI 直接隐藏）。
  if (await selector.locator("[data-single-agent-mode]").count() !== 1) {
    throw new Error(`${scenario.label}/config: 协作关闭时应显示单 Agent 模式选择`);
  }
  if (await selector.locator("[data-single-agent-mode-select] button[aria-haspopup]").count() !== 1) {
    throw new Error(`${scenario.label}/config: 单 Agent 模式选择必须用设计系统下拉`);
  }
  // C25②：协作关闭的说明提示已按要求移除 —— 断言"不存在"而不是"存在且可读"。
  if (await selector.locator("[data-agent-collaboration-off-hint]").count() !== 0) {
    throw new Error(`${scenario.label}/config: 协作关闭的说明提示应已移除`);
  }
  if (/关闭协作后主 Agent 独立完成|不点名任何专家/.test(await selector.innerText())) {
    throw new Error(`${scenario.label}/config: 页面上不应再出现协作关闭的说明文案`);
  }
  assertInsideViewport(await collaborationToggle.boundingBox(), scenario, `${scenario.label}/config collaboration toggle`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agent-collaboration-off.png`),
    fullPage: false
  });

  await collaborationToggle.check();
  await page.waitForTimeout(120);
  if (String(await selector.getAttribute("data-collaboration-enabled")) !== "true") {
    throw new Error(`${scenario.label}/config: re-enabling collaboration must flip data-collaboration-enabled back`);
  }
  if (await selector.locator("[data-single-agent-mode]").count() !== 0) {
    throw new Error(`${scenario.label}/config: 协作开启时不应显示单 Agent 模式选择`);
  }
  if (await selector.locator("[data-agent-collaboration-off-hint]").count() !== 0) {
    throw new Error(`${scenario.label}/config: the collaboration-off hint must disappear once collaboration is on`);
  }
  if (await items.count() !== 6) {
    throw new Error(`${scenario.label}/config: the Agent list must expand again once collaboration is on (got ${await items.count()})`);
  }
  if (await selector.locator("[data-agent-selector-item] input[type=checkbox][disabled]").count() !== 0) {
    throw new Error(`${scenario.label}/config: checkboxes must be interactive again once collaboration is on`);
  }
  if (await checkedCount() !== checkedBeforeToggle) {
    throw new Error(`${scenario.label}/config: re-enabling collaboration must restore the previous selection`);
  }
  await selector.locator("[data-agent-select-clear]").click();
  if (await checkedCount() !== 0) throw new Error(`${scenario.label}/config: clear did not empty the selection after re-enable`);
  if (!(await collaborationToggle.isChecked())) {
    throw new Error(`${scenario.label}/config: clearing the selection must not switch collaboration off`);
  }
  await selector.locator("[data-agent-select-all]").click();
}

// C13：agents tab（Agent 库三栏）。断言：列出内置 Agent、打开编辑器、内置 Agent 只读
// （保存不可用 + 正文只读 + 只读说明），自定义 Agent 可编辑但保存需要改动。
async function verifyAgentLibrary(page, scenario) {
  await page.goto(`${baseUrl}?view=agents&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="agents"] [data-agents-tab]', { timeout: 30_000 });

  const state = await readPageState(page);
  assertNoGlobalOverflow(state, `${scenario.label}/agents`);

  const library = page.locator("[data-agents-tab]");
  const rows = library.locator("[data-agent-library-item][data-agent-id]");
  if (await rows.count() !== 6) {
    throw new Error(`${scenario.label}/agents: expected six listed Agents, got ${await rows.count()}`);
  }
  const listedIds = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-agent-id")));
  const builtinListed = await rows.evaluateAll((nodes) => nodes
    .filter((node) => node.getAttribute("data-agent-source") === "builtin")
    .map((node) => node.getAttribute("data-agent-id")));
  if (builtinListed.length !== 4) {
    throw new Error(`${scenario.label}/agents: expected four builtin Agents in the library, got ${JSON.stringify(builtinListed)}`);
  }
  for (const expected of C20_DEFAULT_AGENT_IDS) {
    if (!listedIds.includes(expected)) {
      throw new Error(`${scenario.label}/agents: 默认角色 ${expected} 未列出：${JSON.stringify(listedIds)}`);
    }
  }
  // C20.5（改写版）：库里**彻底看不到**旧专家——没有停用分组、没有 deprecated 钩子、也没有"已停用/历史角色"字样。
  if (await library.locator("[data-agent-deprecated-group]").count() !== 0) {
    throw new Error(`${scenario.label}/agents: 库里的停用分组应已彻底移除`);
  }
  if (await library.locator('[data-agent-deprecated], [data-agent-deprecated-group]').count() !== 0) {
    throw new Error(`${scenario.label}/agents: 库里不应存在任何 deprecated 钩子`);
  }
  if (/已停用|历史角色|Smart Money/.test(await library.innerText())) {
    throw new Error(`${scenario.label}/agents: 库里不应再出现已下线专家的痕迹`);
  }

  // 打开内置 Agent 编辑器：只读（保存禁用 + 正文 readOnly + 只读说明可见 + 删除禁用）。
  await library.locator('[data-agent-id="desic-data-digest"]').click();
  const editor = library.locator("[data-agent-editor]");
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  const saveButton = library.locator("[data-agent-save]");
  if (await saveButton.count() !== 1) throw new Error(`${scenario.label}/agents: save action is missing`);
  if (!(await saveButton.isDisabled())) {
    throw new Error(`${scenario.label}/agents: builtin Agent must not be savable in place`);
  }
  // 浏览器预览没有 Tauri 命令通道，正文读取会以错误态呈现；只读性以编辑器自身的
  // is-readonly 态、保存禁用与只读说明为准（有正文时再校验 textarea 的 readOnly）。
  if (!/\bis-readonly\b/.test(String(await editor.getAttribute("class") || ""))) {
    throw new Error(`${scenario.label}/agents: builtin Agent editor must be flagged read-only`);
  }
  if (await editor.locator(".agent-lib__readonly-note").count() !== 1) {
    throw new Error(`${scenario.label}/agents: builtin readonly note is missing`);
  }
  const sourceArea = editor.locator("textarea");
  if (await sourceArea.count() > 0 && await sourceArea.first().isEditable()) {
    throw new Error(`${scenario.label}/agents: builtin Agent body must be read-only`);
  }
  // 源码模式必须真的把正文渲染出来：预览夹具已注入正文（readAgent），因此这里能测出
  // "源码框高度塌陷 / 内容没显示"这类真实布局故障（2026-09-18 定位到 `.agent-lib > section`
  // 的 (0,1,1) 特异性覆盖了 `.agent-lib__editor` 的行模板，正文被挤成 2–3 行）。
  if (await sourceArea.count() === 0) {
    throw new Error(`${scenario.label}/agents: source textarea is missing`);
  }
  const sourceValue = await sourceArea.first().inputValue();
  if (sourceValue.trim().length < 200) {
    throw new Error(`${scenario.label}/agents: source textarea is nearly empty (${sourceValue.length} chars)`);
  }
  if (!sourceValue.includes("## 方法与证据要求")) {
    throw new Error(`${scenario.label}/agents: source textarea must render the full AGENTS.md body`);
  }
  const sourceBox = await sourceArea.first().boundingBox();
  if (!sourceBox || sourceBox.height < 240) {
    throw new Error(`${scenario.label}/agents: source textarea collapsed (height=${sourceBox?.height ?? 0})`);
  }
  const editorBox = await editor.boundingBox();
  if (sourceBox && editorBox && sourceBox.height < editorBox.height * 0.55) {
    throw new Error(
      `${scenario.label}/agents: source textarea must fill the editor pane (source=${Math.round(sourceBox.height)}, pane=${Math.round(editorBox.height)})`
    );
  }
  const deleteButton = library.locator("[data-agent-delete]");
  if (!(await deleteButton.isDisabled())) {
    throw new Error(`${scenario.label}/agents: builtin Agent delete must stay disabled`);
  }
  if (await library.locator("[data-agent-duplicate]").isDisabled()) {
    throw new Error(`${scenario.label}/agents: duplicate must be available for a builtin Agent`);
  }
  assertInsideViewport(await editor.boundingBox(), scenario, `${scenario.label}/agents editor`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agent-library-builtin.png`),
    fullPage: false
  });

  // 自定义 Agent 可编辑：编辑器不再是只读态，删除可用，但保存仍需改动。
  await library.locator('[data-agent-id="custom-mean-reversion-desk"]').click();
  await page.waitForTimeout(200);
  if (/\bis-readonly\b/.test(String(await editor.getAttribute("class") || ""))) {
    throw new Error(`${scenario.label}/agents: custom Agent editor must not be read-only`);
  }
  if (await editor.locator(".agent-lib__readonly-note").count() !== 0) {
    throw new Error(`${scenario.label}/agents: custom Agent must not render the builtin readonly note`);
  }
  if (await library.locator("[data-agent-delete]").isDisabled()) {
    throw new Error(`${scenario.label}/agents: custom Agent delete must be available`);
  }
  if (!(await saveButton.isDisabled())) {
    throw new Error(`${scenario.label}/agents: save must stay disabled until the draft changes`);
  }
  // 自定义 Agent 必须真的可编辑：在源码框里输入后保存按钮应变为可用（用户反馈 #4）。
  const customSource = editor.locator("textarea");
  if (await customSource.count() === 0) {
    throw new Error(`${scenario.label}/agents: custom Agent source textarea is missing`);
  }
  if (!(await customSource.first().isEditable())) {
    throw new Error(`${scenario.label}/agents: custom Agent source textarea must be editable`);
  }
  await customSource.first().click();
  await customSource.first().press("End");
  await customSource.first().type("\n<!-- preview edit -->");
  if (await saveButton.isDisabled()) {
    throw new Error(`${scenario.label}/agents: save must become available after editing a custom Agent`);
  }

  // AI 创建对话框：C13 钩子齐全，未填描述时生成按钮不可用。
  await library.locator("[data-agent-create-ai]").click();
  const description = page.locator("[data-agent-ai-description]");
  await description.waitFor({ state: "visible", timeout: 10_000 });
  const generateButton = page.locator("[data-agent-ai-generate]");
  if (await generateButton.count() !== 1) throw new Error(`${scenario.label}/agents: AI generate action is missing`);
  if (!(await generateButton.isDisabled())) {
    throw new Error(`${scenario.label}/agents: AI generate must stay disabled without a description`);
  }
  await description.fill("检查 BTC 永续盘口冲击成本的只读专家");
  if (await generateButton.isDisabled()) {
    throw new Error(`${scenario.label}/agents: AI generate must become available once a description is provided`);
  }
  const dialog = page.locator(".agent-lib-dialog");
  // C16③：AI 创建必须能选模型（默认当前模型），并说明用哪个模型生成。
  const modelSelect = dialog.locator("[data-agent-model-select]");
  if (await modelSelect.count() !== 1) {
    throw new Error(`${scenario.label}/agents: the AI create dialog must offer a model picker`);
  }
  const modelTrigger = modelSelect.locator("button[aria-haspopup]").first();
  if (await modelTrigger.count() !== 1) {
    throw new Error(`${scenario.label}/agents: the model picker must use the design-system select`);
  }
  const modelLabel = String(await modelTrigger.textContent() || "").trim();
  if (!/Preview/.test(modelLabel)) {
    throw new Error(`${scenario.label}/agents: the model picker must default to the current model (got "${modelLabel}")`);
  }
  assertInsideViewport(await dialog.boundingBox(), scenario, `${scenario.label}/agents AI create dialog`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agents-create-ai.png`),
    fullPage: false
  });
  // C16③：预览注入的假生成器让整条链路可走完 —— 生成后必须显示"由 X 生成"、warnings 区可见，
  // 且草稿以 source: ai 进入编辑器（保存按钮随之可用）。
  // C17 P1/P2：点击生成后必须立刻看到"过程卡片"（阶段/计时/模型/字符数）+ 流式文本，
  // 并在生成期间提供取消按钮。预览的分段流式总时长约 1.6s，逐次采样太容易错过窗口，
  // 因此在点击之前装一个 50ms 采样器记录流式文本长度序列，结束后统一断言"确实在增长"。
  await page.evaluate(() => {
    const state = { samples: [] };
    window.__draftStreamSamples = state.samples;
    const timer = window.setInterval(() => {
      const node = document.querySelector("[data-agent-draft-stream]");
      if (node) state.samples.push((node.textContent || "").length);
    }, 50);
    window.__draftStreamTimer = timer;
  });
  await generateButton.click();
  const progress = dialog.locator("[data-agent-draft-progress]");
  await progress.waitFor({ state: "visible", timeout: 10_000 });
  const progressStage = String(await progress.getAttribute("data-draft-stage") || "");
  if (!["preparing", "requested", "streaming", "finalizing"].includes(progressStage)) {
    throw new Error(`${scenario.label}/agents: unexpected draft stage while generating: "${progressStage}"`);
  }
  const phaseText = String(await progress.locator("[data-agent-draft-phase]").textContent() || "").trim();
  const elapsedText = String(await progress.locator("[data-agent-draft-elapsed]").textContent() || "").trim();
  const modelText = String(await progress.locator("[data-agent-draft-model]").textContent() || "").trim();
  if (!phaseText || !elapsedText) {
    throw new Error(`${scenario.label}/agents: the draft progress card must show phase and elapsed time`);
  }
  if (!/Preview/.test(modelText)) {
    throw new Error(`${scenario.label}/agents: the draft progress card must name the model (got "${modelText}")`);
  }
  if (!(await dialog.locator("[data-agent-ai-cancel]").isVisible())) {
    throw new Error(`${scenario.label}/agents: the cancel action must be available while generating`);
  }
  assertInsideViewport(await progress.boundingBox(), scenario, `${scenario.label}/agents draft progress card`);
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agents-draft-streaming.png`),
    fullPage: false
  });
  const charsText = String(await progress.locator("[data-agent-draft-chars]").textContent() || "").trim();
  if (!charsText) {
    throw new Error(`${scenario.label}/agents: the draft progress card must show generated character count`);
  }
  const generatedBy = dialog.locator("[data-agent-generated-by]");
  await generatedBy.first().waitFor({ state: "visible", timeout: 10_000 });
  const generatedText = String(await generatedBy.first().textContent() || "").trim();
  if (!/生成|Generated/i.test(generatedText)) {
    throw new Error(`${scenario.label}/agents: the generated-by note is missing its copy: "${generatedText}"`);
  }
  assertInsideViewport(await generatedBy.first().boundingBox(), scenario, `${scenario.label}/agents generated-by note`);
  // ① 有草稿后按钮变"重新生成"（data-draft-ready 为 true）。
  const readyFlag = String(await dialog.locator("[data-agent-ai-generate]").getAttribute("data-draft-ready") || "");
  if (readyFlag !== "true") {
    throw new Error(`${scenario.label}/agents: the generate action must report data-draft-ready="true" once a draft exists (got "${readyFlag}")`);
  }
  const generateLabel = String(await dialog.locator("[data-agent-ai-generate]").textContent() || "").trim();
  if (!/重新生成|Regenerate/i.test(generateLabel)) {
    throw new Error(`${scenario.label}/agents: the generate action must read as regenerate after a draft exists (got "${generateLabel}")`);
  }
  // ② 源码模式必须真的把草稿渲染进编辑器（网格行归属故障的回归门）：
  //    对话框右栏的弹性行曾被子节点抢走，导致 textarea 落到隐式 auto 行、被挤到底部。
  const previewBody = dialog.locator(".agent-lib-dialog__preview-body");
  const sourceTab = dialog.locator(".agent-lib__mode button").first();
  await sourceTab.click();
  const draftEditor = dialog.locator("[data-agent-draft-editor]");
  await draftEditor.waitFor({ state: "visible", timeout: 5_000 });
  const draftEditorBox = await draftEditor.boundingBox();
  const previewBodyBox = await previewBody.boundingBox();
  if (!draftEditorBox || draftEditorBox.height < 200) {
    throw new Error(`${scenario.label}/agents: the draft source editor is collapsed (height=${draftEditorBox?.height ?? 0})`);
  }
  if (!previewBodyBox || draftEditorBox.height < previewBodyBox.height * 0.55) {
    throw new Error(
      `${scenario.label}/agents: the draft source editor must fill its pane (editor=${Math.round(draftEditorBox.height)}, pane=${Math.round(previewBodyBox?.height ?? 0)})`
    );
  }
  const draftSourceValue = await draftEditor.inputValue();
  if (!draftSourceValue.includes("---") || !draftSourceValue.includes("id:")) {
    throw new Error(`${scenario.label}/agents: the draft source editor must show the generated document`);
  }
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agents-draft-source.png`),
    fullPage: false
  });
  // 切到 preview：渲染容器同样要占满弹性行。
  await dialog.locator(".agent-lib__mode button").nth(1).click();
  const draftPreview = dialog.locator("[data-agent-draft-preview]");
  await draftPreview.waitFor({ state: "visible", timeout: 5_000 });
  const draftPreviewBox = await draftPreview.boundingBox();
  if (!draftPreviewBox || !previewBodyBox || draftPreviewBox.height < previewBodyBox.height * 0.55) {
    throw new Error(
      `${scenario.label}/agents: the draft preview must fill its pane (preview=${Math.round(draftPreviewBox?.height ?? 0)}, pane=${Math.round(previewBodyBox.height)})`
    );
  }
  const streamSamples = await page.evaluate(() => {
    const samples = window.__draftStreamSamples || [];
    if (window.__draftStreamTimer) window.clearInterval(window.__draftStreamTimer);
    return samples;
  });
  const growing = streamSamples.filter((value, index) => index === 0 || value > streamSamples[index - 1]);
  if (streamSamples.length < 2 || growing.length < 2 || (streamSamples[streamSamples.length - 1] ?? 0) <= 0) {
    throw new Error(`${scenario.label}/agents: the draft stream never grew (samples=${JSON.stringify(streamSamples.slice(0, 12))})`);
  }
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agents-generated.png`),
    fullPage: false
  });
  await page.keyboard.press("Escape").catch(() => {});
  await dialog.locator(".modal-actions button").first().click();
  await dialog.waitFor({ state: "detached", timeout: 5_000 });

  // C17 P3：生成过程中取消 —— 必须出现"已取消"终态，此后流式文本不再增长，取消按钮消失。
  await library.locator("[data-agent-create-ai]").click();
  const cancelDialog = page.locator(".agent-lib-dialog");
  await cancelDialog.locator("[data-agent-ai-description]").waitFor({ state: "visible", timeout: 10_000 });
  await cancelDialog.locator("[data-agent-ai-description]").fill("取消路径测试用只读专家");
  await cancelDialog.locator("[data-agent-ai-generate]").click();
  await page.waitForFunction(
    () => (document.querySelector("[data-agent-draft-stream]")?.textContent || "").trim().length > 0,
    undefined,
    { timeout: 10_000 }
  );
  const cancelButton = cancelDialog.locator("[data-agent-ai-cancel]");
  if (!(await cancelButton.isVisible())) {
    throw new Error(`${scenario.label}/agents: cancel must be clickable during generation`);
  }
  await cancelButton.click();
  await page.waitForFunction(
    () => document.querySelector('[data-agent-draft-progress][data-draft-stage="cancelled"]') !== null,
    undefined,
    { timeout: 10_000 }
  );
  const cancelledLength = await page.evaluate(
    () => (document.querySelector("[data-agent-draft-stream]")?.textContent || "").length
  );
  await page.waitForTimeout(600);
  const cancelledLengthAfter = await page.evaluate(
    () => (document.querySelector("[data-agent-draft-stream]")?.textContent || "").length
  );
  // 取消后流式区**不允许继续增长**；被清空/卸载（长度变 0）是允许的终态，因此只断言"不长"。
  if (cancelledLengthAfter > cancelledLength) {
    throw new Error(`${scenario.label}/agents: the draft stream must not keep growing after cancel (${cancelledLength} → ${cancelledLengthAfter})`);
  }
  if (await cancelDialog.locator("[data-agent-ai-cancel]").count() !== 0) {
    throw new Error(`${scenario.label}/agents: the cancel action must disappear once the draft is cancelled`);
  }
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agents-draft-cancelled.png`),
    fullPage: false
  });
  await page.keyboard.press("Escape").catch(() => {});
  await cancelDialog.locator(".modal-actions button").first().click();
  await cancelDialog.waitFor({ state: "detached", timeout: 5_000 });
  if (await library.locator("[data-agent-create-manual]").count() < 1) {
    throw new Error(`${scenario.label}/agents: manual create action is missing`);
  }

  // C15：scopes 概念整体移除 —— 库列表、详情 rail、创建对话框都不该再出现范围 chip/标签/字段。
  if (await library.locator(".agent-lib__row-scope, [data-agent-scope]").count() !== 0) {
    throw new Error(`${scenario.label}/agents: scope tags must be gone from the library rows`);
  }
  const railLabels = await library.locator(".agent-lib__facts dt").allTextContents();
  if (railLabels.some((text) => /证据范围|scopes/i.test(text))) {
    throw new Error(`${scenario.label}/agents: the evidence-scope fact row must be gone: ${JSON.stringify(railLabels)}`);
  }
  await library.locator("[data-agent-create-manual]").click();
  const manualDialog = page.locator(".agent-lib-dialog");
  await manualDialog.waitFor({ state: "visible", timeout: 10_000 });
  if (await manualDialog.locator(".agent-lib-dialog__scopes, [data-agent-scope-option]").count() !== 0) {
    throw new Error(`${scenario.label}/agents: the create dialog must not offer scope chips anymore`);
  }
  const manualDialogText = await manualDialog.innerText();
  if (/scopes|证据范围/.test(manualDialogText)) {
    throw new Error(`${scenario.label}/agents: the create dialog still mentions scopes`);
  }
  // C16②：原生 select / datalist 已按设计规范收敛（不得再有原生控件）。
  if (await manualDialog.locator("select, datalist").count() !== 0) {
    throw new Error(`${scenario.label}/agents: native select/datalist must be gone from the create dialog`);
  }
  if (await manualDialog.locator("[data-agent-envelope-select] button[aria-haspopup]").count() !== 1) {
    throw new Error(`${scenario.label}/agents: the envelope field must use the design-system select`);
  }
  // C16②：角色改「可输入 + 下拉建议」的组合控件。
  const roleInput = manualDialog.locator("[data-agent-role-input]");
  if (await roleInput.count() !== 1) {
    throw new Error(`${scenario.label}/agents: the role combobox input is missing`);
  }
  // 空值时列出全部建议角色；输入后按子串过滤（`AgentRoleCombo` 的既有语义）。
  await roleInput.click();
  await roleInput.fill("");
  const roleOptions = page.locator("[data-agent-role-option]");
  await roleOptions.first().waitFor({ state: "visible", timeout: 5_000 });
  const allRoles = await roleOptions.count();
  if (allRoles < 5) {
    throw new Error(`${scenario.label}/agents: the role combobox must list the role suggestions (got ${allRoles})`);
  }
  await roleInput.fill("market");
  await page.waitForTimeout(80);
  const filteredRoles = page.locator("[data-agent-role-option]");
  const filteredTexts = await filteredRoles.allTextContents();
  if (filteredTexts.length === 0 || !filteredTexts.every((text) => /market/i.test(text))) {
    throw new Error(`${scenario.label}/agents: typing must filter the role suggestions: ${JSON.stringify(filteredTexts)}`);
  }
  // 仍允许自由输入（role 可以是自定义 slug）。
  await roleInput.fill("my-custom-role");
  if ((await roleInput.inputValue()) !== "my-custom-role") {
    throw new Error(`${scenario.label}/agents: the role field must stay free-form`);
  }
  await page.keyboard.press("Escape").catch(() => {});
  // C16①：依赖 Skills 改多选下拉 —— 展开后选项数 = 已配置 Skill 数，勾选生成 chip，chip 可移除。
  const skillsSelect = manualDialog.locator("[data-agent-skills-select]");
  if (await skillsSelect.count() !== 1) {
    throw new Error(`${scenario.label}/agents: the skills multi-select is missing`);
  }
  await skillsSelect.locator("button.agent-skill-select__trigger, button").first().click();
  const skillOptions = page.locator("[data-agent-skill-option][data-skill-id]");
  await skillOptions.first().waitFor({ state: "visible", timeout: 5_000 });
  if (await skillOptions.count() !== 3) {
    throw new Error(`${scenario.label}/agents: expected three configured Skills in the multi-select, got ${await skillOptions.count()}`);
  }
  const firstSkillId = await skillOptions.first().getAttribute("data-skill-id");
  await skillOptions.first().click();
  const skillChips = manualDialog.locator("[data-agent-skill-chip][data-skill-id]");
  if (await skillChips.count() !== 1
    || (await skillChips.first().getAttribute("data-skill-id")) !== firstSkillId) {
    throw new Error(`${scenario.label}/agents: selecting a Skill must render exactly one chip for it`);
  }
  await skillChips.first().locator("button").first().click();
  if (await manualDialog.locator("[data-agent-skill-chip]").count() !== 0) {
    throw new Error(`${scenario.label}/agents: the Skill chip must be removable`);
  }
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-agents-create-manual.png`),
    fullPage: false
  });
  await page.keyboard.press("Escape").catch(() => {});
  await manualDialog.locator(".modal-actions button").first().click();
  await manualDialog.waitFor({ state: "detached", timeout: 5_000 });
}


// C19：试判阶段（配置项 + 运行徽标/详情）。默认 enforce，跳过运行必须有独立状态与可审计理由，
// 并提供"一键强制深度"入口（命令缺失时优雅降级，不卡在 loading）。
async function verifyTriageSettings(page, scenario) {
  await page.goto(`${baseUrl}?view=config&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
  const settings = page.locator("[data-triage-settings]");
  await settings.waitFor({ state: "visible", timeout: 30_000 });
  const modeTrigger = settings.locator("[data-triage-mode-select] button[aria-haspopup]");
  if (await modeTrigger.count() !== 1) {
    throw new Error(`${scenario.label}/triage: the triage mode select is missing`);
  }
  const modeText = String(await modeTrigger.textContent() || "");
  if (!/强制|Enforce/i.test(modeText)) {
    throw new Error(`${scenario.label}/triage: the mode must default to enforce (got "${modeText}")`);
  }
  // C25③：这条劝告式提示已按要求移除（试判设置只描述功能，不劝告）。
  if (await settings.locator("[data-triage-enforce-warning]").count() !== 0) {
    throw new Error(`${scenario.label}/triage: enforce-mode 劝告提示应已移除`);
  }
  for (const [hook, expected] of [
    ["data-triage-max-skips", "3"],
    ["data-triage-silence-minutes", "120"],
    ["data-triage-sample-rate", "0.2"],
    ["data-triage-stop-distance", "1.5"],
    ["data-triage-margin-ratio", "150"],
    ["data-triage-resonance", "2"]
  ]) {
    const input = settings.locator(`[${hook}]`);
    if (await input.count() !== 1) throw new Error(`${scenario.label}/triage: ${hook} is missing`);
    const value = await input.inputValue();
    if (value !== expected) {
      throw new Error(`${scenario.label}/triage: ${hook}默认值应为 ${expected}，实际 ${value}`);
    }
  }
  for (const hook of ["data-triage-escalate-position", "data-triage-escalate-break", "data-triage-escalate-news"]) {
    const box = settings.locator(`[${hook}]`);
    if (await box.count() !== 1) throw new Error(`${scenario.label}/triage: ${hook} 缺失`);
    if (!(await box.isChecked())) throw new Error(`${scenario.label}/triage: ${hook} 默认应为开启`);
  }
  // C25④：口径不再可配置 —— 已固定为「越大越安全」，因此 UI 里不得再出现该选项（阈值控件保留）。
  if (await settings.locator("[data-triage-margin-convention]").count() !== 0) {
    throw new Error(`${scenario.label}/triage: 保证金率口径配置应已移除（固定为越大越安全）`);
  }
  const marginInput = settings.locator("[data-triage-margin-ratio]");
  if ((await marginInput.getAttribute("min")) !== "100") {
    throw new Error(`${scenario.label}/triage: 保证金率阈值下限应为 100（强平区边界）`);
  }
  // 数字越界提示 + 失焦夹取（抽样率上限 1）。
  const sampleRate = settings.locator("[data-triage-sample-rate]");
  await sampleRate.fill("2");
  await sampleRate.blur();
  const clamped = await sampleRate.inputValue();
  if (Number(clamped) > 1) {
    throw new Error(`${scenario.label}/triage: 抽样率越界未被夹取（实际 ${clamped}）`);
  }
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-triage-settings.png`),
    fullPage: false
  });
}

async function verifyTriageRun(page, scenario) {
  await page.goto(`${baseUrl}?view=triage&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="triage"]', { timeout: 30_000 });
  // C25③：这条劝告式提示已按要求移除。
  if (await page.locator("[data-triage-enforce-warning]").count() !== 0) {
    throw new Error(`${scenario.label}/triage: "强制模式会跳过深度分析"提示应已移除`);
  }
  if (/强制模式会跳过深度分析|跳过将不做深度分析/.test(await page.locator(".automation-preview-page").first().innerText())) {
    throw new Error(`${scenario.label}/triage: 页面不应再出现该劝告文案`);
  }
  // C25④：保证金率口径配置已固定为"越大越安全"，UI 不再提供该选项。
  if (await page.locator("[data-triage-margin-convention]").count() !== 0) {
    throw new Error(`${scenario.label}/triage: 保证金率口径配置应已移除`);
  }

  const badges = page.locator("[data-run-triage-badge]");
  await badges.first().waitFor({ state: "visible", timeout: 10_000 });
  const verdicts = await badges.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-triage-verdict")));
  if (!verdicts.includes("escalate") || !verdicts.includes("skip")) {
    throw new Error(`${scenario.label}/triage: 运行列表需同时出现升级与跳过徽标：${JSON.stringify(verdicts)}`);
  }
  const forced = page.locator('[data-run-triage-badge][data-triage-forced="true"]');
  if (await forced.count() < 1) throw new Error(`${scenario.label}/triage: 缺少被硬升级强制的运行`);
  const forcedReasons = String(await page.locator("[data-triage-forced-reasons]").first().textContent() || "").trim();
  if (forcedReasons.length === 0) throw new Error(`${scenario.label}/triage: 强制升级必须写出原因`);
  if (await page.locator('[data-triage-sampled="true"]').count() < 1) {
    throw new Error(`${scenario.label}/triage: 缺少抽样复检标记`);
  }
  const detail = page.locator("[data-run-triage]");
  await detail.first().waitFor({ state: "visible", timeout: 10_000 });
  const skipNote = page.locator("[data-run-triage-skipped-note]");
  if (await skipNote.count() < 1) throw new Error(`${scenario.label}/triage: 跳过运行必须有"已跳过深度分析"说明`);
  const reasons = page.locator("[data-run-triage-reasons] li");
  if (await reasons.count() < 1) throw new Error(`${scenario.label}/triage: 试判理由缺失`);
  for (const hook of ["data-triage-evidence-fact", "data-triage-evidence-source", "data-triage-evidence-at"]) {
    if (await page.locator(`[${hook}]`).count() < 1) throw new Error(`${scenario.label}/triage: 证据缺 ${hook}`);
  }
  const tokensText = String(await detail.first().innerText() || "");
  if (!/试判|Triage/.test(tokensText) || !/深度|Deep/.test(tokensText)) {
    throw new Error(`${scenario.label}/triage: 详情需分开展示试判与深度 token`);
  }
  await page.screenshot({
    path: path.join(artifactDir, `automation-${scenario.label}-triage-run.png`),
    fullPage: false
  });
  // C21.3 反向分支：warnings 为空数组时必须**不渲染**警告行。
  if (await page.locator("[data-run-summary-format-warnings]").count() !== 0) {
    throw new Error(`${scenario.label}/triage: 空 warnings 不应渲染排版提醒`);
  }
  // C26：一键强制深度**只在"未进入深度分析"（skipped）时显示** —— 默认详情正是 skipped 那条。
  const skippedForceDeep = page.locator("[data-run-force-deep]");
  if (await skippedForceDeep.count() !== 1) {
    throw new Error(`${scenario.label}/triage: 被跳过的运行应显示一键强制深度（实际 ${await skippedForceDeep.count()}）`);
  }
  // 预览无 Tauri 通道 → 走"优雅降级"，但绝不能卡在 loading。
  await skippedForceDeep.click();
  await page.waitForFunction(() => {
    const button = document.querySelector("[data-run-force-deep]");
    if (!button) return true;
    const label = (button.textContent || "").trim();
    return !/正在|Requeuing/i.test(label);
  }, undefined, { timeout: 10_000 });
  const forceHint = String(await page.locator(".automation-run-triage-hint").first().textContent().catch(() => "") || "").trim();
  if (!/已重新排入|尚不支持|not supported/i.test(forceHint)) {
    throw new Error(`${scenario.label}/triage: 强制深度后必须给出明确结果提示（实际 "${forceHint}"）`);
  }

  // C20.6 反向分支：详情默认打开的是 skipped 那条；先切到被硬升级强制的那条，
  // 它升级了却没派任何专家、也没填理由 → 必须显式标出。
  // 运行行的可点区域是内部的 <button>（article 本身不可点），因此按按钮点击。
  const forcedRowButton = page.locator(".automation-run-row", {
    has: page.locator('[data-run-triage-badge][data-triage-forced="true"]')
  }).first().locator("button").first();
  // 该列表上有一层不可见覆盖物会让 Playwright 的可点性检查一直等待（元素本身可见且 pointer-events: auto），
  // 因此这里直接在页面上下文里触发 click，绕过 actionability 等待。
  await forcedRowButton.evaluate((node) => node.click());
  await page.waitForTimeout(300);
  if (await page.locator("[data-run-self-analysis-unjustified]").count() < 1) {
    throw new Error(`${scenario.label}/triage: 未说明理由的自分析必须显式标出`);
  }

  // C26：已进入深度分析（含硬升级）的运行**不得**再出现一键强制深度按钮。
  if (await page.locator("[data-run-force-deep]").count() !== 0) {
    throw new Error(`${scenario.label}/triage: 已进入深度分析的运行不应显示一键强制深度`);
  }
}

async function verifyRun(page, scenario) {
  await page.goto(`${baseUrl}?view=run&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
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
  if (!(await page.locator(".automation-agent-trace-lane.status-failed").count())) throw new Error(`${scenario.label}/run: failed Agent state missing`);
  // C18.3：轨迹必须如实呈现每位专家的执行方式（parallel/serial）与时间重叠，
  // 不再暗示"两波编排"。预览夹具 = 3 位并行 + 1 位串行。
  const parallelLanes = await page.locator(".automation-agent-trace-lane.mode-parallel").count();
  const serialLanes = await page.locator(".automation-agent-trace-lane.mode-serial").count();
  if (parallelLanes !== 3 || serialLanes !== 1) {
    throw new Error(`${scenario.label}/run: execution mode per Agent is missing: parallel=${parallelLanes} serial=${serialLanes}`);
  }
  if (!/与上一位重叠 \d+s/.test(await trace.innerText())) {
    throw new Error(`${scenario.label}/run: parallel overlap is not shown in the Agent trace`);
  }
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
  // C15.3：轨迹必须显示"本次授予范围"（数据来自 consult_expert 工具结果的 grantedScopes）。
  const grantedBadges = page.locator("[data-agent-granted-scopes]");
  if (await grantedBadges.count() < 1) {
    throw new Error(`${scenario.label}/run: the granted-scope badge is missing from the expert trace`);
  }
  const grantedTexts = await grantedBadges.allTextContents();
  if (!grantedTexts.some((text) => text.includes("本次授予范围") && text.includes("market"))) {
    throw new Error(`${scenario.label}/run: a narrowed consultation must show its granted scopes: ${JSON.stringify(grantedTexts)}`);
  }
  if (!grantedTexts.some((text) => text.includes("全部只读"))) {
    throw new Error(`${scenario.label}/run: a full-scope consultation must read 全部只读: ${JSON.stringify(grantedTexts)}`);
  }
  if (/证据范围/.test(await trace.innerText())) {
    throw new Error(`${scenario.label}/run: the removed evidence-scope wording is still rendered in the trace`);
  }
  // C18.3：阶段文案由 UI 改成与 v3 一致（不再暗示"两波编排"）。这里只断言结构——
  // 每个阶段块必须给出该阶段的 Agent 数量——具体措辞不锁定，避免与 UI 文案迭代互锁。
  // （"并行取证/反方审查"这对 v2 硬编码文案删除后，可在此追加不存在性断言。）
  const phases = await page.locator(".automation-agent-trace-phase").allTextContents();
  if (phases.length === 0) {
    throw new Error(`${scenario.label}/run: Agent trace renders no phase block: ${JSON.stringify(phases)}`);
  }
  for (const [index, phase] of phases.entries()) {
    if (!/Agent/.test(phase) || !/\d/.test(phase)) {
      throw new Error(`${scenario.label}/run: phase ${index + 1} does not report an Agent count: ${JSON.stringify(phase)}`);
    }
  }
  // C25⑤：运行详情必须显示"是否进入深度分析"（四态）。
  const deepState = await page.locator("[data-run-deep-analysis]").first().getAttribute("data-run-deep-analysis");
  if (deepState !== "deep") {
    throw new Error(`${scenario.label}/run: 该夹具应为已进入深度分析（实际 ${deepState}）`);
  }
  if (!String(await page.locator("[data-run-deep-analysis-label]").first().innerText() || "").includes("已进入深度分析")) {
    throw new Error(`${scenario.label}/run: 深度分析标签文案异常`);
  }
  // C25①：排版提醒行不再展示（审计字段仍记录）。
  if (await page.locator("[data-run-summary-format-warnings]").count() !== 0) {
    throw new Error(`${scenario.label}/run: 排版提醒行应已移除`);
  }

  // 观察条件计数：必须只统计**最终生效的那次计划**（同一轮多次 finishRun 不得累加）。
  const wakeCreated = await page.locator("[data-run-wake-created]").first().getAttribute("data-run-wake-created");
  if (wakeCreated !== "7") {
    throw new Error(`${scenario.label}/run: 观察条件计数应取最终生效计划（期望 7，实际 ${wakeCreated}）`);
  }
  const wakeActive = await page.locator("[data-run-wake-active]").first().getAttribute("data-run-wake-active");
  if (wakeActive !== "7") {
    throw new Error(`${scenario.label}/run: 当前生效观察条件应为 7，实际 ${wakeActive}`);
  }
  if (await page.locator("[data-run-wake-plan-rejected]").count() !== 1) {
    throw new Error(`${scenario.label}/run: 被拒的收尾计划必须显式标注`);
  }
  if (/35 条/.test(await page.locator(".automation-run-section").first().innerText())) {
    throw new Error(`${scenario.label}/run: 不应再出现累加出来的虚高计数`);
  }

  // C23.2：逐专家详情 —— lane 上的「详情」按钮打开弹层，提问/报告必须是**原文且不被 i18n 改写**。
  const laneOpenButtons = page.locator("[data-agent-lane-open]");
  if (await laneOpenButtons.count() !== 4) {
    throw new Error(`${scenario.label}/run: 每条专家 lane 都应有「详情」入口，实际 ${await laneOpenButtons.count()}`);
  }
  await laneOpenButtons.first().click();
  const agentDetail = page.locator("[data-agent-detail]");
  await agentDetail.waitFor({ state: "visible", timeout: 5_000 });
  for (const hook of [
    "data-agent-detail-usage", "data-agent-detail-mode", "data-agent-detail-scopes",
    "data-agent-detail-duration", "data-agent-detail-tokens", "data-agent-detail-tools",
    "data-agent-detail-task", "data-agent-detail-report"
  ]) {
    if (await agentDetail.locator(`[${hook}]`).count() !== 1) {
      throw new Error(`${scenario.label}/run: 专家详情缺少 ${hook}`);
    }
  }
  for (const hook of ["data-agent-detail-task", "data-agent-detail-report"]) {
    const value = await agentDetail.locator(`[${hook}]`).getAttribute("data-i18n-skip");
    if (value === null) {
      throw new Error(`${scenario.label}/run: ${hook} 必须带 data-i18n-skip（否则原文会被 i18n bridge 改写）`);
    }
  }
  const detailTaskText = String(await agentDetail.locator("[data-agent-detail-task]").innerText() || "").trim();
  const detailReportText = String(await agentDetail.locator("[data-agent-detail-report]").innerText() || "").trim();
  if (detailTaskText.length < 20) {
    throw new Error(`${scenario.label}/run: 详情里的"主 Agent 提问"应为完整原文（实际 ${detailTaskText.length} 字）`);
  }
  if (detailReportText.length < 20) {
    throw new Error(`${scenario.label}/run: 详情里的"专家报告"应为全文（实际 ${detailReportText.length} 字）`);
  }
  // Esc 关闭 → 不留残留
  await page.keyboard.press("Escape");
  await agentDetail.waitFor({ state: "detached", timeout: 5_000 });

  // 老记录（第 4 位专家只有空串字段）→ 必须显示占位而不是空白或崩溃
  await laneOpenButtons.nth(3).click();
  const legacyDetail = page.locator("[data-agent-detail]");
  await legacyDetail.waitFor({ state: "visible", timeout: 5_000 });
  if (await legacyDetail.locator("[data-agent-detail-task-missing]").count() !== 1) {
    throw new Error(`${scenario.label}/run: 老记录缺内容时必须显示占位`);
  }
  const legacyTokens = String(await legacyDetail.locator("[data-agent-detail-tokens]").innerText() || "");
  if (!/未报告|Not reported/i.test(legacyTokens)) {
    throw new Error(`${scenario.label}/run: 老记录的 token 应显示"未报告"（实际 "${legacyTokens}"）`);
  }
  await page.keyboard.press("Escape");
  if (await page.locator("[data-agent-detail]").count() !== 0) {
    throw new Error(`${scenario.label}/run: Esc 后详情弹层必须完全卸载`);
  }

  // C20.6：运行详情的"证据贡献"区块 —— 一眼看出数据专家有没有被用到、反方是否走过场。
  const contributions = page.locator("[data-run-contributions]");
  await contributions.first().waitFor({ state: "visible", timeout: 10_000 });
  const usedEvidence = page.locator("[data-run-used-evidence-item]");
  if (await usedEvidence.count() !== 2) {
    throw new Error(`${scenario.label}/run: 引用证据应展示 2 组专家，实际 ${await usedEvidence.count()}`);
  }
  const usedEvidenceExperts = await page.locator("[data-run-used-evidence-expert]").allTextContents();
  if (usedEvidenceExperts.some((text) => !String(text).trim())) {
    throw new Error(`${scenario.label}/run: 引用证据缺少专家名`);
  }
  if (await page.locator("[data-run-used-evidence-point]").count() < 2) {
    throw new Error(`${scenario.label}/run: 引用证据缺少要点条目`);
  }
  // C25①：排版提醒行已按要求移除（审计字段仍记录，只是不展示）；summary 仍必须由 markdown 原样渲染。
  if (await page.locator("[data-run-summary-format-warnings]").count() !== 0) {
    throw new Error(`${scenario.label}/run: 排版提醒行应已移除`);
  }
  if (await page.locator(".automation-run-summary-surface .automation-run-markdown").count() < 1) {
    throw new Error(`${scenario.label}/run: summary 应仍由 markdown 原样渲染`);
  }
  // C20.6：本轮未派专家必须可见（有理由 → 显示理由，不得标为"未说明理由"）。
  const selfAnalysis = page.locator("[data-run-self-analysis]");
  if (await selfAnalysis.count() !== 1) {
    throw new Error(`${scenario.label}/run: 缺少"本轮未派专家"区块`);
  }
  if (await page.locator("[data-run-self-analysis-unjustified]").count() !== 0) {
    throw new Error(`${scenario.label}/run: 已给出理由的运行不应标为"未说明理由"`);
  }

  const resolutions = page.locator("[data-run-contrarian-resolution]");
  if (await resolutions.count() < 3) {
    throw new Error(`${scenario.label}/run: 反方回应应有 3 条，实际 ${await resolutions.count()}`);
  }
  const outcomes = await page.locator("[data-contrarian-outcome-label]").allTextContents();
  if (!outcomes.some((text) => /未被回应|Unresolved/i.test(text))) {
    throw new Error(`${scenario.label}/run: 必须把"未被回应"的反方条目显式标出：${JSON.stringify(outcomes)}`);
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
  await page.goto(`${baseUrl}?view=single-run&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
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
  await page.goto(`${baseUrl}?view=model-error&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
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

async function verifyMinimalMode(page, scenario) {
  // C24：极简模式运行 —— 徽标 + 一句话 summary 原样展示 + 超长警告走既有提醒行。
  await page.goto(`${baseUrl}?view=minimal&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="minimal"]', { timeout: 30_000 });
  const badge = page.locator('[data-run-single-agent-mode="minimal"]');
  if (await badge.count() !== 1) {
    throw new Error(`${scenario.label}/minimal: 极简运行必须显示模式徽标（实际 ${await badge.count()}）`);
  }
  if (!/极简|Minimal/i.test(String(await badge.first().textContent() || ""))) {
    throw new Error(`${scenario.label}/minimal: 模式徽标文案异常`);
  }
  // C25⑤ / tsk_21c3c561：极简模式**不再**把"是否进入深度分析"短路成 `na` —— 极简约束的是
  // "不派专家 + 结论一句话"，不等于"不做深度"。状态只由 triage 判定，因此本夹具
  //（verdict=escalate、phase=deep）必须显示 `deep`。旧断言（期望 `na` / 文案"不适用"）
  // 与修复后的展示层直接冲突，属**断言未随产品语义更新**，故按新语义改写。
  const minimalDeep = await page.locator("[data-run-deep-analysis]").first().getAttribute("data-run-deep-analysis");
  if (minimalDeep !== "deep") {
    throw new Error(`${scenario.label}/minimal: 极简模式下"深度分析"应为已进入（期望 deep，实际 ${minimalDeep}）`);
  }
  if (!String(await page.locator("[data-run-deep-analysis-label]").first().innerText() || "").includes("已进入深度分析")) {
    throw new Error(`${scenario.label}/minimal: "深度分析"标签文案异常（应显示"已进入深度分析"）`);
  }
  // 与"深度分析"标签**相互独立**的判据：极简模式不派驻场专家，但试判判定与它的徽标照常展示。
  // 拆成两条是有意的——将来任一侧改动只应让对应那条红，不得互相掩盖。
  const minimalVerdict = page.locator("[data-run-triage-badge]");
  if (await minimalVerdict.count() !== 1
    || await minimalVerdict.first().getAttribute("data-triage-verdict") !== "escalate") {
    throw new Error(`${scenario.label}/minimal: 极简运行仍须独立展示试判升级徽标（实际 ${await minimalVerdict.count()} 个 / ${await minimalVerdict.first().getAttribute("data-triage-verdict").catch(() => null)}）`);
  }
  // tsk_21c3c561 的 UI 注记：进入深度但无专家时，必须在同一行说明"为什么没有专家"。
  if (await page.locator("[data-run-deep-analysis-minimal-note]").count() !== 1) {
    throw new Error(`${scenario.label}/minimal: 极简模式进入深度时必须注明"不派专家、结论一句话"`);
  }
  const summarySurface = page.locator(".automation-run-summary-surface").first();
  await summarySurface.waitFor({ state: "visible", timeout: 10_000 });
  if (!String(await summarySurface.innerText() || "").trim()) {
    throw new Error(`${scenario.label}/minimal: 极简运行的 summary 必须原样展示（不得折叠或判错）`);
  }
  // C25①：极简模式的排版提醒行已移除（审计字段仍记录），因此这里断言"不展示"。
  if (await page.locator("[data-run-summary-format-warnings]").count() !== 0) {
    throw new Error(`${scenario.label}/minimal: 极简模式不应再展示排版提醒行`);
  }
  // 标准对照：单 Agent 标准模式不得出现该徽标。
  await page.goto(`${baseUrl}?view=single-run&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('.automation-preview-page[data-preview-view="single-run"]', { timeout: 30_000 });
  if (await page.locator('[data-run-single-agent-mode="minimal"]').count() !== 0) {
    throw new Error(`${scenario.label}/minimal: 标准模式不应显示极简徽标`);
  }
  const offDeep = await page.locator("[data-run-deep-analysis]").first().getAttribute("data-run-deep-analysis");
  if (offDeep !== "off") {
    throw new Error(`${scenario.label}/minimal: 未启用试判的运行应显示 off（实际 ${offDeep}）`);
  }
}

async function verifyRunRefresh(page, scenario) {
  // 夹具默认 1.2s 就切到"已完成"，会让"运行中"的断言与机器速度赛跑（历史上偶发失败）。
  // 这里用 `holdMs` 把观察窗口拉到 10s（夹具支持 200–600000，默认仍 1200），
  // 并用夹具暴露的 `data-refresh-completed` 状态属性等待切换，而不是等文案。
  await page.goto(`${baseUrl}?view=refresh&slow=6&holdMs=10000`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  try {
    await page.waitForSelector('.automation-preview-page[data-preview-view="refresh"]', { timeout: 30_000 });
    await page.waitForSelector(".automation-run-modal", { timeout: 30_000 });
  } catch (error) {
    const currentView = await page.locator(".automation-preview-page").getAttribute("data-preview-view").catch(() => null);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    throw new Error(`${scenario.label}/refresh: detail modal missing; view=${currentView}; text=${bodyText.slice(0, 240)}; ${error.message}`);
  }
  const refreshRoot = page.locator("[data-refresh-hold-ms]").first();
  await refreshRoot.waitFor({ state: "attached", timeout: 10_000 });
  const holdMs = await refreshRoot.getAttribute("data-refresh-hold-ms");
  if (holdMs !== "10000") {
    throw new Error(`${scenario.label}/refresh: holdMs 未生效（实际 ${holdMs}）`);
  }
  await page.waitForFunction(
    () => document.querySelector('[data-refresh-completed="false"]') !== null,
    undefined,
    { timeout: 10_000 }
  );
  await page.getByText("Agent 正在分析", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-refresh-completed="true"]') !== null,
    undefined,
    { timeout: 20_000 }
  );
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
  await page.goto(`${baseUrl}?view=optimization&slow=6`, { waitUntil: "networkidle", timeout: 60_000 });
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

  await verifyAgentSelection(page, scenario);
  await verifyAgentLibrary(page, scenario);
  await verifyRun(page, scenario);
  await verifyMinimalMode(page, scenario);
  await verifyTriageSettings(page, scenario);
  await verifyTriageRun(page, scenario);
  await verifySingleRun(page, scenario);
  await verifyModelError(page, scenario);
  await verifyRunRefresh(page, scenario);
  await verifyOptimizationDiff(page, scenario);

  // 浏览器预览没有 Tauri 命令通道：Agent 库的正文读取按设计抛 AGENT_LIBRARY_DESKTOP_ONLY，
  // 编辑器于是渲染错误态（预览的既定行为，不是缺陷）。这类日志与网络噪声一起排除。
  const actionableConsoleErrors = consoleErrors.filter((text) =>
    !/Failed to load resource|ERR_|AGENT_LIBRARY_DESKTOP_ONLY|ai agent read failed/i.test(text)
  );
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
