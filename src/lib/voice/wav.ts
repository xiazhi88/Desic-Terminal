/**
 * 把录到的原始 PCM 转成本机识别引擎要求的格式：16kHz、单声道、16bit WAV。
 * 纯函数、不依赖 DOM，便于直接用 node 测试。
 */

export const ENGINE_SAMPLE_RATE = 16_000;

/** 按窗口取平均下采样（起到简单低通的作用，避免混叠）；源采样率不高于目标时线性插值上采样。 */
export function resampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  if (!(sourceRate > 0) || input.length === 0) return new Float32Array(0);
  if (sourceRate === ENGINE_SAMPLE_RATE) return input;
  const ratio = sourceRate / ENGINE_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  if (ratio > 1) {
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      output[i] = sum / (end - start);
    }
  } else {
    for (let i = 0; i < length; i += 1) {
      const position = i * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      output[i] = input[left] * (1 - fraction) + input[right] * fraction;
    }
  }
  return output;
}

export function mergeChunks(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function encodeWav16kMono(samples16k: Float32Array): Uint8Array<ArrayBuffer> {
  const dataLength = samples16k.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, ENGINE_SAMPLE_RATE, true);
  view.setUint32(28, ENGINE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples16k.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples16k[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** 一步到位：原始分块 PCM（任意采样率）→ 引擎要求的 WAV 字节。 */
export function pcmChunksToEngineWav(chunks: readonly Float32Array[], sourceRate: number): Uint8Array<ArrayBuffer> {
  return encodeWav16kMono(resampleTo16k(mergeChunks(chunks), sourceRate));
}

/**
 * 增量重采样：边录边把任意采样率的 PCM 变成 16kHz，结果与对整段做 `resampleTo16k` 一致
 * （降采样用同样的窗口平均，上采样用同样的线性插值），所以分块边界不会产生杂音。
 */
export class StreamingResampler {
  private readonly ratio: number;
  private buffer: Float32Array = new Float32Array(0);
  /** buffer[0] 对应的绝对采样序号。 */
  private base = 0;
  /** 下一个要产出的输出采样序号。 */
  private index = 0;

  constructor(sourceRate: number) {
    this.ratio = sourceRate > 0 ? sourceRate / ENGINE_SAMPLE_RATE : 0;
  }

  push(input: Float32Array): Float32Array {
    if (this.ratio <= 0 || input.length === 0) return new Float32Array(0);
    if (this.ratio === 1) return input;
    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer);
    merged.set(input, this.buffer.length);
    this.buffer = merged;
    const available = this.base + this.buffer.length;
    const out: number[] = [];
    if (this.ratio > 1) {
      for (;;) {
        const start = Math.floor(this.index * this.ratio);
        const end = Math.max(start + 1, Math.floor((this.index + 1) * this.ratio));
        if (end > available) break;
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += this.buffer[j - this.base];
        out.push(sum / (end - start));
        this.index += 1;
      }
    } else {
      for (;;) {
        const position = this.index * this.ratio;
        const left = Math.floor(position);
        if (left + 1 >= available) break;
        const fraction = position - left;
        out.push(this.buffer[left - this.base] * (1 - fraction) + this.buffer[left + 1 - this.base] * fraction);
        this.index += 1;
      }
    }
    // 丢掉已经用不到的前缀，缓冲区不会无限增长。
    const keepFrom = Math.max(this.base, Math.floor(this.index * this.ratio) - 1);
    if (keepFrom > this.base) {
      this.buffer = this.buffer.slice(keepFrom - this.base);
      this.base = keepFrom;
    }
    return Float32Array.from(out);
  }
}

/** [-1, 1] 浮点 → 16bit 小端 PCM。 */
export function floatToInt16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
