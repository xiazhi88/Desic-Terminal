import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    // `lightweight-charts` ships a development build that keeps its assertion
    // names and readable frames. Its production build strips them, so an
    // internal throw (for example "Value is null") arrives with an unusable
    // stack. Use the development build while serving so chart faults can be
    // traced; release builds stay on the production bundle.
    conditions: command === "serve" ? ["development", "module", "browser"] : undefined
  },
  optimizeDeps: {
    entries: ["index.html"],
    include: [
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
      "clsx",
      "lightweight-charts",
      "lucide-react",
      "react",
      "react-dom/client",
      "zustand"
    ]
  },
  server: {
    port: 1420,
    strictPort: false
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: "esbuild"
  }
}));
