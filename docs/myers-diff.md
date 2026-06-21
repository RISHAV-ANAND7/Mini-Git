# Myers Diff Algorithm

Mini-Git implements Eugene Myers' O(ND) difference algorithm — the same
algorithm used by GNU diff and Git itself.

## Why Myers?

1. **Optimal**: produces the *shortest* edit script (fewest insertions + deletions).
2. **Unsurprising**: tends to produce the "human expected" diff for code.
3. **Efficient**: O((N+M)·D) time where D is usually much smaller than N+M.

## Algorithm Overview

The edit graph has axes `x` (position in old file) and `y` (position in new file).
A *diagonal* move `(x→x+1, y→y+1)` represents an equal line.
A horizontal move `(x→x+1)` is a delete; a vertical `(y→y+1)` is an insert.

Myers finds the path from `(0,0)` to `(n,m)` with the minimum number of
non-diagonal (edit) moves. The key insight is that at edit distance `d`,
all reachable endpoints lie on diagonals `k = -d, -d+2, …, d-2, d`.

### Forward pass

```
for d = 0 .. N+M:
  record v[] snapshot        // v[k] = furthest x on diagonal k
  for k = -d .. d (step 2):
    x = best_x_from_k_minus_1_or_k_plus_1(v, k)
    y = x - k
    extend snake: while a[x] == b[y]: x++, y++
    v[k] = x
    if x >= n and y >= m: done at distance d
```

### Backtracking

Walk backwards through the snapshots from `(n,m)` to `(0,0)`,
at each depth `d` re-applying the same decision logic to determine whether
we arrived via a delete (horizontal) or insert (vertical) move, then emit:

```
emit the insert or delete
emit the diagonal snake (equal lines) that followed it
recurse to depth d-1
```

## Implementation Notes

- `trace[d]` stores `v[]` **after** depth `d` ran, so `trace[d-1]` is the
  pre-depth-`d` state used during backtracking.
- Diagonals are indexed with an offset (`off = N+M`) so negative `k` values
  can be stored in a plain array.
- The snake length after an edit is `x - snakeStartX` where `snakeStartX`
  is `prevX` (insert) or `prevX+1` (delete).
