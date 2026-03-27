// Layout algorithm ported from DoltHub's commit-graph (Apache-2.0)
// https://github.com/dolthub/commit-graph

export interface GraphCommit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
}

export interface PositionedCommit extends GraphCommit {
  x: number;
  y: number;
  color: string;
}

export interface BranchSegment {
  column: number;
  startRow: number;
  endRow: number;
  color: string;
}

export interface CurveDef {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color: string;
}

export interface GraphLayout {
  commits: PositionedCommit[];
  branches: BranchSegment[];
  curves: CurveDef[];
  maxColumn: number;
}

const BRANCH_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d2a8ff",
  "#f78166",
  "#ff7b72",
  "#79c0ff",
  "#7ee787",
  "#ffa657",
  "#d29922",
  "#f0883e",
];

interface BranchPath {
  startRow: number;
  endRow: number;
  endCommitHash: string;
  branchOrder: number;
}

export function layoutCommitGraph(rawCommits: GraphCommit[]): GraphLayout {
  if (rawCommits.length === 0) {
    return { commits: [], branches: [], curves: [], maxColumn: 0 };
  }

  const childrenMap = new Map<string, string[]>();
  const commitMap = new Map<string, GraphCommit>();
  for (const c of rawCommits) {
    commitMap.set(c.hash, c);
    for (const p of c.parents) {
      const children = childrenMap.get(p);
      if (children) {
        children.push(c.hash);
      } else {
        childrenMap.set(p, [c.hash]);
      }
    }
  }

  const sorted = rawCommits;

  const columns: BranchPath[][] = [];
  let branchOrder = 0;
  const posMap = new Map<string, { x: number; y: number; color: string }>();

  for (let row = 0; row < sorted.length; row++) {
    const commit = sorted[row];
    const children = childrenMap.get(commit.hash) ?? [];

    const branchChildXs: number[] = [];
    const mergeChildXs: number[] = [];
    const childYs: number[] = [];

    for (const childHash of children) {
      const childCommit = commitMap.get(childHash);
      const childPos = posMap.get(childHash);
      if (!childCommit || !childPos) continue;
      childYs.push(childPos.y);
      if (childCommit.parents[0] === commit.hash) {
        branchChildXs.push(childPos.x);
      } else {
        mergeChildXs.push(childPos.x);
      }
    }

    let col: number;
    let color: string;

    if (children.length === 0 || (branchChildXs.length === 0 && mergeChildXs.length === 0)) {
      col = columns.length;
      columns.push([]);
      const order = branchOrder++;
      color = BRANCH_COLORS[order % BRANCH_COLORS.length];
      columns[col].push({
        startRow: row,
        endRow: Infinity,
        endCommitHash: commit.hash,
        branchOrder: order,
      });
    } else if (branchChildXs.length > 0) {
      col = Math.min(...branchChildXs);
      const seg = columns[col][columns[col].length - 1];
      if (seg && seg.endRow === Infinity) {
        seg.endRow = row;
        seg.endCommitHash = commit.hash;
      }
      color = BRANCH_COLORS[(seg?.branchOrder ?? 0) % BRANCH_COLORS.length];

      if (commit.parents.length > 0) {
        const order = seg?.branchOrder ?? branchOrder++;
        columns[col].push({
          startRow: row,
          endRow: Infinity,
          endCommitHash: commit.hash,
          branchOrder: order,
        });
      }

      for (const bx of branchChildXs) {
        if (bx !== col) {
          const otherSeg = columns[bx][columns[bx].length - 1];
          if (otherSeg && otherSeg.endRow === Infinity) {
            otherSeg.endRow = row;
            otherSeg.endCommitHash = commit.hash;
          }
        }
      }
    } else {
      const maxChildX = Math.max(...mergeChildXs);
      const minChildY = Math.min(...childYs);
      col = -1;

      for (let c = maxChildX + 1; c < columns.length; c++) {
        const lastSeg = columns[c][columns[c].length - 1];
        if (!lastSeg || lastSeg.endRow <= minChildY) {
          col = c;
          break;
        }
      }

      if (col === -1) {
        col = columns.length;
        columns.push([]);
      }

      const order = branchOrder++;
      color = BRANCH_COLORS[order % BRANCH_COLORS.length];
      columns[col].push({
        startRow: row,
        endRow: Infinity,
        endCommitHash: commit.hash,
        branchOrder: order,
      });
    }

    posMap.set(commit.hash, { x: col, y: row, color });
  }

  for (const colSegs of columns) {
    const last = colSegs[colSegs.length - 1];
    if (last && last.endRow === Infinity) {
      last.endRow = sorted.length - 1;
    }
  }

  const commits: PositionedCommit[] = sorted.map((c) => {
    const pos = posMap.get(c.hash)!;
    return { ...c, x: pos.x, y: pos.y, color: pos.color };
  });

  const branches: BranchSegment[] = [];
  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    for (const seg of columns[colIdx]) {
      if (seg.startRow < seg.endRow) {
        branches.push({
          column: colIdx,
          startRow: seg.startRow,
          endRow: seg.endRow,
          color: BRANCH_COLORS[seg.branchOrder % BRANCH_COLORS.length],
        });
      }
    }
  }

  const curves: CurveDef[] = [];
  for (const commit of commits) {
    const children = childrenMap.get(commit.hash) ?? [];
    for (const childHash of children) {
      const childPos = posMap.get(childHash);
      if (!childPos) continue;
      const childCommit = commitMap.get(childHash);
      if (!childCommit) continue;
      if (childPos.x !== commit.x && childCommit.parents[0] === commit.hash) {
        curves.push({
          startX: childPos.x,
          startY: childPos.y,
          endX: commit.x,
          endY: commit.y,
          color: posMap.get(childHash)!.color,
        });
      }
    }

    for (let i = 1; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i];
      const parentPos = posMap.get(parentHash);
      if (!parentPos) continue;
      if (parentPos.x !== commit.x) {
        curves.push({
          startX: commit.x,
          startY: commit.y,
          endX: parentPos.x,
          endY: parentPos.y,
          color: parentPos.color,
        });
      }
    }
  }

  return {
    commits,
    branches,
    curves,
    maxColumn: columns.length - 1,
  };
}
