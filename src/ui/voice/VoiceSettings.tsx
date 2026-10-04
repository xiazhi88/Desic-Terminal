import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { DEFAULT_CORRECTIONS, sanitizeEntries, type LexiconEntry } from "../../lib/voice/lexicon";
import { readLexicon, saveLexicon, subscribeLexicon } from "../../lib/voice/lexiconStore";
import {
  cancelVoiceLocalInstall,
  installVoiceLocal,
  listenVoiceLocalProgress,
  loadVoiceConfig,
  removeVoiceLocal,
  saveVoiceConfig,
  type VoiceConfigSummary,
  type VoiceLocalProgress,
  type VoiceSource,
} from "../../lib/voice/voiceApi";
import {
  readVoicePreference,
  saveVoicePreference,
  subscribeVoicePreference,
  VOICE_CONFIRM_OPTIONS,
  VOICE_HOLD_KEYS,
  VOICE_PALETTES,
  type VoiceConfirmMs,
  type VoiceHoldKey,
  type VoicePaletteName,
  type VoicePreference,
} from "../../lib/voice/voicePreference";
import { holdKeyLabel } from "./DirectorBar";
import { BUDDY_BOX, BUDDY_PALETTES, PixelBuddy } from "./pixelBuddy";
import "./director.css";

type UiText = (zh: string, en: string) => string;
type Draft = { source: VoiceSource; baseUrl: string; apiKey: string; model: string; language: string };

const LANGUAGES: readonly [string, string, string][] = [
  ["auto", "自动识别", "Auto-detect"],
  ["zh", "中文", "Chinese"],
  ["en", "English", "English"],
];

function formatMegabytes(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
}

function useUiText(): UiText {
  const { i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("zh");
  return useCallback((zh: string, en: string) => (chinese ? zh : en), [chinese]);
}

function describeProgress(progress: VoiceLocalProgress, uiText: UiText) {
  const percent = progress.totalBytes > 0 ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)) : 0;
  switch (progress.phase) {
    case "downloading-engine":
      return uiText(`正在下载识别引擎… ${percent}%`, `Downloading the engine… ${percent}%`);
    case "downloading-model":
      return uiText(`正在下载语音模型… ${percent}%`, `Downloading the speech model… ${percent}%`);
    case "extracting":
      return uiText("正在校验并解压…", "Verifying and extracting…");
    case "verifying":
      return uiText("正在做安装自检…", "Running the install self-test…");
    default:
      return uiText("处理中…", "Working…");
  }
}

// ───────────── 小组件 ─────────────

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={clsx("vs-switch", checked && "is-on")} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: ReactNode }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="vs-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={String(option.value)} type="button" role="radio" aria-checked={option.value === value} className={clsx(option.value === value && "is-on")} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Card({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("vs-card", className)}>
      <header>
        <strong>{title}</strong>
        {hint && <span>{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="vs-row">
      <div className="vs-row-copy">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="vs-row-control">{children}</div>
    </div>
  );
}

/** 活的预览：同一个像素引擎在小窗里原地循环几个表情，换配色立刻生效。 */
function BuddyPreview({ palette }: { palette: VoicePaletteName }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<PixelBuddy | null>(null);
  useEffect(() => {
    if (!canvasRef.current || !trailRef.current || !rootRef.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const engine = new PixelBuddy({ canvas: canvasRef.current, trail: trailRef.current, root: rootRef.current, reducedMotion: reduced });
    engine.startPreview(reduced ? ["happy"] : undefined);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);
  useEffect(() => engineRef.current?.setPalette(palette), [palette]);
  return (
    <div className="vs-preview" aria-hidden="true">
      <div ref={rootRef} className="vs-preview-root">
        <canvas ref={canvasRef} width={BUDDY_BOX} height={BUDDY_BOX} />
      </div>
      <canvas ref={trailRef} className="vs-preview-trail" />
    </div>
  );
}

export function VoiceSettings() {
  const uiText = useUiText();
  const [preference, setPreference] = useState<VoicePreference>(() => readVoicePreference());
  const [summary, setSummary] = useState<VoiceConfigSummary | null>(null);
  const [draft, setDraft] = useState<Draft>({ source: "none", baseUrl: "", apiKey: "", model: "", language: "auto" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [progress, setProgress] = useState<VoiceLocalProgress | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [lexicon, setLexicon] = useState<LexiconEntry[]>(() => readLexicon());
  const [newFrom, setNewFrom] = useState("");
  const [newTo, setNewTo] = useState("");
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  useEffect(() => subscribeVoicePreference(setPreference), []);
  useEffect(() => subscribeLexicon(setLexicon), []);

  const applySummary = useCallback((next: VoiceConfigSummary) => {
    setSummary(next);
    setDraft({ source: next.source, baseUrl: next.baseUrl, apiKey: "", model: next.model, language: next.language });
  }, []);

  useEffect(() => {
    let active = true;
    void loadVoiceConfig()
      .then((next) => { if (active && next) applySummary(next); })
      .catch((error) => { if (active) setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) }); });
    return () => { active = false; };
  }, [applySummary]);

  const update = (patch: Partial<VoicePreference>) => saveVoicePreference({ ...preference, ...patch });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenVoiceLocalProgress((next) => setProgress(next)).then((dispose) => {
      if (disposed) dispose?.();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const refreshSummary = useCallback(async () => {
    const next = await loadVoiceConfig();
    if (next) setSummary(next);
  }, []);

  const installLocal = async () => {
    setLocalBusy(true);
    setStatus(null);
    setProgress({ phase: "downloading-engine", receivedBytes: 0, totalBytes: summary?.localDownloadBytes ?? 0 });
    try {
      await installVoiceLocal();
      // 下载好就直接选用，用户不需要再点一次保存。
      const next = await saveVoiceConfig({ source: "local", model: draft.model, language: draft.language });
      applySummary(next);
      setStatus({ tone: "ok", text: uiText("本机识别已就绪", "Local recognition is ready") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ tone: message.includes("已取消") ? "ok" : "error", text: message });
      await refreshSummary().catch(() => undefined);
    } finally {
      setLocalBusy(false);
      setProgress(null);
    }
  };

  const removeLocal = async () => {
    setLocalBusy(true);
    setStatus(null);
    try {
      await removeVoiceLocal();
      await refreshSummary();
      setStatus({ tone: "ok", text: uiText("已删除本机识别引擎和模型", "Local engine and model removed") });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLocalBusy(false);
    }
  };

  const save = async (options: { clearKey?: boolean } = {}) => {
    setBusy(true);
    setStatus(null);
    try {
      const next = await saveVoiceConfig({
        source: draft.source,
        baseUrl: draft.source === "custom" ? draft.baseUrl : undefined,
        apiKey: draft.apiKey.trim() ? draft.apiKey : undefined,
        clearKey: options.clearKey,
        model: draft.model,
        language: draft.language,
      });
      applySummary(next);
      setStatus({ tone: next.ready ? "ok" : "error", text: next.ready ? uiText("已保存", "Saved") : next.notReadyReason ?? uiText("已保存，但还不能使用", "Saved, but not ready") });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const addEntry = () => {
    const [entry] = sanitizeEntries([{ from: newFrom, to: newTo }]);
    if (!entry) return;
    saveLexicon([entry, ...lexicon.filter((item) => item.from.toLowerCase() !== entry.from.toLowerCase())]);
    setNewFrom("");
    setNewTo("");
  };

  const localSupported = summary?.localSupported ?? true;
  const ready = Boolean(summary?.ready);
  const holdLabel = holdKeyLabel(preference.holdKey, uiText);

  const sources: { value: VoiceSource; title: string; badge?: string; description: string; disabled?: boolean }[] = [
    {
      value: "local",
      title: uiText("本机识别", "On this computer"),
      badge: uiText("离线 · 推荐", "Offline · recommended"),
      description: localSupported
        ? uiText(`录音不出本机，不需要 API Key，边说边出字。首次使用需下载约 ${formatMegabytes(summary?.localDownloadBytes ?? 0)}。`, `Audio never leaves this computer, no API key, live text while you speak. First use downloads about ${formatMegabytes(summary?.localDownloadBytes ?? 0)}.`)
        : uiText("当前系统暂不支持（目前支持 macOS 与 Windows x64）。", "Not supported on this system yet (macOS and Windows x64 only)."),
      disabled: !localSupported,
    },
    {
      value: "active-model",
      title: uiText("沿用当前 AI 模型的服务", "Active AI model's service"),
      description: uiText("适用于 OpenAI 等兼容 /audio/transcriptions 的服务，复用已保存的地址和 Key。", "For OpenAI-compatible services that expose /audio/transcriptions. Reuses the saved URL and key."),
    },
    {
      value: "custom",
      title: uiText("自定义服务", "Custom service"),
      description: uiText("填写任意兼容 OpenAI 转写接口的地址，也可以是本机自建服务。", "Any OpenAI-compatible transcription endpoint, including one self-hosted on localhost."),
    },
  ];

  return (
    <div className="vs">
      {/* 顶部：活的预览 + 总开关 + 状态 */}
      <section className="vs-hero">
        <BuddyPreview palette={preference.palette} />
        <div className="vs-hero-copy">
          <div className="vs-hero-title">
            <strong>{uiText("语音伙伴", "Voice companion")}</strong>
            <span className={clsx("vs-pill", !preference.enabled ? "is-off" : ready ? "is-ok" : "is-warn")}>
              {!preference.enabled ? uiText("未启用", "Off") : ready ? uiText("已就绪", "Ready") : uiText("需要配置识别方式", "Needs a recognition source")}
            </span>
          </div>
          <p>{uiText("一个住在窗口边缘的像素机器人。按住快捷键说话：切合约、换周期、加指标、开订单流；复杂的问题交给语音指挥分析，并给出带证据的卡片。语音永远不会下单。", "A pixel robot that lives at the window edge. Hold a key and speak to switch instruments, timeframes and indicators, or ask for an analysis with evidence cards. Voice never places orders.")}</p>
          {preference.enabled && !ready && summary?.notReadyReason && <p className="vs-warn">{summary.notReadyReason}</p>}
          {!desktop && <p className="vs-warn">{uiText("语音输入仅在桌面应用中可用。", "Voice input is only available in the desktop app.")}</p>}
        </div>
        <Switch checked={preference.enabled} disabled={!desktop} onChange={(enabled) => update({ enabled })} label={uiText("启用语音伙伴", "Enable the voice companion")} />
      </section>

      <div className="vs-grid">
        <Card title={uiText("怎么唤醒", "How to wake it")} hint={uiText("在输入框或弹窗里不会触发", "Ignored inside text fields and dialogs")}>
          <Row label={uiText("按住说话的按键", "Hold-to-talk key")} hint={uiText("松开即发送；也可以直接按住机器人本体", "Release to send. You can also press and hold the robot")}>
            <div className="vs-keys" role="radiogroup" aria-label={uiText("按住说话的按键", "Hold-to-talk key")}>
              {VOICE_HOLD_KEYS.map((key: VoiceHoldKey) => (
                <button key={key} type="button" role="radio" aria-checked={preference.holdKey === key} className={clsx("vs-key", preference.holdKey === key && "is-on")} onClick={() => update({ holdKey: key })}>
                  {key === "Backquote" ? "`" : key === "AltRight" ? "⌥ R" : key}
                </button>
              ))}
            </div>
          </Row>
          <Row label={uiText("说完后的停顿", "Pause before running")} hint={uiText(`停顿里可按 Esc 取消、Tab 改字、Enter 立即执行（当前按键：${holdLabel}）`, `Esc cancels, Tab edits, Enter runs now (key: ${holdLabel})`)}>
            <Segmented<VoiceConfirmMs>
              value={preference.confirmMs}
              label={uiText("说完后的停顿", "Pause before running")}
              onChange={(confirmMs) => update({ confirmMs })}
              options={VOICE_CONFIRM_OPTIONS.map((ms) => ({ value: ms, label: ms === 0 ? uiText("立即", "Now") : `${ms / 1000}s` }))}
            />
          </Row>
        </Card>

        <Card title={uiText("外观", "Appearance")} hint={uiText("左边的小窗是实时预览", "The window on the left is a live preview")}>
          <Row label={uiText("配色", "Colour")}>
            <div className="vs-swatches" role="radiogroup" aria-label={uiText("配色", "Colour")}>
              {VOICE_PALETTES.map((name) => (
                <button key={name} type="button" role="radio" aria-checked={preference.palette === name} aria-label={name} className={clsx("vs-swatch", preference.palette === name && "is-on")} onClick={() => update({ palette: name })}>
                  <i style={{ background: BUDDY_PALETTES[name].base, boxShadow: `inset 0 -6px 0 ${BUDDY_PALETTES[name].shade}, inset 0 6px 0 ${BUDDY_PALETTES[name].light}` }} />
                  <span>{{ violet: uiText("AI 紫", "Violet"), orange: uiText("暖橙", "Orange"), mono: uiText("灰白", "Mono") }[name]}</span>
                </button>
              ))}
            </div>
          </Row>
          <Row label={uiText("停靠位置", "Dock side")}>
            <Segmented<"left" | "right"> value={preference.side} label={uiText("停靠位置", "Dock side")} onChange={(side) => update({ side })} options={[{ value: "left", label: uiText("左侧", "Left") }, { value: "right", label: uiText("右侧", "Right") }]} />
          </Row>
          <Row label={uiText("偶尔探出头来", "Peek out now and then")} hint={uiText("平时只露出一条边；行情剧烈或你在输入时不会出现", "Only an edge shows normally")}>
            <Switch checked={preference.peek} onChange={(peek) => update({ peek })} label={uiText("偶尔探出头来", "Peek out now and then")} />
          </Row>
        </Card>
      </div>

      <Card title={uiText("识别方式", "Recognition source")} hint={uiText("录音只在你说话时采集，不会保存到本机", "Audio is captured only while you speak and is never saved")} className="vs-wide">
        <div className="vs-sources" role="radiogroup" aria-label={uiText("识别方式", "Recognition source")}>
          {sources.map((source) => {
            const selected = draft.source === source.value;
            return (
              <div key={source.value} className={clsx("vs-source", selected && "is-on", source.disabled && "is-disabled")}>
                <button type="button" role="radio" aria-checked={selected} disabled={source.disabled} onClick={() => setDraft({ ...draft, source: source.value })}>
                  <span className="vs-radio" aria-hidden="true" />
                  <span className="vs-source-copy">
                    <strong>{source.title}{source.badge && <em>{source.badge}</em>}</strong>
                    <small>{source.description}</small>
                  </span>
                </button>

                {selected && source.value === "local" && localSupported && (
                  <div className="vs-source-body">
                    {summary?.localInstalled ? (
                      <div className="vs-inline">
                        <span className="vs-ok">{uiText("引擎与模型已安装，识别完全在本机进行。", "Engine and model installed. Recognition runs entirely on this computer.")}</span>
                        <button type="button" className="vs-btn is-ghost" disabled={localBusy} onClick={() => void removeLocal()}>{uiText("删除", "Remove")}</button>
                      </div>
                    ) : localBusy || summary?.localInstalling ? (
                      <div className="vs-progress-block">
                        <span>{progress ? describeProgress(progress, uiText) : uiText("准备中…", "Preparing…")}</span>
                        <progress className="vs-progress" max={progress?.totalBytes || undefined} value={progress && progress.totalBytes > 0 ? progress.receivedBytes : undefined} />
                        <button type="button" className="vs-btn is-ghost" onClick={() => void cancelVoiceLocalInstall()}>{uiText("取消下载", "Cancel download")}</button>
                      </div>
                    ) : (
                      <div className="vs-inline">
                        <span>{uiText(`将从 GitHub 官方发布页下载 sherpa-onnx 与 x-asr 流式模型，共约 ${formatMegabytes(summary?.localDownloadBytes ?? 0)}，逐个校验官方哈希后才会启用。`, `Downloads sherpa-onnx and the x-asr streaming model (${formatMegabytes(summary?.localDownloadBytes ?? 0)}) from the official GitHub releases and verifies their hashes before use.`)}</span>
                        <button type="button" className="vs-btn is-primary" disabled={!desktop} onClick={() => void installLocal()}>{uiText("下载并启用", "Download and enable")}</button>
                      </div>
                    )}
                  </div>
                )}

                {selected && source.value === "custom" && (
                  <div className="vs-source-body vs-form">
                    <label>
                      <span>Base URL</span>
                      <input type="url" value={draft.baseUrl} placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
                    </label>
                    <label>
                      <span>API Key</span>
                      <input type="password" value={draft.apiKey} placeholder={summary?.hasKey ? uiText("已保存，留空保持不变", "Saved. Leave blank to keep") : ""} autoComplete="off" spellCheck={false} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
                    </label>
                  </div>
                )}

                {selected && (source.value === "active-model" || source.value === "custom") && (
                  <div className="vs-source-body vs-form">
                    <label>
                      <span>{uiText("转写模型", "Model")}</span>
                      <input type="text" value={draft.model} placeholder="whisper-1" autoComplete="off" spellCheck={false} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
                    </label>
                    <label>
                      <span>{uiText("语言", "Language")}</span>
                      <select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value })}>
                        {LANGUAGES.map(([value, zh, en]) => <option key={value} value={value}>{uiText(zh, en)}</option>)}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="vs-footer">
          <div className="vs-actions">
            {draft.source !== "local" && (
              <button type="button" className="vs-btn is-primary" disabled={busy || !desktop || draft.source === "none"} onClick={() => void save()}>
                {busy ? uiText("保存中…", "Saving…") : uiText("保存识别方式", "Save")}
              </button>
            )}
            {draft.source === "local" && summary?.source !== "local" && summary?.localInstalled && (
              <button type="button" className="vs-btn is-primary" disabled={busy} onClick={() => void save()}>{uiText("使用本机识别", "Use on-device recognition")}</button>
            )}
            {summary?.hasKey && draft.source === "custom" && (
              <button type="button" className="vs-btn is-ghost" disabled={busy} onClick={() => void save({ clearKey: true })}>{uiText("清除已保存的 Key", "Clear saved key")}</button>
            )}
            {status && <span className={clsx("vs-status", `is-${status.tone}`)}>{status.text}</span>}
          </div>
          {ready && summary?.uploadHost && <p className="vs-note">{uiText(`录音将发送到 ${summary.uploadHost}。`, `Audio will be sent to ${summary.uploadHost}.`)}</p>}
          {ready && summary?.source === "local" && <p className="vs-note">{uiText("录音只在本机处理，不会发送到任何服务器。", "Audio is processed on this computer and sent nowhere.")}</p>}
        </div>
      </Card>

      <Card title={uiText("词汇纠错", "Word corrections")} hint={uiText(`内置 ${DEFAULT_CORRECTIONS.length} 条常见误识别；停顿时按 Tab 改字，系统会自动记住`, `${DEFAULT_CORRECTIONS.length} built-in fixes. Press Tab during the pause to edit; the app learns from it`)} className="vs-wide">
        <div className="vs-lex-add">
          <input value={newFrom} placeholder={uiText("听成了…（例：座椅）", "Heard as… (e.g. 座椅)")} maxLength={24} onChange={(event) => setNewFrom(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addEntry()} />
          <span aria-hidden="true">→</span>
          <input value={newTo} placeholder={uiText("应该是…（例：以太）", "Should be… (e.g. 以太)")} maxLength={24} onChange={(event) => setNewTo(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addEntry()} />
          <button type="button" className="vs-btn" disabled={!newFrom.trim() || !newTo.trim()} onClick={addEntry}>{uiText("添加", "Add")}</button>
        </div>
        {lexicon.length === 0 ? (
          <p className="vs-note">{uiText("还没有自己的纠错记录。第一次识别错的时候，在停顿里按 Tab 把它改对，下次就会自动纠正。", "No corrections of your own yet. When a sentence is misheard, press Tab during the pause and fix it; next time it is corrected automatically.")}</p>
        ) : (
          <ul className="vs-chips">
            {lexicon.map((entry) => (
              <li key={entry.from}>
                <span>{entry.from}</span>
                <b aria-hidden="true">→</b>
                <span>{entry.to}</span>
                <button type="button" aria-label={uiText(`删除 ${entry.from}`, `Remove ${entry.from}`)} onClick={() => saveLexicon(lexicon.filter((item) => item.from !== entry.from))}>×</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
