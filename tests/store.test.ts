// tests/store.test.ts
import * as os   from 'os';
import * as path from 'path';
import * as fs   from 'fs';
import { ObjectStore, serialise, deserialise } from '../src/store';
import { sha1 } from '../src/hash';
import type { BlobObject, TreeObject, CommitObject } from '../src/types';

// ─── Serialisation round-trips ───────────────────────────────────────────────

describe('serialise / deserialise round-trips', () => {
  const blob: BlobObject = { type: 'blob', content: Buffer.from('hello world\n') };
  const tree: TreeObject = {
    type: 'tree',
    entries: [
      { mode: '100644', name: 'README.md', hash: 'a'.repeat(40) },
      { mode: '100644', name: 'src/index.ts', hash: 'b'.repeat(40) },
    ],
  };
  const commit: CommitObject = {
    type: 'commit',
    treeHash:   'c'.repeat(40),
    parentHash: 'd'.repeat(40),
    message: 'Initial commit',
    author: 'Alice <alice@example.com>',
    timestamp: 1718000000000,
  };
  const rootCommit: CommitObject = {
    ...commit,
    parentHash: null,
  };

  it('blob survives serialise → deserialise', () => {
    const result = deserialise(serialise(blob));
    expect(result).toEqual(blob);
  });

  it('tree survives serialise → deserialise (entries sorted by name)', () => {
    const result = deserialise(serialise(tree));
    expect(result.type).toBe('tree');
    if (result.type === 'tree') {
      // Entries are sorted alphabetically during serialisation
      expect(result.entries.map(e => e.name)).toEqual(['README.md', 'src/index.ts']);
    }
  });

  it('commit survives serialise → deserialise', () => {
    const result = deserialise(serialise(commit));
    expect(result).toEqual(commit);
  });

  it('root commit (null parent) survives serialise → deserialise', () => {
    const result = deserialise(serialise(rootCommit));
    expect(result).toEqual(rootCommit);
    if (result.type === 'commit') {
      expect(result.parentHash).toBeNull();
    }
  });

  it('blob with multiline content round-trips', () => {
    const multiline: BlobObject = {
      type: 'blob',
      content: Buffer.from('line1\nline2\nline3\n'),
    };
    expect(deserialise(serialise(multiline))).toEqual(multiline);
  });
});

// ─── Content-addressability ──────────────────────────────────────────────────

describe('content-addressability', () => {
  it('SHA-1 of serialised blob is stable across writes', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('hello') };
    const raw1 = serialise(blob);
    const raw2 = serialise(blob);
    expect(sha1(raw1)).toBe(sha1(raw2));
  });

  it('different content produces different hashes', () => {
    const b1: BlobObject = { type: 'blob', content: Buffer.from('foo') };
    const b2: BlobObject = { type: 'blob', content: Buffer.from('bar') };
    expect(sha1(serialise(b1))).not.toBe(sha1(serialise(b2)));
  });
});

// ─── ObjectStore on disk ─────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-store-test-'));
}

describe('ObjectStore', () => {
  let dir: string;
  let store: ObjectStore;

  beforeEach(() => {
    dir   = tempDir();
    const objectsDir = path.join(dir, 'objects');
    fs.mkdirSync(objectsDir, { recursive: true });
    store = new ObjectStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('write returns the SHA-1 of the serialised content', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('hello') };
    const hash = store.write(blob);
    expect(hash).toBe(sha1(serialise(blob)));
    expect(hash).toHaveLength(40);
  });

  it('write is idempotent — writing same object twice is fine', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('hello') };
    const h1 = store.write(blob);
    const h2 = store.write(blob); // second write — should not throw
    expect(h1).toBe(h2);
  });

  it('read returns the original object', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('stored content') };
    const hash = store.write(blob);
    const read = store.read(hash);
    expect(read).toEqual(blob);
  });

  it('exists returns true for written objects, false otherwise', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('exists test') };
    expect(store.exists('a'.repeat(40))).toBe(false);
    const hash = store.write(blob);
    expect(store.exists(hash)).toBe(true);
  });

  it('read throws for missing objects', () => {
    expect(() => store.read('a'.repeat(40))).toThrow('Object not found');
  });

  it('stores the file at the correct path: objects/<2>/<38>', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('path test') };
    const hash = store.write(blob);
    const expectedPath = path.join(dir, 'objects', hash.slice(0, 2), hash.slice(2));
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('readRaw returns the serialised string that hashes to the object hash', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('raw test') };
    const hash = store.write(blob);
    const raw  = store.readRaw(hash);
    expect(sha1(raw)).toBe(hash); // content-addressability verified
  });
});
