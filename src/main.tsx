import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import "./startup-original.css";
import "./styles.css";
import { i18n, initializeI18n } from "./i18n/runtime";

const searchParams = new URLSearchParams(window.location.search);
const isMascotPreview =
  window.location.pathname === "/mascot" || searchParams.get("preview") === "mascot";
const isCoinPreview = window.location.pathname === "/coin-eth" || searchParams.get("preview") === "coin-eth";
const isStartupPreview =
  window.location.pathname === "/startup-preview" || searchParams.get("preview") === "startup";
const isChartPreview =
  window.location.pathname === "/chart-preview" || searchParams.get("preview") === "chart";
const isAiPreview =
  window.location.pathname === "/ai-preview" || searchParams.get("preview") === "ai";
const isAutomationPreview =
  window.location.pathname === "/automation-preview" || searchParams.get("preview") === "automation";
const isTerminalPreview =
  window.location.pathname === "/terminal-preview" || searchParams.get("preview") === "terminal";

const root = createRoot(document.getElementById("root")!);

const renderApp = (node: ReactNode) => {
  root.render(node);
};

const render = async () => {
  await initializeI18n();
  if (isAutomationPreview) {
    const { AutomationPreview } = await import("./ui/App");
    renderApp(<AutomationPreview />);
    return;
  }
  if (isTerminalPreview) {
    const { TerminalPreview } = await import("./ui/App");
    renderApp(<TerminalPreview />);
    return;
  }
  if (isAiPreview) {
    const { AiPreview } = await import("./ui/App");
    renderApp(<AiPreview />);
    return;
  }
  if (isStartupPreview) {
    const { StartupPreview } = await import("./ui/App");
    renderApp(<StartupPreview />);
    return;
  }
  if (isChartPreview) {
    const { ChartPreview } = await import("./ui/ChartPreview");
    renderApp(<ChartPreview />);
    return;
  }
  if (isCoinPreview) {
    const { CoinPreview } = await import("./ui/CoinPreview");
    renderApp(<CoinPreview />);
    return;
  }
  if (isMascotPreview) {
    const { MascotPreview } = await import("./ui/MascotPreview");
    renderApp(<MascotPreview />);
    return;
  }
  const { App } = await import("./ui/App");
  renderApp(<App />);
};

void render().catch((error) => {
  console.error("application bootstrap failed", error);
  const message = error instanceof Error ? error.message : String(error);
  renderApp(
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#050506",
        color: "#f3f4f6",
        fontFamily: "system-ui, sans-serif"
      }}
    >
      <section style={{ maxWidth: 720 }}>
        <h1 style={{ margin: "0 0 12px", fontSize: 18 }}>{i18n.t("errors:bootstrap")}</h1>
        <p style={{ margin: 0, color: "#a8b0bd", lineHeight: 1.6 }}>{message}</p>
      </section>
    </main>
  );
});
