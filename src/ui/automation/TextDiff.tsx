import { useMemo } from "react";
import clsx from "clsx";

/** 逐行文本差异（Skill 版本对比、交易手册版次对比共用）。样式沿用 `automation-skill-diff-*`。 */
export type TextDiffRow = {
  kind: "same" | "removed" | "added";
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
};

/** 最长公共子序列的逐行对比；两边行数乘积太大时退回按行号对齐，避免卡住界面。 */
export function diffTextLines(oldSource: string, newSource: string): TextDiffRow[] {
  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");
  if (oldLines.length * newLines.length > 2_000_000) {
    const count = Math.max(oldLines.length, newLines.length);
    return Array.from({ length: count }, (_, index) => {
      const oldText = oldLines[index];
      const newText = newLines[index];
      if (oldText === newText) return { kind: "same", oldLine: index + 1, newLine: index + 1, oldText, newText };
      if (oldText === undefined) return { kind: "added", newLine: index + 1, newText };
      if (newText === undefined) return { kind: "removed", oldLine: index + 1, oldText };
      return { kind: "removed", oldLine: index + 1, oldText, newLine: index + 1, newText };
    });
  }
  const matrix = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? matrix[oldIndex + 1][newIndex + 1] + 1
        : Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1]);
    }
  }
  const rows: TextDiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ kind: "same", oldLine: oldIndex + 1, newLine: newIndex + 1, oldText: oldLines[oldIndex], newText: newLines[newIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex >= newLines.length || (oldIndex < oldLines.length && matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1])) {
      rows.push({ kind: "removed", oldLine: oldIndex + 1, oldText: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ kind: "added", newLine: newIndex + 1, newText: newLines[newIndex] });
      newIndex += 1;
    }
  }
  return rows;
}

type DiffItem = { row: TextDiffRow } | { gap: number };

/** 把连续相同的行折叠起来，每处改动前后各留 `context` 行。 */
function collapseSame(rows: TextDiffRow[], context: number): DiffItem[] {
  const keep = rows.map((row) => row.kind !== "same");
  rows.forEach((row, index) => {
    if (row.kind === "same") return;
    for (let offset = -context; offset <= context; offset += 1) {
      if (rows[index + offset]) keep[index + offset] = true;
    }
  });
  const items: DiffItem[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (hidden > 0) items.push({ gap: hidden });
      hidden = 0;
      items.push({ row });
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) items.push({ gap: hidden });
  return items;
}

export function TextDiffTable({
  rows,
  oldLabel,
  newLabel,
  ariaLabel,
  className,
  context,
  collapsedLabel
}: {
  rows: TextDiffRow[];
  oldLabel: string;
  newLabel: string;
  ariaLabel: string;
  className?: string;
  /** 给了就折叠相同的段落（改动前后各留这么多行）。 */
  context?: number;
  collapsedLabel?: (count: number) => string;
}) {
  const items = useMemo<DiffItem[]>(() => (context === undefined ? rows.map((row) => ({ row })) : collapseSame(rows, context)), [context, rows]);
  return (
    <div className={clsx("automation-skill-diff-table", className)} role="table" aria-label={ariaLabel}>
      <div className="automation-skill-diff-columns" role="row">
        <strong role="columnheader">{oldLabel}</strong>
        <strong role="columnheader">{newLabel}</strong>
      </div>
      <div className="automation-skill-diff-scroll">
        {items.map((item, index) => ("gap" in item ? (
          <div className="automation-skill-diff-row is-gap" role="row" key={`gap-${index}`}>
            <div className="automation-skill-diff-gap" role="cell">{collapsedLabel ? collapsedLabel(item.gap) : `… ${item.gap} …`}</div>
          </div>
        ) : (
          <div className={clsx("automation-skill-diff-row", item.row.kind)} role="row" key={`${item.row.kind}-${item.row.oldLine ?? "x"}-${item.row.newLine ?? "x"}-${index}`}>
            <div className="automation-skill-diff-cell old" role="cell"><span>{item.row.oldLine ?? ""}</span><code data-i18n-skip>{item.row.oldText ?? ""}</code></div>
            <div className="automation-skill-diff-cell next" role="cell"><span>{item.row.newLine ?? ""}</span><code data-i18n-skip>{item.row.newText ?? ""}</code></div>
          </div>
        )))}
      </div>
    </div>
  );
}
