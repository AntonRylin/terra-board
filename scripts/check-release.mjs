// Runs before `npm run release`. electron-builder uploads to GitHub Releases with
// GH_TOKEN; stop early when it is missing or this version was already released,
// since installed apps only update to a higher version number.
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const token = process.env.GH_TOKEN;
if (!token) {
  console.error(
    'Set GH_TOKEN to a GitHub token that can write releases to AntonRylin/terra-board.',
  );
  process.exit(1);
}
const response = await fetch(
  `https://api.github.com/repos/AntonRylin/terra-board/releases/tags/v${version}`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
);
if (response.status === 200) {
  console.error(`v${version} is already released. Raise "version" in package.json first.`);
  process.exit(1);
}
if (response.status !== 404) {
  console.error(`Could not reach GitHub (${response.status}). Check GH_TOKEN.`);
  process.exit(1);
}
console.log(`Releasing v${version}.`);
