// 生成 src/theme/phosphor-ai-calm.css：磷光外观下把「AI 研究」里写死的鲜亮紫色压成柔和的紫。
//
// phosphor-neutralize.css 有意保留 AI 区域的紫色；但 AI 研究的紫色（70+ 处 rgba(149,92,255,…) 以及
// 渐变、描边、发光）在磷光外观下仍然过于抢眼。本脚本扫描 AI 研究相关样式，找出含紫色的声明，
// 生成 `:root[data-visual="phosphor"] <原选择器>` 覆盖：
// - 阴影 / 发光里的紫色 → transparent；
// - 其余紫色 → 保持亮度、饱和度压到约 55% 的柔紫，保留原透明度。
// 经典外观不受影响。用法：node scripts/generate-phosphor-ai-calm.mjs（样式改动后重新生成并提交结果）。
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUTPUT = path.join(ROOT, "src/theme/phosphor-ai-calm.css");
const SOURCES = [
  "src/styles.css",
  "src/ui/AiMessageProcess.css",
  ...fs.readdirSync(path.join(ROOT, "src/ui/ai-research")).filter((name) => name.endsWith(".css")).map((name) => `src/ui/ai-research/${name}`)
].filter((file) => fs.existsSync(path.join(ROOT, file)));
// 只处理 AI 研究相关的选择器（.ai-research-*、.ai-message、.ai-process、.ai-tool、.ai-session …）。
// 自动化与 Agent 库不在本次范围内。
const INCLUDE = /\.ai-(?!automation)/i;
const EXCLUDE = /automation|agent-library|ai-provider-setup|ai-research-welcome-orb/i;

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

function hsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), delta = max - min;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (delta === 0) h = 0;
  else if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function isPurple(color) {
  const { h, s, l } = hsl(color);
  return s >= 0.22 && l > 0.05 && l < 0.97 && h >= 245 && h <= 305;
}

function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

// 保持亮度；色相向 262° 靠拢（偏冷）；饱和度压到原来的 ~55%，且不超过 0.5，仍然是看得出颜色的紫。
// 注意只压紫色，别的颜色（涨跌红绿、状态色）一概不动——压过头会让整个面板死气沉沉。
function calm(color) {
  const { s, l } = hsl(color);
  const [r, g, b] = fromHsl(262, Math.min(0.5, s * 0.55), l);
  const alpha = Math.round(color.a * 1000) / 1000;
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rewrite(prop, value) {
  const shadow = /shadow/i.test(prop) || (/^filter$/i.test(prop) && /drop-shadow/i.test(value));
  let changed = false;
  const next = value.replace(COLOR, (match) => {
    const color = parseColor(match);
    if (!isPurple(color)) return match;
    changed = true;
    return shadow ? "transparent" : calm(color);
  });
  return changed ? next : null;
}

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
    .filter((part) => part && INCLUDE.test(part) && !EXCLUDE.test(part) && !/^:root\b|^html\b|^body\b|^\*/.test(part))
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
 * phosphor-ai-calm.css — 由 scripts/generate-phosphor-ai-calm.mjs 生成，请勿手改。
 * 磷光外观下把 AI 研究里写死的鲜亮紫色压成低饱和灰紫，发光去掉。
 * 覆盖 ${rules} 条规则、${declarations} 处声明；样式改动后重新运行脚本。
 */
`;
fs.writeFileSync(OUTPUT, header + out.toString() + "\n");
console.log(`phosphor-ai-calm: ${rules} rules, ${declarations} declarations → ${path.relative(ROOT, OUTPUT)}`);
