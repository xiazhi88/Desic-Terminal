import { useEffect, useId, useState, type FormEvent } from "react";
import { BarChart3, CircleAlert, Save, X } from "lucide-react";
import type {
  SystematicFactorDefinitionView,
  SystematicKlineBlendFactorDefinition
} from "../lib/systematic";
import { TerminalSelect } from "./TerminalSelect";
import "./SystematicFactorEditor.css";

type FactorDraft = {
  name: string;
  code: string;
  description: string;
  lookbackBars: number;
  momentumWeight: number;
  volatilityPenaltyWeight: number;
  volumeWeight: number;
};

type FactorSaveRequest = {
  id: string;
  name: string;
  code: string;
  description: string;
  definition: SystematicKlineBlendFactorDefinition;
  status: "draft" | "research";
};

type SystematicFactorEditorProps = {
  factor: SystematicFactorDefinitionView;
  chinese: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: (request: FactorSaveRequest) => Promise<void>;
};

const MIN_LOOKBACK_BARS = 5;
const MAX_LOOKBACK_BARS = 2_000;
const MAX_COMPONENT_WEIGHT = 5;

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function whole(value: unknown, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function initialDraft(factor: SystematicFactorDefinitionView): FactorDraft {
  const definition = factor.definition;
  return {
    name: factor.name,
    code: factor.code,
    description: factor.description,
    lookbackBars: whole(definition.lookbackBars, 60),
    momentumWeight: finite(definition.momentumWeight, 1),
    volatilityPenaltyWeight: finite(definition.volatilityPenaltyWeight, 1),
    volumeWeight: finite(definition.volumeWeight, 0.25)
  };
}

function persistedStatus(value: string): FactorSaveRequest["status"] {
  return value === "research" ? "research" : "draft";
}

function numericInput(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validationMessage(draft: FactorDraft, chinese: boolean) {
  const message = (zh: string, en: string) => chinese ? zh : en;
  if (!draft.name.trim()) return message("因子名称不能为空。", "Factor name is required.");
  if (draft.name.trim().length > 120) return message("因子名称不能超过 120 个字符。", "Factor name must be at most 120 characters.");
  const code = draft.code.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(code)) {
    return message("因子代码需以英文字母开头，长度为 2 至 32，仅限字母、数字、- 或 _。", "Factor code must start with a letter, be 2-32 characters, and use only letters, digits, - or _.");
  }
  if (draft.description.trim().length > 2_000) return message("研究说明不能超过 2,000 个字符。", "Research description must be at most 2,000 characters.");
  if (!Number.isInteger(draft.lookbackBars) || draft.lookbackBars < MIN_LOOKBACK_BARS || draft.lookbackBars > MAX_LOOKBACK_BARS) {
    return message(`回看周期必须是 ${MIN_LOOKBACK_BARS} 至 ${MAX_LOOKBACK_BARS} 的整数。`, `Lookback must be an integer between ${MIN_LOOKBACK_BARS} and ${MAX_LOOKBACK_BARS}.`);
  }
  if (!Number.isFinite(draft.momentumWeight) || Math.abs(draft.momentumWeight) > MAX_COMPONENT_WEIGHT) {
    return message(`动量权重必须介于 -${MAX_COMPONENT_WEIGHT} 和 ${MAX_COMPONENT_WEIGHT}。`, `Momentum weight must be between -${MAX_COMPONENT_WEIGHT} and ${MAX_COMPONENT_WEIGHT}.`);
  }
  if (!Number.isFinite(draft.volatilityPenaltyWeight) || draft.volatilityPenaltyWeight < 0 || draft.volatilityPenaltyWeight > MAX_COMPONENT_WEIGHT) {
    return message(`波动率惩罚必须介于 0 和 ${MAX_COMPONENT_WEIGHT}。`, `Volatility penalty must be between 0 and ${MAX_COMPONENT_WEIGHT}.`);
  }
  if (!Number.isFinite(draft.volumeWeight) || Math.abs(draft.volumeWeight) > MAX_COMPONENT_WEIGHT) {
    return message(`成交量权重必须介于 -${MAX_COMPONENT_WEIGHT} 和 ${MAX_COMPONENT_WEIGHT}。`, `Volume weight must be between -${MAX_COMPONENT_WEIGHT} and ${MAX_COMPONENT_WEIGHT}.`);
  }
  if (Math.abs(draft.momentumWeight) + draft.volatilityPenaltyWeight + Math.abs(draft.volumeWeight) <= Number.EPSILON) {
    return message("至少保留一个非零公式权重。", "Keep at least one non-zero formula weight.");
  }
  return null;
}

export function SystematicFactorEditor({ factor, chinese, isSaving, onClose, onSave }: SystematicFactorEditorProps) {
  const titleId = useId();
  const [draft, setDraft] = useState<FactorDraft>(() => initialDraft(factor));
  const [status, setStatus] = useState<FactorSaveRequest["status"]>(() => persistedStatus(factor.status));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSaving, onClose]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validationMessage(draft, chinese);
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    try {
      await onSave({
        id: factor.id,
        name: draft.name.trim(),
        code: draft.code.trim().toUpperCase(),
        description: draft.description.trim(),
        status,
        definition: {
          factorId: factor.id,
          lookbackBars: draft.lookbackBars,
          momentumWeight: draft.momentumWeight,
          volatilityPenaltyWeight: draft.volatilityPenaltyWeight,
          volumeWeight: draft.volumeWeight
        }
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  };

  return (
    <div className="systematic-factor-editor-backdrop">
      <section className="systematic-factor-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="systematic-factor-editor__header">
          <div>
            <span>{chinese ? "版本化 K 线因子" : "Versioned K-line factor"}</span>
            <strong id={titleId}>{chinese ? "编辑因子公式" : "Edit factor formula"}</strong>
          </div>
          <button type="button" className="systematic-factor-editor__close" onClick={onClose} disabled={isSaving} aria-label={chinese ? "关闭编辑器" : "Close editor"} title={chinese ? "关闭" : "Close"}><X size={17} /></button>
        </header>

        <form className="systematic-factor-editor__form" onSubmit={submit}>
          <fieldset disabled={isSaving}>
            <div className="systematic-factor-editor__grid systematic-factor-editor__grid--three">
              <label>
                <span>{chinese ? "因子名称" : "Factor name"}</span>
                <input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label>
                <span>{chinese ? "因子代码" : "Factor code"}</span>
                <input value={draft.code} maxLength={32} autoCapitalize="characters" spellCheck={false} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} />
              </label>
              <label>
                <span>{chinese ? "研究状态" : "Research state"}</span>
                <TerminalSelect
                  ariaLabel={chinese ? "研究状态" : "Research state"}
                  value={status}
                  options={[
                    { value: "draft", label: chinese ? "草稿" : "Draft", description: chinese ? "可编辑，仍可查看当前排名。" : "Editable; current ranking remains inspectable." },
                    { value: "research", label: chinese ? "研究" : "Research", description: chinese ? "可用于研究排名，不代表收益已验证。" : "Available for research ranks; not a performance claim." }
                  ]}
                  onChange={(value) => setStatus(value as FactorSaveRequest["status"])}
                  className="systematic-factor-editor__select"
                  maxMenuHeight={150}
                  disabled={isSaving}
                />
              </label>
            </div>

            <label className="systematic-factor-editor__description">
              <span>{chinese ? "研究说明" : "Research description"}</span>
              <textarea value={draft.description} maxLength={2_000} rows={2} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>

            <section className="systematic-factor-editor__formula" aria-label={chinese ? "因子公式" : "Factor formula"}>
              <div className="systematic-factor-editor__section-heading">
                <div><span>{chinese ? "横截面公式" : "Cross-sectional formula"}</span><strong>{chinese ? "在同一快照内标准化后排名" : "Standardize within one aligned snapshot"}</strong></div>
                <small>{chinese ? "权重不是预测置信度" : "Weights are not forecast confidence"}</small>
              </div>
              <code className="systematic-factor-editor__formula-code">score = wM · z(momentum N) - wRV · z(realised vol N) + wV · z(volume ratio N)</code>
              <div className="systematic-factor-editor__grid systematic-factor-editor__grid--four">
                <NumberField label={chinese ? "回看 K 线 (N)" : "Lookback bars (N)"} value={draft.lookbackBars} min={MIN_LOOKBACK_BARS} max={MAX_LOOKBACK_BARS} step={1} onChange={(value) => setDraft({ ...draft, lookbackBars: value })} />
                <NumberField label={chinese ? "动量权重 (wM)" : "Momentum weight (wM)"} value={draft.momentumWeight} min={-MAX_COMPONENT_WEIGHT} max={MAX_COMPONENT_WEIGHT} step="0.05" onChange={(value) => setDraft({ ...draft, momentumWeight: value })} />
                <NumberField label={chinese ? "波动率惩罚 (wRV)" : "Volatility penalty (wRV)"} value={draft.volatilityPenaltyWeight} min={0} max={MAX_COMPONENT_WEIGHT} step="0.05" onChange={(value) => setDraft({ ...draft, volatilityPenaltyWeight: value })} />
                <NumberField label={chinese ? "成交量权重 (wV)" : "Volume weight (wV)"} value={draft.volumeWeight} min={-MAX_COMPONENT_WEIGHT} max={MAX_COMPONENT_WEIGHT} step="0.05" onChange={(value) => setDraft({ ...draft, volumeWeight: value })} />
              </div>
            </section>

            <section className="systematic-factor-editor__boundary" aria-label={chinese ? "数据边界" : "Data boundary"}>
              <BarChart3 size={15} />
              <div><strong>{chinese ? "仅本地已确认 1 分钟 K 线" : "Confirmed local 1m K-lines only"}</strong><p>{chinese ? "评分不读取未来 K 线、资金费率、未平仓量、盘口或账户数据；结果是当前快照内的研究排序。" : "The score reads no future bars, funding, open interest, order book, or account data. It is a research rank within the current snapshot."}</p></div>
            </section>
          </fieldset>

          {error ? <p className="systematic-factor-editor__error" role="alert"><CircleAlert size={15} />{error}</p> : null}
          <footer>
            <p><CircleAlert size={14} />{chinese ? "保存会递增版本；本版不把因子接入纸面或实盘委托。" : "Saving increments the version; this release does not route factors to paper or live orders."}</p>
            <div>
              <button type="button" className="systematic-factor-editor__secondary" onClick={onClose} disabled={isSaving}>{chinese ? "取消" : "Cancel"}</button>
              <button type="submit" className="systematic-factor-editor__save" disabled={isSaving}><Save size={15} />{isSaving ? (chinese ? "保存中" : "Saving") : (chinese ? "保存因子" : "Save factor")}</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min?: number; max?: number; step?: number | string; onChange: (value: number) => void }) {
  return <label className="systematic-factor-editor__number"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(numericInput(event.target.value))} /></label>;
}
