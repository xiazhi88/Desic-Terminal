import { useEffect, useRef } from "react";
import { getMarketHotState } from "../../lib/marketHotStore";
import { prefersReducedMotion } from "../../lib/springMotion";

// 顶栏上沿 1px 心跳线：宽度方向是最近 3 分钟，每秒一格。
// 亮度 = 当秒相对前一秒的价格变化幅度（只表达“活着、在动”）；颜色 = 行情新鲜度：
// 最新行情 5 秒内为实时色，5–20 秒转警示色，超过 20 秒或没有行情时拉平为暗线。
const SAMPLES = 180;
const STALE_MS = 5_000;
const DOWN_MS = 20_000;

type Health = "live" | "stale" | "down";

export function MarketHeartbeat({ symbol, label }: { symbol: string; label: (health: Health, ageMs: number | null) => string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const moves = new Float32Array(SAMPLES);
    const healths: Health[] = Array.from({ length: SAMPLES }, () => "down");
    let head = 0;
    let lastPrice: number | null = null;

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      let maxMove = 0;
      for (const move of moves) maxMove = Math.max(maxMove, move);
      const cell = width / SAMPLES;
      const styles = getComputedStyle(canvas);
      const colors: Record<Health, string> = {
        live: styles.getPropertyValue("--heartbeat-live").trim() || "#5fd4e0",
        stale: styles.getPropertyValue("--heartbeat-stale").trim() || "#f3b23c",
        down: styles.getPropertyValue("--heartbeat-down").trim() || "rgba(200, 200, 230, 0.12)"
      };
      for (let offset = 0; offset < SAMPLES; offset += 1) {
        const index = (head + offset) % SAMPLES;
        const health = healths[index]!;
        const intensity = health === "down" ? 1 : 0.18 + 0.82 * (maxMove > 0 ? Math.sqrt(moves[index]! / maxMove) : 0);
        context.globalAlpha = intensity * (0.35 + 0.65 * (offset / SAMPLES));
        context.fillStyle = colors[health];
        context.fillRect(offset * cell, 0, cell + 0.5, height);
      }
      context.globalAlpha = 1;
    };

    const sample = () => {
      const { ticker } = getMarketHotState();
      const now = Date.now();
      const price = ticker?.instId === symbol ? Number(ticker.last) : Number.NaN;
      const age = ticker?.instId === symbol && ticker.ts ? now - ticker.ts : null;
      const health: Health = age === null || !Number.isFinite(price) || age > DOWN_MS ? "down" : age > STALE_MS ? "stale" : "live";
      moves[head] = health === "live" && lastPrice !== null && Number.isFinite(price) ? Math.abs(price - lastPrice) / lastPrice : 0;
      healths[head] = health;
      head = (head + 1) % SAMPLES;
      if (Number.isFinite(price)) lastPrice = price;
      canvas.dataset.health = health;
      canvas.title = label(health, age);
      if (!document.hidden) draw();
    };

    sample();
    const timer = window.setInterval(sample, prefersReducedMotion() ? 5_000 : 1_000);
    window.addEventListener("resize", draw);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", draw);
    };
  }, [label, symbol]);

  return <canvas ref={canvasRef} className="market-heartbeat" aria-hidden="true" />;
}
