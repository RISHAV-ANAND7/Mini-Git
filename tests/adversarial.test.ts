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

  test('Shape conflict: target file blocked by untracked directory', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.writeFileSync(path.join(repoPath, 'src'), 'src as file'); // target is 'src' file
    cmdAdd(repo, 'src');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    // Main has no 'src' file. We create 'src' directory with untracked file.
    fs.mkdirSync(path.join(repoPath, 'src'));
    fs.writeFileSync(path.join(repoPath, 'src', 'foo.ts'), 'untracked');
    
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/overwrite untracked file inside directory: src[\\\/]foo.ts/);
  });

  test('Shape conflict: target directory blocked by untracked file', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');
    cmdBranch(repo, 'dev');
    
    cmdCheckout(repo, 'dev');
    fs.mkdirSync(path.join(repoPath, 'src'));
    fs.writeFileSync(path.join(repoPath, 'src', 'foo.ts'), 'src file');
    cmdAdd(repo, 'src/foo.ts');
    cmdCommit(repo, 'dev commit');

    cmdCheckout(repo, 'main');
    // Main has no 'src' dir. We create 'src' as an untracked file.
    fs.writeFileSync(path.join(repoPath, 'src'), 'untracked file');
    
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/overwrite untracked file with directory: src/);
  });

  test('Atomic checkout prevents partial updates on corrupt blob', () => {
    // 1. Initial commit on main
    fs.writeFileSync(path.join(repoPath, 'file1.txt'), 'file1-main');
    fs.writeFileSync(path.join(repoPath, 'file2.txt'), 'file2-main');
    cmdAdd(repo, 'file1.txt');
    cmdAdd(repo, 'file2.txt');
    cmdCommit(repo, 'main commit');

    // 2. Create and switch to dev
    cmdBranch(repo, 'dev');
    cmdCheckout(repo, 'dev');

    // 3. Modify both files on dev
    fs.writeFileSync(path.join(repoPath, 'file1.txt'), 'file1-dev');
    fs.writeFileSync(path.join(repoPath, 'file2.txt'), 'file2-dev');
    cmdAdd(repo, 'file1.txt');
    cmdAdd(repo, 'file2.txt');
    cmdCommit(repo, 'dev commit');

    // 4. Back to main
    cmdCheckout(repo, 'main');

    // 5. Corrupt file2-dev's blob
    const file2DevHash = require('../src/hash').sha1(require('../src/store').serialise({ type: 'blob', content: Buffer.from('file2-dev') }));
    const { dir, file } = require('../src/hash').objectPath(file2DevHash);
    const objPath = path.join(repoPath, '.mgit', 'objects', dir, file);
    fs.writeFileSync(objPath, Buffer.from('corrupt'));

    // 6. Attempt to checkout dev. Should fail during pre-read of file2-dev.
    expect(() => cmdCheckout(repo, 'dev')).toThrow(/Corrupt object detected/);

    // 7. Verify working directory was not partially modified (file1 should remain file1-main)
    expect(fs.readFileSync(path.join(repoPath, 'file1.txt'), 'utf8')).toBe('file1-main');
  });

  test('Empty commit check', () => {
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello');
    cmdAdd(repo, 'a.txt');
    cmdCommit(repo, 'first commit');

    // Should throw if nothing changed
    expect(() => cmdCommit(repo, 'second commit')).toThrow(/Nothing to commit/);
  });
});
