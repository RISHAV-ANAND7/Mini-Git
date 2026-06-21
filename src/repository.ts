// src/repository.ts
// Repository: owns the `.mgit/` directory layout and provides
// high-level operations on HEAD, refs, and the staging index.
//
// Directory layout:
//   .mgit/
//   ├── HEAD              — "ref: refs/heads/main"  or a raw commit hash
//   ├── index             — JSON array of IndexEntry
//   ├── objects/          — content-addressable loose objects
//   │   └── <2-char>/
//   │       └── <38-char>
//   └── refs/
//       └── heads/        — branch files, each containing a commit hash

import * as fs   from 'fs';
import * as path from 'path';
import { ObjectStore } from './store';
import { isValidHash } from './hash';
import type { Hash, Index, HeadRef, IndexEntry } from './types';

export const MGIT_DIR       = '.mgit';
export const HEAD_FILE      = 'HEAD';
export const INDEX_FILE     = 'index';
export const REFS_HEADS_DIR = path.join('refs', 'heads');
export const DEFAULT_BRANCH = 'main';

export function isValidBranchName(name: string): boolean {
  return /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/.test(name);
}

export class Repository {
  readonly root: string;    // absolute path to the working directory
  readonly mgitDir: string; // absolute path to .mgit/
  readonly store: ObjectStore;

  constructor(root: string) {
    this.root    = root;
    this.mgitDir = path.join(root, MGIT_DIR);
    this.store   = new ObjectStore(this.mgitDir);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  /** Initialise a fresh .mgit directory.  Throws if one already exists. */
  init(): void {
    if (fs.existsSync(this.mgitDir)) {
      throw new Error(`Already a mini-git repository: ${this.mgitDir}`);
    }
    fs.mkdirSync(path.join(this.mgitDir, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(this.mgitDir, REFS_HEADS_DIR), { recursive: true });

    // HEAD starts pointing at main; no commit exists yet (unborn branch)
    this.writeHead({ type: 'branch', name: DEFAULT_BRANCH });
    // Empty index
    this.writeIndex([]);
  }

  // ─── HEAD ─────────────────────────────────────────────────────────────────

  readHead(): HeadRef {
    const raw = fs.readFileSync(path.join(this.mgitDir, HEAD_FILE), 'utf8').trim();
    if (raw.startsWith('ref: ')) {
      const name = raw.slice('ref: refs/heads/'.length);
      if (!isValidBranchName(name)) throw new Error(`Corrupt HEAD (invalid branch name): ${name}`);
      return { type: 'branch', name };
    }
    if (isValidHash(raw)) {
      return { type: 'detached', hash: raw };
    }
    throw new Error(`Corrupt HEAD: ${raw}`);
  }

  writeHead(ref: HeadRef): void {
    const content = ref.type === 'branch'
      ? `ref: refs/heads/${ref.name}`
      : ref.hash;
    fs.writeFileSync(path.join(this.mgitDir, HEAD_FILE), content, 'utf8');
  }

  /** Resolve HEAD to a commit hash, or null if the branch is unborn. */
  resolveHead(): Hash | null {
    const head = this.readHead();
    if (head.type === 'detached') return head.hash;
    return this.resolveBranch(head.name);
  }

  // ─── Refs / Branches ──────────────────────────────────────────────────────

  /** Read the commit hash that a branch points to; null if branch doesn't exist yet. */
  resolveBranch(name: string): Hash | null {
    if (!isValidBranchName(name)) return null;
    const p = this.branchPath(name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8').trim();
  }

  /** Write (create/update) a branch to point at a commit hash. */
  writeBranch(name: string, hash: Hash): void {
    if (!isValidBranchName(name)) throw new Error(`Invalid branch name: ${name}`);
    const p = this.branchPath(name);
    // Branch names may contain '/' (e.g. feature/auth) — ensure the
    // subdirectory exists before writing.
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, hash, 'utf8');
  }

  /** List all branch names. */
  listBranches(): string[] {
    const dir = path.join(this.mgitDir, REFS_HEADS_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f =>
      fs.statSync(path.join(dir, f)).isFile()
    );
  }

  /** Current branch name, or null if HEAD is detached. */
  currentBranch(): string | null {
    const head = this.readHead();
    return head.type === 'branch' ? head.name : null;
  }

  private branchPath(name: string): string {
    return path.join(this.mgitDir, REFS_HEADS_DIR, name);
  }

  // ─── Index ────────────────────────────────────────────────────────────────

  readIndex(): Index {
    const p = path.join(this.mgitDir, INDEX_FILE);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Index;
  }

  writeIndex(index: Index): void {
    fs.writeFileSync(
      path.join(this.mgitDir, INDEX_FILE),
      JSON.stringify(index, null, 2),
      'utf8',
    );
  }

  /** Stage a file: add or replace its entry in the index. */
  stageFile(entry: IndexEntry): void {
    const index = this.readIndex();
    const idx = index.findIndex(e => e.path === entry.path);
    if (idx === -1) {
      index.push(entry);
    } else {
      index[idx] = entry;
    }
    this.writeIndex(index);
  }

  // ─── Guard ────────────────────────────────────────────────────────────────

  /** Throw a helpful error if we're not inside a mini-git repo. */
  assertInitialised(): void {
    if (!fs.existsSync(this.mgitDir)) {
      throw new Error(
        `Not a mini-git repository (no .mgit directory found).\nRun: mgit init`,
      );
    }
  }

  // ─── Static factory ───────────────────────────────────────────────────────

  /** Walk up from cwd looking for a .mgit directory, like real Git does. */
  static discover(startDir: string = process.cwd()): Repository {
    let dir = startDir;
    while (true) {
      if (fs.existsSync(path.join(dir, MGIT_DIR))) {
        return new Repository(dir);
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(
          'Not a mini-git repository (searched up from current directory).\nRun: mgit init',
        );
      }
      dir = parent;
    }
  }
}
