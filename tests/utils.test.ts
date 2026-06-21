// tests/utils.test.ts
import * as os   from 'os';
import * as path from 'path';
import * as fs   from 'fs';
import { listFilesRecursive, formatDate, padStart } from '../src/utils';

describe('listFilesRecursive', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgit-utils-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists a single file', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    expect(listFilesRecursive(root)).toEqual(['a.txt']);
  });

  it('lists files recursively', () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'README.md'), '');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '');
    const files = listFilesRecursive(root).sort();
    expect(files).toEqual(['README.md', 'src/index.ts']);
  });

  it('excludes .mgit directory', () => {
    fs.mkdirSync(path.join(root, '.mgit'));
    fs.writeFileSync(path.join(root, '.mgit', 'HEAD'), 'ref: refs/heads/main');
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    expect(listFilesRecursive(root)).toEqual(['keep.txt']);
  });

  it('returns empty array for empty directory', () => {
    expect(listFilesRecursive(root)).toEqual([]);
  });

  it('ignores symlinks to prevent recursion', () => {
    try {
      fs.mkdirSync(path.join(root, 'dir1'));
      fs.writeFileSync(path.join(root, 'dir1', 'file.txt'), 'file');
      // Create a symlink/junction that points back to root or a directory
      fs.symlinkSync(path.join(root, 'dir1'), path.join(root, 'link1'), 'junction');
      
      const files = listFilesRecursive(root).sort();
      expect(files).toEqual(['dir1/file.txt']); // link1 is ignored completely
    } catch (err: any) {
      if (err.code === 'EPERM') {
        console.warn('Skipping symlink test due to Windows permissions');
      } else {
        throw err;
      }
    }
  });
});

describe('formatDate', () => {
  it('formats a unix ms timestamp as ISO-8601 without milliseconds', () => {
    const ts = new Date('2024-01-15T10:30:00.000Z').getTime();
    expect(formatDate(ts)).toBe('2024-01-15T10:30:00Z');
  });

  it('strips milliseconds', () => {
    const ts = new Date('2024-06-01T00:00:00.123Z').getTime();
    expect(formatDate(ts)).not.toContain('.123');
  });
});

describe('padStart', () => {
  it('pads a short string', () => {
    expect(padStart('hi', 5)).toBe('   hi');
  });

  it('does not truncate strings longer than width', () => {
    expect(padStart('hello world', 5)).toBe('hello world');
  });

  it('leaves exact-length strings unchanged', () => {
    expect(padStart('abc', 3)).toBe('abc');
  });
});
