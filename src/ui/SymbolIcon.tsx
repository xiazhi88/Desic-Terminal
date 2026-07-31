import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { logger } from "../lib/logger";
import { isTauriRuntime } from "../lib/tauri";
import type { MarketAssetsSummary } from "../types";

type SymbolIconProps = {
  base: string;
  iconPath?: string | null;
  cached?: boolean;
  cacheDir?: string | null;
};

const iconDataUrls = new Map<string, string>();
const iconDataUrlRequests = new Map<string, Promise<string | null>>();
const iconDownloadFailures = new Map<string, number>();
const ICON_DOWNLOAD_RETRY_MS = 5 * 60_000;

function fallbackIconPath(base: string, cacheDir?: string | null) {
  if (!base) return "";
  const fileName = `${base.toLowerCase()}.png`;
  if (cacheDir) {
    const separator = cacheDir.includes("\\") ? "\\" : "/";
    return `${cacheDir.replace(/[\\/]$/, "")}${separator}icons${separator}${fileName}`;
  }
  return `/cache/market-assets/icons/${fileName}`;
}

function marketAssetSrc(path?: string | null) {
  if (!path) return "";
  if (!isTauriRuntime()) {
    const normalized = path.replace(/\\/g, "/");
    const marker = "/cache/market-assets/";
    const markerIndex = normalized.toLowerCase().indexOf(marker);
    return markerIndex >= 0 ? normalized.slice(markerIndex + 1) : normalized;
  }
  try {
    return convertFileSrc(path, "asset");
  } catch (error) {
    logger.error("market asset url conversion failed", error, { path });
    return "";
  }
}

function loadIconDataUrl(path: string, base: string) {
  const cached = iconDataUrls.get(path);
  if (cached) return Promise.resolve(cached);
  const pending = iconDataUrlRequests.get(path);
  if (pending) return pending;
  const normalizedBase = base.trim().toUpperCase();
  const canDownload = /^[A-Z0-9]{1,32}$/.test(normalizedBase);
  const request = (async () => {
    try {
      const local = await invoke<string>("market_icon_data_url", { path });
      if (local) {
        iconDataUrls.set(path, local);
        iconDownloadFailures.delete(normalizedBase);
        return local;
      }
    } catch (error) {
      logger.warn("market icon cache read failed", {
        error: error instanceof Error ? error.message : String(error),
        base: normalizedBase,
        path
      });
    }
    if (!canDownload) return null;
    const failedAt = iconDownloadFailures.get(normalizedBase) ?? 0;
    if (Date.now() - failedAt < ICON_DOWNLOAD_RETRY_MS) return null;
    try {
      const downloaded = await invoke<string>("ensure_market_icon_data_url", { base: normalizedBase });
      if (downloaded) {
        iconDataUrls.set(path, downloaded);
        iconDownloadFailures.delete(normalizedBase);
        return downloaded;
      }
    } catch (error) {
      iconDownloadFailures.set(normalizedBase, Date.now());
      logger.warn("market icon download failed", {
        error: error instanceof Error ? error.message : String(error),
        base: normalizedBase
      });
    }
    return null;
  })()
    .finally(() => iconDataUrlRequests.delete(path));
  iconDataUrlRequests.set(path, request);
  return request;
}

export function SymbolIcon({ base, iconPath, cached, cacheDir }: SymbolIconProps) {
  const [failed, setFailed] = useState(false);
  const [dataUrl, setDataUrl] = useState("");
  const resolvedIconPath = iconPath || fallbackIconPath(base, cacheDir);
  const src = dataUrl || marketAssetSrc(resolvedIconPath);
  const canUseImage = Boolean(src && !failed);

  useEffect(() => {
    setFailed(false);
    setDataUrl(iconDataUrls.get(resolvedIconPath) ?? "");
    if (!resolvedIconPath || !isTauriRuntime()) return;
    let cancelled = false;
    void loadIconDataUrl(resolvedIconPath, base)
      .then((value) => {
        if (!cancelled && value) {
          setDataUrl(value);
          setFailed(false);
        }
        if (!cancelled && !value && cached) {
          logger.warn("market icon cache missing", { base, iconPath: resolvedIconPath });
        }
      })
      .catch((error) => logger.warn("market icon data url failed", {
        error: error instanceof Error ? error.message : String(error),
        base,
        iconPath: resolvedIconPath,
        cached
      }));
    return () => {
      cancelled = true;
    };
  }, [base, cached, resolvedIconPath]);

  return (
    <span className="symbol-icon" aria-hidden="true">
      {canUseImage ? <img src={src} alt="" draggable={false} onError={() => setFailed(true)} /> : <b>{base.slice(0, 1).toUpperCase()}</b>}
    </span>
  );
}

export function symbolBase(symbol: string) {
  return symbol.trim().toUpperCase().split("-")[0] || "?";
}

export function SymbolLabel({
  symbol,
  marketAssets,
  secondary,
  className
}: {
  symbol: string;
  marketAssets?: MarketAssetsSummary | null;
  secondary?: string | null;
  className?: string;
}) {
  const asset = marketAssets?.instruments.find((item) => item.instId === symbol);
  const base = asset?.baseCcy || symbolBase(symbol);
  return (
    <span className={["symbol-label", className].filter(Boolean).join(" ")}>
      <SymbolIcon base={base} iconPath={asset?.iconPath} cached={asset?.iconCached} cacheDir={marketAssets?.cacheDir} />
      <span className="symbol-label-copy">
        <strong>{symbol || "--"}</strong>
        {secondary ? <small>{secondary}</small> : null}
      </span>
    </span>
  );
}
