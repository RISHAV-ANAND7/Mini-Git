import * as fs from 'fs';
import * as path from 'path';
import { sha1, objectPath } from './hash';
import type { Hash, MgitObject, BlobObject, TreeObject, CommitObject, TreeEntry } from './types';


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
    case 'blob': return serialiseBlob(obj);
    case 'tree': return serialiseTree(obj);
    case 'commit': return serialiseCommit(obj);
  }
}

// ─── Deserialisation ──────────────────────────────────────────────────────────

export function deserialise(raw: Buffer): MgitObject {
  const newline = raw.indexOf('\n');
  if (newline === -1) throw new Error(`Unknown object format`);
  const header = raw.slice(0, newline).toString('utf8');

  if (header.startsWith('blob ')) {
    const expectedLen = parseInt(header.slice(5), 10);
    if (isNaN(expectedLen)) throw new Error(`Invalid blob length header`);
    const content = raw.slice(newline + 1);
    if (content.length !== expectedLen) throw new Error(`Blob length mismatch: expected ${expectedLen}, got ${content.length}`);
    return { type: 'blob', content };
  }

  if (header.startsWith('tree ')) {
    const expectedEntries = parseInt(header.slice(5), 10);
    if (isNaN(expectedEntries)) throw new Error(`Invalid tree entry count`);

    const body = raw.slice(newline + 1).toString('utf8');
    const entries: TreeEntry[] = [];
    if (body.length > 0) {
      const parts = body.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          if (part !== '') throw new Error('Tree body must end with null byte');
          continue;
        }
        const space1 = part.indexOf(' ');
        const space2 = part.indexOf(' ', space1 + 1);
        if (space1 === -1 || space2 === -1) throw new Error(`Malformed tree entry: ${part}`);
        const mode = part.slice(0, space1);
        if (!['100644', '100755', '120000', '040000'].includes(mode)) {
          throw new Error(`Invalid tree entry mode: ${mode}`);
        }
        const hash = part.slice(space1 + 1, space2);
        if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(`Invalid tree entry hash: ${hash}`);
        const name = part.slice(space2 + 1);
        if (!name) throw new Error(`Tree entry name cannot be empty`);
        entries.push({ mode: mode as TreeEntry['mode'], hash, name });
      }
    }
    if (entries.length !== expectedEntries) {
      throw new Error(`Tree entry count mismatch: expected ${expectedEntries}, got ${entries.length}`);
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
    const treeHash = get('tree ');
    if (!/^[0-9a-f]{40}$/.test(treeHash)) throw new Error(`Invalid commit tree hash: ${treeHash}`);

    const parentRaw = get('parent ');
    const parentHash = parentRaw === 'null' ? null : parentRaw;
    if (parentHash && !/^[0-9a-f]{40}$/.test(parentHash)) throw new Error(`Invalid commit parent hash: ${parentHash}`);

    const author = get('author ');
    if (!author) throw new Error(`Commit author cannot be empty`);

    const timestampStr = get('timestamp ');
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) throw new Error(`Invalid commit timestamp: ${timestampStr}`);

    const blankIdx = lines.indexOf('');
    if (blankIdx === -1) throw new Error('Commit missing blank line before message');

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

  write(obj: MgitObject): Hash {
    const raw = serialise(obj);
    const hash = sha1(raw);
    const { dir, file } = objectPath(hash);
    const dirPath = path.join(this.objectsDir, dir);
    const filePath = path.join(dirPath, file);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
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
    if (sha1(raw) !== hash) {
      throw new Error(`Corrupt object detected: ${hash}`);
    }
    return deserialise(raw);
  }

  /** Check if an object exists without reading it. */
  exists(hash: Hash): boolean {
    const { dir, file } = objectPath(hash);
    return fs.existsSync(path.join(this.objectsDir, dir, file));
  }
  readRaw(hash: Hash): Buffer {
    const { dir, file } = objectPath(hash);
    const filePath = path.join(this.objectsDir, dir, file);
    return fs.readFileSync(filePath);
  }
}
