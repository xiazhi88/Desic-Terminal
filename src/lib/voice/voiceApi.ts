import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, listenOptional } from "../tauri";
import { int16ToBase64 } from "./wav";

export type VoiceSource = "none" | "active-model" | "custom" | "local";

export type VoiceConfigSummary = {
  source: VoiceSource;
  baseUrl: string;
  model: string;
  /** `auto` 表示由服务自动识别。 */
  language: string;
  hasKey: boolean;
  /** 录音实际会发往的主机名；尚未配置时为空。 */
  uploadHost: string | null;
  ready: boolean;
  notReadyReason: string | null;
  localSupported: boolean;
  localInstalled: boolean;
  localInstalling: boolean;
  localDownloadBytes: number;
};

export type VoiceLocalStatus = {
  supported: boolean;
  installed: boolean;
  installing: boolean;
  totalDownloadBytes: number;
  installId: string;
};

export type VoiceLocalPhase = "downloading-engine" | "downloading-model" | "extracting" | "verifying" | "done" | "failed" | "cancelled";
export type VoiceLocalProgress = { phase: VoiceLocalPhase; receivedBytes: number; totalBytes: number };

export const VOICE_LOCAL_PROGRESS_EVENT = "voice:local-progress";

export type VoiceConfigUpdate = {
  source: VoiceSource;
  baseUrl?: string;
  /** 不传表示沿用已保存的 Key。 */
  apiKey?: string;
  clearKey?: boolean;
  model?: string;
  language?: string;
};

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "语音服务调用失败";
}

export async function loadVoiceConfig(): Promise<VoiceConfigSummary | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<VoiceConfigSummary>("voice_config_summary");
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

export async function saveVoiceConfig(update: VoiceConfigUpdate): Promise<VoiceConfigSummary> {
  if (!isTauriRuntime()) throw new Error("语音设置仅在桌面应用中可用");
  try {
    return await invoke<VoiceConfigSummary>("voice_save_config", { update });
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取录音数据"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export async function loadVoiceLocalStatus(): Promise<VoiceLocalStatus | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<VoiceLocalStatus>("voice_local_status");
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

export async function installVoiceLocal(): Promise<VoiceLocalStatus> {
  if (!isTauriRuntime()) throw new Error("本机识别仅在桌面应用中可用");
  try {
    return await invoke<VoiceLocalStatus>("voice_local_install");
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

export async function cancelVoiceLocalInstall(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("voice_local_cancel").catch(() => undefined);
}

export async function removeVoiceLocal(): Promise<VoiceLocalStatus> {
  if (!isTauriRuntime()) throw new Error("本机识别仅在桌面应用中可用");
  try {
    return await invoke<VoiceLocalStatus>("voice_local_remove");
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

export function listenVoiceLocalProgress(handler: (progress: VoiceLocalProgress) => void) {
  return listenOptional<VoiceLocalProgress>(VOICE_LOCAL_PROGRESS_EVENT, handler);
}

export async function transcribeVoice(input: { blob: Blob; mime: string; wav?: Blob | null; hints?: readonly string[]; language?: string }): Promise<{ text: string; host: string | null }> {
  if (!isTauriRuntime()) throw new Error("语音转写仅在桌面应用中可用");
  // 选了本机识别就发 16kHz WAV，录音不出本机；否则发原始录音交给云端服务。
  const config = await loadVoiceConfig();
  const useLocal = config?.source === "local";
  if (useLocal && !input.wav) throw new Error("当前环境无法为本机识别采集音频，请改用云端服务");
  const audio = useLocal && input.wav ? { blob: input.wav, mime: "audio/wav" } : { blob: input.blob, mime: input.mime };
  const audioBase64 = await blobToBase64(audio.blob);
  try {
    return await invoke<{ text: string; host: string | null }>("voice_transcribe", {
      request: { audioBase64, mime: audio.mime, hints: input.hints ?? [], language: input.language },
    });
  } catch (error) {
    throw new Error(messageOf(error));
  }
}


// ───────────── 流式识别（本机） ─────────────

export const VOICE_PARTIAL_EVENT = "voice:partial";

export type VoiceStream = {
  /** 推送一块 16kHz 单声道 16bit 音频；按调用顺序串行送达。 */
  push: (chunk: Int16Array) => void;
  /** 结束并取最终文字。 */
  finish: () => Promise<string>;
  /** 丢弃并释放。 */
  cancel: () => void;
};

/** 创建一个流式识别会话：立刻开始加载识别器，随后可以持续推送音频块。 */
export function createVoiceStream(onPartial: (text: string) => void): VoiceStream {
  let failure: Error | null = null;
  let closed = false;
  let unlisten: (() => void) | null = null;
  const release = () => {
    closed = true;
    unlisten?.();
    unlisten = null;
  };
  void listenOptional<{ text: string }>(VOICE_PARTIAL_EVENT, (payload) => {
    if (!closed) onPartial(payload.text);
  }).then((dispose) => {
    if (closed) dispose?.();
    else unlisten = dispose;
  });
  let queue: Promise<void> = invoke("voice_stream_start").then(
    () => undefined,
    (error) => {
      failure = new Error(messageOf(error));
    },
  );
  return {
    push(chunk) {
      queue = queue.then(async () => {
        if (failure || closed) return;
        try {
          await invoke("voice_stream_push", { request: { pcmBase64: int16ToBase64(chunk) } });
        } catch (error) {
          failure = new Error(messageOf(error));
        }
      });
    },
    async finish() {
      await queue;
      try {
        if (failure) throw failure;
        return await invoke<string>("voice_stream_finish").catch((error) => {
          throw new Error(messageOf(error));
        });
      } finally {
        release();
      }
    },
    cancel() {
      release();
      queue = queue.then(() => invoke("voice_stream_cancel").then(() => undefined, () => undefined));
    },
  };
}
