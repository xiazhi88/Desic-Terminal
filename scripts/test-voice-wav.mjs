import assert from "node:assert/strict";
import { ENGINE_SAMPLE_RATE, encodeWav16kMono, mergeChunks, pcmChunksToEngineWav, resampleTo16k } from "../src/lib/voice/wav.ts";

// 重采样：长度与采样率成比例，直流量保持不变
const dc48 = new Float32Array(48_000).fill(0.5);
const down = resampleTo16k(dc48, 48_000);
assert.equal(down.length, 16_000);
assert.ok(down.every((v) => Math.abs(v - 0.5) < 1e-6));
assert.equal(resampleTo16k(new Float32Array(44_100), 44_100).length, 16_000, "44.1kHz 的 1 秒应得到 1 秒");
assert.equal(resampleTo16k(new Float32Array(8_000), 8_000).length, 16_000, "8kHz 上采样");
assert.equal(resampleTo16k(new Float32Array(0), 48_000).length, 0);
assert.equal(resampleTo16k(new Float32Array(10), 0).length, 0, "非法采样率不抛错");
const same = new Float32Array([0.1, 0.2]);
assert.equal(resampleTo16k(same, ENGINE_SAMPLE_RATE), same);

// 正弦波下采样后峰值基本保持（低频信号）
const sine = new Float32Array(48_000).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000));
const sineDown = resampleTo16k(sine, 48_000);
assert.ok(Math.max(...sineDown) > 0.95 && Math.min(...sineDown) < -0.95);

// 合并
assert.deepEqual([...mergeChunks([new Float32Array([1, 2]), new Float32Array([3])])], [1, 2, 3]);

// WAV 头与内容
const wav = encodeWav16kMono(new Float32Array([0, 1, -1, 2, -2, 0.5]));
const view = new DataView(wav.buffer);
assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
assert.equal(view.getUint16(20, true), 1);
assert.equal(view.getUint16(22, true), 1, "单声道");
assert.equal(view.getUint32(24, true), 16_000);
assert.equal(view.getUint16(34, true), 16);
assert.equal(view.getUint32(40, true), 12);
assert.equal(view.getUint32(4, true), 36 + 12);
assert.equal(wav.length, 44 + 12);
assert.equal(view.getInt16(44, true), 0);
assert.equal(view.getInt16(46, true), 0x7fff);
assert.equal(view.getInt16(48, true), -0x8000);
assert.equal(view.getInt16(50, true), 0x7fff, "超出范围要截断而不是回绕");
assert.equal(view.getInt16(52, true), -0x8000);

// 整条链：3 个分块 → 引擎 WAV
const chunks = [new Float32Array(16_000).fill(0.25), new Float32Array(16_000).fill(0.25), new Float32Array(16_000).fill(0.25)];
const full = pcmChunksToEngineWav(chunks, 48_000);
assert.equal(full.length, 44 + 16_000 * 2, "3 秒 48kHz → 1 秒 16kHz");
console.log("voice wav tests passed");

// ---- 增量重采样：分块结果必须与整段一致 ----
const { StreamingResampler, floatToInt16, int16ToBase64 } = await import("../src/lib/voice/wav.ts");
const signal = new Float32Array(48_000 * 2).map((_, i) => Math.sin((2 * Math.PI * 330 * i) / 48_000) * 0.6 + Math.sin((2 * Math.PI * 1500 * i) / 48_000) * 0.2);
for (const rate of [48_000, 44_100, 32_000, 8_000]) {
  const src = rate === 48_000 ? signal : signal.slice(0, Math.floor(rate * 2));
  const whole = resampleTo16k(src, rate);
  for (const chunk of [128, 441, 1000, 4096, 7777]) {
    const r = new StreamingResampler(rate);
    const parts = [];
    for (let i = 0; i < src.length; i += chunk) parts.push(r.push(src.slice(i, i + chunk)));
    const streamed = mergeChunks(parts);
    // 流式要等到有足够样本才产出，末尾最多少 1 个输出样本
    assert.ok(whole.length - streamed.length >= 0 && whole.length - streamed.length <= 2, `${rate}Hz chunk ${chunk}: 长度 ${streamed.length} vs ${whole.length}`);
    let maxDiff = 0;
    for (let i = 0; i < streamed.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(streamed[i] - whole[i]));
    assert.ok(maxDiff < 1e-5, `${rate}Hz chunk ${chunk}: 与整段结果相差 ${maxDiff}`);
  }
}
// 缓冲区不会无限增长（长录音）
const longResampler = new StreamingResampler(48_000);
for (let i = 0; i < 400; i += 1) longResampler.push(new Float32Array(4800));
assert.ok(longResampler.buffer.length < 4800 * 3, "长录音时缓冲区应当被裁剪");
assert.equal(new StreamingResampler(0).push(new Float32Array(10)).length, 0);
assert.equal(new StreamingResampler(16_000).push(new Float32Array([0.1, 0.2])).length, 2);

// Int16 / base64
const pcm = floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
assert.deepEqual([...pcm], [0, 32767, -32768, 32767, -32768, 16383]);
assert.equal(int16ToBase64(new Int16Array([1, -2])), Buffer.from(new Uint8Array(new Int16Array([1, -2]).buffer)).toString("base64"));
assert.equal(int16ToBase64(new Int16Array(40_000)).length, Math.ceil((40_000 * 2) / 3) * 4, "大块数据不应因展开参数过多而失败");
console.log("streaming resampler tests passed");
