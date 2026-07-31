import { FolderOpen, LayoutTemplate, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  applyChartLayoutTemplate,
  createChartLayoutTemplate,
  defaultChartPaneLayoutSizing,
  deleteChartLayoutTemplate,
  loadChartLayoutTemplates,
  saveChartLayoutTemplate,
  type ChartPaneLayoutSizing,
  type ChartLayoutTemplate,
} from "../lib/chartLayoutTemplates";
import type { ChartWorkspaceDocument } from "../lib/chartWorkspace";
import { TerminalSelect } from "./TerminalSelect";
import "./ChartWorkspaceTemplates.css";

export type ChartWorkspaceTemplateManagerProps = {
  document: ChartWorkspaceDocument;
  sizing?: ChartPaneLayoutSizing;
  storageKey?: string;
  disabled?: boolean;
  onDocumentChange: (document: ChartWorkspaceDocument) => void;
  onSizingChange?: (sizing: ChartPaneLayoutSizing) => void;
};

/**
 * Named layout templates for chart windows. Templates deliberately preserve
 * pane layout/timeframe/indicators only; applying one never replaces symbols.
 */
export function ChartWorkspaceTemplateManager({
  document,
  sizing = defaultChartPaneLayoutSizing(),
  storageKey,
  disabled = false,
  onDocumentChange,
  onSizingChange,
}: ChartWorkspaceTemplateManagerProps) {
  const [templates, setTemplates] = useState<ChartLayoutTemplate[]>(() => loadChartLayoutTemplates(storageKey));
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const selected = useMemo(() => templates.find((template) => template.id === selectedId) ?? null, [selectedId, templates]);

  useEffect(() => {
    setTemplates(loadChartLayoutTemplates(storageKey));
  }, [storageKey]);

  const save = () => {
    if (disabled) return;
    const template = createChartLayoutTemplate(document, name || `布局 ${document.layout} 图`, sizing);
    const next = saveChartLayoutTemplate(template, storageKey);
    setTemplates(next);
    setSelectedId(template.id);
    setName("");
  };

  const load = () => {
    if (disabled || !selected) return;
    const next = applyChartLayoutTemplate(document, selected);
    onDocumentChange(next.document);
    onSizingChange?.(next.sizing);
  };

  const remove = () => {
    if (disabled || !selectedId || selected?.builtIn) return;
    const next = deleteChartLayoutTemplate(selectedId, storageKey);
    setTemplates(next);
    setSelectedId("");
  };

  return (
    <section className="chart-workspace-template-manager" aria-label="图表布局模板">
      <div className="chart-workspace-template-manager__identity">
        <LayoutTemplate size={14} />
        <div>
          <strong>布局模板</strong>
          <span>仅保存窗格、周期与指标</span>
        </div>
      </div>

      <div className="chart-workspace-template-manager__load">
        <TerminalSelect
          ariaLabel="选择布局模板"
          value={selectedId}
          disabled={disabled || templates.length === 0}
          options={[
            { value: "", label: templates.length ? "选择已保存的模板" : "暂无已保存模板" },
            ...templates.map((template) => ({ value: template.id, label: `${template.builtIn ? "内置 · " : ""}${template.name} · ${template.layout} 图` }))
          ]}
          onChange={setSelectedId}
        />
        <button type="button" disabled={disabled || !selected} onClick={load} title="应用布局、周期和指标，保留当前交易对">
          <FolderOpen size={13} />
          <span>载入</span>
        </button>
        <button type="button" className="chart-workspace-template-manager__delete" disabled={disabled || !selected || Boolean(selected?.builtIn)} onClick={remove} title={selected?.builtIn ? "内置模板不可删除" : "删除该布局模板"}>
          <Trash2 size={13} />
        </button>
      </div>

      <div className="chart-workspace-template-manager__save">
        <input
          aria-label="新布局模板名称"
          value={name}
          maxLength={64}
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
          placeholder={`保存当前 ${document.layout} 图布局`}
        />
        <button type="button" className="chart-workspace-template-manager__save-button" disabled={disabled} onClick={save}>
          <Save size={13} />
          <span>保存模板</span>
        </button>
      </div>
    </section>
  );
}
