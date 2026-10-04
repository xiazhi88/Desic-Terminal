import { floatToInt16, pcmChunksToEngineWav, StreamingResampler } from "./wav";

/**
 * 按住说话的录音：getUserMedia + MediaRecorder，不依赖浏览器内置语音识别
 * （WKWebView / WebView2 里不可靠）。每次按键才打开麦克风，松开立刻释放。
 */

export type VoiceCaptureErrorCode = "unsupported" | "permission-denied" | "no-device" | "failed";

export class VoiceCaptureError extends Error {
  readonly code: VoiceCaptureErrorCode;
  constructor(code: VoiceCaptureErrorCode, message: string) {
    super(message);
    this.name = "VoiceCaptureError";
    this.code = code;
  }
}

export type RecordedAudio = {
  blob: Blob;
  mime: string;
  durationMs: number;
  /** 16kHz 单声道 16bit WAV；本机识别用。浏览器不支持 AudioWorklet 时为 null。 */
  wav: Blob | null;
};

export type RecorderHandle = {
  /** 结束录音并返回音频；重复调用返回同一个结果。 */
  stop(): Promise<RecordedAudio>;
  /** 丢弃录音并释放麦克风。 */
  cancel(): void;
};

export type StartRecordingOptions = {
  /** 单次录音上限，到点自动结束并回调 onAutoStop。 */
  maxMs?: number;
  /** 0–1 的实时音量，用于画音波。 */
  onLevel?: (level: number) => void;
  onAutoStop?: () => void;
  /**
   * 边录边交出 16kHz 单声道 16bit 的音频块（约 160ms 一块，结束时再冲出剩余部分）。
   * 供流式识别使用；不支持 AudioWorklet 时不会被调用。
   */
  onPcm16k?: (chunk: Int16Array) => void;
};

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export function voiceCaptureSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
}

function classify(error: unknown): VoiceCaptureError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new VoiceCaptureError("permission-denied", "麦克风权限被拒绝");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new VoiceCaptureError("no-device", "没有找到可用的麦克风");
  return new VoiceCaptureError("failed", error instanceof Error ? error.message : "无法开始录音");
}

export async function startRecording(options: StartRecordingOptions = {}): Promise<RecorderHandle> {
  if (!voiceCaptureSupported()) throw new VoiceCaptureError("unsupported", "当前环境不支持录音");
  const { maxMs = 30_000, onLevel, onAutoStop, onPcm16k } = options;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    throw classify(error);
  }

  const mimeType = pickRecorderMime();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw classify(error);
  }

  const chunks: Blob[] = [];
  const startedAt = performance.now();
  let audioContext: AudioContext | null = null;
  let frame = 0;
  let autoStopTimer = 0;
  let settled: Promise<RecordedAudio> | null = null;
  let cancelled = false;

  const release = () => {
    window.clearTimeout(autoStopTimer);
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext) void audioContext.close().catch(() => undefined);
    audioContext = null;
  };

  // 一个 AudioContext 同时服务音量条和 PCM 采集：本机识别需要 16kHz WAV，
  // 直接采原始 PCM 比解码 MediaRecorder 的 webm / mp4 更可靠（WKWebView、WebView2 的支持各不相同）。
  const pcmChunks: Float32Array[] = [];
  let pcmRate = 0;
  let resampler: StreamingResampler | null = null;
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  const PCM_BATCH_SAMPLES = 2560;
  const flushPcm = (force: boolean) => {
    if (!onPcm16k || pendingLength === 0 || (!force && pendingLength < PCM_BATCH_SAMPLES)) return;
    const merged = new Float32Array(pendingLength);
    let offset = 0;
    for (const part of pending) {
      merged.set(part, offset);
      offset += part.length;
    }
    pending = [];
    pendingLength = 0;
    onPcm16k(floatToInt16(merged));
  };
  try {
    audioContext = new AudioContext();
    pcmRate = audioContext.sampleRate;
    if (onPcm16k) resampler = new StreamingResampler(pcmRate);
    const source = audioContext.createMediaStreamSource(stream);
    if (onLevel) {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += ((value - 128) / 128) ** 2;
        onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.2));
        frame = window.requestAnimationFrame(tick);
      };
      tick();
    }
    if (audioContext.audioWorklet) {
      const moduleSource = "registerProcessor('desic-pcm-tap',class extends AudioWorkletProcessor{process(inputs){const c=inputs[0]&&inputs[0][0];if(c)this.port.postMessage(c.slice(0));return true;}});";
      const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "application/javascript" }));
      try {
        await audioContext.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const tap = new AudioWorkletNode(audioContext, "desic-pcm-tap", { numberOfOutputs: 1, outputChannelCount: [1] });
      tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
        pcmChunks.push(event.data);
        if (resampler) {
          const converted = resampler.push(event.data);
          if (converted.length > 0) {
            pending.push(converted);
            pendingLength += converted.length;
            flushPcm(false);
          }
        }
      };
      // 部分引擎只处理连到输出的节点：接一个音量为 0 的增益再连到输出，不会发声。
      const mute = audioContext.createGain();
      mute.gain.value = 0;
      source.connect(tap);
      tap.connect(mute);
      mute.connect(audioContext.destination);
    }
  } catch {
    // 音量条与 PCM 采集都是附加能力：失败只影响它们，不影响云端转写所用的 MediaRecorder 录音。
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise<RecordedAudio>((resolve, reject) => {
    recorder.onstop = () => {
      const durationMs = performance.now() - startedAt;
      release();
      if (cancelled) return reject(new VoiceCaptureError("failed", "录音已取消"));
      flushPcm(true);
      const mime = recorder.mimeType || mimeType || "audio/webm";
      const wav = pcmChunks.length > 0 && pcmRate > 0 ? new Blob([pcmChunksToEngineWav(pcmChunks, pcmRate)], { type: "audio/wav" }) : null;
      resolve({ blob: new Blob(chunks, { type: mime }), mime, durationMs, wav });
    };
    recorder.onerror = () => {
      release();
      reject(new VoiceCaptureError("failed", "录音过程中出错"));
    };
  });
  // 取消路径会 reject，避免产生未处理的 Promise 警告。
  finished.catch(() => undefined);

  recorder.start(250);
  autoStopTimer = window.setTimeout(() => {
    if (recorder.state !== "inactive") {
      recorder.stop();
      onAutoStop?.();
    }
  }, maxMs);

  return {
    stop() {
      if (!settled) {
        settled = finished;
        if (recorder.state !== "inactive") recorder.stop();
      }
      return settled;
    },
    cancel() {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    },
  };
}
