import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/** In-app confirmation. `window.confirm` is unavailable in the Tauri webview
 *  ("dialog.confirm not allowed"), so destructive actions use this instead of a
 *  native prompt that silently rejects. */
export function AutomationConfirmDialog({
  title,
  message,
  details,
  confirmText,
  danger,
  secondaryText,
  onSecondary,
  onCancel,
  onConfirm
}: Readonly<{
  title: string;
  message: string;
  /** 需要用户逐条看清的对象（例如要撤的挂单），每条一行。 */
  details?: string[];
  confirmText: string;
  danger?: boolean;
  /** 第二个选择（例如「只停用，不撤单」），放在取消与确认之间。 */
  secondaryText?: string;
  onSecondary?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useTranslation(["automation", "common"]);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // 聚焦只在打开时做一次；和依赖 onCancel 的 Esc 监听分开，避免父组件重渲染时抢走焦点。
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop compact automation-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal-shell compact automation-confirm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head"><div><strong>{title}</strong></div></header>
        <p className="automation-confirm-modal__message">{message}</p>
        {details && details.length > 0 ? (
          <ul className="automation-confirm-modal__details" data-i18n-skip>
            {details.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
        <div className="modal-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>{t("common:cancel")}</button>
          {secondaryText && onSecondary ? <button type="button" onClick={onSecondary}>{secondaryText}</button> : null}
          <button type="button" className={danger ? "danger-action" : ""} onClick={onConfirm}>{confirmText}</button>
        </div>
      </section>
    </div>,
    document.body
  );
}
