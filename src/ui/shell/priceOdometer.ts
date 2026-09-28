import { isPhosphorVisual } from "../../lib/visualPreference";

// 里程表数字：只滚动发生变化的那一位。直接改写 DOM，供命令式更新的价格元素使用
// （顶栏价格条、盘口中间价都不经过 React 渲染）。
// 每一位的真实字符保留为文本节点，textContent / 复制 / 读屏与普通文本一致；
// 可见的滚动数字列由 phosphor.css 中的伪元素绘制。经典外观下退化为直接写文本。

const DIGIT = /\d/;

// 高频行情（BTC 每秒多次）下每次都滚动会让数字列永远停在半途、看起来错位：
// 同一元素两次滚动至少间隔 MIN_ROLL_INTERVAL_MS，期间只保留最新值，到点再写入（方向取累计方向）。
const MIN_ROLL_INTERVAL_MS = 350;
const pending = new WeakMap<HTMLElement, { text: string; direction: number; timer: number | null; lastAt: number }>();

export function writeOdometer(element: HTMLElement, text: string, direction: number) {
  if (!isPhosphorVisual()) {
    applyOdometer(element, text, direction);
    return;
  }
  const now = performance.now();
  const state = pending.get(element) ?? { text, direction: 0, timer: null, lastAt: -Infinity };
  state.text = text;
  state.direction = direction || state.direction;
  pending.set(element, state);
  if (state.timer !== null) return;
  const wait = MIN_ROLL_INTERVAL_MS - (now - state.lastAt);
  const flush = () => {
    state.timer = null;
    state.lastAt = performance.now();
    applyOdometer(element, state.text, state.direction);
    state.direction = 0;
  };
  if (wait <= 0) flush();
  else state.timer = window.setTimeout(flush, wait);
}

function applyOdometer(element: HTMLElement, text: string, direction: number) {
  if (!isPhosphorVisual()) {
    if (element.dataset.odometerText !== undefined) {
      delete element.dataset.odometerText;
      element.classList.remove("odometer");
    }
    if (element.textContent !== text) element.textContent = text;
    return;
  }
  const previous = element.dataset.odometerText;
  if (previous === text && element.childElementCount === text.length) return;
  element.classList.add("odometer");
  const sameShape = previous !== undefined
    && previous.length === text.length
    && element.childElementCount === text.length
    && [...text].every((char, index) => DIGIT.test(char) === DIGIT.test(previous[index] ?? ""));
  if (!sameShape) {
    element.textContent = "";
    for (const char of text) element.appendChild(createCell(char));
    element.dataset.odometerText = text;
    return;
  }
  const flash = direction > 0 ? "is-changed-up" : direction < 0 ? "is-changed-down" : "";
  [...text].forEach((char, index) => {
    if (char === previous![index]) return;
    const cell = element.children[index] as HTMLElement;
    cell.textContent = char;
    if (!DIGIT.test(char)) return;
    cell.dataset.p = previous![index] ?? char;
    cell.dataset.d = char;
    cell.classList.remove("is-changed-up", "is-changed-down");
    if (flash) {
      void cell.offsetWidth;
      cell.classList.add(flash);
    }
  });
  element.dataset.odometerText = text;
}

function createCell(char: string) {
  const cell = document.createElement("span");
  cell.textContent = char;
  if (DIGIT.test(char)) {
    cell.className = "odometer__digit";
    cell.dataset.d = char;
    cell.dataset.p = char;
  } else {
    cell.className = "odometer__separator";
  }
  return cell;
}
