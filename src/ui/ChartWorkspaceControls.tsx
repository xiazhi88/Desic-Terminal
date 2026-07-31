import { Columns2, Grid2X2, LayoutPanelTop, PanelsTopLeft, Rows3 } from "lucide-react";
import {
  setChartWorkspaceLayout,
  type ChartWorkspaceDocument,
  type ChartWorkspaceLayout,
  type ChartWorkspaceOrientation,
} from "../lib/chartWorkspace";
import "./ChartWorkspaceControls.css";

type Props = {
  document: ChartWorkspaceDocument;
  onChange: (document: ChartWorkspaceDocument) => void;
  disabled?: boolean;
  vertical?: boolean;
};

const LAYOUTS: readonly { value: ChartWorkspaceLayout; orientation?: ChartWorkspaceOrientation; label: string; Icon: typeof LayoutPanelTop }[] = [
  { value: 1, label: "单图", Icon: LayoutPanelTop },
  { value: 2, orientation: "horizontal", label: "双图左右", Icon: Columns2 },
  { value: 2, orientation: "vertical", label: "双图上下", Icon: Rows3 },
  { value: 3, label: "三图", Icon: PanelsTopLeft },
  { value: 4, label: "四图", Icon: Grid2X2 },
];

/** The detached workspace toolbar intentionally only controls its layout. */
export function ChartWorkspaceControls({ document, onChange, disabled = false, vertical = false }: Props) {
  return (
    <section className={`chart-workspace-controls chart-workspace-controls--layout-only${vertical ? " chart-workspace-controls--vertical" : ""}`} aria-label="图表布局">
      <div className="chart-workspace-controls__group" aria-label="图表布局">
        <span className="chart-workspace-controls__label">布局</span>
        <div className="chart-workspace-controls__segmented" role="group" aria-label="选择图表布局">
          {LAYOUTS.map(({ value, orientation, label, Icon }) => {
            const active = document.layout === value && (value !== 2 || document.layoutOrientation === orientation);
            return (
              <button
                type="button"
                key={`${value}-${orientation ?? "default"}`}
                className={active ? "is-active" : undefined}
                disabled={disabled}
                onClick={() => onChange(setChartWorkspaceLayout(document, value, orientation ?? document.layoutOrientation))}
                title={label}
                aria-label={label}
              >
                <Icon size={14} />
                <span>{vertical ? label : value === 2 ? orientation === "vertical" ? "2V" : "2H" : value}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
