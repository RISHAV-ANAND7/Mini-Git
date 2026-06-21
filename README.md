# Mini-Git (`mgit`)

A minimal Git implementation in TypeScript — content-addressable object store, Myers diff, and branching. Minimal runtime dependencies (only `commander`).

Built as a resume-grade systems project demonstrating deep understanding of how Git works under the hood.

---

## Object Model

Every object is stored by the SHA-1 hash of its serialised content in `.mgit/objects/<2-char>/<38-char>`. Identical content always maps to the same hash — this is **content-addressability**.

```
Working Directory          Staging Index           Object Store (.mgit/objects/)
─────────────────          ─────────────           ─────────────────────────────

 hello.txt ──► mgit add ──► index entry ──────────────────► BLOB
 README.md ──► mgit add ──► index entry ──────────────────► BLOB
                                                              │
                            mgit commit                       │
                                │                             ▼
                                └──────────────────────────► TREE
                                                              │  entries:
                                                              │    100644 (sha1) hello.txt
                                                              │    040000 (sha1) docs/   ──► TREE
                                                              │
                                                              ▼
                                                            COMMIT
                                                              │  tree     ──► TREE  (sha1)
                                                              │  parent   ──► COMMIT (sha1) or null
                                                              │  author   "Alice <alice@example.com>"
                                                              │  message  "initial commit"
                                                              │  timestamp 1718000000000
                                                              │
                                                              ▼
                                             older COMMIT ◄── parent pointer
                                                  │
                                                  ▼
                                             even older COMMIT (parentHash = null)
                                             ← root commit
```

### Three Object Types

| Type   | Contains                                        | Analogous to    |
|--------|-------------------------------------------------|-----------------|
| Blob   | Raw file content (binary `Buffer`)              | `git cat-file blob` |
| Tree   | `mode hash name\0` entries (supports subtrees)  | `git cat-file tree` |
| Commit | treeHash + parentHash + author + message + ts   | `git cat-file commit` |

### Refs and HEAD

```
.mgit/
├── HEAD               ← "ref: refs/heads/main"  (symbolic)
│                        or "abc1234..."          (detached)
├── index              ← JSON: [{ path, hash }, ...]
├── objects/
│   ├── aa/
│   │   └── f4c61d...  ← blob, tree, or commit (sha1[2:] as filename)
│   └── ...
└── refs/
    └── heads/
        ├── main       ← "abc1234..."  (40-char commit hash)
        └── feature    ← "def5678..."
```

---

## Features

### Core (content-addressable object store)
- `mgit init` — creates `.mgit/` structure
- `mgit add <file>` — hashes file → writes blob → stages in index
- `mgit commit -m "<msg>"` — creates tree + commit, advances branch pointer
- `mgit log` — walks parent chain, prints history
- `mgit checkout <ref>` — restores working directory from commit hash or branch

### Diff (Myers algorithm)
- `mgit diff` — unified diff of working tree vs last commit
- Implements Eugene Myers' O(ND) algorithm (same as GNU diff / Git)

### Branching
- `mgit branch [name]` — list branches or create one at HEAD
- `mgit switch <branch>` — switch to an existing branch
- Branches are plain files in `.mgit/refs/heads/` — dead simple

### Debug
- `mgit cat-object <hash>` — pretty-print any object as JSON
- `mgit status` — show current branch and staged files

---

## Quick Start

```bash
# Install
git clone https://github.com/RISHAV-ANAND7/mini-git
cd mini-git
npm install
npm run build

# Use globally
npm link
# or run directly:
node dist/cli.js <command>
```

```bash
# In a new directory:
mkdir my-project && cd my-project
mgit init

echo "# Hello" > README.md
mgit add README.md
mgit commit -m "initial commit"

echo "world" >> README.md
mgit add README.md
mgit diff          # shows Myers diff

mgit branch feature
mgit switch feature
echo "feature" > feature.txt
mgit add feature.txt
mgit commit -m "add feature"

mgit log --oneline
mgit switch main
```

---

## Serialisation Format

Objects use binary formatting for content (`Buffer` for Blobs) and null-byte termination for trees to avoid parsing ambiguity:

**Blob:**
```
blob <byte-length>\n<raw-binary-content>
```

**Tree:**
```
tree <entry-count>\n<mode> <hash> <name>\0...
```
*(Trees are built recursively, where subdirectories are stored as `040000` tree objects).*

**Commit:**
```
commit\ntree <hash>\nparent <hash|null>\nauthor <name>\ntimestamp <ms>\n\n<message>
```

The hash of each file is `sha1(serialised-content)` — content-addressable by definition.

---

## Running Tests

```bash
npm test                 # all tests
npm run test:coverage    # with coverage report
```

Test coverage includes:
- SHA-1 hashing (RFC test vectors, content-addressable determinism)
- Object serialisation round-trips for all three types
- ObjectStore disk I/O (write/read/exists, content-addressability verification)
- Full `init → add → commit → log` cycle
- `checkout` restores working directory correctly
- Branch creation, listing, switching
- Myers diff correctness on known inputs (Myers 1986 paper examples)
- Unified diff formatter (headers, hunk markers, +/- lines)
- Repository discovery (walks up from sub-directory)

---

## Why Myers Diff?

Myers' O(ND) algorithm finds the **shortest edit script** between two sequences. It's the same algorithm used by GNU diff, Git, and most modern VCS tools.

Key properties:
- **O((N+M)·D)** time, where D is the edit distance (usually small)
- **Minimal diff**: never produces unnecessary edits
- Naturally produces the "least surprising" diff humans expect

The implementation in `src/diff.ts` is self-contained with zero dependencies and includes full backtracking to reconstruct the edit path.

---

## Architecture

```
src/
├── types.ts       — All TypeScript interfaces (Hash, BlobObject, TreeObject, CommitObject, ...)
├── hash.ts        — sha1(), objectPath(), shortHash() — zero deps
├── store.ts       — ObjectStore: serialise/deserialise/write/read all three object types
├── repository.ts  — Repository: .mgit layout, HEAD/refs/index management
├── diff.ts        — Myers diff algorithm + unified diff formatter
├── commands.ts    — Pure command implementations (init/add/commit/log/checkout/diff/branch/switch)
└── cli.ts         — Thin Commander CLI wrapper

tests/
├── hash.test.ts       — SHA-1 correctness + utilities
├── store.test.ts      — Serialisation round-trips + disk I/O
├── repository.test.ts — HEAD/refs/index management
├── commands.test.ts   — Integration: full init→add→commit→log→checkout cycles
└── diff.test.ts       — Myers algorithm correctness on known inputs
```

---

## Environment Variables

| Variable             | Default                    | Purpose              |
|----------------------|----------------------------|----------------------|
| `MGIT_AUTHOR_NAME`   | `$USER` or `unknown`       | Commit author name   |
| `MGIT_AUTHOR_EMAIL`  | `<name>@localhost`         | Commit author email  |

---

## What Mini-Git Intentionally Omits

- **Networking** (push/pull/remotes) — focus is on the local object model
- **Merging** — requires three-way diff; out of scope
- **Pack files** — real Git packs many objects into one file for efficiency
- **Index locking** — no concurrent access protection
- **zlib compression** — objects stored as plain text for readability/debugging
- **`.gitignore` support** — all files must be added explicitly

---

## License

MIT
