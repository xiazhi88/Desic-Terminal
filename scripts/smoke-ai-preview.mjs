import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.DESIC_AI_PREVIEW_URL || "http://127.0.0.1:1420/ai-preview";
const artifactDir = path.resolve("artifacts", "ai-preview");

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector(".ai-panel", { timeout: 30_000 });

  const initial = await readAiPreviewState(page);
  if (!initial.panel || !initial.float) throw new Error(`AI panel or float missing: ${JSON.stringify(initial)}`);
  if (initial.bodyOverflowX > 2 || initial.bodyOverflowY > 2) {
    throw new Error(`AI preview has global overflow: ${JSON.stringify(initial)}`);
  }
  if (!/deepseek-v4-pro/.test(initial.headerText) || !/生成中|思考中|调用工具|读取工具|连接中|stream/i.test(initial.headerText)) {
    throw new Error(`AI header should show model and streaming state: ${JSON.stringify(initial)}`);
  }
  if (!initial.providerText.includes("https://api.deepseek.com")) {
    throw new Error(`AI provider row missing base URL: ${JSON.stringify(initial)}`);
  }
  if (!initial.stopButton || initial.sendButton) {
    throw new Error(`AI preview should start with stop button while streaming: ${JSON.stringify(initial)}`);
  }
  if (!initial.newSessionButton) {
    throw new Error(`AI panel should expose a new-session button: ${JSON.stringify(initial)}`);
  }
  if (!initial.reasoningVisible || !initial.allowedToolVisible || !initial.resultToolVisible || !initial.blockedToolVisible) {
    throw new Error(`AI preview should render reasoning, allowed/result/blocked tool cards: ${JSON.stringify(initial)}`);
  }
  const mergedHistoryGroup = page.locator(".ai-tool-group").filter({ hasText: "market.readInstrument" });
  if (await mergedHistoryGroup.count() !== 1
    || await mergedHistoryGroup.locator(".ai-tool-trace").count() !== 1
    || !/运行了 1 个工具/.test(await mergedHistoryGroup.locator(":scope > summary").textContent() || "")
    || !/2s/.test(await mergedHistoryGroup.locator(":scope > summary").textContent() || "")) {
    throw new Error("historical tool lifecycle should render as one tool row");
  }
  const completedHistoryMessage = mergedHistoryGroup.locator("xpath=ancestor::article[1]");
  if (!/已处理/.test(await completedHistoryMessage.locator(":scope > .ai-process > summary").textContent() || "")) {
    throw new Error("stored completed AI message should not remain processing");
  }
  const storedReasoning = await completedHistoryMessage.locator(".ai-reasoning p").allTextContents();
  if (storedReasoning.length !== 1
    || storedReasoning[0].split("先读取账户和市场上下文").length - 1 !== 1) {
    throw new Error(`stored reasoning event should render once: ${JSON.stringify(storedReasoning)}`);
  }
  const reasoningSummaries = await completedHistoryMessage.locator(".ai-reasoning-summary").allTextContents();
  if (reasoningSummaries.length !== 2
    || reasoningSummaries[0] !== "Inspecting account and market context"
    || reasoningSummaries[1] !== "Planning the risk review") {
    throw new Error(`Codex reasoning summaries should remain separate: ${JSON.stringify(reasoningSummaries)}`);
  }
  if (await completedHistoryMessage.locator(".ai-reasoning-summaries").count() !== 1) {
    throw new Error("adjacent Codex reasoning summaries should share one compact process list");
  }
  const summaryStyles = await completedHistoryMessage.locator(".ai-reasoning-summary").evaluateAll((items) => items.map((item) => {
    const style = getComputedStyle(item);
    const textStyle = getComputedStyle(item.querySelector(".ai-markdown"));
    const markerStyle = getComputedStyle(item, "::before");
    return {
      border: style.borderStyle,
      background: style.backgroundColor,
      display: style.display,
      fontSize: Number.parseFloat(textStyle.fontSize),
      fontWeight: Number.parseInt(textStyle.fontWeight, 10),
      markerWidth: Number.parseFloat(markerStyle.width)
    };
  }));
  if (summaryStyles.some((style) => (
    style.border !== "none"
    || style.background !== "rgba(0, 0, 0, 0)"
    || style.display !== "grid"
    || style.fontSize > 12.1
    || style.fontWeight > 400
    || style.markerWidth < 3
  ))) {
    throw new Error(`Codex reasoning summaries should use compact secondary typography: ${JSON.stringify(summaryStyles)}`);
  }
  const completedProcessText = await completedHistoryMessage.locator(":scope > .ai-process").textContent() || "";
  const completedAnswerText = await completedHistoryMessage.locator(":scope > .ai-answer").textContent() || "";
  if (completedProcessText.includes("历史工具状态已合并") || !completedAnswerText.includes("历史工具状态已合并")) {
    throw new Error("stored final answer must render outside the process timeline");
  }
  const stableHistoryAgent = page.locator(".ai-agent-run", { hasText: "历史市场结构" });
  if (await stableHistoryAgent.count() !== 1
    || !/已完成 · 5s/.test(await stableHistoryAgent.locator(":scope > summary").textContent() || "")
    || /运行中/.test(await stableHistoryAgent.locator(":scope > summary").textContent() || "")) {
    throw new Error("configured Agent lifecycle should merge runtime starts and close on completion");
  }
  const modelErrorMessage = page.locator(".ai-message", { has: page.locator(".ai-agent-run.agent-model-error") });
  const modelErrorCard = modelErrorMessage.locator(".ai-agent-run.agent-model-error");
  if (await modelErrorMessage.count() !== 1
    || await modelErrorCard.count() !== 1
    || !await modelErrorCard.isVisible()
    || !await modelErrorCard.locator(".ai-agent-error").isVisible()
    || !/已处理/.test(await modelErrorMessage.locator(":scope > .ai-process > summary").textContent() || "")
    || !/模型错误 · 625ms/.test(await modelErrorCard.locator(":scope > summary").textContent() || "")
    || !/模型服务错误/.test(await modelErrorCard.locator(".ai-agent-error").textContent() || "")
    || !/模型服务余额不足/.test(await modelErrorCard.locator(".ai-agent-error").textContent() || "")
    || await modelErrorCard.locator(":scope > code").count() !== 0
    || /finishReason/.test(await modelErrorMessage.textContent() || "")
    || /(^|\s)failed($|\s)/i.test(await modelErrorMessage.textContent() || "")) {
    throw new Error("model response errors should render as a dedicated localized error without raw JSON or a generic failed tail");
  }
  if (await modelErrorCard.locator(".ai-agent-error svg").count() !== 1) {
    throw new Error("model response error should include a visible alert icon");
  }
  await stableHistoryAgent.evaluate((node) => {
    let current = node;
    while (current) {
      if (current instanceof HTMLDetailsElement) current.open = true;
      current = current.parentElement;
    }
  });
  await stableHistoryAgent.scrollIntoViewIfNeeded();
  const stableAgentTools = stableHistoryAgent.locator(".ai-agent-tools .ai-tool-trace");
  if (await stableAgentTools.count() !== 2) {
    throw new Error("configured Agent tool rows are missing");
  }
  const toolLayout = await stableAgentTools.locator(":scope > summary").evaluateAll((summaries) => summaries.map((summary) => {
    const action = summary.querySelector(".ai-tool-trace-action")?.getBoundingClientRect();
    const name = summary.querySelector("code")?.getBoundingClientRect();
    const status = summary.querySelector("strong")?.getBoundingClientRect();
    const style = summary.querySelector("code") ? getComputedStyle(summary.querySelector("code")) : null;
    const box = summary.getBoundingClientRect();
    return {
      height: box.height,
      actionX: action?.x ?? -1,
      actionY: action?.y ?? -1,
      nameX: name?.x ?? -1,
      nameY: name?.y ?? -1,
      statusRight: status ? status.right : -1,
      whiteSpace: style?.whiteSpace ?? ""
    };
  }));
  const spread = (values) => Math.max(...values) - Math.min(...values);
  if (toolLayout.some((row) => row.height > 40 || row.whiteSpace !== "nowrap" || Math.abs(row.actionY - row.nameY) > 3)
    || spread(toolLayout.map((row) => row.actionX)) > 1
    || spread(toolLayout.map((row) => row.nameX)) > 1
    || spread(toolLayout.map((row) => row.statusRight)) > 1) {
    throw new Error(`configured Agent tool columns are not aligned: ${JSON.stringify(toolLayout)}`);
  }
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, "agent-tools-1280x760.png"), fullPage: false });
  if (!initial.markdownListVisible || !initial.markdownTableVisible || !initial.markdownCodeVisible) {
    throw new Error(`AI preview should render markdown list/table/code: ${JSON.stringify(initial)}`);
  }
  if (!initial.composerPermissionVisible || !/副驾驶/.test(initial.composerPermissionText) || !initial.composerModelVisible || !initial.composerReasoningVisible || !initial.approvalCardVisible) {
    throw new Error(`AI preview should render composer model, reasoning, permission and approval card: ${JSON.stringify(initial)}`);
  }
  if (initial.nativeSelectCount !== 0) throw new Error(`AI preview rendered native selects: ${initial.nativeSelectCount}`);
  if (initial.panel && initial.float && rectsOverlap(initial.panel, initial.float)) {
    throw new Error(`AI float overlaps open panel: ${JSON.stringify(initial)}`);
  }
  if (initial.stopButtonRect.width < 34 || initial.stopButtonRect.height < 34 || initial.stopButtonRadius < 18) {
    throw new Error(`AI stop button should be stable and circular: ${JSON.stringify(initial)}`);
  }

  await page.locator('.ai-panel-head button[title="会话列表"]').click();
  await page.waitForTimeout(280);
  const sessionsOpen = await readAiPreviewState(page);
  if (!sessionsOpen.sessionSidebar || sessionsOpen.sessionSidebar.width < 260) {
    throw new Error(`AI session sidebar should open at the left: ${JSON.stringify(sessionsOpen)}`);
  }
  if (!sessionsOpen.panel || sessionsOpen.panel.width < initial.panel.width + 250) {
    throw new Error(`AI panel should expand when session sidebar opens: ${JSON.stringify({ initial, sessionsOpen })}`);
  }
  if (!sessionsOpen.panelMain || sessionsOpen.sessionSidebar.x >= sessionsOpen.panelMain.x) {
    throw new Error(`AI session sidebar should remain left of the conversation: ${JSON.stringify(sessionsOpen)}`);
  }
  const userSessionsTab = page.getByRole("tab", { name: "用户会话" });
  const automationSessionsTab = page.getByRole("tab", { name: "AI 自动化" });
  if (await userSessionsTab.getAttribute("aria-selected") !== "true"
    || await automationSessionsTab.getAttribute("aria-selected") !== "false") {
    throw new Error("AI session history should default to user-initiated sessions");
  }
  if (await page.locator(".ai-session-items .ai-session-item").count() !== 1
    || !/BTC 盘面咨询/.test(await page.locator(".ai-session-items").textContent() || "")) {
    throw new Error("user session tab should only render user-initiated sessions");
  }
  await automationSessionsTab.click();
  if (await automationSessionsTab.getAttribute("aria-selected") !== "true"
    || await page.locator(".ai-session-items .ai-session-item").count() !== 2
    || !/BTC 定时扫描/.test(await page.locator(".ai-session-items").textContent() || "")
    || !/自动交易复盘/.test(await page.locator(".ai-session-items").textContent() || "")) {
    throw new Error("automation session tab should render background runs and automated reviews");
  }
  await page.screenshot({ path: path.join(artifactDir, "session-history-tabs-1280x760.png"), fullPage: false });
  await userSessionsTab.click();
  await page.locator('.ai-session-list-head button[title="收起会话列表"]').click();
  await page.waitForTimeout(280);
  const sessionsClosed = await readAiPreviewState(page);
  if (!sessionsClosed.panel || Math.abs(sessionsClosed.panel.width - initial.panel.width) > 2 || sessionsClosed.sessionSidebar.width > 2) {
    throw new Error(`AI session sidebar should collapse cleanly: ${JSON.stringify({ initial, sessionsClosed })}`);
  }

  const leftResize = page.locator(".ai-panel-resize-left");
  const leftResizeBox = await leftResize.boundingBox();
  if (!leftResizeBox) throw new Error("AI panel left resize edge is missing");
  await page.mouse.move(leftResizeBox.x + 2, leftResizeBox.y + leftResizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftResizeBox.x - 80, leftResizeBox.y + leftResizeBox.height / 2, { steps: 4 });
  await page.mouse.up();
  const widthResized = await readAiPreviewState(page);
  if (!widthResized.panel || widthResized.panel.width < sessionsClosed.panel.width + 70) {
    throw new Error(`AI panel width did not resize from its edge: ${JSON.stringify({ sessionsClosed, widthResized })}`);
  }

  const topResize = page.locator(".ai-panel-resize-top");
  const topResizeBox = await topResize.boundingBox();
  if (!topResizeBox) throw new Error("AI panel top resize edge is missing");
  await page.mouse.move(topResizeBox.x + topResizeBox.width / 2, topResizeBox.y + 2);
  await page.mouse.down();
  await page.mouse.move(topResizeBox.x + topResizeBox.width / 2, topResizeBox.y + 62, { steps: 4 });
  await page.mouse.up();
  const heightResized = await readAiPreviewState(page);
  if (!heightResized.panel || heightResized.panel.height > widthResized.panel.height - 50) {
    throw new Error(`AI panel height did not resize from its edge: ${JSON.stringify({ widthResized, heightResized })}`);
  }

  await page.locator(".ai-send.stop").click();
  await page.waitForTimeout(120);
  const stopped = await readAiPreviewState(page);
  if (stopped.stopButton || !stopped.sendButton) {
    throw new Error(`AI stop did not switch back to send button: ${JSON.stringify(stopped)}`);
  }
  if (!/已停止/.test(stopped.lastStatusText) || !/已停止/.test(stopped.floatLabel) || !/已停止/.test(stopped.headerText)) {
    throw new Error(`AI stop did not update visible status: ${JSON.stringify(stopped)}`);
  }
  if (stopped.sendButtonDisabled !== true) {
    throw new Error(`AI send button should be disabled with empty input after stop: ${JSON.stringify(stopped)}`);
  }

  await page.locator(".ai-input-row textarea").fill("检查 BTC 当前风险");
  const readyToSend = await readAiPreviewState(page);
  if (!readyToSend.sendButton || readyToSend.sendButtonDisabled) {
    throw new Error(`AI send button should enable when input has text after stop: ${JSON.stringify(readyToSend)}`);
  }

  const actionableConsoleErrors = consoleErrors.filter((text) => !/WebSocket|ERR_|Failed to load resource/i.test(text));
  if (pageErrors.length > 0 || actionableConsoleErrors.length > 0) {
    throw new Error(`AI preview errors: ${JSON.stringify({ pageErrors, consoleErrors: actionableConsoleErrors })}`);
  }

  await browser.close();
  process.stdout.write(
    `[smoke] ai preview ok: messages=${initial.messageCount}, tools=${initial.toolCount}, stopped="${stopped.lastStatusText}"\n`
  );
}

async function readAiPreviewState(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const item = document.querySelector(selector);
      const box = item?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    const stopButton = document.querySelector(".ai-send.stop");
    const sendButton = document.querySelector(".ai-send:not(.stop)");
    const stopButtonBox = stopButton?.getBoundingClientRect();
    const stopButtonStyle = stopButton ? getComputedStyle(stopButton) : null;
    return {
      panel: rect(".ai-panel"),
      panelMain: rect(".ai-panel-main"),
      sessionSidebar: rect(".ai-session-sidebar"),
      float: rect(".ai-float"),
      stopButton: Boolean(stopButton),
      newSessionButton: Boolean(document.querySelector('.ai-panel-head button[title="新建会话"]')),
      sendButton: Boolean(sendButton),
      sendButtonDisabled: sendButton?.disabled ?? null,
      stopButtonRect: stopButtonBox ? { width: stopButtonBox.width, height: stopButtonBox.height } : { width: 0, height: 0 },
      stopButtonRadius: stopButtonStyle ? parseFloat(stopButtonStyle.borderTopLeftRadius) || 0 : 0,
      headerText: document.querySelector(".ai-panel-head")?.textContent?.trim() || "",
      providerText: document.querySelector(".ai-provider")?.textContent?.trim() || "",
      floatText: document.querySelector(".ai-float")?.textContent?.trim() || "",
      floatLabel: document.querySelector(".ai-float")?.getAttribute("aria-label") || "",
      lastStatusText: Array.from(document.querySelectorAll(".ai-message-status")).at(-1)?.textContent?.trim() || "",
      reasoningVisible: Boolean(document.querySelector(".ai-reasoning")),
      allowedToolVisible: Boolean(document.querySelector(".ai-tool-trace.tool-done")),
      resultToolVisible: Boolean(document.querySelector(".ai-tool-trace.tool-done .ai-tool-panel")),
      blockedToolVisible: Boolean(document.querySelector(".ai-tool-trace.tool-blocked")),
      markdownListVisible: Boolean(document.querySelector(".ai-markdown ul li")),
      markdownTableVisible: Boolean(document.querySelector(".ai-markdown table th")),
      markdownCodeVisible: Boolean(document.querySelector(".ai-markdown pre code")),
      composerPermissionVisible: Boolean(document.querySelector('.ai-composer-options [role="combobox"][aria-label="AI 权限"]')),
      composerPermissionText: document.querySelector('.ai-composer-options [role="combobox"][aria-label="AI 权限"] .terminal-select-value')?.textContent?.trim() || "",
      composerModelVisible: Boolean(document.querySelector('.ai-composer-options [role="combobox"][aria-label="AI 模型"]')),
      composerReasoningVisible: Boolean(document.querySelector('.ai-composer-options [role="combobox"][aria-label="思考深度"]')),
      nativeSelectCount: document.querySelectorAll("select").length,
      approvalCardVisible: Boolean(document.querySelector(".ai-approval-card.approval-pending")),
      messageCount: document.querySelectorAll(".ai-message").length,
      toolCount: document.querySelectorAll(".ai-tool").length,
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight
    };
  });
}

main().catch((error) => {
  process.stderr.write(`[smoke] ai preview failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
