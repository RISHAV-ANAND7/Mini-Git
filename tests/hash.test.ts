// tests/hash.test.ts
import { sha1, objectPath, isValidHash, shortHash } from '../src/hash';

describe('sha1', () => {
  it('produces a 40-character hex string', () => {
    expect(sha1('hello')).toHaveLength(40);
    expect(sha1('hello')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('matches known SHA-1 vectors', () => {
    // RFC-compliant test vectors
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('is deterministic — same input always produces same hash', () => {
    const h1 = sha1('content-addressable storage');
    const h2 = sha1('content-addressable storage');
    expect(h1).toBe(h2);
  });

  it('is collision-resistant — different inputs produce different hashes', () => {
    expect(sha1('blob 5\nhello')).not.toBe(sha1('blob 5\nworld'));
  });

  it('is sensitive to every byte — whitespace changes hash', () => {
    expect(sha1('hello')).not.toBe(sha1('hello '));
    expect(sha1('hello')).not.toBe(sha1('Hello'));
  });
});

describe('objectPath', () => {
  it('splits hash into 2-char dir and 38-char file', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const { dir, file } = objectPath(hash);
    expect(dir).toBe('aa');
    expect(file).toBe('f4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect(dir.length).toBe(2);
    expect(file.length).toBe(38);
  });

  it('dir + file reconstructs the original hash', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    const { dir, file } = objectPath(hash);
    expect(dir + file).toBe(hash);
  });
});

describe('isValidHash', () => {
  it('accepts 40-char hex strings', () => {
    expect(isValidHash('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')).toBe(true);
    expect(isValidHash('0000000000000000000000000000000000000000')).toBe(true);
  });

  it('rejects short, long, or non-hex strings', () => {
    expect(isValidHash('aaf4c61')).toBe(false);                          // too short
    expect(isValidHash('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434dXX')).toBe(false); // too long
    expect(isValidHash('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);   // non-hex
  });
});

describe('shortHash', () => {
  it('returns the first 7 characters', () => {
    const hash = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
    expect(shortHash(hash)).toBe('aaf4c61');
    expect(shortHash(hash)).toHaveLength(7);
  });
});
