import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { Store } = require('../electron/store.cjs');
test(
  'acknowledged edits survive forced writer-process termination',
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'canvas-crash-'));
    const child = fork(new URL('./crash-writer.cjs', import.meta.url), [root], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      const [message] = await once(child, 'message');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const reopened = new Store(root);
      try {
        assert.equal(reopened.loadBoard({ id: message.id }).objects[0].text, 'Acknowledged');
        assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally {
        reopened.close();
      }
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
