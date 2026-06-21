// tests/repository.test.ts
import * as os   from 'os';
import * as path from 'path';
import * as fs   from 'fs';
import { Repository, DEFAULT_BRANCH } from '../src/repository';
import { cmdInit } from '../src/commands';

function tempRepo(): { root: string; repo: Repository } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-repo-test-'));
  cmdInit(root);
  return { root, repo: new Repository(root) };
}

describe('Repository.discover', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-discover-test-'));
    cmdInit(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds repo from the root directory', () => {
    const repo = Repository.discover(root);
    expect(repo.root).toBe(root);
  });

  it('finds repo from a subdirectory', () => {
    const sub = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    const repo = Repository.discover(sub);
    expect(repo.root).toBe(root);
  });

  it('throws when not in a repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-outside-'));
    try {
      expect(() => Repository.discover(outside)).toThrow('Not a mini-git repository');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('HEAD management', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => ({ root, repo } = tempRepo()));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('default HEAD is symbolic ref to main', () => {
    const head = repo.readHead();
    expect(head.type).toBe('branch');
    if (head.type === 'branch') expect(head.name).toBe(DEFAULT_BRANCH);
  });

  it('writeHead with branch produces symbolic ref file', () => {
    repo.writeHead({ type: 'branch', name: 'dev' });
    const raw = fs.readFileSync(path.join(root, '.mgit', 'HEAD'), 'utf8').trim();
    expect(raw).toBe('ref: refs/heads/dev');
  });

  it('writeHead with detached produces raw hash file', () => {
    const hash = 'a'.repeat(40);
    repo.writeHead({ type: 'detached', hash });
    const raw = fs.readFileSync(path.join(root, '.mgit', 'HEAD'), 'utf8').trim();
    expect(raw).toBe(hash);
  });

  it('resolveHead returns null on unborn branch', () => {
    expect(repo.resolveHead()).toBeNull();
  });
});

describe('branch management', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => ({ root, repo } = tempRepo()));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolveBranch returns null for non-existent branch', () => {
    expect(repo.resolveBranch('no-branch')).toBeNull();
  });

  it('writeBranch + resolveBranch round-trips', () => {
    const hash = 'b'.repeat(40);
    repo.writeBranch('feature', hash);
    expect(repo.resolveBranch('feature')).toBe(hash);
  });

  it('listBranches returns empty list initially', () => {
    expect(repo.listBranches()).toEqual([]);
  });

  it('listBranches includes written branches', () => {
    repo.writeBranch('main', 'a'.repeat(40));
    repo.writeBranch('dev', 'b'.repeat(40));
    const branches = repo.listBranches();
    expect(branches).toContain('main');
    expect(branches).toContain('dev');
  });

  it('listBranches includes nested branches', () => {
    repo.writeBranch('feature/ui/auth', 'c'.repeat(40));
    repo.writeBranch('feature/api', 'd'.repeat(40));
    const branches = repo.listBranches();
    expect(branches).toContain('feature/ui/auth');
    expect(branches).toContain('feature/api');
  });

  it('currentBranch returns null when HEAD is detached', () => {
    repo.writeHead({ type: 'detached', hash: 'a'.repeat(40) });
    expect(repo.currentBranch()).toBeNull();
  });

  it('currentBranch returns branch name when symbolic', () => {
    repo.writeHead({ type: 'branch', name: 'main' });
    expect(repo.currentBranch()).toBe('main');
  });
});

describe('index management', () => {
  let root: string;
  let repo: Repository;

  beforeEach(() => ({ root, repo } = tempRepo()));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('initial index is empty', () => {
    expect(repo.readIndex()).toEqual([]);
  });

  it('writeIndex + readIndex round-trips', () => {
    const entries = [{ path: 'a.txt', hash: 'a'.repeat(40) }];
    repo.writeIndex(entries);
    expect(repo.readIndex()).toEqual(entries);
  });

  it('stageFile adds a new entry', () => {
    repo.stageFile({ path: 'new.txt', hash: '1'.repeat(40) });
    const index = repo.readIndex();
    expect(index).toHaveLength(1);
    expect(index[0]?.path).toBe('new.txt');
  });

  it('stageFile replaces existing entry for same path', () => {
    repo.stageFile({ path: 'f.txt', hash: 'a'.repeat(40) });
    repo.stageFile({ path: 'f.txt', hash: 'b'.repeat(40) });
    const index = repo.readIndex();
    expect(index).toHaveLength(1);
    expect(index[0]?.hash).toBe('b'.repeat(40));
  });

  it('stageFile appends new entries for different paths', () => {
    repo.stageFile({ path: 'a.txt', hash: 'a'.repeat(40) });
    repo.stageFile({ path: 'b.txt', hash: 'b'.repeat(40) });
    expect(repo.readIndex()).toHaveLength(2);
  });
});
