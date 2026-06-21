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

  it('read throws if the object hash does not match the content (corruption)', () => {
    const blob: BlobObject = { type: 'blob', content: Buffer.from('good content') };
    const hash = store.write(blob);
    
    // Corrupt the file on disk manually
    const { dir: objDir, file } = require('../src/hash').objectPath(hash);
    const filePath = path.join(dir, 'objects', objDir, file);
    fs.writeFileSync(filePath, Buffer.from('corrupt content'));

    expect(() => store.read(hash)).toThrow(/Corrupt object detected/);
  });
});

describe('deserialise malformed objects rejection', () => {
  it('rejects unknown object types', () => {
    expect(() => deserialise(Buffer.from('unknown\nbody'))).toThrow(/Unknown object format/);
    expect(() => deserialise(Buffer.from('noune'))).toThrow(/Unknown object format/);
  });

  it('rejects malformed blob', () => {
    expect(() => deserialise(Buffer.from('blob \ncontent'))).toThrow(/Invalid blob length header/);
    expect(() => deserialise(Buffer.from('blob abc\ncontent'))).toThrow(/Invalid blob length header/);
    expect(() => deserialise(Buffer.from('blob 100\ncontent'))).toThrow(/Blob length mismatch/);
  });

  it('rejects malformed tree headers', () => {
    expect(() => deserialise(Buffer.from('tree \n'))).toThrow(/Invalid tree entry count/);
    expect(() => deserialise(Buffer.from('tree abc\n'))).toThrow(/Invalid tree entry count/);
  });

  it('rejects malformed tree bodies', () => {
    expect(() => deserialise(Buffer.from('tree 1\nno-null-byte'))).toThrow(/Tree body must end with null byte/);
    expect(() => deserialise(Buffer.from('tree 1\nbad-entry\0'))).toThrow(/Malformed tree entry/);
    expect(() => deserialise(Buffer.from(`tree 1\n999999 ${'a'.repeat(40)} name\0`))).toThrow(/Invalid tree entry mode/);
    expect(() => deserialise(Buffer.from(`tree 1\n100644 bad-hash name\0`))).toThrow(/Invalid tree entry hash/);
    expect(() => deserialise(Buffer.from(`tree 1\n100644 ${'a'.repeat(40)} \0`))).toThrow(/Tree entry name cannot be empty/);
    expect(() => deserialise(Buffer.from(`tree 1\n100644 ${'a'.repeat(40)} name\x00100644 ${'b'.repeat(40)} name2\x00`))).toThrow(/Tree entry count mismatch/);
  });

  it('rejects malformed commits', () => {
    expect(() => deserialise(Buffer.from('commit\n'))).toThrow(/Commit missing field/);
    expect(() => deserialise(Buffer.from('commit\ntree bad\n'))).toThrow(/Invalid commit tree hash/);
    expect(() => deserialise(Buffer.from(`commit\ntree ${'a'.repeat(40)}\nparent bad\n`))).toThrow(/Invalid commit parent hash/);
    expect(() => deserialise(Buffer.from(`commit\ntree ${'a'.repeat(40)}\nparent null\nauthor \n`))).toThrow(/Commit author cannot be empty/);
    expect(() => deserialise(Buffer.from(`commit\ntree ${'a'.repeat(40)}\nparent null\nauthor Alice\ntimestamp bad\n`))).toThrow(/Invalid commit timestamp/);
    expect(() => deserialise(Buffer.from(`commit\ntree ${'a'.repeat(40)}\nparent null\nauthor Alice\ntimestamp 1234\nno-blank-line`))).toThrow(/Commit missing blank line/);
  });
});
