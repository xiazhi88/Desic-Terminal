import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import {
  loadSystematicOverview,
  type SystematicOverview,
} from "../lib/systematic";
import { SystematicFactorPanel } from "./SystematicFactorPanel";

export type MarketRadarExpertLayerProps = Readonly<{
  chinese: boolean;
  desktop: boolean;
  watchlist: string[];
  onNotify: (notification: {
    kind: "success" | "info" | "warning" | "error";
    title: string;
    message: string;
  }) => void;
  onUseForBacktest: (instId: string) => void;
  onAddToWatchlist: (instId: string) => void;
}>;

export default function MarketRadarExpertLayer({
  chinese,
  desktop,
  watchlist,
  onNotify,
  onUseForBacktest,
  onAddToWatchlist,
}: MarketRadarExpertLayerProps) {
  const [overview, setOverview] = useState<SystematicOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      const next = await loadSystematicOverview();
      setOverview(next);
      setError(next ? null : (chinese ? "高级模型数据不可用" : "Advanced model data is unavailable"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [chinese, desktop]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!desktop) {
    return <div className="market-radar-expert__state"><CircleAlert size={15} /><span>{chinese ? "高级模型仅在桌面运行时可用" : "Advanced models require the desktop runtime"}</span></div>;
  }
  if (loading) {
    return <div className="market-radar-expert__state"><Loader2 className="spin" size={16} /><span>{chinese ? "正在加载高级模型" : "Loading advanced models"}</span></div>;
  }
  if (error && !overview) {
    return <div className="market-radar-expert__state"><CircleAlert size={15} /><span>{error}</span><button type="button" onClick={() => void refresh()}>{chinese ? "重试" : "Retry"}</button></div>;
  }

  return (
    <div className="market-radar-expert">
      <SystematicFactorPanel
        factors={overview?.factorDefinitions ?? []}
        chinese={chinese}
        desktop={desktop}
        watchlist={watchlist}
        refresh={refresh}
        onNotify={onNotify}
        onUseForBacktest={onUseForBacktest}
        onAddToWatchlist={onAddToWatchlist}
      />
    </div>
  );
}
