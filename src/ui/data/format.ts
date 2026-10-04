import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type UiText = (zh: string, en: string) => string;

export function useUiText(): UiText {
  const { i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("zh");
  return (zh, en) => (chinese ? zh : en);
}

// ───────────── 格式化与小工具（数据页各视图共用） ─────────────

export const fmtNumber = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtSigned = (value: number | null | undefined, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

export const fmtPercent = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value.toFixed(digits)}%`);
export const fmtSignedPercent = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`);

/** 收益用 `--up`，亏损用 `--down`，与全应用的红涨绿跌（或用户反转后）保持一致。 */
export const tone = (value: number | null | undefined): "pos" | "neg" | "flat" => (value === null || value === undefined || !Number.isFinite(value) || value === 0 ? "flat" : value > 0 ? "pos" : "neg");

export function formatDuration(ms: number | null | undefined, uiText: UiText): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "--";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return uiText(`${minutes} 分钟`, `${minutes} min`);
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return uiText(`${hours} 小时 ${minutes % 60} 分`, `${hours} h ${minutes % 60} m`);
  return uiText(`${Math.round(hours / 24)} 天`, `${Math.round(hours / 24)} d`);
}

export function useElementWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  // 回调 ref：容器可能在 loading / 空数据时不渲染，晚挂载也能测到宽度。
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const update = () => setWidth(Math.round(element.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}
