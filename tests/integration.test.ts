
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  cmdInit, cmdAdd, cmdAddAll, cmdCommit, cmdLog,
  cmdCheckout, cmdBranch, cmdSwitch, cmdDiff,
} from '../src/commands';
import { Repository } from '../src/repository';
import { sha1 } from '../src/hash';
import { serialise } from '../src/store';
import type { BlobObject } from '../src/types';

function tempRepo(): { root: string; repo: Repository } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-e2e-'));
  cmdInit(root);
  return { root, repo: new Repository(root) };
}

function write(root: string, name: string, content: string): void {
  const abs = path.join(root, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function read(root: string, name: string): string {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

describe('Full multi-branch workflow', () => {
  let root: string;
  let repo: Repository;
  const AUTHOR = 'Dev <dev@example.com>';

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('full workflow: init → add → commit → branch → switch → commit → checkout', () => {
    write(root, 'README.md', '# Project\n');
    write(root, 'src/index.ts', 'export const version = "1.0.0";\n');

    cmdAdd(repo, 'README.md');
    cmdAdd(repo, 'src/index.ts');
    const { hash: c1 } = cmdCommit(repo, 'initial commit', AUTHOR);

    expect(repo.resolveBranch('main')).toBe(c1);
    const log1 = cmdLog(repo);
    expect(log1).toHaveLength(1);
    expect(log1[0]?.message).toBe('initial commit');

    // ── Phase 2: second commit on main ───────────────────────────────────────
    write(root, 'src/index.ts', 'export const version = "1.1.0";\n');
    cmdAdd(repo, 'src/index.ts');
    const { hash: c2 } = cmdCommit(repo, 'bump version to 1.1.0', AUTHOR);

    expect(repo.resolveBranch('main')).toBe(c2);
    const log2 = cmdLog(repo);
    expect(log2).toHaveLength(2);
    expect(log2[0]?.message).toBe('bump version to 1.1.0');
    expect(log2[1]?.message).toBe('initial commit');

    // Parent chain is correct
    const c2obj = repo.store.read(c2);
    if (c2obj.type !== 'commit') throw new Error('not commit');
    expect(c2obj.parentHash).toBe(c1);

    // ── Phase 3: create and switch to feature branch ──────────────────────────
    cmdBranch(repo, 'feature/auth');
    cmdSwitch(repo, 'feature/auth');
    expect(repo.currentBranch()).toBe('feature/auth');

    write(root, 'src/auth.ts', 'export function login() {}\n');
    cmdAdd(repo, 'src/auth.ts');
    const { hash: c3 } = cmdCommit(repo, 'add auth module', AUTHOR);

    // feature advanced, main stayed
    expect(repo.resolveBranch('feature/auth')).toBe(c3);
    expect(repo.resolveBranch('main')).toBe(c2);

    // Feature log has 3 entries
    const log3 = cmdLog(repo);
    expect(log3).toHaveLength(3);
    expect(log3[0]?.message).toBe('add auth module');

    // ── Phase 4: switch back to main, verify isolation ────────────────────────
    cmdSwitch(repo, 'main');
    expect(repo.currentBranch()).toBe('main');
    // auth.ts should not be present on main (restored to c2 state)
    expect(fs.existsSync(path.join(root, 'src', 'auth.ts'))).toBe(false);
    expect(read(root, 'src/index.ts')).toBe('export const version = "1.1.0";\n');

    // ── Phase 5: checkout old commit by hash (detached HEAD) ─────────────────
    cmdCheckout(repo, c1);
    expect(repo.readHead().type).toBe('detached');
    expect(read(root, 'src/index.ts')).toBe('export const version = "1.0.0";\n');

    // ── Phase 6: return to main ───────────────────────────────────────────────
    cmdCheckout(repo, 'main');
    expect(repo.currentBranch()).toBe('main');
    expect(read(root, 'src/index.ts')).toBe('export const version = "1.1.0";\n');
  });
});

describe('Content-addressability invariants', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('identical files in different commits share the same blob object', () => {
    write(root, 'shared.txt', 'shared content');
    cmdAdd(repo, 'shared.txt');
    const { hash: c1 } = cmdCommit(repo, 'first', 'A <a@a.com>');

    // Modify then restore
    write(root, 'shared.txt', 'different');
    cmdAdd(repo, 'shared.txt');
    cmdCommit(repo, 'second', 'A <a@a.com>');

    write(root, 'shared.txt', 'shared content'); // restore original
    cmdAdd(repo, 'shared.txt');
    const { hash: c3 } = cmdCommit(repo, 'third', 'A <a@a.com>');

    // Extract blob hash from first and third commits' trees
    const getBlob = (commitHash: string): string => {
      const commit = repo.store.read(commitHash);
      if (commit.type !== 'commit') throw new Error('not commit');
      const tree = repo.store.read(commit.treeHash);
      if (tree.type !== 'tree') throw new Error('not tree');
      return tree.entries.find(e => e.name === 'shared.txt')!.hash;
    };

    expect(getBlob(c1)).toBe(getBlob(c3)); // same blob, deduped by content
  });

  it('sha1(serialise(blob)) matches the stored object hash', () => {
    write(root, 'verify.txt', 'verify me');
    cmdAdd(repo, 'verify.txt');

    const index = repo.readIndex();
    const storedHash = index.find(e => e.path === 'verify.txt')!.hash;

    // Independently compute what the hash should be
    const expectedBlob: BlobObject = { type: 'blob', content: Buffer.from('verify me') };
    const expectedHash = sha1(serialise(expectedBlob));

    expect(storedHash).toBe(expectedHash);
    // And verify the raw file on disk hashes back to the stored hash
    const raw = repo.store.readRaw(storedHash);
    expect(sha1(raw)).toBe(storedHash);
  });

  it('recursive tree round trip correctly builds and flattens nested structures', () => {
    write(root, 'initial.txt', 'init');
    cmdAddAll(repo);
    const { hash: initialCommit } = cmdCommit(repo, 'initial', 'A <a@a.com>');

    write(root, 'a.txt', 'a');
    write(root, 'docs/b.txt', 'b');
    write(root, 'docs/nested/c.txt', 'c');
    cmdAddAll(repo);
    const { hash: nestedCommit } = cmdCommit(repo, 'nested', 'A <a@a.com>');

    // Switch to initial commit to remove the nested files
    cmdCheckout(repo, initialCommit);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);

    // Checkout the nested commit to restore them via recursive tree parsing
    cmdCheckout(repo, nestedCommit);

    expect(read(root, 'a.txt')).toBe('a');
    expect(read(root, 'docs/b.txt')).toBe('b');
    expect(read(root, 'docs/nested/c.txt')).toBe('c');
  });
});

describe('mgit add .', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages all files in the working tree', () => {
    write(root, 'a.txt', 'aaa');
    write(root, 'b.txt', 'bbb');
    write(root, 'src/c.ts', 'ccc');

    cmdAddAll(repo);
    const index = repo.readIndex();
    const paths = index.map(e => e.path).sort();
    expect(paths).toEqual(['a.txt', 'b.txt', 'src/c.ts']);
  });

  it('does not stage .mgit internals', () => {
    write(root, 'app.ts', 'hello');
    cmdAddAll(repo);
    const index = repo.readIndex();
    expect(index.every(e => !e.path.startsWith('.mgit'))).toBe(true);
  });
});
