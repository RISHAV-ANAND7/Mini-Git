// src/types.ts
// Core type definitions for Mini-Git's object model

/** SHA-1 hex digest — 40 hex characters */
export type Hash = string;

/** The three object types that make up Mini-Git's object store */
export type ObjectType = 'blob' | 'tree' | 'commit';

// ─── Object interfaces ────────────────────────────────────────────────────────

/**
 * Blob: stores raw file content.
 * Analogous to git blob objects.
 */
export interface BlobObject {
  type: 'blob';
  content: Buffer;
}

/**
 * A single entry inside a Tree object.
 * mode: '100644' for regular files, '040000' for sub-trees.
 */
export interface TreeEntry {
  mode: '100644' | '040000';
  name: string;
  hash: Hash;
}

/**
 * Tree: a directory snapshot — maps names to blob/tree hashes.
 * Analogous to git tree objects.
 */
export interface TreeObject {
  type: 'tree';
  entries: TreeEntry[];
}

/**
 * Commit: points to a root tree + optional parent commit + metadata.
 * Analogous to git commit objects.
 */
export interface CommitObject {
  type: 'commit';
  treeHash: Hash;
  parentHash: Hash | null;
  message: string;
  author: string;
  timestamp: number; // Unix ms
}

export type MgitObject = BlobObject | TreeObject | CommitObject;

// ─── Index (staging area) ─────────────────────────────────────────────────────

/**
 * Index entry — maps a repo-relative file path to its staged blob hash.
 * Serialised as JSON to `.mgit/index`.
 */
export interface IndexEntry {
  path: string;
  hash: Hash;
}

export type Index = IndexEntry[];

// ─── HEAD / refs ──────────────────────────────────────────────────────────────

/**
 * HEAD can point to a branch name (symbolic) or directly to a commit (detached).
 */
export type HeadRef =
  | { type: 'branch'; name: string }
  | { type: 'detached'; hash: Hash };

// ─── Diff types ──────────────────────────────────────────────────────────────

export type DiffOpType = 'equal' | 'insert' | 'delete';

export interface DiffOp {
  op: DiffOpType;
  lines: string[];
}
