#!/usr/bin/env node
// src/cli.ts
// Mini-Git CLI — thin wrapper that maps commander sub-commands to
// the pure command implementations in commands.ts.

import { Command } from 'commander';
import * as path from 'path';
import {
  cmdInit,
  cmdAdd,
  cmdCommit,
  cmdLog,
  formatLog,
  cmdCheckout,
  cmdDiff,
  cmdBranch,
  cmdSwitch,
} from './commands';
import { Repository } from './repository';

const program = new Command();

program
  .name('mgit')
  .description('Mini-Git — a content-addressable VCS in TypeScript')
  .version('1.0.0');

// ─── init ────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Create an empty Mini-Git repository in the current directory')
  .action(() => {
    run(() => {
      console.log(cmdInit(process.cwd()));
    });
  });

// ─── add ─────────────────────────────────────────────────────────────────────
program
  .command('add <file>')
  .description('Stage a file or "." to stage all files')
  .action((file: string) => {
    run(() => {
      const repo = Repository.discover();
      if (file === '.') {
        const { cmdAddAll } = require('./commands');
        console.log(cmdAddAll(repo));
      } else {
        console.log(cmdAdd(repo, file));
      }
    });
  });

// ─── commit ──────────────────────────────────────────────────────────────────
program
  .command('commit')
  .description('Record staged changes as a new commit')
  .requiredOption('-m, --message <message>', 'Commit message')
  .option('--author <author>', 'Override author (defaults to $MGIT_AUTHOR_NAME)')
  .action((opts: { message: string; author?: string }) => {
    run(() => {
      const repo = Repository.discover();
      const { output } = cmdCommit(repo, opts.message, opts.author);
      console.log(output);
    });
  });

// ─── log ─────────────────────────────────────────────────────────────────────
program
  .command('log')
  .description('Show commit history')
  .option('--oneline', 'Compact one-line-per-commit format')
  .action((opts: { oneline?: boolean }) => {
    run(() => {
      const repo = Repository.discover();
      const entries = cmdLog(repo);
      if (opts.oneline) {
        entries.forEach(e => console.log(`${e.short} ${e.message}`));
      } else {
        console.log(formatLog(entries));
      }
    });
  });

// ─── checkout ────────────────────────────────────────────────────────────────
program
  .command('checkout <ref>')
  .description('Restore working directory to a commit hash or branch')
  .action((ref: string) => {
    run(() => {
      const repo = Repository.discover();
      console.log(cmdCheckout(repo, ref));
    });
  });

// ─── diff ────────────────────────────────────────────────────────────────────
program
  .command('diff')
  .description('Show line-level diff between working tree and last commit (Myers)')
  .action(() => {
    run(() => {
      const repo = Repository.discover();
      const output = cmdDiff(repo);
      if (output) console.log(output);
    });
  });

// ─── branch ──────────────────────────────────────────────────────────────────
program
  .command('branch [name]')
  .description('List branches, or create a new branch at HEAD')
  .action((name?: string) => {
    run(() => {
      const repo = Repository.discover();
      console.log(cmdBranch(repo, name));
    });
  });

// ─── switch ──────────────────────────────────────────────────────────────────
program
  .command('switch <branch>')
  .description('Switch to an existing branch')
  .action((branch: string) => {
    run(() => {
      const repo = Repository.discover();
      console.log(cmdSwitch(repo, branch));
    });
  });

// ─── cat-object (debug) ──────────────────────────────────────────────────────
program
  .command('cat-object <hash>')
  .description('Print raw object content (for debugging)')
  .action((hash: string) => {
    run(() => {
      const repo = Repository.discover();
      const obj = repo.store.read(hash);
      console.log(JSON.stringify(obj, null, 2));
    });
  });

// ─── status ──────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show working tree status')
  .action(() => {
    run(() => {
      const repo = Repository.discover();
      const { cmdStatus } = require('./commands');
      console.log(cmdStatus(repo));
    });
  });

// ─── Error handler ───────────────────────────────────────────────────────────
function run(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    process.exit(1);
  }
}


// ─── hash-object ─────────────────────────────────────────────────────────────
program
  .command('hash-object <file>')
  .description('Compute SHA-1 of a file without staging (plumbing)')
  .action((file: string) => {
    run(() => {
      const { cmdHashObject } = require('./commands');
      console.log(cmdHashObject(file));
    });
  });

// ─── ls-tree ─────────────────────────────────────────────────────────────────
program
  .command('ls-tree <ref>')
  .description('List tree contents for a commit or tree object')
  .action((ref: string) => {
    run(() => {
      const repo = Repository.discover();
      const { cmdLsTree } = require('./commands');
      console.log(cmdLsTree(repo, ref));
    });
  });

program.parse(process.argv);

// ─── ls-tree ──────────────────────────────────────────────────────────────────
