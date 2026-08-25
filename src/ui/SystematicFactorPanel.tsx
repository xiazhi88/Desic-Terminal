import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  BarChart3,
  ChevronRight,
  CircleAlert,
  Download,
  FileChartColumn,
  FilePlus2,
  HelpCircle,
  LoaderCircle,
  Play,
  Save,
  SlidersHorizontal,
  Trash2,
  X
} from "lucide-react";
import {
  cancelSystematicFactorEvaluation,
  createDefaultSystematicFactor,
  deleteSystematicFactor,
  evaluateSystematicFactor,
  loadSystematicFactorEvaluations,
  previewSystematicFactor,
  repairSystematicFactorData,
  saveSystematicFactor,
  startSystematicFactorEvaluation,
  type SystematicFactorCoverageDiagnostics,
  type SystematicFactorDefinitionView,
  type SystematicFactorEvaluationRecordView,
  type SystematicFactorView,
  loadSystematicFactorBuilderCatalogue,
  type SystematicFactorBuilderCatalogue,
  type SystematicKlineBlendFactorDefinition
} from "../lib/systematic";
import { SystematicFactorReport } from "./SystematicFactorReport";
import {
  SystematicFactorExpressionBuilder,
  type ExpressionDraft
} from "./SystematicFactorExpressionBuilder";
import { SymbolIcon } from "./SymbolIcon";
import "./SystematicFactorPanel.css";

/**
 * Factor workbench.
 *
 * The builder is the primary surface, not a catalogue. A factor library here is a
 * generative namespace rather than a finite list — a formula crossed with its
 * windows and weights — so the main interaction is constructing one and saving
 * what you built. The left column is therefore "what I saved", closer to
 * bookmarks than to a product listing.
 *
 * Adjusting a formula re-ranks without saving. Requiring a save to see a result
 * was the slowest loop in the removed implementation, and it forced a version
 * bump for every experiment.
 */

/** Matches the notification shape the surrounding lab already passes down. */
type Notify = (notification: {
  kind: "success" | "info" | "warning" | "error";
  title: string;
  message: string;
}) => void;

type Props = Readonly<{
  factors: SystematicFactorDefinitionView[];
  chinese: boolean;
  desktop: boolean;
  watchlist: string[];
  refresh: () => Promise<void>;
  onNotify: Notify;
  onUseForBacktest: (instId: string) => void;
  onAddToWatchlist?: (instId: string) => void;
}>;

type BlendDraft = {
  name: string;
  code: string;
  description: string;
  lookbackBars: number;
  momentumWeight: number;
  volatilityPenaltyWeight: number;
  volumeWeight: number;
};

const PREVIEW_DEBOUNCE_MS = 300;
type FactorPanelView = "workbench" | "conclusion";

export function SystematicFactorPanel({
  factors,
  chinese,
  desktop,
  watchlist,
  refresh,
  onNotify,
  onUseForBacktest,
  onAddToWatchlist
}: Props) {
  const text = useMemo(() => panelCopy(chinese), [chinese]);
  const [selectedId, setSelectedId] = useState<string | null>(factors[0]?.id ?? null);
  const [draft, setDraft] = useState<BlendDraft | null>(null);
  const [rows, setRows] = useState<SystematicFactorView[]>([]);
  const [diagnostics, setDiagnostics] = useState<SystematicFactorCoverageDiagnostics | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [evaluations, setEvaluations] = useState<SystematicFactorEvaluationRecordView[]>([]);
  const [activeEvaluation, setActiveEvaluation] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<FactorPanelView>("workbench");
  // Counting previews is what lets the report say how many attempts preceded a
  // result: selecting the best of many inflates it, so the count has to travel
  // with the conclusion.
  const [previewCount, setPreviewCount] = useState(0);
  const [catalogue, setCatalogue] = useState<SystematicFactorBuilderCatalogue | null>(null);
  const [expressionDraft, setExpressionDraft] = useState<ExpressionDraft>({
    sourceId: "trailingReturn",
    sourceWindow: 1_440,
    stages: [{ op: "csRank", ascending: true }]
  });
  // The host-composed expression, or null while the selections are invalid. Saving
  // is blocked on null so a malformed factor cannot be stored.
  const [composedExpression, setComposedExpression] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);

  // The catalogue is static for a session, so it is fetched once.
  useEffect(() => {
    if (!desktop) return;
    void loadSystematicFactorBuilderCatalogue()
      .then((value) => setCatalogue(value ?? null))
      .catch(() => setCatalogue(null));
  }, [desktop]);

  const selected = useMemo(
    () => factors.find((factor) => factor.id === selectedId) ?? null,
    [factors, selectedId]
  );

  useEffect(() => {
    if (!selectedId && factors.length > 0) setSelectedId(factors[0].id);
  }, [factors, selectedId]);

  // Reset the draft whenever the selection changes so edits cannot leak between
  // factors.
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      return;
    }
    const definition = selected.definition as SystematicKlineBlendFactorDefinition;
    setDraft({
      name: selected.name,
      code: selected.code,
      description: selected.description,
      lookbackBars: whole(definition?.lookbackBars, 60),
      momentumWeight: finite(definition?.momentumWeight, 1),
      volatilityPenaltyWeight: finite(definition?.volatilityPenaltyWeight, 1),
      volumeWeight: finite(definition?.volumeWeight, 0.25)
    });
    setPreviewCount(0);
  }, [selected]);

  const loadSaved = useCallback(
    async (factorId: string) => {
      if (!desktop) return;
      setLoading(true);
      try {
        const result = await evaluateSystematicFactor(factorId);
        if (!result) return;
        setRows(result.factors);
        setDiagnostics(result.diagnostics ?? null);
        setUnavailableReason(result.unavailableReason ?? null);
      } catch (error) {
        onNotify({
          kind: "error",
          title: text.rankingFailed,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setLoading(false);
      }
    },
    [desktop, onNotify, text.rankingFailed]
  );

  useEffect(() => {
    if (selectedId) void loadSaved(selectedId);
  }, [selectedId, loadSaved]);

  // Do not display the previous factor's report while the next factor's records
  // are loading. The selected tab is preserved, which makes comparison efficient,
  // but its contents must always belong to the selected factor.
  useEffect(() => {
    setEvaluations([]);
    setActiveEvaluation(null);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !desktop) return;
    let current = true;
    void loadSystematicFactorEvaluations(selectedId)
      .then((records) => {
        if (current) setEvaluations(records ?? []);
      })
      .catch(() => {
        if (current) setEvaluations([]);
      });
    return () => {
      current = false;
    };
  }, [selectedId, desktop, evaluating]);

  // Debounced preview: the ranking follows the sliders without a save.
  const previewTimer = useRef<number | null>(null);
  const requestPreview = useCallback(
    (next: BlendDraft) => {
      if (!selected || !desktop) return;
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      previewTimer.current = window.setTimeout(() => {
        void previewSystematicFactor({
          factorId: selected.id,
          definition: {
            kind: "klineBlend",
            factorId: selected.id,
            lookbackBars: next.lookbackBars,
            momentumWeight: next.momentumWeight,
            volatilityPenaltyWeight: next.volatilityPenaltyWeight,
            volumeWeight: next.volumeWeight
          }
        })
          .then((result) => {
            if (!result) return;
            setRows(result.factors);
            setDiagnostics(result.diagnostics ?? null);
            setUnavailableReason(result.unavailableReason ?? null);
            setPreviewCount((count) => count + 1);
          })
          .catch((error) => {
            onNotify({
              kind: "error",
              title: text.previewFailed,
              message: error instanceof Error ? error.message : String(error)
            });
          });
      }, PREVIEW_DEBOUNCE_MS);
    },
    [selected, desktop, onNotify, text.previewFailed]
  );

  useEffect(
    () => () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    },
    []
  );

  // Expression edits re-rank exactly like weight edits do, so the ranking always
  // reflects what is on screen rather than what was last saved.
  useEffect(() => {
    if (!selected || selected.kind !== "expression" || !composedExpression || !desktop) return;
    const timer = window.setTimeout(() => {
      void previewSystematicFactor({
        factorId: selected.id,
        definition: {
          kind: "expression",
          factorId: selected.id,
          expression: composedExpression
        } as unknown as SystematicKlineBlendFactorDefinition
      })
        .then((result) => {
          if (!result) return;
          setRows(result.factors);
          setDiagnostics(result.diagnostics ?? null);
          setUnavailableReason(result.unavailableReason ?? null);
          setPreviewCount((count) => count + 1);
        })
        .catch(() => {
          // The builder already surfaces composition errors inline; a failed
          // preview must not replace that with a second, vaguer message.
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [selected, composedExpression, desktop]);

  const updateDraft = (patch: Partial<BlendDraft>) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      // Formula edits re-rank; prose edits do not need a recomputation.
      if (
        patch.lookbackBars !== undefined ||
        patch.momentumWeight !== undefined ||
        patch.volatilityPenaltyWeight !== undefined ||
        patch.volumeWeight !== undefined
      ) {
        requestPreview(next);
      }
      return next;
    });
  };

  /**
   * Creates a factor, optionally from a preset.
   *
   * A preset is a starting point rather than a catalogue entry: this factor
   * library is a generative namespace, so the useful thing to offer is something
   * that already works and can then be edited, not a list to pick from.
   */
  const create = async (presetId?: string) => {
    setSaving(true);
    try {
      const created = await createDefaultSystematicFactor();
      if (!created) return;
      const preset = catalogue?.presets.find((item) => item.id === presetId);
      if (preset) {
        // Presets are expressions, so the new factor is immediately rewritten as
        // one. Its evidence-supported direction is recorded in the description so
        // the report can judge the measured sign against the intended one.
        await saveSystematicFactor({
          id: created.id,
          name: chinese ? preset.labelZh : preset.labelEn,
          code: created.code,
          description: `${text.presetOrigin} ${preset.id} · ${text.expectedSign}: ${preset.expectedSign}`,
          status: "draft",
          definition: {
            kind: "expression",
            factorId: created.id,
            expression: preset.expression
          } as unknown as SystematicKlineBlendFactorDefinition
        });
      }
      await refresh();
      setSelectedId(created.id);
      setPresetPickerOpen(false);
    } catch (error) {
      onNotify({
        kind: "error",
        title: text.createFailed,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!selected || !draft) return;
    const isExpression = selected.kind === "expression";
    // Saving is blocked while the composition is invalid, so a malformed factor
    // cannot reach storage and later fail at scoring time.
    if (isExpression && !composedExpression) {
      onNotify({
        kind: "warning",
        title: text.saveFailed,
        message: text.expressionInvalid
      });
      return;
    }
    setSaving(true);
    try {
      await saveSystematicFactor({
        id: selected.id,
        name: draft.name,
        code: draft.code,
        description: draft.description,
        status: selected.status === "research" ? "research" : "draft",
        definition: isExpression
          ? ({
              kind: "expression",
              factorId: selected.id,
              expression: composedExpression
            } as unknown as SystematicKlineBlendFactorDefinition)
          : {
              kind: "klineBlend",
              factorId: selected.id,
              lookbackBars: draft.lookbackBars,
              momentumWeight: draft.momentumWeight,
              volatilityPenaltyWeight: draft.volatilityPenaltyWeight,
              volumeWeight: draft.volumeWeight
            }
      });
      await refresh();
      onNotify({ kind: "success", title: text.saved, message: text.savedDetail });
    } catch (error) {
      onNotify({
        kind: "error",
        title: text.saveFailed,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (factor: SystematicFactorDefinitionView) => {
    try {
      await deleteSystematicFactor(factor.id);
      await refresh();
      setSelectedId(null);
    } catch (error) {
      onNotify({
        kind: "error",
        title: text.deleteFailed,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const repair = async () => {
    if (!selected) return;
    setRepairing(true);
    try {
      const result = await repairSystematicFactorData(selected.id);
      if (result) {
        onNotify({
          kind: result.repaired > 0 ? "success" : "info",
          title: text.repairDone,
          // Stating what is left matters more than what was done: a pass is
          // deliberately small, so knowing another is needed is the actionable
          // part.
          message: text.repairSummary
            .replace("{repaired}", String(result.repaired))
            .replace("{attempted}", String(result.attempted))
            .replace("{days}", String(result.daysPerInstrument))
            .replace("{remaining}", String(result.remaining))
        });
      }
      await loadSaved(selected.id);
    } catch (error) {
      onNotify({
        kind: "error",
        title: text.repairFailed,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setRepairing(false);
    }
  };

  const evaluate = async () => {
    if (!selected) return;
    setEvaluating(true);
    try {
      const record = await startSystematicFactorEvaluation({ factorId: selected.id });
      if (record) {
        setEvaluations((items) => [record, ...items.filter((item) => item.id !== record.id)]);
        setActiveEvaluation(record.id);
        // Finishing an evaluation is an explicit transition from construction to
        // interpretation, so take the user directly to the conclusion instead of
        // appending a long report below the editor.
        setActiveView("conclusion");
        onNotify({
          kind: record.overallLevel === "fail" ? "warning" : "success",
          title: text.evaluationDone,
          message: text.evaluationSummary.replace(
            "{points}",
            String(record.metrics?.gridPoints ?? 0)
          )
        });
      }
    } catch (error) {
      onNotify({
        kind: "error",
        title: text.evaluationFailed,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setEvaluating(false);
    }
  };

  const shownEvaluation = useMemo(
    () =>
      evaluations.find((record) => record.id === activeEvaluation) ?? evaluations[0] ?? null,
    [evaluations, activeEvaluation]
  );

  return (
    <div className="systematic-factor-panel">
      {presetPickerOpen ? (
        <PresetPicker
          catalogue={catalogue}
          chinese={chinese}
          saving={saving}
          text={text}
          onCancel={() => setPresetPickerOpen(false)}
          onChoose={(presetId) => void create(presetId)}
        />
      ) : null}
      <aside className="systematic-factor-panel__library">
        <div className="systematic-lab__pane-head">
          <span>{text.savedFactors}</span>
          <span className="systematic-lab__count">{factors.length}</span>
          <button
            type="button"
            className="systematic-lab__icon-button"
            onClick={() => setPresetPickerOpen(true)}
            disabled={!desktop || saving}
            title={text.newFactor}
            aria-label={text.newFactor}
          >
            <FilePlus2 size={14} />
          </button>
        </div>
        <div className="systematic-factor-panel__library-scroll">
          {factors.length === 0 ? (
            <div className="systematic-lab-empty-state">
              <span>
                <BarChart3 size={18} />
              </span>
              <strong>{text.noFactors}</strong>
              <p>{text.noFactorsDetail}</p>
              <div className="systematic-lab-empty-state__action">
                <button
                  type="button"
                  className="systematic-lab__command-button is-primary"
                  onClick={() => setPresetPickerOpen(true)}
                  disabled={!desktop || saving}
                >
                  <FilePlus2 size={13} />
                  {text.newFactor}
                </button>
              </div>
            </div>
          ) : (
            factors.map((factor) => {
              const verified = factorIsVerified(factor.id, evaluations);
              return (
                <div
                  key={factor.id}
                  className={`systematic-factor-panel__row${
                    factor.id === selectedId ? " is-active" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="systematic-factor-panel__row-select"
                    onClick={() => setSelectedId(factor.id)}
                  >
                    <strong>{factor.name}</strong>
                    <small>
                      {factor.code} · v{factor.version} · {factor.kind}
                    </small>
                    {/* Separating "exists" from "checked" at the point of
                        selection: an unevaluated factor should never look as
                        trustworthy as a validated one. */}
                    <span
                      className={`systematic-factor-panel__badge${
                        verified ? " is-verified" : ""
                      }`}
                    >
                      {verified ? <BadgeCheck size={11} /> : null}
                      {verified ? text.verified : text.unverified}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="systematic-lab__row-delete"
                    onClick={() => void remove(factor)}
                    disabled={!desktop}
                    title={text.deleteFactor}
                    aria-label={text.deleteFactor}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <main className="systematic-factor-panel__main">
        {!selected || !draft ? (
          <div className="systematic-lab-empty-state">
            <span>
              <BarChart3 size={18} />
            </span>
            <strong>{text.selectFactor}</strong>
            <p>{text.selectFactorDetail}</p>
          </div>
        ) : (
          <>
            <div
              className="systematic-factor-panel__tabs"
              role="tablist"
              aria-label={text.factorViews}
            >
              <button
                id="factor-workbench-tab"
                type="button"
                role="tab"
                aria-selected={activeView === "workbench"}
                aria-controls="factor-workbench-view"
                className={activeView === "workbench" ? "is-active" : undefined}
                onClick={() => setActiveView("workbench")}
              >
                <SlidersHorizontal size={14} />
                {text.workbenchView}
              </button>
              <button
                id="factor-conclusion-tab"
                type="button"
                role="tab"
                aria-selected={activeView === "conclusion"}
                aria-controls="factor-conclusion-view"
                className={activeView === "conclusion" ? "is-active" : undefined}
                onClick={() => setActiveView("conclusion")}
              >
                <FileChartColumn size={14} />
                {text.conclusionView}
                {shownEvaluation ? (
                  <span aria-label={text.hasEvaluation}>{evaluations.length}</span>
                ) : null}
              </button>
            </div>

            {activeView === "workbench" ? (
              <div
                id="factor-workbench-view"
                className="systematic-factor-panel__view"
                role="tabpanel"
                aria-labelledby="factor-workbench-tab"
              >
                <CoverageBanner
                  diagnostics={diagnostics}
                  unavailableReason={unavailableReason}
                  loading={loading}
                  repairing={repairing}
                  desktop={desktop}
                  text={text}
                  onRepair={() => void repair()}
                />

                <section className="systematic-factor-panel__ranking" aria-label={text.ranking}>
                  <div className="systematic-factor-panel__ranking-head">
                    <span>{text.ranking}</span>
                    <div>
                      <button
                        type="button"
                        className="systematic-lab__command-button"
                        onClick={() => void evaluate()}
                        disabled={!desktop || evaluating}
                      >
                        {evaluating ? (
                          <LoaderCircle size={13} className="is-spinning" />
                        ) : (
                          <Play size={13} />
                        )}
                        {evaluating ? text.evaluating : text.runEvaluation}
                      </button>
                      <button
                        type="button"
                        className="systematic-lab__command-button is-primary"
                        onClick={() => void save()}
                        disabled={!desktop || saving}
                      >
                        {saving ? (
                          <LoaderCircle size={13} className="is-spinning" />
                        ) : (
                          <Save size={13} />
                        )}
                        {text.saveFactor}
                      </button>
                    </div>
                  </div>
                  <RankingTable
                    rows={rows}
                    text={text}
                    watchlist={watchlist}
                    onUseForBacktest={onUseForBacktest}
                    onAddToWatchlist={onAddToWatchlist}
                  />
                </section>

                {/* The editor follows the factor's family. A blend is four weights;
                    an expression is a source plus an editable operator chain. */}
                {selected.kind === "expression" ? (
                  <section className="systematic-factor-panel__builder" aria-label={text.builder}>
                    <div className="systematic-factor-panel__builder-head">
                      <span>{text.expressionBuilder}</span>
                      <small>{text.expressionBuilderHint}</small>
                    </div>
                    <div className="systematic-factor-panel__fields">
                      <label>
                        <span>{text.factorName}</span>
                        <input
                          value={draft.name}
                          maxLength={120}
                          onChange={(event) => updateDraft({ name: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>{text.factorCode}</span>
                        <input
                          value={draft.code}
                          maxLength={32}
                          onChange={(event) => updateDraft({ code: event.target.value })}
                        />
                      </label>
                    </div>
                    <SystematicFactorExpressionBuilder
                      catalogue={catalogue}
                      draft={expressionDraft}
                      chinese={chinese}
                      desktop={desktop}
                      onChange={setExpressionDraft}
                      onComposed={setComposedExpression}
                    />
                  </section>
                ) : (
                  <BlendBuilder draft={draft} text={text} onChange={updateDraft} />
                )}
              </div>
            ) : (
              <div
                id="factor-conclusion-view"
                className="systematic-factor-panel__view is-conclusion"
                role="tabpanel"
                aria-labelledby="factor-conclusion-tab"
              >
                {shownEvaluation ? (
                  <SystematicFactorReport evaluation={shownEvaluation} chinese={chinese} />
                ) : (
                  <div className="systematic-lab-empty-state">
                    <span>
                      <FileChartColumn size={18} />
                    </span>
                    <strong>{text.noEvaluationTitle}</strong>
                    <p>{text.noEvaluationYet}</p>
                    <div className="systematic-lab-empty-state__action">
                      <button
                        type="button"
                        className="systematic-lab__command-button is-primary"
                        onClick={() => void evaluate()}
                        disabled={!desktop || evaluating}
                      >
                        {evaluating ? (
                          <LoaderCircle size={13} className="is-spinning" />
                        ) : (
                          <Play size={13} />
                        )}
                        {evaluating ? text.evaluating : text.runEvaluation}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Starting-point gallery shown when creating a factor.
 *
 * Offered instead of an empty formula because this library is a generative
 * namespace rather than a finite catalogue: the useful starting point is
 * something that already works and can then be edited. Each preset states the
 * direction the published evidence supports, so a reversal factor is not mistaken
 * for a failing momentum one.
 */
function PresetPicker({
  catalogue,
  chinese,
  saving,
  text,
  onCancel,
  onChoose
}: Readonly<{
  catalogue: SystematicFactorBuilderCatalogue | null;
  chinese: boolean;
  saving: boolean;
  text: PanelCopy;
  onCancel: () => void;
  onChoose: (presetId?: string) => void;
}>) {
  return (
    <div className="systematic-factor-panel__picker-backdrop" role="presentation">
      <section className="systematic-factor-panel__picker" aria-label={text.newFactor}>
        <header>
          <div>
            <span>{text.newFactor}</span>
            <strong>{text.pickStartingPoint}</strong>
          </div>
          <button type="button" onClick={onCancel} aria-label={text.cancel}>
            <X size={15} />
          </button>
        </header>
        <div className="systematic-factor-panel__picker-list">
          {(catalogue?.presets ?? []).map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="systematic-factor-panel__picker-option"
              disabled={saving}
              onClick={() => onChoose(preset.id)}
            >
              <strong>{chinese ? preset.labelZh : preset.labelEn}</strong>
              <small>
                {text.expectedSign}:{" "}
                {preset.expectedSign === "negative"
                  ? text.signNegative
                  : preset.expectedSign === "positive"
                    ? text.signPositive
                    : text.signUnknown}
              </small>
            </button>
          ))}
          {/* The blend remains available: it is the simplest thing that works,
              and four labelled weights are easier to reason about than a chain. */}
          <button
            type="button"
            className="systematic-factor-panel__picker-option"
            disabled={saving}
            onClick={() => onChoose(undefined)}
          >
            <strong>{text.blankBlend}</strong>
            <small>{text.blankBlendDetail}</small>
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Coverage banner.
 *
 * An empty or partial ranking always states its cause and offers the action that
 * addresses it. The removed implementation rendered an unexplained empty table,
 * which gave a user no way to tell an empty universe from missing local history.
 */
function CoverageBanner({
  diagnostics,
  unavailableReason,
  loading,
  repairing,
  desktop,
  text,
  onRepair
}: Readonly<{
  diagnostics: SystematicFactorCoverageDiagnostics | null;
  unavailableReason: string | null;
  loading: boolean;
  repairing: boolean;
  desktop: boolean;
  text: PanelCopy;
  onRepair: () => void;
}>) {
  if (loading) {
    return (
      <div className="systematic-factor-panel__banner">
        <LoaderCircle size={14} className="is-spinning" />
        <span>{text.loadingRanking}</span>
      </div>
    );
  }
  if (unavailableReason) {
    return (
      <div className="systematic-factor-panel__banner is-warn">
        <CircleAlert size={14} />
        <span>
          {unavailableReason === "noUniverseSnapshot"
            ? text.noUniverseSnapshot
            : unavailableReason}
        </span>
      </div>
    );
  }
  if (!diagnostics) return null;

  const reasons = Object.entries(diagnostics.reasonCounts);
  // Compare against the whole universe, not the eligible subset. Eligibility
  // already requires enough fresh local bars, so an instrument with no history
  // never becomes eligible — and that is exactly the case repair addresses.
  // Testing against `universeEligible` hid the button precisely when almost
  // nothing had data, which is when it matters most.
  const partial = diagnostics.scored < diagnostics.universeTotal;
  return (
    <div className={`systematic-factor-panel__banner${partial ? " is-warn" : ""}`}>
      <CircleAlert size={14} />
      <div>
        <span>
          {text.coverageSummary
            .replace("{total}", String(diagnostics.universeTotal))
            .replace("{scored}", String(diagnostics.scored))}
        </span>
        {reasons.length > 0 ? (
          <small>
            {text.missingLabel}
            {reasons
              .map(([code, count]) => `${text.skipReasons[code] ?? code} (${count})`)
              .join(" · ")}
          </small>
        ) : null}
        {!diagnostics.crossSectionSufficient ? (
          <small className="is-warn">{text.crossSectionTooNarrow}</small>
        ) : null}
        {/* Ranking readiness and evaluation readiness are different thresholds.
            Stating only the former let a healthy-looking ranking sit beside an
            evaluation that could never produce a valid grid point. */}
        <small className={diagnostics.evaluationReady < 10 ? "is-warn" : undefined}>
          {text.evaluationReady
            .replace("{ready}", String(diagnostics.evaluationReady))
            .replace(
              "{days}",
              String(Math.round(diagnostics.evaluationRequiredBars / 1440))
            )}
        </small>
        {diagnostics.snapshotStale ? <small>{text.snapshotStale}</small> : null}
        <small>{diagnostics.survivorshipNote}</small>
      </div>
      {partial ? (
        <button
          type="button"
          className="systematic-lab__command-button"
          onClick={onRepair}
          disabled={!desktop || repairing}
          // The wait is minutes, not seconds, so the cost is stated before the
          // click rather than discovered during it.
          title={text.repairCostHint}
        >
          {repairing ? (
            <LoaderCircle size={13} className="is-spinning" />
          ) : (
            <Download size={13} />
          )}
          {repairing ? text.repairing : text.repairData}
        </button>
      ) : null}
    </div>
  );
}

function RankingTable({
  rows,
  text,
  watchlist,
  onUseForBacktest,
  onAddToWatchlist
}: Readonly<{
  rows: SystematicFactorView[];
  text: PanelCopy;
  watchlist: string[];
  onUseForBacktest: (instId: string) => void;
  onAddToWatchlist?: (instId: string) => void;
}>) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (rows.length === 0) {
    return <p className="systematic-factor-panel__hint">{text.noRanking}</p>;
  }
  return (
    <div className="systematic-factor-panel__table" role="table" aria-label={text.ranking}>
      <div className="systematic-factor-panel__table-head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">{text.instrument}</span>
        <span role="columnheader">{text.score}</span>
        <span role="columnheader">{text.rankChange}</span>
        <span role="columnheader">{text.momentum}</span>
        <span role="columnheader">{text.volatility}</span>
        <span role="columnheader">{text.turnoverColumn}</span>
        <span role="columnheader" />
      </div>
      {rows.map((row) => {
        const delta =
          row.previousRank !== undefined ? row.previousRank - row.rank : undefined;
        const inWatchlist = watchlist.includes(row.instId);
        return (
          <div key={row.id} className="systematic-factor-panel__table-group">
            <div className="systematic-factor-panel__table-row" role="row">
              <span role="cell">{row.rank}</span>
              <span role="cell" className="systematic-factor-panel__instrument">
                <SymbolIcon base={row.instId.split("-")[0]} />
                {row.instId}
              </span>
              <span role="cell">{row.alphaScore.toFixed(3)}</span>
              <span
                role="cell"
                className={
                  delta === undefined || delta === 0
                    ? undefined
                    : delta > 0
                      ? "is-up"
                      : "is-down"
                }
              >
                {delta === undefined ? "--" : delta === 0 ? "0" : `${delta > 0 ? "↑" : "↓"}${Math.abs(delta)}`}
              </span>
              <span role="cell">{(row.momentumPct * 100).toFixed(2)}%</span>
              <span role="cell">{(row.realizedVolatilityPct * 100).toFixed(2)}%</span>
              <span role="cell">{formatCompact(row.liquidityUsdt)}</span>
              <span role="cell" className="systematic-factor-panel__row-actions">
                {onAddToWatchlist && !inWatchlist ? (
                  <button
                    type="button"
                    className="systematic-lab__command-button is-quiet"
                    onClick={() => onAddToWatchlist(row.instId)}
                  >
                    {text.addToWatchlist}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="systematic-lab__command-button is-quiet"
                  onClick={() => onUseForBacktest(row.instId)}
                  disabled={!inWatchlist}
                  title={inWatchlist ? undefined : text.watchlistRequired}
                >
                  {text.useForBacktest}
                </button>
                <button
                  type="button"
                  className="systematic-lab__icon-button"
                  aria-expanded={expanded === row.id}
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  title={text.whyThisRank}
                  aria-label={text.whyThisRank}
                >
                  <ChevronRight size={13} />
                </button>
              </span>
            </div>
            {expanded === row.id ? (
              <div className="systematic-factor-panel__evidence">
                <p>{row.evidence}</p>
                <small>{row.counterEvidence}</small>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Weight editor for the K-line blend family.
 *
 * Sliders paired with numeric inputs: the slider communicates the range and
 * invites exploration, the number field makes a specific value reachable.
 */
function BlendBuilder({
  draft,
  text,
  onChange
}: Readonly<{
  draft: BlendDraft;
  text: PanelCopy;
  onChange: (patch: Partial<BlendDraft>) => void;
}>) {
  return (
    <section className="systematic-factor-panel__builder" aria-label={text.builder}>
      <div className="systematic-factor-panel__builder-head">
        <span>{text.builder}</span>
        <small>{text.builderHint}</small>
      </div>
      <div className="systematic-factor-panel__fields">
        <label>
          <span>{text.factorName}</span>
          <input
            value={draft.name}
            maxLength={120}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label>
          <span>{text.factorCode}</span>
          <input
            value={draft.code}
            maxLength={32}
            onChange={(event) => onChange({ code: event.target.value })}
          />
        </label>
      </div>
      <code className="systematic-factor-panel__formula">
        score = wM·z(momentum) − wRV·z(volatility) + wV·z(volume)
      </code>
      <div className="systematic-factor-panel__sliders">
        <SliderField
          label={text.lookback}
          hint={text.lookbackHint}
          value={draft.lookbackBars}
          min={5}
          max={2000}
          step={1}
          onChange={(value) => onChange({ lookbackBars: Math.round(value) })}
        />
        <SliderField
          label={text.momentumWeight}
          hint={text.momentumWeightHint}
          value={draft.momentumWeight}
          min={-5}
          max={5}
          step={0.05}
          onChange={(value) => onChange({ momentumWeight: value })}
        />
        <SliderField
          label={text.volatilityWeight}
          hint={text.volatilityWeightHint}
          value={draft.volatilityPenaltyWeight}
          min={0}
          max={5}
          step={0.05}
          onChange={(value) => onChange({ volatilityPenaltyWeight: value })}
        />
        <SliderField
          label={text.volumeWeight}
          hint={text.volumeWeightHint}
          value={draft.volumeWeight}
          min={-5}
          max={5}
          step={0.05}
          onChange={(value) => onChange({ volumeWeight: value })}
        />
      </div>
      <label className="systematic-factor-panel__description">
        <span>{text.researchNote}</span>
        <textarea
          value={draft.description}
          maxLength={2000}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>
    </section>
  );
}

/**
 * A slider that carries its own explanation.
 *
 * A label like "volatility penalty" names the control but does not say which way
 * raising it moves the ranking, and that is the part which decides whether the
 * value is set correctly. The hint opens on hover, on focus, and on click, so it
 * is reachable by pointer and by keyboard.
 */
function SliderField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange
}: Readonly<{
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="systematic-factor-panel__slider">
      <span className="systematic-factor-panel__slider-label">
        {label}
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
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </div>
  );
}

/**
 * A factor counts as verified once an evaluation held up out of sample.
 *
 * Existing is not the same as checked, and the distinction belongs at the point
 * of selection rather than behind a click.
 */
function factorIsVerified(
  factorId: string,
  evaluations: SystematicFactorEvaluationRecordView[]
) {
  return evaluations.some(
    (record) =>
      record.factorId === factorId &&
      record.status === "completed" &&
      record.overallLevel !== "fail"
  );
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function whole(value: unknown, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

type PanelCopy = ReturnType<typeof panelCopy>;

function panelCopy(chinese: boolean) {
  if (chinese) {
    return {
      savedFactors: "我的因子",
      newFactor: "新建因子",
      deleteFactor: "删除因子",
      noFactors: "还没有因子",
      noFactorsDetail: "新建一个因子后，调整权重即可实时看到全市场排名。",
      selectFactor: "选择一个因子",
      selectFactorDetail: "从左侧选择因子，或新建一个开始研究。",
      verified: "已验证",
      unverified: "未验证",
      ranking: "截面排名",
      factorViews: "因子工作区视图",
      workbenchView: "构建与排名",
      conclusionView: "评估结论",
      hasEvaluation: "已有评估结论",
      noEvaluationTitle: "还没有评估结论",
      builder: "因子构建器",
      builderHint: "拖动滑块即时重排，无需保存",
      expressionBuilder: "表达式构建器",
      expressionBuilderHint: "选基础指标 + 拼算子链，改动即时重排；不需要手写 JSON",
      expressionInvalid: "当前算子组合无效，请先修正构建器中提示的问题。",
      pickStartingPoint: "选一个起点",
      cancel: "取消",
      expectedSign: "预期方向",
      signPositive: "正向（分数高的应该涨得多）",
      signNegative: "负向（分数高的应该跌得多）",
      signUnknown: "未声明",
      presetOrigin: "由预设创建：",
      blankBlend: "K 线加权因子",
      blankBlendDetail: "动量、波动率、成交量三项加权。四个数字，最容易上手。",
      factorName: "因子名称",
      factorCode: "因子代码",
      lookback: "回看周期（根）",
      lookbackHint:
        "每个合约向前看多少根 1 分钟 K 线来计算动量、波动率和成交量。周期越长信号越平滑、换手越低；越短反应越快但噪声越大。已核实的加密动量有效区间是 2–4 周（约 30 天），1–3 天反而是均值回归。",
      momentumWeight: "动量权重",
      momentumWeightHint:
        "正值 = 追涨（涨得多的排前面）；负值 = 抄底（跌得多的排前面）。每个合约的涨幅先在全市场内做 z-score，所以比较的是相对强弱，不是绝对涨幅。",
      volatilityWeight: "波动率惩罚",
      volatilityWeightHint:
        "从分数里减去波动率，所以数值越大越偏好平静的合约。只能取 0 或正数——公式里已经是减号。已核实：低波动合约跑赢是加密市场最稳健的截面规律之一，五种波动率定义下都成立。",
      volumeWeight: "成交量权重",
      volumeWeightHint:
        "正值偏好成交量放大的合约（相对自身均量），负值偏好缩量的。缺省给 0.25 这样的小权重，因为成交量主要用来过滤掉没人交易的合约，而不是当主信号。",
      researchNote: "研究说明",
      saveFactor: "保存因子",
      saved: "因子已保存",
      savedDetail: "公式变更才会递增版本；改名不影响已有评估。",
      saveFailed: "无法保存因子",
      createFailed: "无法新建因子",
      deleteFailed: "无法删除因子",
      previewFailed: "无法预览排名",
      rankingFailed: "无法读取排名",
      loadingRanking: "正在计算截面排名…",
      noRanking: "当前没有可排名的合约。",
      instrument: "合约",
      score: "分数",
      rankChange: "变化",
      momentum: "动量",
      volatility: "波动率",
      turnoverColumn: "成交额",
      whyThisRank: "为什么排这个位置",
      addToWatchlist: "加入自选",
      useForBacktest: "设为回测标的",
      watchlistRequired: "回测标的必须先加入自选",
      repairData: "补充评估历史",
      repairing: "正在补充评估历史…",
      repairDone: "评估历史补充完成",
      repairSummary:
        "已为 {repaired} / {attempted} 个合约补充约 {days} 天 1 分钟 K 线。还有 {remaining} 个候选合约，可再次补充。",
      repairCostHint:
        "复用项目统一的 K 线完整性同步，为因子截面中尚未进入自选的合约补充约 3 个月历史；不会创建另一份 K 线数据。一次处理少量合约，可能需要几分钟。",
      repairFailed: "无法补齐数据",
      runEvaluation: "跑 IC 评估",
      evaluating: "评估中…",
      evaluationDone: "评估完成",
      evaluationSummary: "共 {points} 个评估时点。请查看结论。",
      evaluationFailed: "评估失败",
      noEvaluationYet: "还没有评估记录。跑一次 IC 评估，才能知道这个排名有没有预测力。",
      coverageSummary: "宇宙 {total} 个合约，可评分 {scored} 个。",
      missingLabel: "缺失：",
      crossSectionTooNarrow: "可评分合约少于 2 个，无法构成截面排名。",
      evaluationReady:
        "可用于历史评估的合约：{ready} 个（需要约 {days} 天 1 分钟 K 线）。排名只需一个回看窗口，IC 评估要在数月的每个时点上都有数据，门槛高得多。",
      snapshotStale: "宇宙快照已过期，下次评估会自动刷新。",
      noUniverseSnapshot: "尚无合约宇宙快照。请先刷新市场资源。",
      skipReasons: {
        noLocalBars: "无本地 K 线",
        insufficientBars: "K 线不足",
        seriesGap: "序列有缺口",
        invalidPrice: "价格无效",
        readFailed: "读取失败"
      } as Record<string, string>
    };
  }
  return {
    savedFactors: "My factors",
    newFactor: "New factor",
    deleteFactor: "Delete factor",
    noFactors: "No factors yet",
    noFactorsDetail: "Create one, then adjust its weights to see the ranking update live.",
    selectFactor: "Select a factor",
    selectFactorDetail: "Choose a factor on the left, or create one to start.",
    verified: "Verified",
    unverified: "Unverified",
    ranking: "Cross-sectional ranking",
    factorViews: "Factor workspace views",
    workbenchView: "Build & rank",
    conclusionView: "Evaluation conclusion",
    hasEvaluation: "Evaluation conclusion available",
    noEvaluationTitle: "No evaluation conclusion yet",
    builder: "Factor builder",
    builderHint: "Drag a slider to re-rank without saving",
    expressionBuilder: "Expression builder",
    expressionBuilderHint:
      "Pick a measure and chain operators; edits re-rank immediately and no JSON is written by hand",
    expressionInvalid:
      "The current operator chain is not valid. Fix the issue reported in the builder first.",
    pickStartingPoint: "Pick a starting point",
    cancel: "Cancel",
    expectedSign: "Expected direction",
    signPositive: "Positive (higher score should rise more)",
    signNegative: "Negative (higher score should fall more)",
    signUnknown: "Not declared",
    presetOrigin: "Created from preset:",
    blankBlend: "K-line weighted blend",
    blankBlendDetail:
      "Momentum, volatility and volume weighted together. Four numbers, the easiest starting point.",
    factorName: "Factor name",
    factorCode: "Factor code",
    lookback: "Lookback (bars)",
    lookbackHint:
      "How many one-minute bars each instrument looks back over to compute momentum, volatility and volume. Longer smooths the signal and lowers turnover; shorter reacts faster but is noisier. Verified crypto momentum lives at 2-4 weeks (~30 days), while 1-3 day lookbacks mean-revert instead.",
    momentumWeight: "Momentum weight",
    momentumWeightHint:
      "Positive favours instruments that rose most; negative favours those that fell most. Each instrument's return is z-scored across the universe first, so this ranks relative strength rather than absolute return.",
    volatilityWeight: "Volatility penalty",
    volatilityWeightHint:
      "Subtracted from the score, so a larger value prefers calmer instruments. Only zero or positive is accepted because the formula already carries the minus sign. Verified: low-volatility outperformance is among the most reproducible crypto cross-sectional effects, holding across five volatility definitions.",
    volumeWeight: "Volume weight",
    volumeWeightHint:
      "Positive favours instruments trading above their own average volume, negative favours quieter ones. The default is small (0.25) because volume mainly screens out instruments nobody is trading rather than acting as the primary signal.",
    researchNote: "Research note",
    saveFactor: "Save factor",
    saved: "Factor saved",
    savedDetail: "Only a formula change bumps the version; renaming leaves evaluations valid.",
    saveFailed: "Could not save the factor",
    createFailed: "Could not create a factor",
    deleteFailed: "Could not delete the factor",
    previewFailed: "Could not preview the ranking",
    rankingFailed: "Could not load the ranking",
    loadingRanking: "Computing the cross-sectional ranking...",
    noRanking: "No instruments could be ranked.",
    instrument: "Instrument",
    score: "Score",
    rankChange: "Change",
    momentum: "Momentum",
    volatility: "Volatility",
    turnoverColumn: "Turnover",
    whyThisRank: "Why this rank",
    addToWatchlist: "Add to watchlist",
    useForBacktest: "Use for backtest",
    watchlistRequired: "A backtest instrument must be in the watchlist first",
    repairData: "Backfill evaluation history",
    repairing: "Backfilling evaluation history...",
    repairDone: "Evaluation history backfill finished",
    repairSummary:
      "Backfilled about {days} days of 1m bars for {repaired} of {attempted} instruments. {remaining} candidates remain.",
    repairCostHint:
      "Uses the terminal's shared K-line integrity sync to add roughly three months of history for factor-universe instruments that are not already covered by the watchlist. It does not create a second candle store. A pass covers only a few instruments and can take minutes.",
    repairFailed: "Could not repair data",
    runEvaluation: "Run IC evaluation",
    evaluating: "Evaluating...",
    evaluationDone: "Evaluation finished",
    evaluationSummary: "{points} grid points. Read the conclusion.",
    evaluationFailed: "Evaluation failed",
    noEvaluationYet:
      "No evaluation yet. Run one to find out whether this ranking has any predictive value.",
    coverageSummary: "{total} instruments in the universe, {scored} scored.",
    missingLabel: "Missing: ",
    crossSectionTooNarrow: "Fewer than 2 instruments scored, which cannot form a ranking.",
    evaluationReady:
      "Ready for historical evaluation: {ready} instruments (needs about {days} days of 1m bars). Ranking needs one lookback; an IC evaluation needs data at every point across months, which is a far higher bar.",
    snapshotStale: "The universe snapshot is stale and will refresh on the next evaluation.",
    noUniverseSnapshot: "No instrument universe snapshot yet. Refresh market resources first.",
    skipReasons: {
      noLocalBars: "no local bars",
      insufficientBars: "insufficient bars",
      seriesGap: "series gap",
      invalidPrice: "invalid price",
      readFailed: "read failed"
    } as Record<string, string>
  };
}
