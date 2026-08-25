import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, HelpCircle, Plus, Trash2 } from "lucide-react";
import {
  composeSystematicFactorExpression,
  type SystematicFactorBuilderCatalogue,
  type SystematicFactorComposeStage,
  type SystematicFactorOperatorDescriptor
} from "../lib/systematic";

/**
 * Structured factor builder.
 *
 * A factor is assembled by choosing a measure and then a chain of stages, never
 * by typing the underlying syntax tree. The removed editor exposed raw JSON,
 * which asked the user to learn a representation instead of expressing a
 * decision — and made a malformed factor easy to save.
 *
 * The catalogue of sources and operators comes from the evaluator's own crate, so
 * this component cannot offer something the evaluator would reject. The host also
 * performs the assembly and validation, so an invalid combination is reported
 * while editing rather than at save time.
 *
 * Stage order is meaningful and editable. `ts_rank` after `cs_rank` reads "rank
 * across the market, then judge that standing against its own history", which is
 * a different factor from the reverse — a distinction a flat weight editor cannot
 * express at all.
 */

export type ExpressionDraft = {
  sourceId: string;
  sourceWindow: number;
  stages: SystematicFactorComposeStage[];
};

type Props = Readonly<{
  catalogue: SystematicFactorBuilderCatalogue | null;
  draft: ExpressionDraft;
  chinese: boolean;
  desktop: boolean;
  onChange: (draft: ExpressionDraft) => void;
  /** Called with the validated expression, or null while it is invalid. */
  onComposed: (expression: Record<string, unknown> | null) => void;
}>;

export function SystematicFactorExpressionBuilder({
  catalogue,
  draft,
  chinese,
  desktop,
  onChange,
  onComposed
}: Props) {
  const text = useMemo(() => builderCopy(chinese), [chinese]);
  const [error, setError] = useState<string | null>(null);
  const [formula, setFormula] = useState<string>("");

  const source = catalogue?.sources.find((item) => item.id === draft.sourceId) ?? null;
  const operatorsById = useMemo(() => {
    const map = new Map<string, SystematicFactorOperatorDescriptor>();
    for (const operator of catalogue?.operators ?? []) map.set(operator.id, operator);
    return map;
  }, [catalogue]);

  // The formula text is derived locally for immediate feedback while typing; the
  // host remains the authority on whether the expression is actually valid.
  useEffect(() => {
    if (!source) {
      setFormula("");
      return;
    }
    const label = chinese ? source.labelZh : source.labelEn;
    let rendered = source.takesWindow ? `${label}(${draft.sourceWindow})` : label;
    for (const stage of draft.stages) {
      const operator = operatorsById.get(stage.op);
      if (!operator) continue;
      const args: string[] = [rendered];
      if (operator.takesWindow) args.push(String(stage.window ?? 60));
      if (operator.takesDirection) {
        args.push(stage.ascending === false ? text.descending : text.ascending);
      }
      rendered = `${operator.name}(${args.join(", ")})`;
    }
    setFormula(rendered);
  }, [source, draft, operatorsById, chinese, text.ascending, text.descending]);

  // Compose through the host so validation matches the evaluator exactly.
  const compose = useCallback(async () => {
    if (!desktop || !catalogue) return;
    try {
      const expression = await composeSystematicFactorExpression({
        sourceId: draft.sourceId,
        sourceWindow: draft.sourceWindow,
        stages: draft.stages
      });
      setError(null);
      onComposed(expression ?? null);
    } catch (composeError) {
      const message =
        composeError instanceof Error ? composeError.message : String(composeError);
      setError(message);
      // A failed composition must not leave a stale valid expression behind, or
      // the user could save something they are no longer looking at.
      onComposed(null);
    }
  }, [desktop, catalogue, draft, onComposed]);

  useEffect(() => {
    const timer = window.setTimeout(() => void compose(), 250);
    return () => window.clearTimeout(timer);
  }, [compose]);

  const hasCrossSection = draft.stages.some(
    (stage) => operatorsById.get(stage.op)?.scope === "crossSection"
  );

  const addStage = (op: string) => {
    const operator = operatorsById.get(op);
    if (!operator) return;
    onChange({
      ...draft,
      stages: [
        ...draft.stages,
        {
          op,
          window: operator.takesWindow ? 60 : undefined,
          ascending: operator.takesDirection ? true : undefined
        }
      ]
    });
  };

  const updateStage = (index: number, patch: Partial<SystematicFactorComposeStage>) => {
    onChange({
      ...draft,
      stages: draft.stages.map((stage, position) =>
        position === index ? { ...stage, ...patch } : stage
      )
    });
  };

  const removeStage = (index: number) => {
    onChange({ ...draft, stages: draft.stages.filter((_, position) => position !== index) });
  };

  const moveStage = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.stages.length) return;
    const stages = [...draft.stages];
    const [moved] = stages.splice(index, 1);
    stages.splice(target, 0, moved);
    onChange({ ...draft, stages });
  };

  if (!catalogue) {
    return <p className="systematic-factor-panel__hint">{text.loadingCatalogue}</p>;
  }

  const stageLimitReached = draft.stages.length >= catalogue.maxPipelineStages;

  return (
    <div className="systematic-factor-builder">
      {/* The rendered formula is the primary feedback: it states what the
          selections mean in one line, so the chain below can stay terse. */}
      <code className="systematic-factor-panel__formula">{formula || text.chooseSource}</code>

      <div className="systematic-factor-builder__section">
        <label className="systematic-factor-builder__field">
          <span>
            {text.source}
            <HintButton hint={text.sourceHint} label={text.source} />
          </span>
          <select
            value={draft.sourceId}
            onChange={(event) => {
              const next = catalogue.sources.find((item) => item.id === event.target.value);
              onChange({
                ...draft,
                sourceId: event.target.value,
                sourceWindow: next?.defaultWindow ?? draft.sourceWindow
              });
            }}
          >
            {catalogue.sources.map((item) => (
              <option key={item.id} value={item.id}>
                {chinese ? item.labelZh : item.labelEn}
              </option>
            ))}
          </select>
        </label>
        {source?.takesWindow ? (
          <label className="systematic-factor-builder__field">
            <span>{text.lookback}</span>
            <input
              type="number"
              min={2}
              max={catalogue.maxWindowBars}
              value={draft.sourceWindow}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) {
                  onChange({ ...draft, sourceWindow: Math.round(parsed) });
                }
              }}
            />
          </label>
        ) : null}
      </div>
      {source ? (
        <p className="systematic-factor-builder__detail">
          {chinese ? source.detailZh : source.detailEn}
        </p>
      ) : null}

      <div className="systematic-factor-builder__chain-head">
        <span>{text.stages}</span>
        <small>{text.stagesHint}</small>
      </div>

      {draft.stages.length === 0 ? (
        <p className="systematic-factor-panel__hint">{text.noStages}</p>
      ) : (
        <ol className="systematic-factor-builder__chain">
          {draft.stages.map((stage, index) => {
            const operator = operatorsById.get(stage.op);
            if (!operator) return null;
            return (
              <li key={`${stage.op}-${index}`} className="systematic-factor-builder__stage">
                <span
                  className={`systematic-factor-builder__scope is-${operator.scope}`}
                  title={
                    operator.scope === "crossSection" ? text.scopeCross : text.scopeTime
                  }
                >
                  {operator.scope === "crossSection" ? text.scopeCrossShort : text.scopeTimeShort}
                </span>
                <span className="systematic-factor-builder__stage-name">
                  <code>{operator.name}</code>
                  <small>{chinese ? operator.labelZh : operator.labelEn}</small>
                </span>
                {operator.takesWindow ? (
                  <input
                    type="number"
                    min={2}
                    max={catalogue.maxWindowBars}
                    value={stage.window ?? 60}
                    aria-label={text.lookback}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (Number.isFinite(parsed)) {
                        updateStage(index, { window: Math.round(parsed) });
                      }
                    }}
                  />
                ) : (
                  <span />
                )}
                {operator.takesDirection ? (
                  <select
                    value={stage.ascending === false ? "desc" : "asc"}
                    aria-label={text.direction}
                    onChange={(event) =>
                      updateStage(index, { ascending: event.target.value === "asc" })
                    }
                  >
                    <option value="asc">{text.ascending}</option>
                    <option value="desc">{text.descending}</option>
                  </select>
                ) : (
                  <span />
                )}
                <span className="systematic-factor-builder__stage-actions">
                  <button
                    type="button"
                    onClick={() => moveStage(index, -1)}
                    disabled={index === 0}
                    title={text.moveUp}
                    aria-label={text.moveUp}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStage(index, 1)}
                    disabled={index === draft.stages.length - 1}
                    title={text.moveDown}
                    aria-label={text.moveDown}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStage(index)}
                    title={text.removeStage}
                    aria-label={text.removeStage}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="systematic-factor-builder__add">
        {catalogue.operators.map((operator) => (
          <button
            key={operator.id}
            type="button"
            className="systematic-lab__command-button is-quiet"
            onClick={() => addStage(operator.id)}
            disabled={stageLimitReached}
            title={chinese ? operator.detailZh : operator.detailEn}
          >
            <Plus size={11} />
            {operator.name}
          </button>
        ))}
      </div>

      {/* A factor without a cross-sectional stage produces values that are not
          comparable between instruments, so ranking them would be meaningless.
          Saying so here is more useful than rejecting the save later. */}
      {!hasCrossSection ? (
        <p className="systematic-factor-builder__warning">
          <CircleAlert size={12} />
          {text.needsCrossSection}
        </p>
      ) : null}
      {error ? (
        <p className="systematic-factor-builder__warning is-error">
          <CircleAlert size={12} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HintButton({ hint, label }: Readonly<{ hint: string; label: string }>) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="systematic-factor-panel__help"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`${label}: ${hint}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle size={12} />
      </button>
      {open ? (
        <span className="systematic-factor-panel__help-bubble" role="tooltip">
          {hint}
        </span>
      ) : null}
    </span>
  );
}

type BuilderCopy = ReturnType<typeof builderCopy>;

function builderCopy(chinese: boolean) {
  if (chinese) {
    return {
      loadingCatalogue: "正在加载可用算子…",
      chooseSource: "请选择一个基础measure",
      source: "基础指标",
      sourceHint:
        "因子的起点。所有选项都是无量纲的（比率或百分比），因为直接用价格排名会按币价高低排序，而不是按行为排序——这是自定义因子最常见的错误。",
      lookback: "回看（根）",
      stages: "算子链",
      stagesHint: "顺序有意义：先截面排名再看自身历史，与反过来是两个不同的因子",
      noStages: "还没有算子。至少需要一个截面算子，分数才能在合约之间比较。",
      scopeCross: "截面算子：在同一时刻跨合约计算",
      scopeTime: "时序算子：在单个合约内沿时间计算",
      scopeCrossShort: "截面",
      scopeTimeShort: "时序",
      ascending: "升序",
      descending: "降序",
      direction: "排序方向",
      moveUp: "上移",
      moveDown: "下移",
      removeStage: "删除该算子",
      needsCrossSection:
        "缺少截面算子。没有它，分数只是每个合约各自的数值，无法横向比较，也无法排名。"
    };
  }
  return {
    loadingCatalogue: "Loading available operators...",
    chooseSource: "Choose a base measure",
    source: "Base measure",
    sourceHint:
      "Where the factor starts. Every option is unit-free (a ratio or a percentage), because ranking on raw price orders instruments by denomination rather than behaviour — the most common way a first factor goes wrong.",
    lookback: "Lookback (bars)",
    stages: "Operator chain",
    stagesHint:
      "Order matters: ranking across the market then against own history is a different factor from the reverse",
    noStages:
      "No operators yet. At least one cross-sectional operator is needed for scores to be comparable between instruments.",
    scopeCross: "Cross-sectional: computed across instruments at one timestamp",
    scopeTime: "Time-series: computed along time within one instrument",
    scopeCrossShort: "CS",
    scopeTimeShort: "TS",
    ascending: "Ascending",
    descending: "Descending",
    direction: "Sort direction",
    moveUp: "Move up",
    moveDown: "Move down",
    removeStage: "Remove this operator",
    needsCrossSection:
      "No cross-sectional operator. Without one the scores are per-instrument values that cannot be compared or ranked."
  };
}
