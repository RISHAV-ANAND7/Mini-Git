// src/utils.ts
// Shared utility helpers used across multiple modules.

import * as fs   from 'fs';
import * as path from 'path';

/**
 * Recursively list all regular files under a directory,
 * returning paths relative to `root`. Excludes .mgit/.
 */
export function listFilesRecursive(root: string, dir: string = root): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    const rel     = path.relative(root, absPath).replace(/\\/g, '/');
    if (rel.startsWith('.mgit')) continue;
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      results.push(...listFilesRecursive(root, absPath));
    } else {
      results.push(rel);
    }
  }
  return results;
}

/**
 * Format a Unix timestamp (ms) as an ISO-8601 string in local time,
 * trimming milliseconds — matches how git log displays dates.
 */
export function formatDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Pad a string on the left with spaces to a given width.
 */
export function padStart(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

export function ensureInsideRepo(repoRoot: string, targetPath: string): string {
  const absPath = path.resolve(repoRoot, targetPath);
  
  let resolvedPath = absPath;
  if (fs.existsSync(absPath)) {
    resolvedPath = fs.realpathSync(absPath);
  } else {
    let dir = path.dirname(absPath);
    while (dir !== repoRoot && !fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (fs.existsSync(dir)) {
      const realDir = fs.realpathSync(dir);
      resolvedPath = path.join(realDir, path.relative(dir, absPath));
    }
  }

  const relPath = path.relative(repoRoot, resolvedPath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    throw new Error(`Path traversal detected: '${targetPath}' resolves outside the repository`);
  }
  return absPath;
}

/**
 * Recursively list all files in a directory, returning relative paths.
 */
export function listFiles(dir: string, base: string = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const absPath = path.join(dir, entry);
    if (fs.statSync(absPath).isDirectory()) {
      results.push(...listFiles(absPath, base));
    } else {
      results.push(path.relative(base, absPath).replace(/\\/g, '/'));
    }
  }
  return results;
}
