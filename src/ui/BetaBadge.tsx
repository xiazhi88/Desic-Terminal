import clsx from "clsx";
import { useTranslation } from "react-i18next";

/** 「测试版」小标签：标在尚未稳定的功能入口旁边（目前是交易员模式）。悬停显示说明。样式见 styles.css `.beta-badge`。 */
export function BetaBadge({ className }: { className?: string }) {
  const { t } = useTranslation("common");
  return (
    <span className={clsx("beta-badge", className)} title={t("betaHint")} data-beta-badge>
      {t("beta")}
    </span>
  );
}
