import { useEffect, useRef, useState } from "react";
import type { MarketAssetsSummary, MarketRadarRankChange, Ticker } from "../types";
import { buildMarketRadarRows } from "./marketRadar";
import { buildRadarSnapshotInput, radarAlertMessage } from "./marketRadarSnapshot";
import { listenMarketRadarHistory, loadMarketRadarResearchScores, recordMarketRadarSnapshot } from "./okx";

type Notify = (notification: { kind: "success" | "info" | "warning" | "error"; title: string; message: string }) => void;

// 雷达快照在应用级记录：应用运行期间每个 UTC 小时写一份（同小时后写覆盖），
// 不再依赖雷达页是否打开，星图回放与 1h / 1d / 7d 排名变化因此少有空洞。
// 行情来自 App 已有的全市场 tickers 刷新（雷达页打开时 30 秒一次，否则 5 分钟一次），不额外请求。
export function useRadarSnapshotRecorder({
  enabled,
  marketAssets,
  tickers,
  fetchedAt,
  chinese,
  onNotify,
}: {
  enabled: boolean;
  marketAssets: MarketAssetsSummary | null;
  tickers: Ticker[];
  fetchedAt: number | null;
  chinese: boolean;
  onNotify: Notify;
}) {
  const [rankChanges, setRankChanges] = useState<MarketRadarRankChange[]>([]);
  const [scoresRevision, setScoresRevision] = useState(0);
  const recordedKeyRef = useRef("");
  const inputsRef = useRef({ marketAssets, tickers, chinese, onNotify });
  inputsRef.current = { marketAssets, tickers, chinese, onNotify };

  // 研究历史推进到小时线 / 完成时重新取研究分，同一小时的快照随之以新分数覆盖。
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void listenMarketRadarHistory((status) => {
      if (active && (status.phase === "hourly" || status.phase === "complete")) setScoresRevision((value) => value + 1);
    }).then((dispose) => {
      if (!active) dispose?.();
      else unlisten = dispose;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [enabled]);

  const bucket = fetchedAt ? Math.floor(fetchedAt / 3_600_000) : null;
  const universeSize = marketAssets?.instruments.length ?? 0;

  useEffect(() => {
    if (!enabled || bucket === null || !fetchedAt || universeSize === 0) return;
    let active = true;
    void loadMarketRadarResearchScores().then((scores) => {
      const { marketAssets: assets, tickers: currentTickers } = inputsRef.current;
      const rows = buildMarketRadarRows(assets?.instruments ?? [], currentTickers, scores);
      const key = `${bucket}:${scores.length}:${scoresRevision}`;
      if (!active || rows.length === 0 || recordedKeyRef.current === key) return null;
      recordedKeyRef.current = key;
      return recordMarketRadarSnapshot(buildRadarSnapshotInput(rows, scores, fetchedAt));
    }).then((result) => {
      if (!active || !result) return;
      setRankChanges(result.changes);
      const { chinese: zh, onNotify: notify } = inputsRef.current;
      for (const alert of result.alerts) {
        notify({ kind: alert.kind === "spreadAbove" ? "warning" : "info", title: alert.ruleName, message: radarAlertMessage(alert, zh) });
      }
    });
    return () => {
      active = false;
    };
    // 每个小时桶（或研究分更新）只触发一次；tickers 通过 ref 读取最新值，fetchedAt 取触发时刻的值。
  }, [bucket, enabled, scoresRevision, universeSize]);

  return rankChanges;
}
