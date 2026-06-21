

import { myersDiff, formatUnifiedDiff, unifiedDiffStrings } from '../src/diff';
import type { DiffOp } from '../src/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Reconstruct the "new" file from a diff to verify patch correctness. */
function applyDiff(oldLines: string[], ops: DiffOp[]): string[] {
  const result: string[] = [];
  for (const op of ops) {
    if (op.op === 'equal' || op.op === 'insert') {
      result.push(...op.lines);
    }
    // delete ops are dropped
  }
  return result;
}

/** Reconstruct the "old" file from a diff (reverse). */
function applyDiffReverse(newLines: string[], ops: DiffOp[]): string[] {
  const result: string[] = [];
  for (const op of ops) {
    if (op.op === 'equal' || op.op === 'delete') {
      result.push(...op.lines);
    }
  }
  return result;
}


describe('myersDiff — edge cases', () => {
  it('two empty arrays → empty diff', () => {
    expect(myersDiff([], [])).toEqual([]);
  });

  it('empty old + non-empty new → all inserts', () => {
    const ops = myersDiff([], ['a', 'b', 'c']);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('insert');
    expect(ops[0]?.lines).toEqual(['a', 'b', 'c']);
  });

  it('non-empty old + empty new → all deletes', () => {
    const ops = myersDiff(['x', 'y'], []);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('delete');
    expect(ops[0]?.lines).toEqual(['x', 'y']);
  });

  it('identical arrays → all equal', () => {
    const lines = ['foo', 'bar', 'baz'];
    const ops = myersDiff(lines, lines);
    expect(ops.every(o => o.op === 'equal')).toBe(true);
    expect(applyDiff(lines, ops)).toEqual(lines);
  });

  it('single-line insert', () => {
    const ops = myersDiff(['a', 'c'], ['a', 'b', 'c']);
    // Should produce equal('a'), insert('b'), equal('c') or equivalent
    const result = applyDiff(['a', 'c'], ops);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('single-line delete', () => {
    const ops = myersDiff(['a', 'b', 'c'], ['a', 'c']);
    const result = applyDiff(['a', 'b', 'c'], ops);
    expect(result).toEqual(['a', 'c']);
  });
});

// ─── correctness on known inputs ─────────────────────────────────────────────

describe('myersDiff — known inputs (Myers 1986 examples)', () => {
  // Classic diff textbook example: a→b
  const a = ['A', 'B', 'C', 'A', 'B', 'B', 'A'];
  const b = ['C', 'B', 'A', 'B', 'A', 'C'];

  it('patch correctness: applying diff to old produces new', () => {
    const ops = myersDiff(a, b);
    expect(applyDiff(a, ops)).toEqual(b);
  });

  it('reverse patch correctness: deletes reconstruct old file', () => {
    const ops = myersDiff(a, b);
    expect(applyDiffReverse(b, ops)).toEqual(a);
  });

  it('no unnecessary ops — all ops are used', () => {
    const ops = myersDiff(a, b);
    expect(ops.length).toBeGreaterThan(0);
    ops.forEach(op => expect(op.lines.length).toBeGreaterThan(0));
  });
});

describe('myersDiff — realistic code change', () => {
  const oldCode = [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'function sub(a, b) {',
    '  return a - b;',
    '}',
  ];

  const newCode = [
    'function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'function mul(a: number, b: number): number {',
    '  return a * b;',
    '}',
  ];

  it('patch correctness', () => {
    const ops = myersDiff(oldCode, newCode);
    expect(applyDiff(oldCode, ops)).toEqual(newCode);
  });

  it('detects the changed first line', () => {
    const ops = myersDiff(oldCode, newCode);
    const hasDelete = ops.some(o => o.op === 'delete' && o.lines.some(l => l.includes('function add(a, b)')));
    const hasInsert = ops.some(o => o.op === 'insert' && o.lines.some(l => l.includes('number')));
    expect(hasDelete).toBe(true);
    expect(hasInsert).toBe(true);
  });

  it('preserves unchanged lines as equal', () => {
    const ops = myersDiff(oldCode, newCode);
    const equalLines = ops.filter(o => o.op === 'equal').flatMap(o => o.lines);
    expect(equalLines).toContain('  return a + b;');
    expect(equalLines).toContain('');
  });
});

// ─── unified diff formatter ───────────────────────────────────────────────────

describe('formatUnifiedDiff', () => {
  const oldLines = ['line1', 'line2', 'line3'];
  const newLines = ['line1', 'CHANGED', 'line3'];

  it('produces --- and +++ headers', () => {
    const output = formatUnifiedDiff('a/file.txt', 'b/file.txt', oldLines, newLines);
    expect(output).toContain('--- a/file.txt');
    expect(output).toContain('+++ b/file.txt');
  });

  it('produces @@ hunk headers', () => {
    const output = formatUnifiedDiff('a/f', 'b/f', oldLines, newLines);
    expect(output).toContain('@@');
  });

  it('marks deleted lines with -', () => {
    const output = formatUnifiedDiff('a/f', 'b/f', oldLines, newLines);
    expect(output).toContain('-line2');
  });

  it('marks inserted lines with +', () => {
    const output = formatUnifiedDiff('a/f', 'b/f', oldLines, newLines);
    expect(output).toContain('+CHANGED');
  });

  it('returns empty string for identical content', () => {
    const output = formatUnifiedDiff('a/f', 'b/f', oldLines, oldLines);
    expect(output).toBe('');
  });
});

describe('unifiedDiffStrings', () => {
  it('diffs two multi-line strings', () => {
    const old = 'foo\nbar\nbaz\n';
    const nw  = 'foo\nQUX\nbaz\n';
    const out = unifiedDiffStrings('old', 'new', old, nw);
    expect(out).toContain('-bar');
    expect(out).toContain('+QUX');
  });

  it('returns empty for identical strings', () => {
    const s = 'same\ncontent\n';
    expect(unifiedDiffStrings('a', 'b', s, s)).toBe('');
  });
});

// ─── property tests ──────────────────────────────────────────────────────────

describe('myersDiff — properties', () => {
  const testCases: Array<[string[], string[]]> = [
    [['a'], ['b']],
    [['a', 'b', 'c'], ['c', 'b', 'a']],
    [['x'], []],
    [[], ['y']],
    [['same', 'same'], ['same', 'same']],
    [['1', '2', '3', '4', '5'], ['1', '3', '5']],
    [['a', 'b'], ['a', 'b', 'c', 'd']],
  ];

  test.each(testCases)('applying diff(%p, %p) reproduces the new array', (a, b) => {
    const ops = myersDiff(a, b);
    expect(applyDiff(a, ops)).toEqual(b);
  });

  test.each(testCases)('no empty ops in result', (a, b) => {
    const ops = myersDiff(a, b);
    ops.forEach(op => expect(op.lines.length).toBeGreaterThan(0));
  });
});
