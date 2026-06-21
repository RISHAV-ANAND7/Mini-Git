import * as fs from 'fs';
import * as path from 'path';
import { cmdInit, cmdAdd, cmdCommit, cmdBranch, cmdCheckout } from '../src/commands';
import { Repository } from '../src/repository';

describe('Adversarial Tests', () => {
  let repoPath: string;
  let repo: Repository;

  beforeEach(() => {
    repoPath = path.join(__dirname, 'test-repo-' + Math.random().toString(36).substring(7));
    fs.mkdirSync(repoPath, { recursive: true });
    cmdInit(repoPath);
    repo = new Repository(repoPath);
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  test('Path traversal prevention: mgit add ../outside.txt', () => {
    const outsideFile = path.join(repoPath, '../outside.txt');
    fs.writeFileSync(outsideFile, 'outside content');
    try {
      expect(() => cmdAdd(repo, '../outside.txt')).toThrow(/resolves outside the repository/);
    } finally {
      fs.unlinkSync(outsideFile);
    }
  });

  test('Invalid branch name', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    expect(() => cmdBranch(repo, '../sneaky')).toThrow(/Invalid branch name/);
    expect(() => cmdBranch(repo, 'feature foo')).toThrow(/Invalid branch name/);
  });

  test('Safe-checkout conflict detection (unstaged modification)', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello dev');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'uncommitted changes');
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/would be overwritten by checkout/);
  });

  test('Staged modification blocks checkout', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello dev');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'staged changes');
    cmdAdd(repo, 'a.txt');
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/would be overwritten by checkout/);
  });

  test('Staged deletion blocks checkout', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello dev');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    fs.unlinkSync(path.join(repoPath, 'a.txt'));
    repo.stageFile({ path: 'a.txt', hash: '' }); // simulate staged deletion or mgit add deleted
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/would be overwritten by checkout/);
  });

  test('Staged new-file conflict blocks checkout', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'new.txt'), 'hello dev');
    cmdAdd(repo, 'new.txt');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    fs.writeFileSync(path.join(repoPath, 'new.txt'), 'staged new file');
    cmdAdd(repo, 'new.txt');
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/would be overwritten by checkout/);
  });

  test('Locally deleted file conflict blocks checkout', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello dev');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    fs.unlinkSync(path.join(repoPath, 'a.txt'));
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/would be overwritten by checkout/);
  });

  test('Untracked file overwritten by target blocks checkout', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'in dev');
    cmdAdd(repo, 'untracked.txt');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'untracked file in main');
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/untracked working tree files would be overwritten/);
  });

  test('Binary safe blob storage', () => {
    const binaryContent = Buffer.from([0x00, 0xFF, 0xFE, 0x01, 0x02, 0x00]);
    fs.writeFileSync(path.join(repoPath, 'binary.bin'), binaryContent);
    cmdAdd(repo, 'binary.bin');
    cmdCommit(repo, 'binary commit');

    const index = repo.readIndex();
    const entry = index.find(e => e.path === 'binary.bin');
    expect(entry).toBeDefined();

    const blobObj = repo.store.read(entry!.hash);
    expect(blobObj.type).toBe('blob');
    if (blobObj.type === 'blob') {
      expect(blobObj.content).toEqual(binaryContent);
    }
  });

  test('Ambiguous tree serialization with spaces and newlines', () => {
    const weirdFileName = 'file with spaces and newlines.txt';
    fs.writeFileSync(path.join(repoPath, weirdFileName), 'content');
    cmdAdd(repo, weirdFileName);
    cmdCommit(repo, 'weird file');

    const index = repo.readIndex();
    const entry = index.find(e => e.path === weirdFileName);
    expect(entry).toBeDefined();
  });

  test('Empty commit check', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');

    // Should throw if nothing changed
    expect(() => cmdCommit(repo, 'second commit')).toThrow(/Nothing to commit/);
  });
});
