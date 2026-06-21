

import * as crypto from 'crypto';
import type { Hash } from './types';


export function sha1(data: string | Buffer): Hash {
  const hasher = crypto.createHash('sha1');
  if (typeof data === 'string') {
    hasher.update(data, 'utf8');
  } else {
    hasher.update(data);
  }
  return hasher.digest('hex');
}


export function objectPath(hash: Hash): { dir: string; file: string } {
  return {
    dir: hash.slice(0, 2),
    file: hash.slice(2),
  };
}

export function isValidHash(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}


export function shortHash(hash: Hash): string {
  return hash.slice(0, 7);
}
