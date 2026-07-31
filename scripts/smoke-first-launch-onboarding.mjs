import { chromium } from "playwright";

const baseUrl = process.env.DESIC_PREVIEW_URL || "http://127.0.0.1:1420/terminal-preview";
const steps = ["account", "ai", "profile", "trade"];
const viewports = [
  { label: "desktop", width: 1440, height: 900 },
  { label: "compact", width: 1180, height: 720 }
];

function overlaps(a, b) {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

async function verifyStep(browser, step, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}?onboarding=${step}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".first-launch-onboarding", { timeout: 30_000 });
  await page.waitForSelector(`[data-onboarding-target="${step}"]`, { timeout: 30_000 });
  await page.waitForTimeout(250);

  const state = await page.evaluate((activeStep) => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height } : null;
    };
    return {
      activeStep,
      card: rect(".first-launch-card"),
      guide: rect(".first-launch-guide-bar"),
      ring: rect(".first-launch-spotlight"),
      bodyX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      exitButtons: document.querySelectorAll(".first-launch-exit").length,
      aiDockVisible: document.querySelector(".ai-dock") ? getComputedStyle(document.querySelector(".ai-dock")).visibility : "missing"
    };
  }, step);

  if (!state.card || !state.guide || !state.ring) throw new Error(`${step}/${viewport.label}: onboarding geometry missing`);
  if (state.bodyX > 2 || state.bodyY > 2) throw new Error(`${step}/${viewport.label}: global overflow ${JSON.stringify(state)}`);
  if (overlaps(state.card, state.guide)) throw new Error(`${step}/${viewport.label}: guide overlaps card`);
  if (state.exitButtons !== 1) throw new Error(`${step}/${viewport.label}: exit action missing`);
  if (state.card.left < 0 || state.card.top < 0 || state.card.right > viewport.width || state.card.bottom > viewport.height) {
    throw new Error(`${step}/${viewport.label}: card outside viewport ${JSON.stringify(state.card)}`);
  }
  if (state.aiDockVisible !== "hidden" && state.aiDockVisible !== "missing") {
    throw new Error(`${step}/${viewport.label}: AI dock should not cover onboarding`);
  }
  const screenshot = await page.screenshot({ fullPage: false });
  if (screenshot.length < 20_000) throw new Error(`${step}/${viewport.label}: screenshot appears blank`);
  if (pageErrors.length > 0) throw new Error(`${step}/${viewport.label}: page errors ${JSON.stringify(pageErrors)}`);
  if (step === "trade") {
    await page.getByRole("button", { name: "去交易一笔" }).click();
    await page.waitForSelector(".first-launch-onboarding", { state: "detached" });
    const completed = await page.evaluate(() => JSON.parse(localStorage.getItem("desicterminal.firstLaunchOnboarding.v1") || "null")?.status);
    if (completed !== "completed") throw new Error(`${step}/${viewport.label}: CTA did not complete onboarding: ${completed}`);
  }
  await page.close();
}

async function verifyExitAndResume(browser) {
  const page = await browser.newPage({ viewport: viewports[0] });
  await page.goto(`${baseUrl}?onboarding=account`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".first-launch-onboarding", { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".first-launch-onboarding", { state: "detached" });
  const resume = page.getByRole("button", { name: "继续首次配置指引" });
  if (await resume.count() !== 1) throw new Error("resume entry missing after onboarding exit");
  const dismissed = await page.evaluate(() => JSON.parse(localStorage.getItem("desicterminal.firstLaunchOnboarding.v1") || "null")?.status);
  if (dismissed !== "dismissed") throw new Error(`dismissed state was not persisted: ${dismissed}`);
  await resume.click();
  await page.waitForSelector(".first-launch-onboarding");
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem("desicterminal.firstLaunchOnboarding.v1") || "null")?.status);
  if (active !== "active") throw new Error(`resume state was not persisted: ${active}`);
  await page.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      for (const step of steps) await verifyStep(browser, step, viewport);
    }
    await verifyExitAndResume(browser);
  } finally {
    await browser.close();
  }
  process.stdout.write(`[smoke] first launch onboarding ok: steps=${steps.length}, viewports=${viewports.length}, final-cta=completed, exit-resume=ok\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
