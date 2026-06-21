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

  test('Safe-checkout conflict detection', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    // Switch to dev, change a.txt, commit
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello dev');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'dev commit');

    // Switch back to main
    cmdCheckout(repo, 'main');

    // Now modify working tree a.txt
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'uncommitted changes');

    // Attempting to checkout dev should fail because it would overwrite 'a.txt' which has uncommitted changes
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/would be overwritten by checkout/);
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
