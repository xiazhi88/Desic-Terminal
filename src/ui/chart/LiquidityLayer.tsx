import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { TradingChartHandle } from "../chartAdapter";
import { LiquidityHeatmapPrimitive } from "./LiquidityHeatmapPrimitive";
import "./liquidity.css";

type UiText = (english: string, chinese: string) => string;

export type LiquidityLayerState = {
  enabled: boolean;
  supported: boolean;
  gain: number;
  setGain: (gain: number) => void;
};

/** 流动性模式开启时在主 K 线序列上挂载热力图图元；图表实例重建时随之重新挂载。 */
export function useLiquidityLayer(
  chartRef: MutableRefObject<TradingChartHandle | null>,
  chartVersion: number,
  enabled: boolean,
  symbol: string,
  text: UiText
): LiquidityLayerState {
  const primitiveRef = useRef<LiquidityHeatmapPrimitive | null>(null);
  const [supported, setSupported] = useState(true);
  const [gain, setGainState] = useState(() => {
    const stored = Number(window.localStorage.getItem("desic.chart.liquidity-gain.v1"));
    return Number.isFinite(stored) && stored >= 0.5 && stored <= 3 ? stored : 1.25;
  });
  const gainRef = useRef(gain);
  gainRef.current = gain;

  useEffect(() => {
    const chart = chartRef.current;
    if (!enabled || !chart) return;
    const primitive = new LiquidityHeatmapPrimitive(symbol, {
      resting: text("Resting", "挂单"),
      traded: text("Traded in view", "视野内成交"),
      pulled: text("Pulled", "撤单"),
      eaten: text("Filled", "成交消耗"),
      contracts: text("ct", "张")
    });
    chart.attachCandlePrimitive(primitive);
    primitive.setGain(gainRef.current);
    primitiveRef.current = primitive;
    setSupported(primitive.heatmapSupported);
    return () => {
      chart.detachCandlePrimitive(primitive);
      primitiveRef.current = null;
    };
  }, [chartRef, chartVersion, enabled, symbol, text]);

  const setGain = (next: number) => {
    setGainState(next);
    window.localStorage.setItem("desic.chart.liquidity-gain.v1", String(next));
    primitiveRef.current?.setGain(next);
  };

  return { enabled, supported, gain, setGain };
}

export function LiquidityLegend({ layer, text }: { layer: LiquidityLayerState; text: UiText }) {
  if (!layer.enabled) return null;
  return (
    <div className="chart-liquidity-legend" role="group" aria-label={text("Liquidity heatmap legend", "流动性热力图图例")}>
      {layer.supported ? (
        <>
          <span className="chart-liquidity-legend__ramp" aria-hidden="true" />
          <span>{text("Resting size · log", "挂单量 · 对数")}</span>
          <label className="chart-liquidity-legend__gain">
            <span>{text("Contrast", "对比")}</span>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.05}
              value={layer.gain}
              onChange={(event) => layer.setGain(Number(event.target.value))}
              aria-label={text("Heatmap contrast", "热力图对比度")}
            />
          </label>
        </>
      ) : (
        <span className="chart-liquidity-legend__notice">{text("WebGL2 unavailable: heatmap hidden, trades and events still shown", "当前设备不支持所需的 WebGL2 纹理，热力层不显示，成交与事件仍显示")}</span>
      )}
      <span className="chart-liquidity-legend__item"><i className="is-buy" />{text("Aggressive buy", "主动买")}</span>
      <span className="chart-liquidity-legend__item"><i className="is-sell" />{text("Aggressive sell", "主动卖")}</span>
      <span className="chart-liquidity-legend__item"><b aria-hidden="true">×</b>{text("Wall filled", "成交消耗")}</span>
      <span className="chart-liquidity-legend__item"><i className="is-pulled" />{text("Wall pulled", "撤单")}</span>
    </div>
  );
}
