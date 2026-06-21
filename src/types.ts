export type Hash = string;
export type ObjectType = 'blob' | 'tree' | 'commit';

export interface BlobObject {
  type: 'blob';
  content: Buffer;
}


export interface TreeEntry {
  mode: '100644' | '040000';
  name: string;
  hash: Hash;
}


export interface TreeObject {
  type: 'tree';
  entries: TreeEntry[];
}

export interface CommitObject {
  type: 'commit';
  treeHash: Hash;
  parentHash: Hash | null;
  message: string;
  author: string;
  timestamp: number; // Unix ms
}

export type MgitObject = BlobObject | TreeObject | CommitObject;

export interface IndexEntry {
  path: string;
  hash: Hash;
}

export type Index = IndexEntry[];


export type HeadRef =
  | { type: 'branch'; name: string }
  | { type: 'detached'; hash: Hash };


export type DiffOpType = 'equal' | 'insert' | 'delete';

export interface DiffOp {
  op: DiffOpType;
  lines: string[];
}
