// 生成 src/theme/phosphor-neutralize.css：磷光外观下把非 AI 区域的紫色中和掉。
//
// 旧样式里有数百处写死的紫色（背景、描边、渐变、发光），token 重映射覆盖不到。本脚本用 PostCSS
// 扫描业务样式，找出含紫色（色相 250°–300°、饱和度足够）的声明，为每条规则生成一条
// `:root[data-visual="phosphor"] <原选择器>` 覆盖：
// - 阴影 / 发光（box-shadow、text-shadow、filter 的 drop-shadow）里的紫色 → transparent（去掉发光）；
// - 其余颜色（背景、描边、文字、渐变）→ 亮度相近的信号色（冷天蓝），保留原透明度。
// AI 相关区域（AI 研究、AI 自动化、Agent 库、AI 入口）按设计保留紫色，不生成覆盖。
//
// 用法：node scripts/generate-phosphor-neutralize.mjs（样式改动后重新生成并提交结果）。
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUTPUT = path.join(ROOT, "src/theme/phosphor-neutralize.css");
const SOURCES = [
  "src/styles.css",
  "src/theme/atmosphere.css",
  "src/theme/data-voice.css",
  "src/theme/motion.css",
  "src/theme/signature.css",
  ...fs.readdirSync(path.join(ROOT, "src/ui")).filter((name) => name.endsWith(".css")).map((name) => `src/ui/${name}`),
  ...["chart", "radar", "shell"].flatMap((dir) => fs.readdirSync(path.join(ROOT, "src/ui", dir)).filter((name) => name.endsWith(".css")).map((name) => `src/ui/${dir}/${name}`))
];
// AI 区域与已按磷光重写的组件：保留原样。
const KEEP = /(^|[\s.#[>+~(,])(ai-|ai_|automation|agent-library|agent-card|rail-ai|\[data-workspace="ai"\]|startup|splash|evb|rc-|design-system)/i;

const COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+(?:\s*[,/]\s*[\d.]+%?)?\s*\)/gi;

function parseColor(text) {
  if (text.startsWith("#")) {
    let hex = text.slice(1);
    if (hex.length <= 4) hex = [...hex].map((char) => char + char).join("");
    const value = Number.parseInt(hex.slice(0, 6), 16);
    const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a: alpha };
  }
  const parts = text.match(/[\d.]+%?/g).map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number(part)));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

function isPurple({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max === 0 || delta / max < 0.22 || delta < 18) return false;
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= 250 && hue <= 300;
}

// 信号色（与 phosphor.css 的 --signal 一致）：紫色换成同色相的信号色，按原色感知亮度缩放，保留透明度；
// 这样选中、当前标签、主按钮仍有颜色层次，只是不再借用 AI 紫。
const SIGNAL = { r: 106, g: 176, b: 236 };
const SIGNAL_LUMINANCE = 0.2126 * SIGNAL.r + 0.7152 * SIGNAL.g + 0.0722 * SIGNAL.b;

function neutral({ r, g, b, a }) {
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const scale = Math.min(1.35, Math.max(0.18, luminance / SIGNAL_LUMINANCE));
  const channel = (value) => Math.min(255, Math.round(value * scale));
  const alpha = Math.round(a * 1000) / 1000;
  const rgb = `${channel(SIGNAL.r)}, ${channel(SIGNAL.g)}, ${channel(SIGNAL.b)}`;
  return alpha >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`;
}

function rewrite(prop, value) {
  const shadow = /shadow/i.test(prop) || (/^filter$/i.test(prop) && /drop-shadow/i.test(value));
  let changed = false;
  const next = value.replace(COLOR, (match) => {
    const color = parseColor(match);
    if (!isPurple(color)) return match;
    changed = true;
    return shadow ? "transparent" : neutral(color);
  });
  return changed ? next : null;
}

// 只在顶层逗号处拆分选择器列表（:is(a, b) / :not(a, b) 内部的逗号不能拆）。
function splitSelectors(selector) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function scopedSelector(selector) {
  return splitSelectors(selector)
    .map((part) => part.trim())
    .filter((part) => part && !KEEP.test(part) && !/^:root\b|^html\b|^body\b|^\*/.test(part))
    .map((part) => `:root[data-visual="phosphor"] ${part}`)
    .join(",\n");
}

const out = postcss.root();
let rules = 0;
let declarations = 0;
for (const file of SOURCES) {
  const css = fs.readFileSync(path.join(ROOT, file), "utf8");
  const tree = postcss.parse(css, { from: file });
  tree.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/i.test(rule.parent.name)) return;
    const selector = scopedSelector(rule.selector);
    if (!selector) return;
    const replacements = [];
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith("--")) return;
      const next = rewrite(decl.prop, decl.value);
      if (next !== null) replacements.push(postcss.decl({ prop: decl.prop, value: next, important: decl.important }));
    });
    if (replacements.length === 0) return;
    const clone = postcss.rule({ selector });
    for (const decl of replacements) clone.append(decl);
    // 保留外层 @media / @supports，其余 at-rule 直接放顶层。
    let target = out;
    const wrappers = [];
    for (let parent = rule.parent; parent && parent.type === "atrule"; parent = parent.parent) {
      if (/^(media|supports|container)$/i.test(parent.name)) wrappers.unshift(parent);
    }
    for (const wrapper of wrappers) {
      const existing = target.nodes.find((node) => node.type === "atrule" && node.name === wrapper.name && node.params === wrapper.params && node.__generated);
      if (existing) target = existing;
      else {
        const created = postcss.atRule({ name: wrapper.name, params: wrapper.params });
        created.__generated = true;
        target.append(created);
        target = created;
      }
    }
    target.append(clone);
    rules += 1;
    declarations += replacements.length;
  });
}

const header = `/*
 * phosphor-neutralize.css — 由 scripts/generate-phosphor-neutralize.mjs 生成，请勿手改。
 * 磷光外观下中和非 AI 区域写死的紫色：发光去掉，其余紫色换成亮度相近的信号色（非 AI 强调色）。
 * 覆盖 ${rules} 条规则、${declarations} 处声明；样式改动后重新运行脚本。
 */
`;
fs.writeFileSync(OUTPUT, header + out.toString() + "\n");
console.log(`phosphor-neutralize: ${rules} rules, ${declarations} declarations → ${path.relative(ROOT, OUTPUT)}`);
