import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, X } from "lucide-react";
import { TerminalSelect } from "../TerminalSelect";
import { formatLocalizedDate } from "../../i18n/runtime";
import type { TraderEntryOrder, TraderInstructionKind, TraderInstructionRow } from "../../lib/ai";
import { EditorSegmented, HelpTip } from "./ProfileEditorControls";
import { commandErrorText, type TraderInstructionApi } from "./traderApi";
import "./profile-editor.css";

const HOUR_MS = 3_600_000;
const MAX_DURATION_MS = 30 * 24 * HOUR_MS;
const KINDS: TraderInstructionKind[] = ["no_entry", "long_only", "short_only", "note"];
type ExpiryPreset = "1h" | "4h" | "today" | "week" | "custom";

export type InstructionProfile = { id: string; name: string; symbols?: string[] };

/** 预设的到期时间：今天结束 = 本地 23:59；本周结束 = 本周日 23:59。离现在不到 1 小时的往后顺延一天 / 一周。 */
function presetExpiry(preset: Exclude<ExpiryPreset, "custom">, now: number) {
  if (preset === "1h") return now + HOUR_MS;
  if (preset === "4h") return now + 4 * HOUR_MS;
  const end = new Date(now);
  end.setHours(23, 59, 0, 0);
  if (preset === "week") end.setDate(end.getDate() + ((7 - end.getDay()) % 7));
  if (end.getTime() - now < HOUR_MS) end.setDate(end.getDate() + (preset === "week" ? 7 : 1));
  return end.getTime();
}

function toLocalInput(ms: number) {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 临时指令：用户对一段时间、一个范围下的命令。不开新仓 / 只做多 / 只做空由代码强制，说明只给 AI 参考。
 * 新建代码强制的指令时，范围内已挂的 AI 开仓单列出来（默认勾选一起撤），还没执行的 AI 开仓机会直接作废。
 */
export function InstructionsPanel({
  api,
  profiles,
  defaultProfileId,
  focusNonce,
  onChanged
}: {
  api: TraderInstructionApi;
  profiles: InstructionProfile[];
  defaultProfileId?: string | null;
  focusNonce?: number;
  onChanged?: () => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const [items, setItems] = useState<TraderInstructionRow[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [profileId, setProfileId] = useState<string>(defaultProfileId ?? "");
  const [instId, setInstId] = useState<string>("");
  const [kind, setKind] = useState<TraderInstructionKind>("no_entry");
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<ExpiryPreset>("4h");
  const [customExpiry, setCustomExpiry] = useState(() => toLocalInput(Date.now() + 24 * HOUR_MS));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [orders, setOrders] = useState<{ list: TraderEntryOrder[]; selected: Set<string> } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoadError(null);
      setItems((await api.list(true)) ?? []);
    } catch (reason) {
      setLoadError(commandErrorText(reason));
      setItems([]);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 从某个 Profile 跳进来：新指令默认作用于这个 Profile。
  useEffect(() => {
    if (defaultProfileId) {
      setProfileId(defaultProfileId);
      setFormOpen(true);
    }
  }, [defaultProfileId, focusNonce]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const symbols = useMemo(() => {
    const scoped = profileId ? profiles.filter((profile) => profile.id === profileId) : profiles;
    return [...new Set(scoped.flatMap((profile) => profile.symbols ?? []))].sort();
  }, [profileId, profiles]);
  useEffect(() => {
    if (instId && !symbols.includes(instId)) setInstId("");
  }, [instId, symbols]);

  const kindLabel = useCallback((value: string) => t(`automation:instructionKind_${value}`, { defaultValue: value }), [t]);
  const scopeLabel = useCallback((item: Pick<TraderInstructionRow, "profileId" | "profileName" | "instId">) => [
    item.profileId ? (item.profileName ?? item.profileId) : t("automation:instructionAllProfiles"),
    item.instId ?? t("automation:instructionAllSymbols")
  ].join(" · "), [t]);
  const formatTime = (ms: number) => formatLocalizedDate(ms, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const remaining = (ms: number) => {
    const minutes = Math.max(0, Math.round((ms - Date.now()) / 60_000));
    if (minutes < 60) return t("automation:instructionRemainingMinutes", { count: minutes });
    const hours = Math.round(minutes / 60);
    return hours < 48 ? t("automation:instructionRemainingHours", { count: hours }) : t("automation:instructionRemainingDays", { count: Math.round(hours / 24) });
  };

  const expiresAt = () => (preset === "custom" ? new Date(customExpiry).getTime() : presetExpiry(preset, Date.now()));
  const enforced = kind !== "note";

  const create = async (cancelOrdIds: string[]) => {
    setBusy(true);
    setFormError(null);
    try {
      const result = await api.create({ profileId: profileId || null, instId: instId || null, kind, text: text.trim(), expiresAt: expiresAt(), cancelOrdIds });
      setOrders(null);
      setFormOpen(false);
      setText("");
      await reload();
      if (result) {
        const failed = result.cancelledOrders.filter((order) => !order.ok).length;
        setNotice([
          t("automation:instructionCreated"),
          result.voidedOpportunities > 0 ? t("automation:instructionVoided", { count: result.voidedOpportunities }) : null,
          result.cancelledOrders.length > 0 ? t("automation:instructionOrdersCancelled", { count: result.cancelledOrders.length - failed }) : null,
          failed > 0 ? t("automation:instructionOrdersFailed", { count: failed }) : null
        ].filter(Boolean).join(" "));
      }
      onChanged?.();
    } catch (reason) {
      setFormError(commandErrorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const expiry = expiresAt();
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      setFormError(t("automation:instructionExpiryPast"));
      return;
    }
    if (expiry - Date.now() > MAX_DURATION_MS) {
      setFormError(t("automation:instructionExpiryTooLong"));
      return;
    }
    if (kind === "note" && !text.trim()) {
      setFormError(t("automation:instructionNoteRequired"));
      return;
    }
    if (!enforced) {
      void create([]);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const found = (await api.scopeOrders(profileId || null, instId || null, kind)) ?? [];
      setBusy(false);
      if (found.length === 0) {
        void create([]);
        return;
      }
      setOrders({ list: found, selected: new Set(found.map((order) => order.ordId)) });
    } catch (reason) {
      setBusy(false);
      setFormError(commandErrorText(reason));
    }
  };

  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      await api.cancel(id);
      await reload();
      onChanged?.();
    } catch (reason) {
      setLoadError(commandErrorText(reason));
    } finally {
      setCancelling(null);
    }
  };

  const active = (items ?? []).filter((item) => item.status === "active");
  const history = (items ?? []).filter((item) => item.status !== "active");
  const row = (item: TraderInstructionRow) => {
    const isEnforced = item.kind !== "note";
    return (
      <div className={clsx("tri-row", item.status !== "active" && "is-ended")} key={item.id} data-instruction-row={item.kind}>
        <span className={clsx("tri-tag", isEnforced ? "is-enforced" : "is-note")}>{isEnforced ? t("automation:instructionEnforced") : t("automation:instructionGuidance")}</span>
        <span className="tri-row__main">
          <b>{kindLabel(item.kind)}</b>
          <span data-i18n-skip>{scopeLabel(item)}</span>
          {item.text ? <em data-i18n-skip>{item.text}</em> : null}
        </span>
        <span className="tri-row__time">
          {item.status === "active"
            ? t("automation:instructionUntil", { time: formatTime(item.expiresAt), remaining: remaining(item.expiresAt) })
            : item.status === "cancelled"
              ? t("automation:instructionCancelledAt", { time: formatTime(item.cancelledAt ?? item.expiresAt) })
              : t("automation:instructionExpiredAt", { time: formatTime(item.expiresAt) })}
        </span>
        {item.status === "active" ? (
          <button type="button" className="pfe-btn is-small is-ghost" disabled={cancelling === item.id} onClick={() => void cancel(item.id)} data-instruction-cancel>
            {cancelling === item.id ? <Loader2 className="spin" size={12} /> : <X size={12} />}{t("automation:instructionCancel")}
          </button>
        ) : <span />}
      </div>
    );
  };

  return (
    <section className="tri" data-trader-instructions>
      <div className="tri-head">
        <span className="tri-head__title">
          {t("automation:instructionTitle")}
          <HelpTip text={t("automation:instructionHelp")} />
        </span>
        <span className="pfe-spacer" />
        {!formOpen ? (
          <button type="button" className="pfe-btn is-small" onClick={() => { setFormOpen(true); setFormError(null); }} data-instruction-new>
            <Plus size={13} />{t("automation:instructionNew")}
          </button>
        ) : null}
      </div>
      {notice ? <p className="tri-notice" role="status">{notice}</p> : null}

      {formOpen ? (
        <div className="tri-form" data-instruction-form>
          <div className="pfe-row">
            <span className="pfe-row__label">{t("automation:instructionScope")}</span>
            <div className="pfe-row__control">
              <div className="tri-select">
                <TerminalSelect
                  ariaLabel={t("automation:instructionScope")}
                  value={profileId}
                  options={[{ value: "", label: t("automation:instructionAllProfiles") }, ...profiles.map((profile) => ({ value: profile.id, label: profile.name }))]}
                  onChange={setProfileId}
                />
              </div>
              <div className="tri-select is-narrow">
                <TerminalSelect
                  ariaLabel={t("automation:instructionSymbol")}
                  value={instId}
                  options={[{ value: "", label: t("automation:instructionAllSymbols") }, ...symbols.map((symbol) => ({ value: symbol, label: symbol }))]}
                  onChange={setInstId}
                />
              </div>
            </div>
          </div>
          <div className="pfe-row">
            <span className="pfe-row__label">{t("automation:instructionKind")} <HelpTip text={t("automation:instructionKindHelp")} /></span>
            <div className="pfe-row__control">
              <EditorSegmented
                value={kind}
                ariaLabel={t("automation:instructionKind")}
                options={KINDS.map((value) => ({ value, label: kindLabel(value) }))}
                onChange={setKind}
              />
            </div>
          </div>
          <div className="pfe-row">
            <span className="pfe-row__label">{t("automation:instructionText")}</span>
            <div className="pfe-row__control tri-text">
              <input
                type="text"
                value={text}
                maxLength={200}
                placeholder={kind === "note" ? t("automation:instructionNotePlaceholder") : t("automation:instructionTextPlaceholder")}
                onChange={(event) => setText(event.target.value)}
                data-instruction-text
                data-i18n-skip
              />
            </div>
          </div>
          <div className="pfe-row">
            <span className="pfe-row__label">{t("automation:instructionExpiry")}</span>
            <div className="pfe-row__control">
              <EditorSegmented
                value={preset}
                ariaLabel={t("automation:instructionExpiry")}
                options={(["1h", "4h", "today", "week", "custom"] as const).map((value) => ({ value, label: t(`automation:instructionExpiry_${value}`) }))}
                onChange={setPreset}
              />
              {preset === "custom" ? (
                <input
                  type="datetime-local"
                  className="tri-datetime"
                  value={customExpiry}
                  min={toLocalInput(Date.now())}
                  max={toLocalInput(Date.now() + MAX_DURATION_MS)}
                  onChange={(event) => setCustomExpiry(event.target.value)}
                  aria-label={t("automation:instructionExpiry")}
                />
              ) : (
                <span className="pfe-row__muted">{formatTime(expiresAt())}</span>
              )}
            </div>
          </div>
          <div className="tri-form__foot">
            {formError ? <span className="tri-error" role="alert" data-i18n-skip>{formError}</span> : <span className="tri-hint">{enforced ? t("automation:instructionEnforcedHint") : t("automation:instructionNoteHint")}</span>}
            <span className="pfe-spacer" />
            <button type="button" className="pfe-btn" disabled={busy} onClick={() => { setFormOpen(false); setFormError(null); }}>{t("common:cancel")}</button>
            <button type="button" className="pfe-btn is-primary" disabled={busy} onClick={() => void submit()} data-instruction-submit>
              {busy ? <Loader2 className="spin" size={13} /> : null}{t("automation:instructionCreate")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="tri-list" data-instruction-active>
        {items === null ? (
          <p className="tri-empty"><Loader2 className="spin" size={13} />{t("common:loading")}</p>
        ) : loadError ? (
          <p className="tri-error" role="alert" data-i18n-skip>{loadError}</p>
        ) : active.length === 0 ? (
          <p className="tri-empty">{t("automation:instructionEmpty")}</p>
        ) : active.map(row)}
      </div>
      {history.length > 0 ? (
        <div className="tri-history">
          <button type="button" className="pfe-link" onClick={() => setShowHistory((value) => !value)} data-instruction-history-toggle>
            {showHistory ? t("automation:instructionHideHistory") : t("automation:instructionShowHistory", { count: history.length })}
          </button>
          {showHistory ? <div className="tri-list">{history.map(row)}</div> : null}
        </div>
      ) : null}

      {orders ? createPortal(
        <div className="modal-backdrop compact automation-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOrders(null); }}>
          <section className="modal-shell compact automation-confirm-modal tri-orders" role="dialog" aria-modal="true" aria-label={t("automation:instructionOrdersTitle")} data-instruction-orders>
            <header className="modal-head"><div><strong>{t("automation:instructionOrdersTitle")}</strong></div></header>
            <p className="automation-confirm-modal__message">{t("automation:instructionOrdersDetail")}</p>
            <div className="tri-orders__list">
              {orders.list.map((order) => (
                <label key={order.ordId} className="tri-orders__item">
                  <input
                    type="checkbox"
                    checked={orders.selected.has(order.ordId)}
                    onChange={(event) => {
                      const selected = new Set(orders.selected);
                      if (event.target.checked) selected.add(order.ordId);
                      else selected.delete(order.ordId);
                      setOrders({ ...orders, selected });
                    }}
                    data-instruction-order={order.ordId}
                  />
                  <span data-i18n-skip>
                    {order.instId} · {order.side === "sell" ? t("automation:sideShort") : t("automation:sideLong")} {order.sz ?? "--"} @ {order.px ?? "--"}
                    {profiles.find((profile) => profile.id === order.profileId)?.name ? ` · ${profiles.find((profile) => profile.id === order.profileId)?.name}` : ""}
                  </span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={() => setOrders(null)}>{t("common:cancel")}</button>
              <button type="button" disabled={busy} onClick={() => void create([...orders.selected])} data-instruction-orders-confirm>
                {orders.selected.size > 0 ? t("automation:instructionCreateAndCancel", { count: orders.selected.size }) : t("automation:instructionCreateKeepOrders")}
              </button>
            </div>
          </section>
        </div>,
        document.body
      ) : null}
    </section>
  );
}
