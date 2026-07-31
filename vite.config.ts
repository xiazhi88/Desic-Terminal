import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
});
