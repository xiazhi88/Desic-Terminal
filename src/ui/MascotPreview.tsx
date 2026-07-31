const mascotImage = "/assets/cyber-snow-leopard-cutout.png";

export function MascotPreview() {
  return (
    <main className="mascot25d" aria-label="赛博雪豹 2.5D 悬浮动画预览">
      <div className="mascot25d-character" aria-hidden="true">
        <div className="mascot25d-floor" />
        <div className="mascot25d-shadow" />
        <img className="mascot25d-base" src={mascotImage} alt="" />
        <img className="mascot25d-depth depth-back" src={mascotImage} alt="" />
        <img className="mascot25d-depth depth-face" src={mascotImage} alt="" />
        <div className="mascot25d-eye eye-left" />
        <div className="mascot25d-eye eye-right" />
        <div className="mascot25d-blink blink-left" />
        <div className="mascot25d-blink blink-right" />
        <div className="mascot25d-paw-glow" />
        <div className="mascot25d-collar collar-a" />
        <div className="mascot25d-collar collar-b" />
        <div className="mascot25d-circuit circuit-body" />
        <div className="mascot25d-circuit circuit-tail" />
        <svg className="mascot25d-chart" viewBox="0 0 360 300" role="img" aria-label="动态行情线">
          <defs>
            <filter id="chartGlow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <path className="chart-line chart-line-back" d="M18 238 L62 210 L96 218 L136 164 L178 118 L218 148 L258 96 L316 52" />
          <path className="chart-line" d="M18 238 L62 210 L96 218 L136 164 L178 118 L218 148 L258 96 L316 52" />
          <g className="candles">
            <path d="M78 184 V252" />
            <rect x="66" y="204" width="24" height="38" rx="3" />
            <path d="M128 126 V198" />
            <rect x="116" y="142" width="24" height="42" rx="3" />
            <path d="M176 86 V158" />
            <rect x="164" y="108" width="24" height="36" rx="3" />
          </g>
        </svg>
      </div>
    </main>
  );
}
