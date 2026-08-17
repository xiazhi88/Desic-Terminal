import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

/**
 * In-app confirmation prompt.
 *
 * `window.confirm` is unavailable in the Tauri webview: the call is rejected
 * with "dialog.confirm not allowed" and raises an unhandled rejection, which
 * means the guard silently fails open or closed depending on the call site.
 * Every destructive or lossy action therefore routes through this component.
 */
export type ConfirmPromptRequest = {
  title: string;
  message: string;
  confirmText: string;
  /** Renders the confirm button as destructive. */
  danger?: boolean;
  onConfirm: () => void;
};

export function ConfirmPrompt({
  request,
  onClose
}: Readonly<{ request: ConfirmPromptRequest; onClose: () => void }>) {
  const { t } = useTranslation("common");
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop compact confirm-prompt-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="modal-shell compact confirm-prompt" role="dialog" aria-modal="true" aria-label={request.title}>
        <header className="modal-head">
          <div><strong>{request.title}</strong></div>
          <button className="window-button" type="button" onClick={onClose} title={t("cancel")}><X size={15} /></button>
        </header>
        <p className="confirm-prompt__message">{request.message}</p>
        <div className="modal-actions">
          <button type="button" ref={cancelRef} onClick={onClose}>{t("cancel")}</button>
          <button
            type="button"
            className={request.danger ? "danger-action" : ""}
            onClick={() => { onClose(); request.onConfirm(); }}
          >
            {request.confirmText}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

/**
 * Owns the pending request and renders the prompt.
 *
 * Returns `confirm` to raise a prompt and `element` to place in the tree. The
 * caller keeps its own control flow: the action runs from `onConfirm` rather
 * than from a resolved boolean, so no call site can accidentally continue as if
 * the user had agreed.
 */
export function useConfirmPrompt() {
  const [request, setRequest] = useState<ConfirmPromptRequest | null>(null);
  const close = useCallback(() => setRequest(null), []);
  const confirm = useCallback((next: ConfirmPromptRequest) => setRequest(next), []);
  return {
    confirm,
    element: request ? <ConfirmPrompt request={request} onClose={close} /> : null
  };
}
