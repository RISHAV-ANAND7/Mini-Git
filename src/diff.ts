// src/diff.ts
// Myers diff algorithm — the same O(ND) algorithm that GNU diff and Git use.
//
// Reference: Eugene W. Myers, "An O(ND) Difference Algorithm and Its Variations"
//            Algorithmica, 1986.

import type { DiffOp, DiffOpType } from './types';

// ─── Forward pass ─────────────────────────────────────────────────────────────

/**
 * Run Myers forward algorithm.
 * Returns trace where trace[d] = v[] snapshot AFTER depth d ran
 * (i.e., the state that can be used to answer "where were we before depth d+1?").
 */
function computeTrace(a: string[], b: string[]): [number[][], number] {
  const n = a.length, m = b.length;
  const max = n + m, off = max;
  const v = new Array<number>(2 * max + 2).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const ki = k + off;
      let x: number;
      if (k === -d || (k !== d && (v[ki - 1] ?? 0) < (v[ki + 1] ?? 0))) {
        x = v[ki + 1] ?? 0;
      } else {
        x = (v[ki - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[ki] = x;
    }
    trace.push(v.slice()); // snapshot AFTER depth d ran
    if ((v[0 + off] ?? 0) >= n && (0 - (v[0 + off] ?? 0)) >= -m) {
      // Check all k diagonals for termination
    }
    // Check if done
    for (let k = -d; k <= d; k += 2) {
      const x = v[k + off] ?? 0;
      const y = x - k;
      if (x >= n && y >= m) return [trace, d];
    }
  }
  return [trace, max];
}

// ─── Backtracking ─────────────────────────────────────────────────────────────

type RawStep = { op: DiffOpType; aIdx: number; bIdx: number };

function backtrack(
  a: string[], b: string[],
  trace: number[][],
  d: number,
): RawStep[] {
  const n = a.length, m = b.length;
  const max = n + m, off = max;

  const result: RawStep[] = [];
  let x = n, y = m;

  for (let depth = d; depth > 0; depth--) {
    // trace[depth-1] = v[] state AFTER depth (depth-1) ran = before depth ran
    const vBefore = trace[depth - 1]!;
    const k = x - y;
    const ki = k + off;

    const cameDown =
      k === -depth ||
      (k !== depth && (vBefore[ki - 1] ?? 0) < (vBefore[ki + 1] ?? 0));

    const prevK = cameDown ? k + 1 : k - 1;
    // prevX is where the snake ENDED at depth-1 on diagonal prevK
    const prevX = vBefore[prevK + off] ?? 0;
    const prevY = prevX - prevK;

    // The edit happened at (prevX, prevY):
    //   insert: (prevX, prevY) -> (prevX, prevY+1) then snake to (x, y)
    //   delete: (prevX, prevY) -> (prevX+1, prevY) then snake to (x, y)
    const snakeStartX = cameDown ? prevX     : prevX + 1;
    const snakeStartY = cameDown ? prevY + 1 : prevY;
    const snakeLen    = x - snakeStartX;

    // Emit in reverse order (we'll reverse at end): snake first, then edit
    for (let i = snakeLen - 1; i >= 0; i--) {
      result.push({ op: 'equal', aIdx: snakeStartX + i, bIdx: snakeStartY + i });
    }

    if (cameDown) {
      result.push({ op: 'insert', aIdx: prevX, bIdx: prevY });
    } else {
      result.push({ op: 'delete', aIdx: prevX, bIdx: prevY });
    }

    x = prevX;
    y = prevY;
  }

  // Remaining snake from (0,0) to (x,y)
  for (let i = x - 1; i >= 0; i--) {
    result.push({ op: 'equal', aIdx: i, bIdx: i });
  }

  result.reverse();
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function myersDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ op: 'insert', lines: [...b] }];
  if (m === 0) return [{ op: 'delete', lines: [...a] }];

  const [trace, d] = computeTrace(a, b);
  const steps = backtrack(a, b, trace, d);

  const ops: DiffOp[] = [];
  for (const step of steps) {
    const line = step.op === 'delete' ? a[step.aIdx] : b[step.bIdx];
    if (line === undefined) continue;
    const last = ops[ops.length - 1];
    if (last && last.op === step.op) {
      last.lines.push(line);
    } else {
      ops.push({ op: step.op, lines: [line] });
    }
  }
  return ops;
}

// ─── Unified diff formatter ───────────────────────────────────────────────────

const CONTEXT = 3;

export function formatUnifiedDiff(
  oldLabel: string,
  newLabel: string,
  oldLines: string[],
  newLines: string[],
): string {
  const ops = myersDiff(oldLines, newLines);
  if (ops.length === 0 || ops.every(o => o.op === 'equal')) return '';

  type Ann = { op: DiffOpType; text: string; oldNo: number; newNo: number };
  const ann: Ann[] = [];
  let oi = 1, ni = 1;
  for (const op of ops) {
    for (const text of op.lines) {
      ann.push({ op: op.op, text, oldNo: oi, newNo: ni });
      if (op.op === 'equal')  { oi++; ni++; }
      if (op.op === 'delete') { oi++; }
      if (op.op === 'insert') { ni++; }
    }
  }

  const inHunk = new Set<number>();
  for (let i = 0; i < ann.length; i++) {
    if (ann[i]!.op !== 'equal') {
      for (let c = Math.max(0, i - CONTEXT); c <= Math.min(ann.length - 1, i + CONTEXT); c++) {
        inHunk.add(c);
      }
    }
  }

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];

  let i = 0;
  while (i < ann.length) {
    if (!inHunk.has(i)) { i++; continue; }

    let end = i;
    while (end + 1 < ann.length && inHunk.has(end + 1)) end++;

    const firstAnn = ann[i]!;
    const oldStart = firstAnn.oldNo;
    const newStart = firstAnn.newNo;
    let oldCount = 0, newCount = 0;
    const hunkLines: string[] = [];

    for (let j = i; j <= end; j++) {
      const r = ann[j]!;
      if (r.op === 'equal')  { hunkLines.push(` ${r.text}`); oldCount++; newCount++; }
      if (r.op === 'delete') { hunkLines.push(`-${r.text}`); oldCount++; }
      if (r.op === 'insert') { hunkLines.push(`+${r.text}`); newCount++; }
    }

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...hunkLines);
    i = end + 1;
  }

  return out.join('\n');
}

// ─── Convenience helpers ──────────────────────────────────────────────────────

export function diffStrings(oldText: string, newText: string): DiffOp[] {
  return myersDiff(oldText.split('\n'), newText.split('\n'));
}

export function unifiedDiffStrings(
  oldLabel: string,
  newLabel: string,
  oldText: string,
  newText: string,
): string {
  return formatUnifiedDiff(oldLabel, newLabel, oldText.split('\n'), newText.split('\n'));
}
