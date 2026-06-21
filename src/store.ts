// src/store.ts
// Content-addressable object store.
//
// Objects are stored in `.mgit/objects/<2-char-prefix>/<38-char-rest>`.
// Each file contains the serialised form of a BlobObject, TreeObject, or
// CommitObject.  Serialisation is a simple text format (not zlib compressed,
// unlike real Git) so that the files are human-readable for learning purposes.
//
// Serialisation format
// ─────────────────────
//   blob <content-length>\n<content>
//   tree <entry-count>\n<mode> <name> <hash>\n...
//   commit\ntree <treeHash>\nparent <parentHash|null>\nauthor <author>\ntimestamp <ms>\n\n<message>

import * as fs from 'fs';
import * as path from 'path';
import { sha1, objectPath } from './hash';
import type { Hash, MgitObject, BlobObject, TreeObject, CommitObject, TreeEntry } from './types';

// ─── Serialisation ────────────────────────────────────────────────────────────

export function serialiseBlob(obj: BlobObject): Buffer {
  const header = Buffer.from(`blob ${obj.content.length}\n`, 'utf8');
  return Buffer.concat([header, obj.content]);
}

export function serialiseTree(obj: TreeObject): Buffer {
  const entries = obj.entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => `${e.mode} ${e.hash} ${e.name}\0`)
    .join('');
  return Buffer.from(`tree ${obj.entries.length}\n${entries}`, 'utf8');
}

export function serialiseCommit(obj: CommitObject): Buffer {
  const text = [
    'commit',
    `tree ${obj.treeHash}`,
    `parent ${obj.parentHash ?? 'null'}`,
    `author ${obj.author}`,
    `timestamp ${obj.timestamp}`,
    '',
    obj.message,
  ].join('\n');
  return Buffer.from(text, 'utf8');
}

export function serialise(obj: MgitObject): Buffer {
  switch (obj.type) {
    case 'blob':   return serialiseBlob(obj);
    case 'tree':   return serialiseTree(obj);
    case 'commit': return serialiseCommit(obj);
  }
}

// ─── Deserialisation ──────────────────────────────────────────────────────────

export function deserialise(raw: Buffer): MgitObject {
  const newline = raw.indexOf('\n');
  if (newline === -1) throw new Error(`Unknown object format`);
  const header = raw.slice(0, newline).toString('utf8');

  if (header.startsWith('blob ')) {
    const content = raw.slice(newline + 1);
    return { type: 'blob', content };
  }

  if (header.startsWith('tree ')) {
    const body = raw.slice(newline + 1).toString('utf8');
    const entries: TreeEntry[] = [];
    if (body.length > 0) {
      const parts = body.split('\0');
      for (const part of parts) {
        if (!part) continue; // skip empty string after last \0
        const space1 = part.indexOf(' ');
        const space2 = part.indexOf(' ', space1 + 1);
        if (space1 === -1 || space2 === -1) throw new Error(`Malformed tree entry: ${part}`);
        const mode = part.slice(0, space1) as TreeEntry['mode'];
        const hash = part.slice(space1 + 1, space2);
        const name = part.slice(space2 + 1);
        entries.push({ mode, hash, name });
      }
    }
    return { type: 'tree', entries };
  }

  if (header === 'commit') {
    const text = raw.toString('utf8');
    const lines = text.split('\n');
    const get = (prefix: string): string => {
      const line = lines.find(l => l.startsWith(prefix));
      if (!line) throw new Error(`Commit missing field: ${prefix}`);
      return line.slice(prefix.length);
    };
    const treeHash     = get('tree ');
    const parentRaw    = get('parent ');
    const parentHash   = parentRaw === 'null' ? null : parentRaw;
    const author       = get('author ');
    const timestamp    = parseInt(get('timestamp '), 10);
    // message is everything after the blank line
    const blankIdx = lines.indexOf('');
    const message = lines.slice(blankIdx + 1).join('\n');
    return { type: 'commit', treeHash, parentHash, author, timestamp, message };
  }

  throw new Error(`Unknown object format: ${header.slice(0, 20)}`);
}

// ─── Object Store I/O ─────────────────────────────────────────────────────────

export class ObjectStore {
  private readonly objectsDir: string;

  constructor(mgitDir: string) {
    this.objectsDir = path.join(mgitDir, 'objects');
  }

  /** Write an object to disk and return its SHA-1 hash. Idempotent. */
  write(obj: MgitObject): Hash {
    const raw  = serialise(obj);
    const hash = sha1(raw);
    const { dir, file } = objectPath(hash);
    const dirPath  = path.join(this.objectsDir, dir);
    const filePath = path.join(dirPath, file);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    // Idempotent — don't overwrite if already present (same content ⟹ same hash)
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, raw);
    }
    return hash;
  }

  /** Read and deserialise an object by its hash. */
  read(hash: Hash): MgitObject {
    const { dir, file } = objectPath(hash);
    const filePath = path.join(this.objectsDir, dir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Object not found: ${hash}`);
    }
    const raw = fs.readFileSync(filePath);
    return deserialise(raw);
  }

  /** Check if an object exists without reading it. */
  exists(hash: Hash): boolean {
    const { dir, file } = objectPath(hash);
    return fs.existsSync(path.join(this.objectsDir, dir, file));
  }

  /** Return the raw serialised content for a given hash (for verification). */
  readRaw(hash: Hash): Buffer {
    const { dir, file } = objectPath(hash);
    const filePath = path.join(this.objectsDir, dir, file);
    return fs.readFileSync(filePath);
  }
}
