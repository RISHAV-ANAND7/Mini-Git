# Mini-Git Object Model

## Content-Addressable Storage

Every object is stored by the SHA-1 digest of its serialised content:

```
hash = sha1(serialise(object))
path = .mgit/objects/<hash[0:2]>/<hash[2:]>
```

Identical content → identical hash → single stored copy. This makes the
object store an append-only, deduplicated, immutable database.

## Object Types

### Blob

Stores the raw content of a single file at a point in time.

```
blob <byte-length>\n<content>
```

No filename, no permissions — those live in the Tree.

### Tree

A directory snapshot: maps `(mode, name)` pairs to object hashes.
Entries are sorted by name for deterministic serialisation.

```
tree <entry-count>\n
<mode> <name> <hash>\n
...
```

| Mode     | Meaning          |
|----------|------------------|
| `100644` | Regular file     |
| `040000` | Sub-tree (dir)   |

### Commit

A snapshot in time: points to a root tree, an optional parent commit,
and carries author + message + timestamp metadata.

```
commit\n
tree <tree-hash>\n
parent <commit-hash|null>\n
author <name <email>>\n
timestamp <unix-ms>\n
\n
<message>
```

## Object Chain

```
COMMIT ──── treeHash ──► TREE
  │                        ├── "README.md"  ──► BLOB (sha1 of file content)
  │                        └── "src/main.ts" ──► BLOB
  │
  └── parentHash ──► COMMIT (previous commit)
                       │
                       └── parentHash ──► COMMIT ... ──► null (root)
```

## Refs

```
HEAD          "ref: refs/heads/main"   (symbolic — points to a branch)
              "abc1234..."             (detached — points to a commit)

refs/heads/
  main        "abc1234..."             (branch pointer — a commit hash)
  feature/x   "def5678..."
```

HEAD → branch → commit → tree → blobs. Following this chain from any
commit reproduces the exact state of every tracked file at that moment.
