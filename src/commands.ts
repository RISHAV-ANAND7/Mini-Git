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
  const relPath = path.relative(repo.root, absPath).replace(/\\/g, '/');

  if (!fs.existsSync(absPath)) {
    const index = repo.readIndex();
    if (index.some(e => e.path === relPath)) {
      repo.writeIndex(index.filter(e => e.path !== relPath));
      return `rm: ${relPath}`;
    }
    throw new Error(`pathspec '${filePath}' did not match any files`);
  }

  const content = fs.readFileSync(absPath);
  const blob: BlobObject = { type: 'blob', content };
  const hash = repo.store.write(blob);

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
  const filesOnDisk = listFilesRecursive(repo.root);
  const index = repo.readIndex();
  
  const allFiles = new Set([...filesOnDisk, ...index.map(e => e.path)]);
  if (allFiles.size === 0) return 'Nothing to add.';
  
  const results: string[] = [];
  for (const file of allFiles) {
    const absPath = path.join(repo.root, file);
    if (fs.existsSync(absPath) || index.some(e => e.path === file)) {
      results.push(cmdAdd(repo, file));
    }
  }
  return results.filter(Boolean).join('\n');
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

  // Build nested tree entries from the flat index
  const treeHash = buildTree(repo, index);

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

  // Find current HEAD tree to know what was originally checked out
  const headHash = repo.resolveHead();
  let headFiles = new Map<string, Hash>();
  if (headHash) {
    const headObj = repo.store.read(headHash);
    if (headObj.type === 'commit') {
      headFiles = flattenTree(repo, headObj.treeHash);
    }
  }

  // Restore files
  const restored: string[] = [];
  const targetFiles = flattenTree(repo, commitObj.treeHash);

  // Safe-checkout conflict detection
  const currentIndex = repo.readIndex();
  const indexMap = new Map(currentIndex.map(e => [e.path, e.hash]));
  
  const workingFiles = listFilesRecursive(repo.root);
  const workingMap = new Map<string, Hash>();
  for (const f of workingFiles) {
    const absPath = path.join(repo.root, f);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath);
    workingMap.set(f, sha1(serialise({ type: 'blob', content })));
  }

  const pathsToUpdate = new Set<string>();
  const pathsToDelete = new Set<string>();

  for (const [p, targetHash] of targetFiles.entries()) {
    if (headFiles.get(p) !== targetHash) {
      pathsToUpdate.add(p);
    }
  }
  for (const p of headFiles.keys()) {
    if (!targetFiles.has(p)) {
      pathsToDelete.add(p);
    }
  }

  for (const p of new Set([...pathsToUpdate, ...pathsToDelete])) {
    const inIndex = indexMap.has(p);
    const inWorking = workingMap.has(p);

    if (!inIndex && inWorking) {
      throw new Error(`The following untracked working tree files would be overwritten by checkout:\n  ${p}\nPlease move or remove them before you switch branches.`);
    }

    const isStaged = indexMap.get(p) !== headFiles.get(p);
    const isUnstaged = inWorking ? (workingMap.get(p) !== indexMap.get(p)) : inIndex;

    if (isStaged || isUnstaged) {
      throw new Error(`Your local changes to '${p}' would be overwritten by checkout.\nPlease commit your changes or stash them before you switch branches.`);
    }
  }

  for (const p of pathsToDelete) {
    const absPath = ensureInsideRepo(repo.root, p);
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      let dir = path.dirname(absPath);
      while (dir !== repo.root) {
        try { fs.rmdirSync(dir); dir = path.dirname(dir); } catch { break; }
      }
    }
  }

  for (const p of pathsToUpdate) {
    const hash = targetFiles.get(p)!;
    const blobObj = repo.store.read(hash);
    if (blobObj.type !== 'blob') throw new Error(`Not a blob: ${hash}`);
    const absPath = ensureInsideRepo(repo.root, p);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, blobObj.content);
    restored.push(p);
  }

  const finalIndexMap = new Map(indexMap);
  for (const p of pathsToDelete) {
    finalIndexMap.delete(p);
  }
  for (const p of pathsToUpdate) {
    finalIndexMap.set(p, targetFiles.get(p)!);
  }
  const newIndex: IndexEntry[] = Array.from(finalIndexMap.entries())
    .map(([path, hash]) => ({ path, hash }))
    .sort((a, b) => a.path.localeCompare(b.path));
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

export function cmdDiff(repo: Repository, staged: boolean = false): string {
  repo.assertInitialised();

  const index = repo.readIndex();
  
  const parts: string[] = [];

  if (staged) {
    const headHash = repo.resolveHead();
    let headFiles = new Map<string, Hash>();
    if (headHash) {
      const commitObj = repo.store.read(headHash);
      if (commitObj.type === 'commit') {
        headFiles = flattenTree(repo, commitObj.treeHash);
      }
    }

    const indexMap = new Map(index.map(e => [e.path, e.hash]));
    const allPaths = new Set([...headFiles.keys(), ...indexMap.keys()]);

    for (const p of Array.from(allPaths).sort()) {
      const hHash = headFiles.get(p);
      const iHash = indexMap.get(p);
      
      if (hHash === iHash) continue;

      let headContent = '';
      if (hHash) {
        const blobObj = repo.store.read(hHash);
        if (blobObj.type === 'blob') headContent = blobObj.content.toString('utf8');
      }

      let indexContent = '';
      if (iHash) {
        const blobObj = repo.store.read(iHash);
        if (blobObj.type === 'blob') indexContent = blobObj.content.toString('utf8');
      }

      const diff = unifiedDiffStrings(`a/${p}`, `b/${p}`, headContent, indexContent);
      if (diff) parts.push(diff);
    }
    
    return parts.length > 0 ? parts.join('\n\n') : 'No differences (index matches HEAD)';

  } else {
    if (index.length === 0) return 'Nothing staged. Use: mgit add <file>';
    
    for (const entry of index) {
      const absPath = path.join(repo.root, entry.path);
      const workingContent = fs.existsSync(absPath)
        ? fs.readFileSync(absPath, 'utf8')
        : '';

      let indexContent = '';
      const blobObj = repo.store.read(entry.hash);
      if (blobObj.type === 'blob') {
        indexContent = blobObj.content.toString('utf8');
      }

      const diff = unifiedDiffStrings(
        `a/${entry.path}`,
        `b/${entry.path}`,
        indexContent,
        workingContent,
      );

      if (diff) parts.push(diff);
    }

    return parts.length > 0 ? parts.join('\n\n') : 'No differences (working tree matches index)';
  }
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
    .map(e => `${e.mode} ${e.mode === '040000' ? 'tree' : 'blob'} ${e.hash}\t${e.name}`)
    .join('\n');
}

// ─── status ──────────────────────────────────────────────────────────────────

export function cmdStatus(repo: Repository): string {
  repo.assertInitialised();

  const head = repo.readHead();
  const commitHash = repo.resolveHead();
  let headFiles = new Map<string, Hash>();
  if (commitHash) {
    const commitObj = repo.store.read(commitHash);
    if (commitObj.type === 'commit') {
      headFiles = flattenTree(repo, commitObj.treeHash);
    }
  }

  const index = repo.readIndex();
  const indexMap = new Map(index.map(e => [e.path, e.hash]));

  const workingFiles = listFilesRecursive(repo.root);
  const workingMap = new Map<string, Hash>();
  for (const f of workingFiles) {
    const absPath = path.join(repo.root, f);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath);
    workingMap.set(f, sha1(serialise({ type: 'blob', content })));
  }

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  // Changes to be committed (Index vs HEAD)
  for (const [p, hash] of indexMap.entries()) {
    if (headFiles.get(p) !== hash) staged.push(p);
  }
  for (const [p] of headFiles.entries()) {
    if (!indexMap.has(p)) staged.push(p + ' (deleted)');
  }

  // Changes not staged for commit (Working vs Index)
  for (const [p, hash] of workingMap.entries()) {
    if (indexMap.has(p)) {
      if (indexMap.get(p) !== hash) unstaged.push(p);
    } else {
      untracked.push(p);
    }
  }
  for (const [p] of indexMap.entries()) {
    if (!workingMap.has(p)) unstaged.push(p + ' (deleted)');
  }

  staged.sort();
  unstaged.sort();
  untracked.sort();

  const lines: string[] = [];
  lines.push(head.type === 'branch' ? `On branch ${head.name}` : `HEAD detached at ${head.hash.slice(0, 7)}`);
  
  if (staged.length > 0) {
    lines.push('\nChanges to be committed:');
    staged.forEach(p => lines.push(`  modified/added:   ${p}`));
  }
  if (unstaged.length > 0) {
    lines.push('\nChanges not staged for commit:');
    unstaged.forEach(p => lines.push(`  modified/deleted: ${p}`));
  }
  if (untracked.length > 0) {
    lines.push('\nUntracked files:');
    untracked.forEach(p => lines.push(`  ${p}`));
  }
  
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    lines.push('nothing to commit, working tree clean');
  }

  return lines.join('\n');
}

// ─── Nested Tree Helpers ──────────────────────────────────────────────────────

export function buildTree(repo: Repository, index: IndexEntry[]): Hash {
  const rootTree: TreeEntry[] = [];
  const groups = new Map<string, IndexEntry[]>();

  for (const entry of index) {
    const parts = entry.path.split('/');
    if (parts.length === 1) {
      rootTree.push({ mode: '100644', name: parts[0], hash: entry.hash });
    } else {
      const dir = parts[0];
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push({
        path: parts.slice(1).join('/'),
        hash: entry.hash
      });
    }
  }

  for (const [dir, subEntries] of groups.entries()) {
    const subTreeHash = buildTree(repo, subEntries);
    rootTree.push({ mode: '040000', name: dir, hash: subTreeHash });
  }

  const tree: TreeObject = { type: 'tree', entries: rootTree };
  return repo.store.write(tree);
}

export function flattenTree(repo: Repository, treeHash: Hash, prefix: string = ''): Map<string, Hash> {
  const map = new Map<string, Hash>();
  const obj = repo.store.read(treeHash);
  if (obj.type !== 'tree') return map;

  for (const entry of obj.entries) {
    const fullPath = prefix + entry.name;
    if (entry.mode === '040000') {
      const subMap = flattenTree(repo, entry.hash, fullPath + '/');
      for (const [p, h] of subMap.entries()) map.set(p, h);
    } else {
      map.set(fullPath, entry.hash);
    }
  }
  return map;
}
