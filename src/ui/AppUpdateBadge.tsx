import { useCallback, useEffect, useMemo, useState } from "react";
import { listenOptional, checkAppUpdate, loadAppUpdateStatus } from "../lib/tauri";
import { installAvailableUpdate, type UpdateProgress } from "../lib/updater";
import type { AppUpdateState } from "../types";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function progressPercent(progress: UpdateProgress | null) {
  if (!progress?.total || progress.total <= 0) return null;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}

function updateDetail(value: string, t: ReturnType<typeof useTranslation>["t"]) {
  const known: Record<string, string> = {
    "source update requires the main branch": t("updateRequiresMain"),
    "source update requires a clean working tree": t("updateRequiresCleanTree"),
    "local main has diverged from origin/main": t("updateMainDiverged"),
    "origin/main has no source update to apply": t("updateNoLongerAvailable")
  };
  return known[value] ?? value;
}

export function AppUpdateBadge() {
  const { t } = useTranslation("common");
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState("");
  const busy = state?.status === "checking" || Boolean(progress);

  const checkNow = useCallback(async () => {
    setError("");
    try {
      const next = await checkAppUpdate();
      if (next) setState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadAppUpdateStatus().then((next) => {
      if (active && next) setState(next);
    });
    void checkNow();
    const interval = window.setInterval(() => void checkNow(), UPDATE_CHECK_INTERVAL_MS);
    let cleanup: (() => void) | null = null;
    void listenOptional<AppUpdateState>("app:update-state", (next) => {
      if (active) setState(next);
    }).then((dispose) => {
      if (!active) dispose?.();
      else cleanup = dispose;
    });
    return () => {
      active = false;
      window.clearInterval(interval);
      cleanup?.();
    };
  }, [checkNow]);

  const applyUpdate = useCallback(async () => {
    if (!state?.available || state.blockedReason || progress) return;
    setError("");
    try {
      await installAvailableUpdate(state, setProgress);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [progress, state]);

  const percent = progressPercent(progress);
  const statusText = useMemo(() => {
    if (progress) return t(`updatePhase_${progress.phase}`);
    if (state?.blockedReason) return t("updateBlocked");
    if (state?.available) return t("updateAvailable");
    if (state?.status === "checking") return t("checkingForUpdates");
    if (state?.status === "failed") return t("updateCheckFailed");
    return t("upToDate");
  }, [progress, state, t]);

  return (
    <div
      className="app-update-badge"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`rail-logo${state?.available ? " has-update" : ""}`}
        aria-label={state?.available ? t("updateAvailable") : "Desic Terminal"}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <img src="/assets/brand/desic-terminal-icon.png" alt="Desic Terminal" />
        {busy ? <Loader2 className="app-update-logo-spinner spin" size={13} /> : null}
      </button>
      {open ? (
        <div className="app-update-popover" role="dialog" aria-label={t("applicationUpdate") }>
          <header>
            <div>
              <strong>{t("applicationUpdate")}</strong>
              <span>{statusText}</span>
            </div>
          </header>
          <dl>
            <div><dt>{t("currentVersion")}</dt><dd>{state?.currentVersion ?? "--"}{state?.currentRevision ? ` · ${state.currentRevision}` : ""}</dd></div>
            <div><dt>{t("latestVersion")}</dt><dd>{state?.latestVersion ?? state?.currentVersion ?? "--"}{state?.latestRevision ? ` · ${state.latestRevision}` : ""}</dd></div>
          </dl>
          {state?.commitsBehind ? <p>{t("commitsBehind", { count: state.commitsBehind })}</p> : null}
          {state?.blockedReason ? <p className="app-update-error">{updateDetail(state.blockedReason, t)}</p> : null}
          {error ? <p className="app-update-error">{updateDetail(error, t)}</p> : null}
          {progress ? (
            <div className="app-update-progress" aria-label={statusText}>
              <span style={{ width: `${percent ?? 36}%` }} />
              <small>{percent == null ? statusText : `${statusText} ${percent}%`}</small>
            </div>
          ) : null}
          <button type="button" className="app-update-check" onClick={() => void checkNow()} disabled={busy}>
            <RefreshCw size={14} className={state?.status === "checking" ? "spin" : undefined} />
            {t("checkForUpdates")}
          </button>
          {state?.available && !state.blockedReason ? (
            <button type="button" className="app-update-install" onClick={() => void applyUpdate()} disabled={busy}>
              <Download size={14} /> {t("updateNow")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
