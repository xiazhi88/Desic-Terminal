import { useEffect, useRef, useState } from "react";
import { applyVisualPreference, readVisualPreference, type VisualPreference } from "../../lib/visualPreference";
import { writeOdometer } from "./priceOdometer";
import "./shell.css";

// 开发者预览：/design-system-preview。只读取当前生效的 token 值，不进入用户导航。
// 右上角可临时切换磷光 / 经典做对比（不写入用户偏好）。

const SURFACES = ["--bg", "--panel", "--panel-2", "--surface-raised"];
const INKS = ["--text", "--muted", "--weak"];
const SIGNALS: Array<[string, string]> = [["--up", "涨 / 卖盘"], ["--down", "跌 / 买盘"], ["--ai", "AI"], ["--live", "实时"], ["--warn", "警示"], ["--danger", "危险"]];

function tokenValue(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "—";
}

export function DesignSystemPreview() {
  const [visual, setVisual] = useState<VisualPreference>(() => readVisualPreference());
  const [, forceRender] = useState(0);
  const odometerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    applyVisualPreference(visual);
    forceRender((value) => value + 1);
  }, [visual]);

  useEffect(() => {
    let price = 64_810.3;
    let previous = price;
    const tick = () => {
      previous = price;
      price = Math.round((price + (Math.random() - 0.5) * 12) * 10) / 10;
      if (odometerRef.current) writeOdometer(odometerRef.current, price.toLocaleString("en-US", { minimumFractionDigits: 1 }), Math.sign(price - previous));
    };
    tick();
    const timer = window.setInterval(tick, 900);
    return () => window.clearInterval(timer);
  }, [visual]);

  return (
    <main className="design-system-preview">
      <header>
        <div>
          <small>Desic Terminal · Design system</small>
          <h1>磷光：三条纪律先于任何组件</h1>
        </div>
        <div className="design-system-preview__switch" role="radiogroup" aria-label="外观">
          {(["phosphor", "classic"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={visual === value} onClick={() => setVisual(value)}>{value === "phosphor" ? "磷光" : "经典"}</button>
          ))}
        </div>
      </header>
      <section className="design-system-preview__rules">
        <article><small>01</small><strong>颜色只表达信息</strong><p>涨跌、买卖、状态才有颜色；按钮、标签、选中态都是中性墨色。紫色只属于 AI。</p></article>
        <article><small>02</small><strong>光只属于活数据</strong><p>发光 = 实时、正在变化、需要注意。静态内容、装饰与品牌标识一律不发光。</p></article>
        <article><small>03</small><strong>动效只解释变化</strong><p>数字只滚动变化的那一位；面板只在出现与消失时运动。120–420ms，全部有减弱动效回退。</p></article>
      </section>
      <section>
        <h2>表面 · 同一色相，只按亮度分层</h2>
        <div className="design-system-preview__swatches">
          {SURFACES.map((name) => <figure key={name}><span style={{ background: `var(${name})` }} /><figcaption><b>{name}</b><code>{tokenValue(name)}</code></figcaption></figure>)}
        </div>
      </section>
      <section>
        <h2>墨色与信号</h2>
        <div className="design-system-preview__swatches">
          {INKS.map((name) => <figure key={name}><span style={{ background: `var(${name})` }} /><figcaption><b>{name}</b><code>{tokenValue(name)}</code></figcaption></figure>)}
          {SIGNALS.map(([name, label]) => <figure key={name}><span style={{ background: `var(${name})` }} /><figcaption><b>{name} · {label}</b><code>{tokenValue(name)}</code></figcaption></figure>)}
        </div>
      </section>
      <section>
        <h2>数字与动效</h2>
        <div className="design-system-preview__specimens">
          <div><small>行情显示字体 · 里程表</small><span className="design-system-preview__price" ref={odometerRef} /></div>
          <div><small>等宽表格数字</small><span className="design-system-preview__mono">64,810.3 · 0.0100% · 1,821.93</span></div>
          <div><small>活数据点（唯一常驻呼吸的元素）</small><span className="design-system-preview__live"><i />实时连接</span></div>
        </div>
      </section>
    </main>
  );
}
