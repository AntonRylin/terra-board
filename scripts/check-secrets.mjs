// Refuses a commit that would add a Telegram API ID or hash, or a file that
// holds one (git runs it before each commit: .githooks/pre-commit, set up with
// `git config core.hooksPath .githooks`). It checks:
// - file names: Telegram credentials, sessions and the build's telegram-app.json;
// - added lines that assign an api_hash (32 hex) or api_id (5+ digits);
// - added lines containing a value this computer knows to be real: the
//   build's electron/generated/telegram-app.json, the TERRA_TELEGRAM_API_*
//   environment variables, and SHA-256 fingerprints listed one per line in
//   .git/info/terra-secret-hashes (never the values themselves).
// Run `node scripts/check-secrets.mjs --remember <value>` to add a fingerprint.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
// Made-up values the tests and placeholders use.
const examples = new Set([
  '0123456789abcdef0123456789abcdef',
  'abcdef0123456789abcdef0123456789',
  '12345',
  '123456',
  '1234567',
]);

export const forbiddenFile = (name) =>
  /(^|\/)(credentials\.bin|database-key\.bin|telegram-app\.json|td\.binlog)$/i.test(name) ||
  /\.session(-journal)?$/i.test(name) ||
  /(^|\/)telegram\/database\//i.test(name);

const assignment =
  /(api[_-]?hash|apihash|TERRA_TELEGRAM_API_HASH)["'`]?\s*[:=]\s*["'`]?([0-9a-f]{32})\b|(api[_-]?id|apiid|TERRA_TELEGRAM_API_ID)["'`]?\s*[:=]\s*["'`]?(\d{5,12})\b/gi;

/** Problems in a staged diff (`git diff --cached -U0`): [file, reason]. */
export function findSecrets(diff, { known = new Set(), fingerprints = new Set() } = {}) {
  const problems = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '');
      if (file !== '/dev/null' && forbiddenFile(file))
        problems.push([file, 'this file holds Telegram credentials or a session']);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const match of line.matchAll(assignment)) {
      const value = (match[2] || match[4]).toLowerCase();
      if (!examples.has(value))
        problems.push([file, `an ${match[2] ? 'API hash' : 'API ID'} is assigned`]);
    }
    for (const token of line.match(/\b[0-9a-f]{32}\b|\b\d{5,12}\b/gi) || []) {
      const value = token.toLowerCase();
      if (known.has(value) || fingerprints.has(sha(value)))
        problems.push([file, 'it contains your real Telegram API ID or hash']);
    }
  }
  return problems;
}

function gitDir() {
  return execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
}
function localValues(root) {
  const known = new Set();
  const app = join(root, 'electron', 'generated', 'telegram-app.json');
  try {
    const { apiId, apiHash } = JSON.parse(readFileSync(app, 'utf8'));
    if (apiId) known.add(String(apiId));
    if (apiHash) known.add(String(apiHash).toLowerCase());
  } catch {
    /* No build credentials here. */
  }
  for (const name of ['TERRA_TELEGRAM_API_ID', 'TERRA_TELEGRAM_API_HASH'])
    if (process.env[name]) known.add(process.env[name].toLowerCase());
  return known;
}
function readFingerprints() {
  const file = join(gitDir(), 'info', 'terra-secret-hashes');
  return new Set(
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^[0-9a-f]{64}$/.test(l))
      : [],
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const remember = process.argv.indexOf('--remember');
  if (remember > 0) {
    const value = (process.argv[remember + 1] || '').trim().toLowerCase();
    if (!value) throw Error('Give the value to remember.');
    const file = join(gitDir(), 'info', 'terra-secret-hashes');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, sha(value) + '\n');
    console.log('Remembered its fingerprint in .git/info/terra-secret-hashes.');
    process.exit(0);
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const problems = findSecrets(diff, {
    known: localValues(root),
    fingerprints: readFingerprints(),
  });
  if (problems.length) {
    console.error('Commit refused: it would add Telegram credentials.');
    for (const [file, reason] of problems) console.error(`  ${file}: ${reason}`);
    console.error('Remove them from the staged changes. They belong only in the app on your PC.');
    process.exit(1);
  }
}
