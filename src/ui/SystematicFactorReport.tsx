import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Info } from "lucide-react";
import type {
  SystematicFactorEvaluationRecordView,
  SystematicFactorHorizonMetrics,
  SystematicQuantileStat,
  SystematicVerdictFinding,
  SystematicVerdictLevel
} from "../lib/systematic";

/**
 * Evaluation report.
 *
 * Two structural decisions are deliberate.
 *
 * The conclusion layer comes first. Every comparable tool surveyed presents
 * metrics and charts and leaves the reader to decide whether the factor works,
 * which means the tool only helps people who could already read the raw numbers.
 * Each finding here is mechanically derived, so it can simply be stated.
 *
 * The body is sectioned and collapsible rather than one long scroll. A widely
 * used reference tear sheet emits a single figure over two metres tall with no
 * navigation, because its tables stream out immediately while its charts
 * accumulate into one canvas flushed at the end.
 */

type Props = Readonly<{
  evaluation: SystematicFactorEvaluationRecordView;
  chinese: boolean;
}>;

type SectionId = "conclusion" | "coverage" | "ic" | "quantiles" | "stability" | "boundaries";

export function SystematicFactorReport({ evaluation, chinese }: Props) {
  const text = useMemo(() => reportCopy(chinese), [chinese]);
  const [open, setOpen] = useState<Set<SectionId>>(
    () => new Set<SectionId>(["conclusion", "coverage", "ic", "quantiles"])
  );
  const toggle = (id: SectionId) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const metrics = evaluation.metrics;
  // The shortest horizon is the primary one: it matches the cadence the factor
  // would actually be rebalanced at.
  const primary = metrics?.horizons?.[0];

  if (evaluation.status === "failed") {
    return (
      <section className="systematic-factor-report" aria-label={text.title}>
        <div className="systematic-factor-report__verdict is-fail">
          <CircleAlert size={16} />
          <div>
            <strong>{text.evaluationFailed}</strong>
            <p>{evaluation.error || text.evaluationFailedDetail}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="systematic-factor-report" aria-label={text.title}>
      <ReportSection
        id="conclusion"
        title={text.conclusion}
        hint={text.conclusionHint}
        open={open.has("conclusion")}
        onToggle={toggle}
      >
        {evaluation.verdicts.length === 0 ? (
          <p className="systematic-factor-report__note">{text.noFindings}</p>
        ) : (
          <ul className="systematic-factor-report__verdicts">
            {evaluation.verdicts.map((finding, index) => (
              <VerdictRow
                key={`${finding.code}-${index}`}
                finding={finding}
                text={text}
              />
            ))}
          </ul>
        )}
      </ReportSection>

      {/* Data adequacy precedes any performance claim: a spread computed over
          too few instruments is not a weaker result, it is a different one. */}
      <ReportSection
        id="coverage"
        title={text.coverage}
        hint={text.coverageHint}
        open={open.has("coverage")}
        onToggle={toggle}
      >
        <div className="systematic-factor-report__stats">
          <Stat label={text.gridPoints} value={formatCount(metrics?.gridPoints)} />
          <Stat label={text.universeSize} value={formatCount(metrics?.universeSize)} />
          <Stat
            label={text.minCrossSection}
            value={formatCount(metrics?.minCrossSection)}
            tone={(metrics?.minCrossSection ?? 0) < evaluation.quantileBuckets * 2 ? "warn" : undefined}
          />
          <Stat label={text.skippedPoints} value={formatCount(metrics?.skippedSparsePoints)} />
          <Stat label={text.buckets} value={formatCount(evaluation.quantileBuckets)} />
          <Stat label={text.cadence} value={formatCadence(evaluation.gridMinutes, text)} />
        </div>
      </ReportSection>

      <ReportSection
        id="ic"
        title={text.informationCoefficient}
        hint={text.icHint}
        open={open.has("ic")}
        onToggle={toggle}
      >
        {metrics?.horizons?.length ? (
          <div className="systematic-factor-report__horizons">
            {metrics.horizons.map((horizon) => (
              <HorizonIc
                key={horizon.horizonMinutes}
                horizon={horizon}
                text={text}
              />
            ))}
          </div>
        ) : (
          <p className="systematic-factor-report__note">{text.noMetrics}</p>
        )}
      </ReportSection>

      <ReportSection
        id="quantiles"
        title={text.quantileProfile}
        hint={text.quantileHint}
        open={open.has("quantiles")}
        onToggle={toggle}
      >
        {primary?.quantiles?.length ? (
          <QuantileChart
            stats={primary.quantiles}
            buckets={evaluation.quantileBuckets}
            text={text}
          />
        ) : (
          <p className="systematic-factor-report__note">{text.noQuantiles}</p>
        )}
      </ReportSection>

      <ReportSection
        id="stability"
        title={text.stability}
        hint={text.stabilityHint}
        open={open.has("stability")}
        onToggle={toggle}
      >
        <div className="systematic-factor-report__stats">
          <Stat
            label={text.rankAutocorrelation}
            value={formatRatio(metrics?.rankAutocorrelation)}
            tone={(metrics?.rankAutocorrelation ?? 1) < 0.5 ? "warn" : undefined}
          />
          <Stat label={text.turnover} value={formatPercent(metrics?.topBucketTurnover)} />
          <Stat
            label={text.annualCost}
            value={formatPercent(metrics?.annualisedCostAtFullTurnover)}
          />
          <Stat
            label={text.realisedCost}
            value={formatPercent(
              metrics && metrics.topBucketTurnover !== undefined
                ? metrics.annualisedCostAtFullTurnover * metrics.topBucketTurnover
                : undefined
            )}
          />
        </div>
        <p className="systematic-factor-report__note">{text.costNote}</p>
      </ReportSection>

      {/* Boundaries are part of the result, not a disclaimer appended to it. */}
      <ReportSection
        id="boundaries"
        title={text.boundaries}
        hint={text.boundariesHint}
        open={open.has("boundaries")}
        onToggle={toggle}
      >
        <ul className="systematic-factor-report__boundaries">
          {(metrics?.boundaryNotes ?? []).map((note) => (
            <li key={note}>
              <Info size={12} />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </ReportSection>
    </section>
  );
}

function ReportSection({
  id,
  title,
  hint,
  open,
  onToggle,
  children
}: Readonly<{
  id: SectionId;
  title: string;
  hint: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: React.ReactNode;
}>) {
  return (
    <section className="systematic-factor-report__section">
      <button
        type="button"
        className="systematic-factor-report__section-head"
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <span>
          <strong>{title}</strong>
          <small>{hint}</small>
        </span>
      </button>
      {open ? <div className="systematic-factor-report__section-body">{children}</div> : null}
    </section>
  );
}

function VerdictRow({
  finding,
  text
}: Readonly<{ finding: SystematicVerdictFinding; text: ReportCopy }>) {
  const copy = text.findings[finding.code] ?? {
    title: finding.code,
    detail: ""
  };
  return (
    <li className={`systematic-factor-report__verdict is-${finding.level}`}>
      <VerdictIcon level={finding.level} />
      <div>
        <strong>{copy.title}</strong>
        {copy.detail ? <p>{copy.detail}</p> : null}
        <small>
          {finding.detail.measured !== undefined
            ? `${text.measured} ${formatSigned(finding.detail.measured)}`
            : null}
          {finding.detail.threshold !== undefined
            ? ` · ${text.threshold} ${formatSigned(finding.detail.threshold)}`
            : null}
          {finding.detail.count !== undefined ? ` · ${finding.detail.count}` : null}
        </small>
      </div>
    </li>
  );
}

function VerdictIcon({ level }: Readonly<{ level: SystematicVerdictLevel }>) {
  if (level === "fail") return <CircleAlert size={15} />;
  if (level === "caution") return <AlertTriangle size={15} />;
  return <CheckCircle2 size={15} />;
}

function HorizonIc({
  horizon,
  text
}: Readonly<{ horizon: SystematicFactorHorizonMetrics; text: ReportCopy }>) {
  const train = horizon.trainIc;
  const validation = horizon.validationIc;
  return (
    <div className="systematic-factor-report__horizon">
      <div className="systematic-factor-report__horizon-head">
        <strong>{formatHorizon(horizon.horizonMinutes, text)}</strong>
        {horizon.quantileSpread !== undefined ? (
          <span>
            {text.spread} <b>{formatPercent(horizon.quantileSpread)}</b>
          </span>
        ) : null}
      </div>
      <div className="systematic-factor-report__stats">
        {/* IC mean leads: its sign is the single most informative number. */}
        <Stat
          label={text.icMean}
          value={formatSigned(train?.mean)}
          tone={train && train.mean < 0 ? "warn" : undefined}
          emphasis
        />
        <Stat label={text.icir} value={formatSigned(train?.icir)} />
        <Stat label={text.hitRate} value={formatPercent(train?.hitRate)} />
        <Stat
          label={text.outOfSampleIc}
          value={formatSigned(validation?.mean)}
          tone={
            train && validation && Math.sign(train.mean) !== Math.sign(validation.mean)
              ? "warn"
              : undefined
          }
        />
        <Stat label={text.periods} value={formatCount(train?.periods)} />
      </div>
      {horizon.icSeries.length > 1 ? (
        <IcSparkline values={horizon.icSeries} label={text.icOverTime} />
      ) : null}
      <small className="systematic-factor-report__tstat">
        {text.tStat} {formatSigned(train?.tStat)} · {text.tStatCaveat}
      </small>
    </div>
  );
}

/**
 * Inline IC series. Drawn as SVG because the project ships only a time-series
 * chart library, and this is a bounded sequence of already-computed values
 * rather than a price series.
 */
function IcSparkline({ values, label }: Readonly<{ values: number[]; label: string }>) {
  const width = 480;
  const height = 64;
  const extent = Math.max(...values.map((value) => Math.abs(value)), 0.01);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((value, index) => {
      const x = index * step;
      const y = height / 2 - (value / extent) * (height / 2 - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="systematic-factor-report__spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {/* Zero line: the sign of the IC is what matters most, so the axis is
          drawn explicitly rather than implied. */}
      <line x1={0} y1={height / 2} x2={width} y2={height / 2} className="is-axis" />
      <polyline points={points} />
    </svg>
  );
}

/**
 * Bucket profile as a full bar chart with error bars.
 *
 * Never reduced to a monotonicity flag: a real crypto momentum signal has been
 * documented producing a U-shaped profile that pays at both extremes, which a
 * single ordering summary would describe as broken in both directions.
 */
function QuantileChart({
  stats,
  buckets,
  text
}: Readonly<{ stats: SystematicQuantileStat[]; buckets: number; text: ReportCopy }>) {
  const extent = Math.max(
    ...stats.map((stat) => Math.abs(stat.meanReturn) + stat.standardError),
    0.0001
  );
  const thin = stats.some((stat) => stat.minMembersPerPeriod < 5);
  return (
    <div className="systematic-factor-report__quantiles">
      <div className="systematic-factor-report__bars">
        {stats.map((stat) => {
          const magnitude = (Math.abs(stat.meanReturn) / extent) * 46;
          const errorHeight = (stat.standardError / extent) * 46;
          return (
            <div className="systematic-factor-report__bar" key={stat.bucket}>
              <div className="systematic-factor-report__bar-track">
                <span
                  className={`systematic-factor-report__bar-fill ${
                    stat.meanReturn >= 0 ? "is-gain" : "is-loss"
                  }`}
                  style={{
                    height: `${Math.max(magnitude, 1)}%`,
                    [stat.meanReturn >= 0 ? "bottom" : "top"]: "50%"
                  }}
                />
                {/* The error bar is always drawn: a bucket mean without its
                    precision invites over-reading, especially when a bucket
                    holds only a few instruments. */}
                <span
                  className="systematic-factor-report__bar-error"
                  style={{
                    height: `${Math.max(errorHeight * 2, 1)}%`,
                    bottom: `calc(50% + ${
                      stat.meanReturn >= 0 ? magnitude - errorHeight : -magnitude - errorHeight
                    }%)`
                  }}
                />
              </div>
              <b>{formatPercent(stat.meanReturn)}</b>
              <small>
                {text.bucket} {stat.bucket + 1}
              </small>
              <small className={stat.minMembersPerPeriod < 5 ? "is-warn" : undefined}>
                n≥{stat.minMembersPerPeriod}
              </small>
            </div>
          );
        })}
      </div>
      {thin ? (
        <p className="systematic-factor-report__note is-warn">
          {text.thinBucketNote.replace("{buckets}", String(buckets))}
        </p>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  emphasis
}: Readonly<{ label: string; value: string; tone?: "warn"; emphasis?: boolean }>) {
  return (
    <div
      className={`systematic-factor-report__stat${emphasis ? " is-emphasis" : ""}${
        tone === "warn" ? " is-warn" : ""
      }`}
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatCount(value: number | undefined) {
  return value === undefined ? "--" : String(value);
}

function formatSigned(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatRatio(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function formatPercent(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(2)}%`;
}

function formatCadence(minutes: number, text: ReportCopy) {
  if (minutes % 1440 === 0) return `${minutes / 1440}${text.dayUnit}`;
  if (minutes % 60 === 0) return `${minutes / 60}${text.hourUnit}`;
  return `${minutes}${text.minuteUnit}`;
}

function formatHorizon(minutes: number, text: ReportCopy) {
  return `${text.forward} ${formatCadence(minutes, text)}`;
}

type ReportCopy = ReturnType<typeof reportCopy>;

function reportCopy(chinese: boolean) {
  if (chinese) {
    return {
      title: "因子评估报告",
      conclusion: "结论",
      conclusionHint: "以下判断全部由已算出的数字机械得出",
      coverage: "数据充分性",
      coverageHint: "先确认数据够不够，再看表现",
      informationCoefficient: "信息系数 (IC)",
      icHint: "因子排名与后续收益的秩相关；先看 IC 均值的符号",
      quantileProfile: "分档收益",
      quantileHint: "完整柱状图与标准误；两头都高的 U 形也是可交易形态",
      stability: "稳定性与成本",
      stabilityHint: "排名越不稳定，换手越高，手续费吃掉的越多",
      boundaries: "口径与边界",
      boundariesHint: "这些数字不包含什么",
      evaluationFailed: "评估失败",
      evaluationFailedDetail: "未能完成本次评估。",
      noFindings: "没有产生任何判断。",
      noMetrics: "没有可用指标。",
      noQuantiles: "截面过窄，无法分档。",
      gridPoints: "评估时点",
      universeSize: "宇宙合约数",
      minCrossSection: "最小截面",
      skippedPoints: "跳过时点",
      buckets: "分档数",
      cadence: "调仓间隔",
      icMean: "IC 均值",
      icir: "ICIR",
      hitRate: "胜率",
      outOfSampleIc: "样本外 IC",
      periods: "样本期数",
      spread: "首末档差",
      icOverTime: "IC 时序",
      tStat: "t 值",
      tStatCaveat: "分钟级样本量极大且窗口重叠，t 值不可用于决策",
      rankAutocorrelation: "排名自相关",
      turnover: "换手率",
      annualCost: "满仓换手年化成本",
      realisedCost: "实际年化成本",
      costNote:
        "毛收益随调仓频率的平方根增长，成本随频率线性增长，因此存在有限最优频率——不是越快越好。",
      bucket: "第",
      thinBucketNote:
        "存在成员少于 5 个的档位。此时档位均值主要由个别合约决定，不宜按 {buckets} 档解读。",
      measured: "实测",
      threshold: "阈值",
      forward: "前向",
      dayUnit: " 天",
      hourUnit: " 小时",
      minuteUnit: " 分钟",
      findings: chineseFindings()
    };
  }
  return {
    title: "Factor evaluation report",
    conclusion: "Conclusion",
    conclusionHint: "Every statement below is derived mechanically from computed values",
    coverage: "Data adequacy",
    coverageHint: "Confirm the data supports a claim before reading performance",
    informationCoefficient: "Information coefficient",
    icHint: "Rank correlation between score and forward return; check the sign of IC mean first",
    quantileProfile: "Quantile profile",
    quantileHint: "Full bars with standard error; a U shape that pays at both ends is tradable",
    stability: "Stability and cost",
    stabilityHint: "An unstable ranking turns over more, and fees consume more of the return",
    boundaries: "Scope and boundaries",
    boundariesHint: "What these numbers exclude",
    evaluationFailed: "Evaluation failed",
    evaluationFailedDetail: "This evaluation did not complete.",
    noFindings: "No findings were produced.",
    noMetrics: "No metrics available.",
    noQuantiles: "The cross-section is too narrow to bucket.",
    gridPoints: "Grid points",
    universeSize: "Universe size",
    minCrossSection: "Min cross-section",
    skippedPoints: "Skipped points",
    buckets: "Buckets",
    cadence: "Rebalance",
    icMean: "IC mean",
    icir: "ICIR",
    hitRate: "Hit rate",
    outOfSampleIc: "Out-of-sample IC",
    periods: "Periods",
    spread: "Top-bottom spread",
    icOverTime: "IC over time",
    tStat: "t-stat",
    tStatCaveat: "inflated by sample size and overlapping windows; not a decision rule",
    rankAutocorrelation: "Rank autocorrelation",
    turnover: "Turnover",
    annualCost: "Annual cost at full turnover",
    realisedCost: "Realised annual cost",
    costNote:
      "Gross return scales with the square root of rebalance frequency while cost scales linearly, so a finite optimum always exists.",
    bucket: "Bucket",
    thinBucketNote:
      "At least one bucket holds fewer than 5 members. Its mean is driven by individual instruments, so a {buckets}-bucket reading is not supported.",
    measured: "measured",
    threshold: "threshold",
    forward: "Forward",
    dayUnit: "d",
    hourUnit: "h",
    minuteUnit: "m",
    findings: englishFindings()
  };
}

/**
 * Finding copy keyed by the verdict code the backend emits.
 *
 * Each entry states what was measured and what follows arithmetically, and stops
 * there — a passing measurement is not a claim that the factor is tradable once
 * funding, depth and margin are accounted for.
 */
function chineseFindings(): Record<string, { title: string; detail: string }> {
  return {
    icSignInverted: {
      title: "方向反了",
      detail: "IC 为负，说明分数高的合约随后表现更差。把权重取负，或直接当反转因子用。"
    },
    icSignAsIntended: { title: "方向符合预期", detail: "" },
    hitRateAtChance: {
      title: "胜率不高于抛硬币",
      detail: "即使均值有利，符号也不可依赖。"
    },
    signFlippedOutOfSample: {
      title: "样本外符号反转",
      detail: "训练段与验证段方向相反，这是过拟合最强的信号。"
    },
    weakenedOutOfSample: {
      title: "样本外显著减弱",
      detail: "方向一致但强度不足训练段一半。"
    },
    heldOutOfSample: { title: "样本外表现一致", detail: "" },
    noOutOfSampleWindow: {
      title: "没有样本外窗口",
      detail: "区间太短，无法切分训练与验证，缺少防过拟合依据。"
    },
    thinQuantiles: {
      title: "档位成员过少",
      detail: "档位均值主要由个别合约决定。减少档数或扩大宇宙。"
    },
    nonMonotonicProfile: {
      title: "分档非单调",
      detail: "不必然是问题：两头都赚钱的 U 形是真实存在且可交易的形态。请看完整柱状图。"
    },
    spreadWithinNoise: {
      title: "首末档差在噪声范围内",
      detail: "误差棒重叠，价差与 0 无法区分。"
    },
    costExceedsSpread: {
      title: "成本高于价差",
      detail: "按当前调仓频率与换手率，手续费已经吃掉全部收益。放慢调仓或降低换手。"
    },
    rankingUnstable: {
      title: "排名不稳定",
      detail: "相邻周期排名相关性低，意味着每期都要大幅调仓。"
    },
    implausiblyStrong: {
      title: "强度高得可疑",
      detail: "已核实的扣费后样本外单因子区间是 0.4–1.0。请检查：存活者偏差、未来数据、未付手续费、未计资金费。"
    },
    crossSectionTooNarrow: {
      title: "截面不足两个合约",
      detail: "少于两个合约无法构成排名。"
    },
    crossSectionBelowBucketRequirement: {
      title: "截面不足以支撑当前档数",
      detail: "每档至少需要两个合约。"
    },
    coverageLow: {
      title: "覆盖率偏低",
      detail: "多数合约未能打分，排名只描述了宇宙的一小部分。可先补齐数据。"
    },
    manyTrials: {
      title: "尝试次数较多",
      detail: "在多次尝试里挑最好的会高估结果。次数越多，单个结果越需要样本外验证。"
    },
    noIcMeasured: {
      title: "未能算出 IC",
      detail: "没有足够的有效时点，无法评估预测力。"
    }
  };
}

function englishFindings(): Record<string, { title: string; detail: string }> {
  return {
    icSignInverted: {
      title: "Direction is inverted",
      detail:
        "IC is negative, so higher-scoring instruments subsequently did worse. Negate the weights or treat this as a reversal factor."
    },
    icSignAsIntended: { title: "Direction matches intent", detail: "" },
    hitRateAtChance: {
      title: "Hit rate no better than chance",
      detail: "The sign is not dependable even where the mean is favourable."
    },
    signFlippedOutOfSample: {
      title: "Sign flipped out of sample",
      detail: "Train and validation disagree in direction, the strongest sign of fitting."
    },
    weakenedOutOfSample: {
      title: "Weakened out of sample",
      detail: "Same direction, but less than half the in-sample strength."
    },
    heldOutOfSample: { title: "Held out of sample", detail: "" },
    noOutOfSampleWindow: {
      title: "No out-of-sample window",
      detail: "The window was too short to split, so there is no defence against fitting."
    },
    thinQuantiles: {
      title: "Buckets are thin",
      detail:
        "A bucket mean is driven by individual instruments. Reduce the bucket count or widen the universe."
    },
    nonMonotonicProfile: {
      title: "Profile is not monotonic",
      detail:
        "Not necessarily a problem: a U shape paying at both extremes is a real, tradable form. Read the full bar chart."
    },
    spreadWithinNoise: {
      title: "Spread is within noise",
      detail: "Error bars overlap, so the spread is not distinguishable from zero."
    },
    costExceedsSpread: {
      title: "Cost exceeds the spread",
      detail:
        "At this cadence and turnover, fees consume the entire measured return. Slow the rebalance or reduce turnover."
    },
    rankingUnstable: {
      title: "Ranking is unstable",
      detail: "Low correlation between consecutive periods implies heavy rebalancing every period."
    },
    implausiblyStrong: {
      title: "Implausibly strong",
      detail:
        "Verified cost-aware out-of-sample single-factor results cluster in 0.4-1.0. Check survivorship bias, look-ahead, unpaid fees and uncounted funding."
    },
    crossSectionTooNarrow: {
      title: "Cross-section below two instruments",
      detail: "Fewer than two instruments cannot form a ranking."
    },
    crossSectionBelowBucketRequirement: {
      title: "Cross-section too narrow for this bucket count",
      detail: "Each bucket needs at least two instruments."
    },
    coverageLow: {
      title: "Coverage is low",
      detail:
        "Most instruments produced no score, so the ranking describes a small part of the universe. Repairing data may help."
    },
    manyTrials: {
      title: "Many trials",
      detail:
        "Selecting the best of many attempts inflates the result. The more trials, the more a single result needs out-of-sample confirmation."
    },
    noIcMeasured: {
      title: "No IC could be measured",
      detail: "There were too few usable grid points to assess predictive value."
    }
  };
}
