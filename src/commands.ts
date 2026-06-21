// src/commands.ts
// High-level command implementations.
// Each function mirrors one CLI sub-command and is kept pure enough
// to be unit-tested without spinning up a real CLI.

import * as fs   from 'fs';
import { listFilesRecursive, ensureInsideRepo } from './utils';
import * as path from 'path';
import { sha1, shortHash } from './hash';
import { serialise, deserialise } from './store';
import { unifiedDiffStrings } from './diff';
import { Repository, DEFAULT_BRANCH } from './repository';
import type {
  Hash,
  BlobObject,
  TreeObject,
  CommitObject,
  IndexEntry,
  TreeEntry,
} from './types';

// ─── init ────────────────────────────────────────────────────────────────────

export function cmdInit(root: string): string {
  const repo = new Repository(root);
  repo.init();
  return `Initialised empty Mini-Git repository in ${repo.mgitDir}`;
}

// ─── add ─────────────────────────────────────────────────────────────────────

export function cmdAdd(repo: Repository, filePath: string): string {
  repo.assertInitialised();

  const absPath = ensureInsideRepo(repo.root, filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`pathspec '${filePath}' did not match any files`);
  }

  const content = fs.readFileSync(absPath);
  const blob: BlobObject = { type: 'blob', content };
  const hash = repo.store.write(blob);

  // Store path relative to repo root so it's portable
  const relPath = path.relative(repo.root, absPath).replace(/\\/g, '/');
  repo.stageFile({ path: relPath, hash });

  return `add: ${relPath} → ${shortHash(hash)}`;
}


// ─── add . (all files) ───────────────────────────────────────────────────────

/**
 * Stage all tracked files in the working tree.
 * Skips .mgit/ automatically (via listFilesRecursive).
 * Mirrors `git add .`
 */
export function cmdAddAll(repo: Repository): string {
  repo.assertInitialised();
  const files = listFilesRecursive(repo.root);
  if (files.length === 0) return 'Nothing to add.';
  const results: string[] = [];
  for (const file of files) {
    results.push(cmdAdd(repo, file));
  }
  return results.join('\n');
}

// ─── commit ──────────────────────────────────────────────────────────────────

export function cmdCommit(
  repo: Repository,
  message: string,
  author: string = getAuthor(),
): { hash: Hash; output: string } {
  repo.assertInitialised();

  const index = repo.readIndex();
  if (index.length === 0) {
    throw new Error('Nothing to commit (index is empty). Use: mgit add <file>');
  }

  // Build tree entries from the flat index
  // Note: this implementation uses a single flat tree (no sub-trees) for simplicity.
  // Nested directory support would require building a tree of trees.
  const entries: TreeEntry[] = index.map(e => ({
    mode: '100644' as const,
    name: e.path,
    hash: e.hash,
  }));

  const tree: TreeObject = { type: 'tree', entries };
  const treeHash = repo.store.write(tree);

  const parentHash = repo.resolveHead();
  if (parentHash) {
    const parentObj = repo.store.read(parentHash);
    if (parentObj.type === 'commit' && parentObj.treeHash === treeHash) {
      throw new Error('Nothing to commit (working tree clean)');
    }
  }

  const commit: CommitObject = {
    type: 'commit',
    treeHash,
    parentHash,
    message,
    author,
    timestamp: Date.now(),
  };

  const commitHash = repo.store.write(commit);

  // Advance branch pointer (or detached HEAD)
  const head = repo.readHead();
  if (head.type === 'branch') {
    repo.writeBranch(head.name, commitHash);
  } else {
    repo.writeHead({ type: 'detached', hash: commitHash });
  }

  const output = `[${repo.currentBranch() ?? 'HEAD'} ${shortHash(commitHash)}] ${message}`;
  return { hash: commitHash, output };
}

// ─── log ─────────────────────────────────────────────────────────────────────

export interface LogEntry {
  hash: Hash;
  short: string;
  author: string;
  date: string;
  message: string;
}

export function cmdLog(repo: Repository): LogEntry[] {
  repo.assertInitialised();

  let hash = repo.resolveHead();
  if (!hash) {
    throw new Error('No commits yet.');
  }

  const entries: LogEntry[] = [];

  while (hash) {
    const obj = repo.store.read(hash);
    if (obj.type !== 'commit') throw new Error(`Expected commit, got ${obj.type}: ${hash}`);

    entries.push({
      hash,
      short:   shortHash(hash),
      author:  obj.author,
      date:    new Date(obj.timestamp).toISOString(),
      message: obj.message,
    });

    hash = obj.parentHash;
  }

  return entries;
}

export function formatLog(entries: LogEntry[]): string {
  return entries.map(e =>
    [
      `commit ${e.hash}`,
      `Author: ${e.author}`,
      `Date:   ${e.date}`,
      '',
      `    ${e.message}`,
      '',
    ].join('\n'),
  ).join('\n');
}

// ─── checkout ────────────────────────────────────────────────────────────────

export function cmdCheckout(repo: Repository, ref: string): string {
  repo.assertInitialised();

  // Resolve ref: try branch first, then raw hash
  let commitHash: Hash | null = repo.resolveBranch(ref);
  let targetBranch: string | null = null;

  if (commitHash) {
    // It's a branch name
    targetBranch = ref;
  } else {
    // Assume it's a (possibly short) commit hash — find the full hash
    commitHash = resolveRef(repo, ref);
    if (!commitHash) {
      throw new Error(`Unknown ref: '${ref}' (not a branch or commit hash)`);
    }
  }

  // Read the commit
  const commitObj = repo.store.read(commitHash);
  if (commitObj.type !== 'commit') {
    throw new Error(`Not a commit: ${commitHash}`);
  }

  // Read the tree
  const treeObj = repo.store.read(commitObj.treeHash);
  if (treeObj.type !== 'tree') {
    throw new Error(`Not a tree: ${commitObj.treeHash}`);
  }

  // Restore files
  const restored: string[] = [];
  const targetPaths = new Set(treeObj.entries.map(e => e.name));

  // Remove files in the working tree that are NOT in the target tree
  // (only remove files that were tracked — i.e. present in current index)
  const currentIndex = repo.readIndex();

  // Safe-checkout conflict detection
  for (const entry of currentIndex) {
    const absPath = path.join(repo.root, entry.path);
    if (fs.existsSync(absPath)) {
      const workingContent = fs.readFileSync(absPath);
      // Constructing blob to get its hash. Since BlobObject content is Buffer.
      const workingHash = sha1(serialise({ type: 'blob', content: workingContent }));
      if (workingHash !== entry.hash) {
        throw new Error(`Your local changes to '${entry.path}' would be overwritten by checkout.\nPlease commit your changes before you switch branches.`);
      }
    }
  }

  for (const entry of currentIndex) {
    if (!targetPaths.has(entry.path)) {
      const absPath = ensureInsideRepo(repo.root, entry.path);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        // Clean up empty parent directories
        let dir = path.dirname(absPath);
        while (dir !== repo.root) {
          try {
            fs.rmdirSync(dir); // only removes if empty
            dir = path.dirname(dir);
          } catch { break; }
        }
      }
    }
  }

  for (const entry of treeObj.entries) {
    const blobObj = repo.store.read(entry.hash);
    if (blobObj.type !== 'blob') {
      throw new Error(`Not a blob: ${entry.hash}`);
    }
    const absPath = ensureInsideRepo(repo.root, entry.name);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, blobObj.content);
    restored.push(entry.name);
  }

  // Restore index to match the checked-out tree
  const newIndex: IndexEntry[] = treeObj.entries.map(e => ({
    path: e.name,
    hash: e.hash,
  }));
  repo.writeIndex(newIndex);

  // Update HEAD
  if (targetBranch) {
    repo.writeHead({ type: 'branch', name: targetBranch });
    return `Switched to branch '${targetBranch}'\n  Restored: ${restored.join(', ')}`;
  } else {
    repo.writeHead({ type: 'detached', hash: commitHash });
    return `HEAD is now at ${shortHash(commitHash)}\n  Restored: ${restored.join(', ')}`;
  }
}

// ─── diff ────────────────────────────────────────────────────────────────────

export function cmdDiff(repo: Repository): string {
  repo.assertInitialised();

  const index = repo.readIndex();
  if (index.length === 0) return 'Nothing staged. Use: mgit add <file>';

  const commitHash = repo.resolveHead();
  const parts: string[] = [];

  for (const entry of index) {
    const absPath = path.join(repo.root, entry.path);
    const workingContent = fs.existsSync(absPath)
      ? fs.readFileSync(absPath, 'utf8')
      : '';

    // Find committed content for this path
    let committedContent = '';
    if (commitHash) {
      const commitObj = repo.store.read(commitHash);
      if (commitObj.type === 'commit') {
        const treeObj = repo.store.read(commitObj.treeHash);
        if (treeObj.type === 'tree') {
          const treeEntry = treeObj.entries.find(e => e.name === entry.path);
          if (treeEntry) {
            const blobObj = repo.store.read(treeEntry.hash);
            if (blobObj.type === 'blob') {
              committedContent = blobObj.content.toString('utf8');
            }
          }
        }
      }
    }

    const diff = unifiedDiffStrings(
      `a/${entry.path}`,
      `b/${entry.path}`,
      committedContent,
      workingContent,
    );

    if (diff) parts.push(diff);
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No differences (working tree matches HEAD)';
}

// ─── branch ──────────────────────────────────────────────────────────────────

export function cmdBranch(repo: Repository, name?: string): string {
  repo.assertInitialised();

  if (!name) {
    // List branches
    const branches  = repo.listBranches();
    const current   = repo.currentBranch();
    const lines = branches.map(b => b === current ? `* ${b}` : `  ${b}`);
    return lines.length > 0 ? lines.join('\n') : '(no branches yet)';
  }

  // Create branch
  const commitHash = repo.resolveHead();
  if (!commitHash) {
    throw new Error('Cannot create a branch on an unborn repository (no commits yet)');
  }

  if (repo.resolveBranch(name)) {
    throw new Error(`Branch '${name}' already exists`);
  }

  repo.writeBranch(name, commitHash);
  return `Branch '${name}' created at ${shortHash(commitHash)}`;
}

// ─── switch ──────────────────────────────────────────────────────────────────

export function cmdSwitch(repo: Repository, branchName: string): string {
  repo.assertInitialised();

  const commitHash = repo.resolveBranch(branchName);
  if (!commitHash) {
    throw new Error(`Branch '${branchName}' not found. Create it first: mgit branch ${branchName}`);
  }

  // Restore working tree for the branch tip
  const result = cmdCheckout(repo, branchName);
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a partial or full hash to a full 40-char hash by scanning the
 * object store.  Returns null if not found.
 */
function resolveRef(repo: Repository, ref: string): Hash | null {
  // Try exact match first
  if (repo.store.exists(ref)) return ref;

  // Try prefix match by scanning objects directory
  const objectsDir = path.join(repo.mgitDir, 'objects');
  if (!fs.existsSync(objectsDir)) return null;

  const prefix2  = ref.slice(0, 2);
  const rest     = ref.slice(2);
  const subDir   = path.join(objectsDir, prefix2);

  if (!fs.existsSync(subDir)) return null;

  const matches = fs.readdirSync(subDir).filter(f => f.startsWith(rest));
  if (matches.length === 1) return prefix2 + matches[0];
  if (matches.length > 1)   throw new Error(`Ambiguous ref: ${ref}`);
  return null;
}

function getAuthor(): string {
  // Prefer env vars (mirrors Git's GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL pattern)
  const name  = process.env['MGIT_AUTHOR_NAME']  ?? process.env['USER'] ?? 'unknown';
  const email = process.env['MGIT_AUTHOR_EMAIL'] ?? `${name}@localhost`;
  return `${name} <${email}>`;
}

// ─── hash-object (plumbing) ───────────────────────────────────────────────────

/**
 * Hash a file and print its SHA-1 without staging it.
 * Mirrors `git hash-object <file>`.
 */
export function cmdHashObject(filePath: string): Hash {
  const fs = require('fs') as typeof import('fs');
  const content = fs.readFileSync(filePath);
  const blob: import('./types').BlobObject = { type: 'blob', content };
  return sha1(serialise(blob));
}

// ─── ls-tree ─────────────────────────────────────────────────────────────────

/**
 * List the contents of a tree object (by commit hash or tree hash).
 * Mirrors `git ls-tree <ref>`.
 */
export function cmdLsTree(repo: Repository, ref: string): string {
  repo.assertInitialised();

  let hash: Hash = ref;

  // If it looks like a branch or short hash, resolve it
  if (ref.length < 40) {
    const branchHash = repo.resolveBranch(ref);
    if (branchHash) {
      hash = branchHash;
    } else {
      // Try resolving as commit hash prefix
      const resolved = resolveRef(repo, ref);
      if (!resolved) throw new Error(`Unknown ref: ${ref}`);
      hash = resolved;
    }
  }

  const obj = repo.store.read(hash);
  let treeHash: Hash;

  if (obj.type === 'commit') {
    treeHash = obj.treeHash;
  } else if (obj.type === 'tree') {
    treeHash = hash;
  } else {
    throw new Error(`Not a commit or tree: ${hash}`);
  }

  const tree = repo.store.read(treeHash);
  if (tree.type !== 'tree') throw new Error(`Not a tree: ${treeHash}`);

  return tree.entries
    .map(e => `${e.mode} blob ${e.hash}\t${e.name}`)
    .join('\n');
}
