import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { ChevronDown, Gauge, Sparkles, Zap } from "lucide-react";
import { FASTLANE_MODE_ENABLED } from "./fastlaneMode";
import "./fastlane.css";

/**
 * C29.5 / §9.1：新建 Profile 的两张卡片。
 *
 * 两张卡等宽并列、键盘可达（原生 button），各含 3 条原理与一个"查看原理"展开（不跳转）。
 * 钩子：`[data-profile-card="ai"]` / `[data-profile-card="fastlane"]`。
 *
 * **C29.19**：本版本不发布快判模式 → 快判卡片**不渲染**（`fastlaneEnabled=false`）。
 * 组件与卡片定义**原样保留**，下个版本把 `FASTLANE_MODE_ENABLED` 翻 `true` 即可恢复两张卡。
 */

type ProfileTypeCardsProps = {
  onPick: (type: "ai" | "fastlane") => void;
  disabled?: boolean;
  /**
   * 是否渲染快判卡片。**默认跟总开关**（`FASTLANE_MODE_ENABLED`）——
   * 调用方忘传时得到的是"撤下"（安全侧），而不是把未开放的能力露出去。
   */
  fastlaneEnabled?: boolean;
};

function CardBody({ points }: { points: [string, string][] }) {
  return (
    <ul className="fastlane-card__points">
      {points.map(([title, detail]) => (
        <li key={title}>
          <strong>{title}</strong>
          <span>{detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProfileTypeCards({
  onPick,
  disabled = false,
  fastlaneEnabled = FASTLANE_MODE_ENABLED
}: ProfileTypeCardsProps) {
  const { t } = useTranslation(["automation", "common"]);
  const [openDetail, setOpenDetail] = useState<"ai" | "fastlane" | null>(null);

  const cards: Array<{
    type: "ai" | "fastlane";
    icon: ReactNode;
    title: string;
    subtitle: string;
    fit: string;
    points: [string, string][];
    detail: ReactNode;
  }> = [
    {
      type: "ai",
      icon: <Sparkles size={18} />,
      title: t("profileCardAiTitle"),
      subtitle: t("profileCardAiSubtitle"),
      fit: t("profileCardAiFit"),
      points: [
        [t("profileCardAiPoint1Title"), t("profileCardAiPoint1Detail")],
        [t("profileCardAiPoint2Title"), t("profileCardAiPoint2Detail")],
        [t("profileCardAiPoint3Title"), t("profileCardAiPoint3Detail")]
      ],
      detail: <p>{t("profileCardAiDetail")}</p>
    },
    {
      type: "fastlane",
      icon: <Zap size={18} />,
      title: t("profileCardFastlaneTitle"),
      subtitle: t("profileCardFastlaneSubtitle"),
      fit: t("profileCardFastlaneFit"),
      points: [
        [t("profileCardFastlanePoint1Title"), t("profileCardFastlanePoint1Detail")],
        [t("profileCardFastlanePoint2Title"), t("profileCardFastlanePoint2Detail")],
        [t("profileCardFastlanePoint3Title"), t("profileCardFastlanePoint3Detail")]
      ],
      detail: <p>{t("profileCardFastlaneDetail")}</p>
    }
  ];

  // C29.19：开关关闭 → 只留原有 AI Profile 卡片（快判卡片定义仍在上面的数组里，未删）。
  const visibleCards = fastlaneEnabled
    ? cards
    : cards.filter((card) => card.type !== "fastlane");

  return (
    <div className="fastlane-picker" role="group" aria-label={t("profileNewPickerTitle")}>
      <header className="fastlane-picker__head">
        <h3><Gauge size={15} />{t("profileNewPickerTitle")}</h3>
        <p>{t("profileNewPickerHint")}</p>
      </header>
      <div className="fastlane-picker__grid">
        {visibleCards.map((card) => {
          const expanded = openDetail === card.type;
          return (
            <article className={clsx("fastlane-card", `is-${card.type}`)} key={card.type}>
              <div className="fastlane-card__art" aria-hidden="true">
                <span className="fastlane-card__glyph">{card.icon}</span>
                {card.type === "fastlane" ? (
                  <span className="fastlane-card__sparkline">
                    <i style={{ height: "26%" }} /><i style={{ height: "48%" }} /><i style={{ height: "36%" }} /><i style={{ height: "72%" }} /><i style={{ height: "58%" }} /><i style={{ height: "88%" }} />
                  </span>
                ) : (
                  <span className="fastlane-card__nodes">
                    <i /><i /><i /><i />
                  </span>
                )}
              </div>
              <div className="fastlane-card__body">
                <strong className="fastlane-card__title">{card.title}</strong>
                <span className="fastlane-card__subtitle">{card.subtitle}</span>
                <CardBody points={card.points} />
                <span className="fastlane-card__fit">{card.fit}</span>
              </div>
              <div className="fastlane-card__actions">
                <button
                  type="button"
                  className="fastlane-card__pick"
                  data-profile-card={card.type}
                  disabled={disabled}
                  onClick={() => onPick(card.type)}
                >
                  {card.type === "fastlane" ? <Zap size={13} /> : <Sparkles size={13} />}
                  {t("profileCardCreate", { name: card.title })}
                </button>
                <button
                  type="button"
                  className="fastlane-card__why"
                  aria-expanded={expanded}
                  onClick={() => setOpenDetail(expanded ? null : card.type)}
                >
                  <ChevronDown size={13} className={expanded ? "is-open" : undefined} />
                  {t("profileCardWhy")}
                </button>
              </div>
              {expanded ? <div className="fastlane-card__detail">{card.detail}</div> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default ProfileTypeCards;
