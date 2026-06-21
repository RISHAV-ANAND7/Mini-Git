// src/hash.ts
// SHA-1 hashing utilities for content-addressable object storage.
// Uses Node's built-in crypto — zero external dependencies.

import * as crypto from 'crypto';
import type { Hash } from './types';

/**
 * Compute the SHA-1 digest of a string and return its 40-char hex form.
 * This is the key primitive that makes the object store content-addressable:
 * identical content always produces the same hash.
 *
 * @example
 *   sha1('hello') // => 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d'
 */
export function sha1(data: string | Buffer): Hash {
  const hasher = crypto.createHash('sha1');
  if (typeof data === 'string') {
    hasher.update(data, 'utf8');
  } else {
    hasher.update(data);
  }
  return hasher.digest('hex');
}

/**
 * Derive the two-character prefix directory and remainder filename
 * for the loose-object layout: `.mgit/objects/<2-char>/<38-char>`.
 * Mirrors exactly how Git stores loose objects.
 */
export function objectPath(hash: Hash): { dir: string; file: string } {
  return {
    dir: hash.slice(0, 2),
    file: hash.slice(2),
  };
}

/**
 * Verify that a given string looks like a valid full SHA-1 hex digest.
 */
export function isValidHash(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/**
 * Create a short (7-char) hash prefix suitable for display — mirrors `git log --oneline`.
 */
export function shortHash(hash: Hash): string {
  return hash.slice(0, 7);
}
