import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  deleteTraderCorrection,
  loadTraderHandbookRevisions,
  saveTraderCorrection,
  TRADER_CORRECTION_CATEGORIES,
  type TraderCorrection,
  type TraderCorrectionCategory,
  type TraderDecisionRow,
  type TraderHandbookSetup,
  type TraderHandbookSnapshot
} from "../../lib/ai";
import { commandErrorText } from "./traderApi";
import "./trader-workspace.css";

export type CorrectionApi = {
  save: (decisionId: string, category: TraderCorrectionCategory, text: string) => Promise<{ suggestionId: string | null } | null>;
  remove: (decisionId: string) => Promise<void>;
};

function formatContextPrice(value: number | null) {
  return value === null ? "--" : String(Number(value.toFixed(4)));
}

function regimeText(value: string | null, chinese: boolean) {
  if (value === "up") return chinese ? "上升" : "up";
  if (value === "down") return chinese ? "下降" : "down";
  if (value === "mixed") return chinese ? "不明" : "mixed";
  return chinese ? "不可用" : "unavailable";
}

/** 结果一栏：影子结算的 R 与离场方式，真实成交时附上真实 R。未结算时说明为什么没有结果。 */
function resultText(row: TraderDecisionRow, chinese: boolean) {
  const real = row.realR === null ? "" : `${chinese ? " · 真实 " : " · real "}${row.realR.toFixed(1)}R`;
  if (row.shadowStatus === "resolved") {
    const exit = row.exitKind === "target"
      ? (chinese ? "到目标" : "target")
      : row.exitKind === "stop"
        ? (chinese ? "止损" : "stop")
        : row.exitKind
          ? (chinese ? "超时" : "timeout")
          : "";
    const shadow = row.shadowR === null ? "--" : `${row.shadowR.toFixed(1)}R`;
    return `${chinese ? "影子 " : "shadow "}${shadow}${exit ? `（${exit}）` : ""}${real}`;
  }
  const pending: Record<string, [string, string]> = {
    pending: ["还在结算中", "still settling"],
    unfilled: ["没有成交", "never filled"],
    skipped: ["不结算（管理持仓或不做）", "not settled (manage or no-trade)"],
    duplicate: ["同一计划，不重复结算", "same plan, not counted twice"]
  };
  const label = pending[row.shadowStatus] ?? ["无效", "invalid"];
  return `${chinese ? label[0] : label[1]}${real}`;
}

/** 形态的原文规则（从运行当时的手册里找）：没有就不显示这一段。 */
function SetupRules({ setup, chinese }: { setup: TraderHandbookSetup; chinese: boolean }) {
  const rows: Array<[string, string]> = [
    [chinese ? "入场" : "Entry", setup.entry],
    [chinese ? "止损" : "Stop", setup.stop],
    [chinese ? "目标" : "Target", setup.target],
    [chinese ? "失效" : "Invalidation", setup.invalidation]
  ].filter((row): row is [string, string] => Boolean(row[1]?.trim()));
  if (rows.length === 0) return null;
  return (
    <dl className="trc-rules" data-correction-rules>
      {rows.map(([label, text]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd data-i18n-skip>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

export const DESKTOP_CORRECTION_API: CorrectionApi = { save: saveTraderCorrection, remove: deleteTraderCorrection };

const POPOVER_WIDTH = 420;

/**
 * 决策行上的「纠正」：类别 + 一句话。已纠正的行显示你的意见（点开可以改或删）。
 * 纠正会写进之后几轮的简报；同一形态 30 天内攒够 3 条会生成一条手册修改建议。
 */
export function CorrectionButton({
  row,
  api = DESKTOP_CORRECTION_API,
  handbook,
  onChanged
}: {
  row: TraderDecisionRow;
  api?: CorrectionApi;
  /**
   * 当前显示的手册（成绩单或运行详情读到的那本）：用来显示形态的名字和原文规则。
   * 决策用的是别的版本时，打开弹窗再去修订历史里取那一版；拿不到时只少这一段，不影响纠正。
   */
  handbook?: TraderHandbookSnapshot | null;
  onChanged: (correction: TraderCorrection | null, suggestionId: string | null) => void;
}) {
  const { t, i18n } = useTranslation(["automation", "common"]);
  const chinese = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase().startsWith("zh");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [category, setCategory] = useState<TraderCorrectionCategory>((row.correction?.category as TraderCorrectionCategory) ?? "wrong_direction");
  const [text, setText] = useState(row.correction?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (value: string) => t(`automation:correctionCategory_${value}`, { defaultValue: value });
  // 决策当时那一版手册里的形态。null = 还没取到 / 取不到；stale = 只能退回当前规则（手册之后改过）。
  const [decisionSetup, setDecisionSetup] = useState<{ setup: TraderHandbookSetup; stale: boolean } | null>(null);
  const setup = decisionSetup?.setup ?? null;

  useEffect(() => {
    if (!open || !row.setupId) {
      if (!open) setDecisionSetup(null);
      return;
    }
    const setupId = row.setupId;
    const current = handbook && handbook.id === row.handbookId ? handbook.content.setups.find((item) => item.id === setupId) ?? null : null;
    const sameVersion = row.handbookVersion === null || (handbook !== null && handbook !== undefined && handbook.id === row.handbookId && handbook.version === row.handbookVersion);
    if (sameVersion) {
      setDecisionSetup(current ? { setup: current, stale: false } : null);
      return;
    }
    // 先给当前规则（标「已改过」），修订历史取到那一版后再换成当时的原文。
    setDecisionSetup(current ? { setup: current, stale: true } : null);
    let cancelled = false;
    loadTraderHandbookRevisions(row.handbookId)
      .then((revisions) => {
        const then = revisions?.find((item) => item.version === row.handbookVersion)?.content?.setups.find((item) => item.id === setupId);
        if (!cancelled && then) setDecisionSetup({ setup: then, stale: false });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, row.setupId, row.handbookId, row.handbookVersion, handbook]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8));
    const below = rect.bottom + 6;
    const height = popoverRef.current?.offsetHeight ?? 240;
    const preferred = below + height > window.innerHeight - 8 ? rect.top - height - 6 : below;
    // 上下都放不下时贴着视口（弹窗自身有 max-height + 滚动），不能让底部按钮落到屏幕外。
    setPosition({ left, top: Math.max(8, Math.min(preferred, window.innerHeight - height - 8)) });
    // 形态规则是打开后才填进来的（可能还要去修订历史里取），内容变了高度就变，要重新定位。
  }, [open, decisionSetup]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openPopover = () => {
    setCategory((row.correction?.category as TraderCorrectionCategory) ?? "wrong_direction");
    setText(row.correction?.text ?? "");
    setError(null);
    setPosition(null);
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.save(row.id, category, text.trim());
      onChanged({ category, text: text.trim(), updatedAt: Date.now() }, result?.suggestionId ?? null);
      setOpen(false);
    } catch (reason) {
      setError(commandErrorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.remove(row.id);
      onChanged(null, null);
      setOpen(false);
    } catch (reason) {
      setError(commandErrorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {row.correction ? (
        // 意见原文是用户写的内容：悬停提示放在跳过翻译的外层上。
        <span className="trc-wrap" title={row.correction.text || undefined} data-i18n-skip>
          <button
            type="button"
            ref={triggerRef}
            className="trc-tag"
            onClick={() => (open ? setOpen(false) : openPopover())}
            data-correction-open={row.id}
            data-corrected
          >
            {label(row.correction.category)}
          </button>
        </span>
      ) : (
        <button type="button" ref={triggerRef} className="trc-add" onClick={() => (open ? setOpen(false) : openPopover())} data-correction-open={row.id}>
          {t("automation:correctionAdd")}
        </button>
      )}
      {open ? createPortal(
        <div
          ref={popoverRef}
          className="trc-popover"
          role="dialog"
          aria-label={t("automation:correctionTitle")}
          style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, width: POPOVER_WIDTH }}
          data-correction-popover
        >
          <strong>{t("automation:correctionTitle")}</strong>
          <span className="trc-popover__decision" data-i18n-skip>
            {[
              row.instId.replace("-USDT-SWAP", ""),
              setup?.name || row.setupId || (chinese ? "没写形态" : "no setup"),
              row.side === "long" ? t("automation:sideLong") : row.side === "short" ? t("automation:sideShort") : null
            ].filter(Boolean).join(" · ")}
          </span>

          {/* 光看价格和 R 写不出纠正：把 AI 当时的理由、形态原文规则和当时的行情摆在表单上方。 */}
          <div className="trc-context" data-correction-context>
            {row.reason ? (
              <section>
                <h5>{t("automation:correctionWhyAi")}</h5>
                <p className="trc-context__reason" data-i18n-skip>{row.reason}</p>
              </section>
            ) : null}
            {setup ? (
              <section>
                <h5>
                  {t("automation:correctionSetupRules")}
                  {row.setupStatus === "observing" ? <em>{t("automation:setupStatusObserving")}</em> : null}
                  {decisionSetup?.stale ? <em className="is-stale" title={t("automation:correctionRulesStaleHint")}>{t("automation:correctionRulesStale")}</em> : null}
                </h5>
                <SetupRules setup={setup} chinese={chinese} />
              </section>
            ) : null}
            <section>
              <h5>{t("automation:correctionFacts")}</h5>
              <ul className="trc-context__facts">
                <li>
                  <span>{t("automation:correctionFactPlan")}</span>
                  <b data-i18n-skip>{[row.entry, row.stop, row.target].map(formatContextPrice).join(" / ")}</b>
                </li>
                <li>
                  <span>{t("automation:correctionFactRegime")}</span>
                  <b>
                    {regimeText(row.regimeDaily, chinese)}
                    {row.regime4h ? ` · 4h ${regimeText(row.regime4h, chinese)}` : ""}
                    {row.againstDirection ? ` · ${t("automation:correctionFactAgainst")}` : ""}
                  </b>
                </li>
                <li>
                  <span>{t("automation:correctionFactResult")}</span>
                  <b data-i18n-skip>{resultText(row, chinese)}</b>
                </li>
              </ul>
            </section>
          </div>
          <div className="trc-chips" role="radiogroup" aria-label={t("automation:correctionCategory")}>
            {TRADER_CORRECTION_CATEGORIES.map((value) => (
              <button type="button" role="radio" key={value} aria-checked={category === value} className={clsx(category === value && "is-active")} onClick={() => setCategory(value)} data-correction-category={value}>
                {label(value)}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            value={text}
            maxLength={300}
            placeholder={t("automation:correctionPlaceholder")}
            onChange={(event) => setText(event.target.value)}
            data-correction-text
            data-i18n-skip
          />
          <small className="trc-popover__hint">{t("automation:correctionHint")}</small>
          {error ? <small className="trc-popover__error" role="alert" data-i18n-skip>{error}</small> : null}
          <div className="trc-popover__actions">
            {row.correction ? <button type="button" className="pfe-btn is-small is-ghost is-danger" disabled={busy} onClick={() => void remove()} data-correction-delete>{t("common:delete")}</button> : null}
            <span className="pfe-spacer" />
            <button type="button" className="pfe-btn is-small" disabled={busy} onClick={() => setOpen(false)}>{t("common:cancel")}</button>
            <button type="button" className="pfe-btn is-small is-primary" disabled={busy} onClick={() => void save()} data-correction-save>
              {busy ? <Loader2 className="spin" size={12} /> : null}{t("common:save")}
            </button>
          </div>
        </div>,
        document.body
      ) : null}
    </>
  );
}
