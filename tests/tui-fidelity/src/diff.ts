import type { CellDiff, CellSnapshot, FixtureResult, GridSnapshot } from "./types.ts";

const MAX_DIFFS = 20;

export function diffGrids(
  name: string,
  description: string,
  snapshotAt: number,
  usedVisibleTextFallback: boolean,
  pathGrid: GridSnapshot,
  referenceGrid: GridSnapshot
): FixtureResult {
  const firstDiffs: CellDiff[] = [];
  let divergentCells = 0;
  const cells = Math.max(pathGrid.cells.length, referenceGrid.cells.length);
  for (let index = 0; index < cells; index += 1) {
    const expected = referenceGrid.cells[index] ?? blankCell(index, referenceGrid.cols);
    const actual = pathGrid.cells[index] ?? blankCell(index, pathGrid.cols);
    if (!sameCell(expected, actual)) {
      divergentCells += 1;
      if (firstDiffs.length < MAX_DIFFS) {
        firstDiffs.push({ row: expected.row, col: expected.col, expected, actual });
      }
    }
  }

  return {
    name,
    description,
    snapshotAt,
    usedVisibleTextFallback,
    divergentCells,
    firstDiffs,
    pathSerialized: pathGrid.serialized,
    referenceSerialized: referenceGrid.serialized
  };
}

export function formatResult(result: FixtureResult): string {
  const status = result.divergentCells === 0 ? "PASS" : "DIFF";
  const lines = [
    `${status} ${result.name}: ${result.divergentCells} divergent cells, fallback=${String(
      result.usedVisibleTextFallback
    )}`
  ];
  for (const diff of result.firstDiffs) {
    lines.push(
      `  row ${diff.row} col ${diff.col}: expected ${formatCell(diff.expected)} actual ${formatCell(
        diff.actual
      )}`
    );
  }
  return lines.join("\n");
}

function sameCell(expected: CellSnapshot, actual: CellSnapshot): boolean {
  return (
    expected.chars === actual.chars &&
    expected.width === actual.width &&
    expected.fg === actual.fg &&
    expected.bg === actual.bg &&
    expected.flags === actual.flags
  );
}

function blankCell(index: number, cols: number): CellSnapshot {
  return {
    row: Math.floor(index / cols),
    col: index % cols,
    chars: "",
    width: 1,
    fg: 0,
    bg: 0,
    flags: 0
  };
}

function formatCell(cell: CellSnapshot): string {
  const chars = cell.chars === "" ? " " : cell.chars;
  return JSON.stringify({
    chars,
    width: cell.width,
    fg: cell.fg,
    bg: cell.bg,
    flags: cell.flags
  });
}
