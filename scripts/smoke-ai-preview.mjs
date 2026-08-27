import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.DESIC_AI_PREVIEW_URL || "http://127.0.0.1:1420/ai-research-preview";
const artifactDir = path.resolve("artifacts", "ai-preview");
const viewports = [
  { width: 1440, height: 900, name: "ai-research-1440x900" },
  { width: 1280, height: 720, name: "ai-research-1280x720" },
  { width: 720, height: 720, name: "ai-research-720x720" }
];

async function readLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null;
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      host: rect(".ai-research-host"),
      shell: rect(".ai-research-shell"),
      sidebar: rect(".ai-session-sidebar"),
      main: rect(".ai-panel-main"),
      inspector: rect(".ai-research-inspector"),
      inspectorTabCount: document.querySelectorAll(".ai-inspector-tabs [role=tab]").length,
      columnResizeCount: document.querySelectorAll(".ai-column-resize").length,
      toolArtifactCount: document.querySelectorAll(".ai-tool-open-artifact").length,
      shellColumns: getComputedStyle(document.querySelector(".ai-research-shell")).gridTemplateColumns,
      context: rect(".ai-research-context"),
      composer: rect(".ai-composer"),
      contextDisplay: document.querySelector(".ai-research-context") ? getComputedStyle(document.querySelector(".ai-research-context")).display : "removed",
      contextText: document.querySelector(".ai-context-meter-wrap")?.textContent || "",
       contextTriggerCount: document.querySelectorAll(".ai-context-meter-trigger").length,
       runningSessionCount: document.querySelectorAll(".ai-session-item.running").length,
       inspectorSectionCount: document.querySelectorAll(".ai-inspector-sections button").length,
       intelligenceNavCount: document.querySelectorAll(".ai-intelligence-nav button").length,
       welcomeCount: document.querySelectorAll(".ai-research-welcome").length,
       commandPaletteCount: document.querySelectorAll(".ai-command-palette").length,
      headerText: document.querySelector(".ai-panel-head")?.textContent || "",
      messageMetricsText: Array.from(document.querySelectorAll(".ai-message-actions")).map((node) => node.textContent || "").join(" "),
      placeholder: document.querySelector(".ai-composer textarea")?.getAttribute("placeholder") || "",
      floatCount: document.querySelectorAll(".ai-float").length,
      resizeCount: document.querySelectorAll(".ai-panel-resize").length,
      sessionTabCount: document.querySelectorAll(".ai-session-tabs").length,
      nativeSelectCount: document.querySelectorAll("select").length,
      taskDockCount: document.querySelectorAll(".ai-task-dock").length,
      queueDockCount: document.querySelectorAll(".ai-queue-dock").length,
      stopButtonCount: document.querySelectorAll(".ai-send.stop").length,
      sendButtonCount: document.querySelectorAll(".ai-send:not(.stop)").length,
       composerControlCount: document.querySelectorAll(".ai-composer-controls").length,
       legacyComposerActionCount: document.querySelectorAll(".ai-composer-actions").length,
       inspectorShortcutCount: document.querySelectorAll(".ai-inspector-shortcut").length,
       calendarScroll: document.querySelector(".ai-intel-calendar-scroll") ? (() => { const node = document.querySelector(".ai-intel-calendar-scroll"); return { overflowX: getComputedStyle(node).overflowX, scrollWidth: node.scrollWidth, width: node.clientWidth }; })() : null,
      coarsePointer: matchMedia("(pointer: coarse)").matches,
      touchTargets: Array.from(document.querySelectorAll(".ai-message-actions button, .ai-research-shell .ai-send, .ai-research-shell .terminal-select-trigger")).map((item) => {
        const box = item.getBoundingClientRect();
        return { width: box.width, height: box.height };
      })
    };
  });
}

function assertLayout(layout) {
  if (!layout.host || !layout.shell || !layout.sidebar || !layout.main || !layout.composer) {
    throw new Error(`AI Research workspace regions are missing: ${JSON.stringify(layout)}`);
  }
  if (layout.floatCount !== 0 || layout.resizeCount !== 0 || layout.sessionTabCount !== 0) {
    throw new Error(`Legacy floating assistant controls remain: ${JSON.stringify(layout)}`);
  }
  if (layout.scrollWidth > layout.viewport.width || layout.scrollHeight > layout.viewport.height) {
    throw new Error(`AI Research preview overflows the viewport: ${JSON.stringify(layout)}`);
  }
  if (layout.sidebar.right > layout.main.x + 1 || layout.composer.bottom > layout.viewport.height) {
    throw new Error(`AI Research columns or composer are misaligned: ${JSON.stringify(layout)}`);
  }
  if (layout.contextDisplay !== "removed" || layout.contextTriggerCount !== 1 || layout.runningSessionCount < 1 || layout.inspectorSectionCount !== 0) {
    throw new Error(`Research context should be represented by one compact popover trigger: ${JSON.stringify(layout)}`);
  }
  if (layout.viewport.width > 880 && (!layout.inspector || layout.inspector.width < 280 || layout.inspectorTabCount < 1 || layout.columnResizeCount !== 2)) {
    throw new Error(`Desktop research inspector should be a visible resizable tabbed third column: ${JSON.stringify(layout)}`);
  }
  if (layout.viewport.width <= 880 && layout.inspector && layout.inspector.width > 1) {
    throw new Error(`Narrow layouts should collapse the research inspector without horizontal overflow: ${JSON.stringify(layout)}`);
  }
  if (!/deepseek-v4-flash/i.test(layout.headerText) || !/47\.2k\s*\/\s*256k/i.test(layout.contextText)) {
    throw new Error(`Model or measured context state is missing: ${JSON.stringify(layout)}`);
  }
  if (!/TTFT\s+\d/i.test(layout.messageMetricsText)) {
    throw new Error(`Measured TTFT metadata is missing: ${JSON.stringify(layout)}`);
  }
  if (/Press Enter|Shift\+Enter/i.test(layout.placeholder)) {
    throw new Error(`Composer placeholder should not expose instructions: ${JSON.stringify(layout)}`);
  }
  if (layout.floatCount || layout.nativeSelectCount || layout.taskDockCount !== 1 || layout.queueDockCount !== 1) {
    throw new Error(`AI Research controls are incomplete: ${JSON.stringify(layout)}`);
  }
  const expectedInspectorShortcuts = layout.viewport.width <= 660 ? 0 : 3;
  if (layout.stopButtonCount !== 1 || layout.sendButtonCount !== 1 || layout.inspectorShortcutCount !== expectedInspectorShortcuts || layout.composerControlCount !== 1 || layout.legacyComposerActionCount !== 0) {
    throw new Error(`Streaming composer and right-panel shortcuts are incomplete: ${JSON.stringify(layout)}`);
  }
  if (layout.coarsePointer && layout.touchTargets.some((target) => target.width < 44 || target.height < 44)) {
    throw new Error(`Coarse-pointer controls need 44px targets: ${JSON.stringify(layout)}`);
  }
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const pageErrors = [];

  try {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width === 720 });
      await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
      await page.waitForSelector(".ai-research-shell", { timeout: 30_000 });
      const layout = await readLayout(page);
      assertLayout(layout);
      await page.screenshot({ path: path.join(artifactDir, `${viewport.name}.png`), fullPage: false });
      await page.close();
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => localStorage.setItem("desic.ui.language.v1", "zh-CN"));
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
    const process = page.locator(".ai-process").first();
    const processSummary = process.locator(":scope > summary");
    if (await process.getAttribute("open") === null) await processSummary.click();
    const toolGroup = page.locator(".ai-tool-group").first();
    if (await toolGroup.count() !== 1) throw new Error("Preview should include a grouped tool trace");
    if (await toolGroup.getAttribute("open") === null) await toolGroup.locator(":scope > summary").click();
    const directMarketTool = page.locator(".ai-tool-direct-artifact").first();
    if (await directMarketTool.count() !== 1) throw new Error("A completed market tool should directly open its market workspace");
    await directMarketTool.click();
    if (await page.locator(".ai-research-inspector").count() !== 1 || await page.locator(".ai-inspector-tabs [role=tab]").count() < 2 || await page.locator(".ai-market-kline-canvas").count() !== 1) {
      throw new Error("Clicking a market candle row should open a dedicated K-line workspace");
    }
    const visibleFacts = await page.locator(".ai-inspector-facts").allTextContents();
    if (visibleFacts.some((value) => /ageMs|dataAt|seqId|sourceEventSeqs|fetchedAt/.test(value))) {
      throw new Error(`Technical freshness fields should remain in raw disclosure: ${visibleFacts.join(" | ")}`);
    }
    await page.locator(".ai-inspector-tabs [role=tab]").first().click();
    if (await page.locator(".ai-market-open-trading").count() !== 1) throw new Error("Default market overview should expose a Trading workspace shortcut");
    await page.screenshot({ path: path.join(artifactDir, "ai-research-kline.png"), fullPage: false });
    const skillTool = page.locator(".ai-tool-trace").filter({ hasText: "已读取交易哲学 Skill" }).first();
    if (await skillTool.count() !== 1) throw new Error("Preview should include a completed Skill tool result");
    if (await skillTool.getAttribute("open") === null) await skillTool.locator(":scope > summary").click();
    await skillTool.locator(".ai-tool-open-artifact").click();
    if (!/trading-philosophy/.test(await page.locator(".ai-research-inspector").textContent() || "")
      || !/Never promise profits/.test(await page.locator(".ai-research-inspector").textContent() || "")) {
      throw new Error("Skill artifacts should render the returned name and rules, not an empty tool payload");
    }
    const strategyTool = page.locator(".ai-tool-trace").filter({ hasText: "BTC 确认趋势" }).first();
     if (await strategyTool.count() !== 1) throw new Error("Preview should include a completed strategy creation tool result");
     if (await strategyTool.getAttribute("open") === null) await strategyTool.locator(":scope > summary").click();
     if (await strategyTool.locator(".ai-tool-code-preview").count() !== 1 || !/def on_bar/.test(await strategyTool.locator(".ai-tool-code-preview").textContent() || "")) throw new Error("Strategy creation should expose returned source as a code block");
     await strategyTool.locator(".ai-tool-open-artifact").click();
      await page.waitForSelector(".ai-inspector-code-surface .systematic-python-editor", { timeout: 30_000 });
     if (await page.locator(".ai-inspector-code-surface .systematic-python-editor").count() !== 1) throw new Error("Opening a strategy artifact should render its read-only code editor surface");
      const evidenceReference = page.locator(".ai-evidence-references button").filter({ hasText: "BTC 确认趋势" });
      if (await evidenceReference.count() !== 1) throw new Error("Assistant answers should expose reverse evidence references");
      if (await page.locator(".ai-evidence-marker").count() !== 0) throw new Error("Inline paragraph evidence markers should be removed");
      await evidenceReference.click();
      if (!/BTC 确认趋势/.test(await page.locator(".ai-research-inspector").textContent() || "")) throw new Error("Evidence references should open the matching strategy artifact");
      const backReference = page.locator(".ai-artifact-reference");
      if (await backReference.count() !== 1) throw new Error("Inspector evidence should expose a back-reference to its answer");
      await backReference.click();
      if (await page.locator(".ai-message.ai-message-located").count() !== 1) throw new Error("Back-reference should locate and highlight the source answer");
     await page.locator(".ai-inspector-shortcut[aria-label*='市场情报']").click();
    if (await page.locator(".ai-intelligence-workspace").count() !== 1 || await page.locator(".ai-intelligence-nav button").count() !== 5) throw new Error("Market intelligence should expose five compact right-panel views");
    const intelligenceLabels = await page.locator(".ai-intelligence-nav button").allTextContents();
    if (!intelligenceLabels.some((label) => label.includes("新闻")) || !intelligenceLabels.some((label) => label.includes("衍生品"))) throw new Error(`Localized intelligence tabs are missing: ${intelligenceLabels.join("|")}`);
    await page.locator(".ai-intelligence-nav button").filter({ hasText: "情绪" }).click();
     const calendarScroll = page.locator(".ai-intel-calendar-scroll");
     if (await calendarScroll.count() > 0) {
       const geometry = await calendarScroll.evaluate((node) => ({ overflowX: getComputedStyle(node).overflowX, scrollWidth: node.scrollWidth, width: node.clientWidth }));
       if (geometry.overflowX !== "auto" || geometry.scrollWidth <= geometry.width) throw new Error(`Economic calendar needs an explicit horizontal scroller: ${JSON.stringify(geometry)}`);
     }
     const calendarScrollerSource = await page.locator(".ai-intel-calendar-scroll").count();
     if (calendarScrollerSource > 1) throw new Error("Economic calendar should expose one horizontal scroll container");
     const railLabels = page.locator(".ai-inspector-sections button span");
    for (let index = 0; index < await railLabels.count(); index += 1) {
      const labelBox = await railLabels.nth(index).boundingBox();
      if (labelBox && labelBox.width > 2 && labelBox.height > 2) throw new Error("Inspector rail labels should be tooltip-only");
    }
    const intelligenceShortcut = page.locator(".ai-inspector-shortcut[aria-label*='市场情报']");
     await intelligenceShortcut.click();
     if (await page.locator(".ai-research-inspector").count() !== 1 || await page.locator(".ai-intelligence-workspace").count() !== 1) throw new Error("Center rail intelligence shortcut should open the matching inspector section");
     const radarShortcut = page.locator(".ai-inspector-shortcut[aria-label*='市场雷达']");
     await radarShortcut.click();
     if (await page.locator(".ai-radar-panel").count() !== 1 || await page.locator(".ai-radar-tabs button").count() !== 5) throw new Error("Center rail Market Radar shortcut should open five compact radar tabs");
     if (await page.locator(".ai-inspector-sections").count() !== 0) throw new Error("The inspector must not duplicate center-rail section controls");
     await intelligenceShortcut.click();
      const expandIntelligence = page.locator(".ai-intelligence-expand");
    if (await expandIntelligence.count() !== 1 || await expandIntelligence.isDisabled()) throw new Error("Full Market Intelligence action is missing");
    await expandIntelligence.click();
    await page.waitForSelector(".intelligence-page", { timeout: 30_000 });
    await page.locator(".intelligence-tabs button").nth(1).click();
    await page.waitForSelector(".intelligence-calendar-event-table", { timeout: 30_000 });
    await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector(".ai-research-shell", { timeout: 30_000 });
    await page.locator(".ai-inspector-shortcut[aria-label*='研究标签']").click();

    const sessionResize = page.locator(".ai-column-resize-sessions");
    const resizeStart = await sessionResize.boundingBox();
    if (!resizeStart) throw new Error("Session column resize affordance is unavailable");
    await page.mouse.move(resizeStart.x + 3, resizeStart.y + 60);
    await page.mouse.down();
    await page.mouse.move(resizeStart.x + 44, resizeStart.y + 60);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector(".ai-research-shell")?.getAttribute("style")?.includes("--ai-sessions-width: 293px"));
    const resizedColumns = await page.evaluate(() => document.querySelector(".ai-research-shell")?.getAttribute("style") || "");
    if (!resizedColumns.includes("--ai-sessions-width: 293px")) throw new Error("Session resize drag should update the workspace width");

    const contextIsolation = await page.evaluate(async () => {
      const { applyAiEvent } = await import("/src/ui/AiMessageProcess.tsx");
      let messages = [{ id: "assistant-completed", role: "assistant", text: "done", tools: [], completed: true }];
      applyAiEvent({
        type: "contextUsage",
        sessionId: "session-context",
        usage: { usedTokens: 42, measuredAt: 1, usedSource: "clineMessages" }
      }, () => {}, (update) => {
        messages = typeof update === "function" ? update(messages) : update;
      });
      return messages[0]?.contextUsage ?? null;
    });
    if (contextIsolation !== null) throw new Error(`Session context should not mutate an arbitrary assistant turn: ${JSON.stringify(contextIsolation)}`);

    const contextTrigger = page.locator(".ai-context-meter-trigger");
    await contextTrigger.click();
    if (await page.locator(".ai-context-popover").count() !== 1 || !/系统|System/.test(await page.locator(".ai-context-popover").textContent() || "") || !/最近一次|latest/i.test(await page.locator(".ai-context-popover").textContent() || "")) {
      throw new Error("Context meter should open an estimated breakdown popover");
    }
    await page.keyboard.press("Escape");

    const commandComposer = page.locator(".ai-composer textarea");
    await commandComposer.fill("/mar");
    if (await page.locator(".ai-command-palette").count() !== 1 || await page.locator(".ai-command-palette button").count() === 0) {
      throw new Error("Slash command palette should expose research commands and Skills");
    }
    await commandComposer.press("ArrowDown");
    await commandComposer.press("Enter");
    if ((await commandComposer.inputValue()).startsWith("/")) {
      throw new Error("Selecting a research command should insert an editable prompt starter");
    }

    const taskToggle = page.locator(".ai-task-dock > button");
    await taskToggle.click();
    if (await taskToggle.getAttribute("aria-expanded") !== "true"
      || await page.locator(".ai-task-dock p").count() !== 3
      || await page.locator(".ai-task-dock p.in_progress").count() !== 1) {
      throw new Error("Task dock should expand into structured todo states");
    }

    const queueToggle = page.locator(".ai-queue-dock > button");
    await queueToggle.click();
    const queueItem = page.locator(".ai-queue-item").first();
    if (await queueToggle.getAttribute("aria-expanded") !== "true" || !await queueItem.isVisible()) {
      throw new Error("Queued prompts should expand from the composer dock");
    }
    await queueItem.locator("button").first().click();
    const queueEditor = queueItem.locator("input");
    if (!await queueEditor.isVisible() || await queueEditor.inputValue() !== "补充比较 BTC 与 ETH 的资金费率结构。") {
      throw new Error("Queued prompt should support inline editing");
    }

    await page.locator(".ai-send.stop").click();
    await page.waitForTimeout(60);
    if (await page.locator(".ai-send.stop").count() !== 0
      || await page.locator(".ai-queue-dock").count() !== 0
      || !/已停止/.test(await page.locator(".ai-panel-head").textContent() || "")) {
      throw new Error("Stop should end streaming and clear pending prompts");
    }
    const composer = page.locator(".ai-composer textarea");
    await composer.fill("检查 BTC 当前风险");
    if (await page.locator(".ai-send").isDisabled()) {
      throw new Error("Composer send action should enable when a stopped session has a draft");
    }

    const actionableConsoleErrors = consoleErrors.filter((text) => !/WebSocket|ERR_|Failed to load resource/i.test(text));
    if (actionableConsoleErrors.length || pageErrors.length) {
      throw new Error(`AI Research preview logged errors: ${JSON.stringify({ actionableConsoleErrors, pageErrors })}`);
    }

    console.log(JSON.stringify({ ok: true, baseUrl, viewports: viewports.map(({ width, height }) => `${width}x${height}`) }));
    await page.close();
  } finally {
    await browser.close();
  }
}

await main();
