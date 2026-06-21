// tests/commands.test.ts
// Integration tests for the full init → add → commit → log → checkout cycle.
// All tests run in isolated temp directories.

import * as os   from 'os';
import * as path from 'path';
import * as fs   from 'fs';
import {
  cmdInit,
  cmdAdd,
  cmdCommit,
  cmdLog,
  cmdCheckout,
  cmdDiff,
  cmdBranch,
  cmdSwitch,
} from '../src/commands';
import { Repository } from '../src/repository';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function tempRepo(): { root: string; repo: Repository } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-cmd-test-'));
  cmdInit(root);
  const repo = new Repository(root);
  return { root, repo };
}

function writeFile(root: string, name: string, content: string): void {
  const abs = path.join(root, name);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function readFile(root: string, name: string): string {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

// ─── init ────────────────────────────────────────────────────────────────────

describe('cmdInit', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-init-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates .mgit directory', () => {
    cmdInit(root);
    expect(fs.existsSync(path.join(root, '.mgit'))).toBe(true);
  });

  it('creates .mgit/objects directory', () => {
    cmdInit(root);
    expect(fs.existsSync(path.join(root, '.mgit', 'objects'))).toBe(true);
  });

  it('creates .mgit/refs/heads directory', () => {
    cmdInit(root);
    expect(fs.existsSync(path.join(root, '.mgit', 'refs', 'heads'))).toBe(true);
  });

  it('creates HEAD pointing to main', () => {
    cmdInit(root);
    const head = fs.readFileSync(path.join(root, '.mgit', 'HEAD'), 'utf8').trim();
    expect(head).toBe('ref: refs/heads/main');
  });

  it('creates empty index', () => {
    cmdInit(root);
    const index = JSON.parse(
      fs.readFileSync(path.join(root, '.mgit', 'index'), 'utf8')
    );
    expect(index).toEqual([]);
  });

  it('throws if already initialised', () => {
    cmdInit(root);
    expect(() => cmdInit(root)).toThrow('Already a mini-git repository');
  });
});

// ─── add ─────────────────────────────────────────────────────────────────────

describe('cmdAdd', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages a file and returns a message with short hash', () => {
    writeFile(root, 'hello.txt', 'hello world');
    const msg = cmdAdd(repo, 'hello.txt');
    expect(msg).toMatch(/add: hello\.txt → [0-9a-f]{7}/);
  });

  it('writes a blob object to the object store', () => {
    writeFile(root, 'foo.txt', 'foo content');
    cmdAdd(repo, 'foo.txt');
    const index = repo.readIndex();
    expect(index).toHaveLength(1);
    expect(repo.store.exists(index[0]!.hash)).toBe(true);
  });

  it('adds the file to the index with a relative path', () => {
    writeFile(root, 'bar.txt', 'bar content');
    cmdAdd(repo, 'bar.txt');
    const index = repo.readIndex();
    expect(index[0]?.path).toBe('bar.txt');
  });

  it('updates an existing index entry (re-add)', () => {
    writeFile(root, 'update.txt', 'v1');
    cmdAdd(repo, 'update.txt');
    writeFile(root, 'update.txt', 'v2');
    cmdAdd(repo, 'update.txt');
    const index = repo.readIndex();
    expect(index).toHaveLength(1); // still one entry
    const blob = repo.store.read(index[0]!.hash);
    expect(blob.type).toBe('blob');
    if (blob.type === 'blob') expect(blob.content.toString('utf8')).toBe('v2');
  });

  it('throws for a non-existent file', () => {
    expect(() => cmdAdd(repo, 'no-such-file.txt')).toThrow("pathspec 'no-such-file.txt' did not match any files");
  });

  it('hashes are content-addressable — same content same hash', () => {
    writeFile(root, 'a.txt', 'identical');
    writeFile(root, 'b.txt', 'identical');
    cmdAdd(repo, 'a.txt');
    cmdAdd(repo, 'b.txt');
    const index = repo.readIndex();
    expect(index[0]!.hash).toBe(index[1]!.hash); // same blob
  });
});

// ─── commit ──────────────────────────────────────────────────────────────────

describe('cmdCommit', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
    writeFile(root, 'file.txt', 'hello');
    cmdAdd(repo, 'file.txt');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns a commit hash', () => {
    const { hash } = cmdCommit(repo, 'first commit', 'Test <t@t.com>');
    expect(hash).toHaveLength(40);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('advances the branch pointer', () => {
    const { hash } = cmdCommit(repo, 'first commit', 'Test <t@t.com>');
    expect(repo.resolveBranch('main')).toBe(hash);
  });

  it('stores a commit object in the object store', () => {
    const { hash } = cmdCommit(repo, 'first commit', 'Test <t@t.com>');
    const obj = repo.store.read(hash);
    expect(obj.type).toBe('commit');
  });

  it('commit object references a tree', () => {
    const { hash } = cmdCommit(repo, 'first commit', 'Test <t@t.com>');
    const commit = repo.store.read(hash);
    if (commit.type !== 'commit') throw new Error('not a commit');
    const tree = repo.store.read(commit.treeHash);
    expect(tree.type).toBe('tree');
  });

  it('tree contains the staged file', () => {
    const { hash } = cmdCommit(repo, 'first commit', 'Test <t@t.com>');
    const commit = repo.store.read(hash);
    if (commit.type !== 'commit') throw new Error('not a commit');
    const tree = repo.store.read(commit.treeHash);
    if (tree.type !== 'tree') throw new Error('not a tree');
    expect(tree.entries.some(e => e.name === 'file.txt')).toBe(true);
  });

  it('root commit has null parent', () => {
    const { hash } = cmdCommit(repo, 'first commit', 'Test <t@t.com>');
    const commit = repo.store.read(hash);
    if (commit.type !== 'commit') throw new Error('not a commit');
    expect(commit.parentHash).toBeNull();
  });

  it('second commit has first commit as parent', () => {
    const { hash: h1 } = cmdCommit(repo, 'first', 'Test <t@t.com>');
    writeFile(root, 'file2.txt', 'second file');
    cmdAdd(repo, 'file2.txt');
    const { hash: h2 } = cmdCommit(repo, 'second', 'Test <t@t.com>');
    const commit2 = repo.store.read(h2);
    if (commit2.type !== 'commit') throw new Error('not a commit');
    expect(commit2.parentHash).toBe(h1);
  });

  it('throws if index is empty', () => {
    repo.writeIndex([]);
    expect(() => cmdCommit(repo, 'empty', 'Test <t@t.com>')).toThrow('Nothing to commit');
  });

  it('output string contains short hash and message', () => {
    const { output } = cmdCommit(repo, 'my message', 'Test <t@t.com>');
    expect(output).toMatch(/\[main [0-9a-f]{7}\] my message/);
  });
});

// ─── log ─────────────────────────────────────────────────────────────────────

describe('cmdLog', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('throws on empty repo', () => {
    expect(() => cmdLog(repo)).toThrow('No commits yet');
  });

  it('returns one entry after one commit', () => {
    writeFile(root, 'a.txt', 'a');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first', 'A <a@a.com>');
    const log = cmdLog(repo);
    expect(log).toHaveLength(1);
    expect(log[0]?.message).toBe('first');
  });

  it('returns entries in reverse-chronological order', () => {
    writeFile(root, 'a.txt', 'a');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'commit 1', 'A <a@a.com>');

    writeFile(root, 'b.txt', 'b');
    cmdAdd(repo, 'b.txt');
    cmdCommit(repo, 'commit 2', 'A <a@a.com>');

    writeFile(root, 'c.txt', 'c');
    cmdAdd(repo, 'c.txt');
    cmdCommit(repo, 'commit 3', 'A <a@a.com>');

    const log = cmdLog(repo);
    expect(log).toHaveLength(3);
    expect(log[0]?.message).toBe('commit 3');
    expect(log[1]?.message).toBe('commit 2');
    expect(log[2]?.message).toBe('commit 1');
  });

  it('each entry has a valid 40-char hash', () => {
    writeFile(root, 'x.txt', 'x');
    cmdAdd(repo, 'x.txt');
    cmdCommit(repo, 'x', 'X <x@x.com>');
    const log = cmdLog(repo);
    expect(log[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(log[0]?.short).toHaveLength(7);
  });
});

// ─── checkout ────────────────────────────────────────────────────────────────

describe('cmdCheckout', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores file content from an older commit', () => {
    writeFile(root, 'app.txt', 'version 1');
    cmdAdd(repo, 'app.txt');
    const { hash: h1 } = cmdCommit(repo, 'v1', 'Dev <dev@dev.com>');

    writeFile(root, 'app.txt', 'version 2');
    cmdAdd(repo, 'app.txt');
    cmdCommit(repo, 'v2', 'Dev <dev@dev.com>');

    // Current content is v2
    expect(readFile(root, 'app.txt')).toBe('version 2');

    // Checkout to first commit
    cmdCheckout(repo, h1);
    expect(readFile(root, 'app.txt')).toBe('version 1');
  });

  it('detaches HEAD when checking out by hash', () => {
    writeFile(root, 'f.txt', 'content');
    cmdAdd(repo, 'f.txt');
    const { hash } = cmdCommit(repo, 'first', 'D <d@d.com>');
    cmdCheckout(repo, hash);
    const head = repo.readHead();
    expect(head.type).toBe('detached');
  });

  it('updates HEAD to branch when checking out a branch', () => {
    writeFile(root, 'f.txt', 'content');
    cmdAdd(repo, 'f.txt');
    cmdCommit(repo, 'first', 'D <d@d.com>');
    cmdBranch(repo, 'dev');
    cmdCheckout(repo, 'dev');
    const head = repo.readHead();
    expect(head.type).toBe('branch');
    if (head.type === 'branch') expect(head.name).toBe('dev');
  });

  it('throws for unknown ref', () => {
    writeFile(root, 'f.txt', 'content');
    cmdAdd(repo, 'f.txt');
    cmdCommit(repo, 'first', 'D <d@d.com>');
    expect(() => cmdCheckout(repo, 'nosuchref')).toThrow("Unknown ref: 'nosuchref'");
  });
});

// ─── branch & switch ─────────────────────────────────────────────────────────

describe('cmdBranch + cmdSwitch', () => {
  let root: string;
  let repo: Repository;
  let firstHash: string;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
    writeFile(root, 'base.txt', 'base content');
    cmdAdd(repo, 'base.txt');
    ({ hash: firstHash } = cmdCommit(repo, 'base commit', 'Dev <dev@dev.com>'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a branch at current HEAD', () => {
    cmdBranch(repo, 'feature');
    expect(repo.resolveBranch('feature')).toBe(firstHash);
  });

  it('throws if branch already exists', () => {
    cmdBranch(repo, 'dup');
    expect(() => cmdBranch(repo, 'dup')).toThrow("Branch 'dup' already exists");
  });

  it('lists branches with current branch marked', () => {
    cmdBranch(repo, 'feature');
    const listing = cmdBranch(repo); // no name arg = list
    expect(listing).toContain('* main');
    expect(listing).toContain('  feature');
  });

  it('switch moves HEAD to the new branch', () => {
    cmdBranch(repo, 'feature');
    cmdSwitch(repo, 'feature');
    const head = repo.readHead();
    expect(head.type).toBe('branch');
    if (head.type === 'branch') expect(head.name).toBe('feature');
  });

  it('commits on feature branch do not affect main', () => {
    cmdBranch(repo, 'feature');
    cmdSwitch(repo, 'feature');

    writeFile(root, 'feature.txt', 'feature work');
    cmdAdd(repo, 'feature.txt');
    const { hash: featureHash } = cmdCommit(repo, 'feature commit', 'Dev <dev@dev.com>');

    expect(repo.resolveBranch('feature')).toBe(featureHash);
    expect(repo.resolveBranch('main')).toBe(firstHash); // main unchanged
  });

  it('throws switch for non-existent branch', () => {
    expect(() => cmdSwitch(repo, 'no-such-branch'))
      .toThrow("Branch 'no-such-branch' not found");
  });
});

// ─── diff ────────────────────────────────────────────────────────────────────

describe('cmdDiff', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows no diff when working tree matches index', () => {
    fs.writeFileSync(path.join(root, 'same.txt'), 'same');
    cmdAdd(repo, 'same.txt');
    const diff = cmdDiff(repo);
    expect(diff).toBe('No differences (working tree matches index)');
  });

  it('shows diff when working tree differs from index content', () => {
    fs.writeFileSync(path.join(root, 'change.txt'), 'old line');
    cmdAdd(repo, 'change.txt');

    fs.writeFileSync(path.join(root, 'change.txt'), 'old line\nnew line');

    const diff = cmdDiff(repo);
    expect(diff).toContain('+new line');
    expect(diff).toContain('change.txt');
  });

  it('shows all lines as added on first commit if not staged', () => {
    // Diff compares index and working tree. If it is in index but not working tree, it's deleted. 
    // Wait, if it's new and staged, it's in index. If we don't change working tree, working matches index.
    // The test originally added 'new.txt', and checked diff. Now that working matches index, diff is empty!
    // We should modify the file after staging to see a diff.
    fs.writeFileSync(path.join(root, 'new.txt'), 'alpha\nbeta');
    cmdAdd(repo, 'new.txt');
    fs.writeFileSync(path.join(root, 'new.txt'), 'alpha\nbeta\ngamma');
    const diff = cmdDiff(repo);
    expect(diff).toContain('+gamma');
  });

  it('shows diff between HEAD and index when --staged is used', () => {
    fs.writeFileSync(path.join(root, 'staged.txt'), 'version 1');
    cmdAdd(repo, 'staged.txt');
    cmdCommit(repo, 'first', 'A <a@a.com>');

    fs.writeFileSync(path.join(root, 'staged.txt'), 'version 1\nversion 2');
    cmdAdd(repo, 'staged.txt'); // stage it

    const diff = cmdDiff(repo, true); // true = staged
    expect(diff).toContain('+version 2');
    expect(diff).toContain('staged.txt');

    // working tree modified further, but staged shouldn't see it
    fs.writeFileSync(path.join(root, 'staged.txt'), 'version 1\nversion 2\nversion 3');
    const diff2 = cmdDiff(repo, true);
    expect(diff2).not.toContain('+version 3');
  });
});

// ─── status ──────────────────────────────────────────────────────────────────

describe('cmdStatus', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows clean working tree', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first', 'A <a@a.com>');
    const status = require('../src/commands').cmdStatus(repo);
    expect(status).toContain('nothing to commit, working tree clean');
  });

  it('shows untracked files', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    const status = require('../src/commands').cmdStatus(repo);
    expect(status).toContain('Untracked files:');
    expect(status).toContain('a.txt');
  });

  it('shows staged and unstaged files', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first', 'A <a@a.com>');

    fs.writeFileSync(path.join(root, 'a.txt'), 'a modified'); // unstaged
    fs.writeFileSync(path.join(root, 'b.txt'), 'b');
    cmdAdd(repo, 'b.txt'); // staged

    const status = require('../src/commands').cmdStatus(repo);
    expect(status).toContain('Changes to be committed:');
    expect(status).toContain('modified/added:   b.txt');
    expect(status).toContain('Changes not staged for commit:');
    expect(status).toContain('modified/deleted: a.txt');
  });

  it('shows deleted files correctly', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first', 'A <a@a.com>');

    fs.unlinkSync(path.join(root, 'a.txt')); // deleted from working tree
    let status = require('../src/commands').cmdStatus(repo);
    expect(status).toContain('modified/deleted: a.txt (deleted)');

    repo.stageFile({ path: 'a.txt', hash: '' }); // staged deletion
    status = require('../src/commands').cmdStatus(repo);
    expect(status).toContain('a.txt (deleted)');
  });
});

// ─── ls-tree ─────────────────────────────────────────────────────────────────

describe('cmdLsTree', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => {
    ({ root, repo } = tempRepo());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists tree contents for a commit', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'dir', 'b.txt'), 'b');
    cmdAdd(repo, 'a.txt');
    cmdAdd(repo, 'dir/b.txt');
    const { hash } = cmdCommit(repo, 'first', 'A <a@a.com>');

    const out = require('../src/commands').cmdLsTree(repo, hash);
    expect(out).toContain('100644 blob');
    expect(out).toContain('a.txt');
    expect(out).toContain('040000 tree');
    expect(out).toContain('dir');
  });

  it('throws for unknown ref', () => {
    expect(() => require('../src/commands').cmdLsTree(repo, 'bad')).toThrow('Unknown ref: bad');
  });

  it('throws for non-tree objects', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    cmdAdd(repo, 'a.txt');
    const blobHash = repo.readIndex()[0]!.hash;
    expect(() => require('../src/commands').cmdLsTree(repo, blobHash)).toThrow('Not a commit or tree');
  });
});
