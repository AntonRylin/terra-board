import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

// Packages the renderer loads at startup: everything reached from src/main.tsx
// through static imports. Type-only imports and import() calls load nothing.
function startupPackages(entry) {
  const parent = new Map([[entry, null]]);
  const packages = new Map();
  const queue = [entry];
  const statement =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  const typeOnly = (clause) => {
    const names = /\{([^}]*)\}/.exec(clause);
    if (!names || clause.replace(names[0], '').replace(/[\s,]/g, '')) return false;
    const list = names[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    return list.length > 0 && list.every((name) => name.startsWith('type '));
  };
  while (queue.length) {
    const file = queue.shift();
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(statement)) {
      if (match[1] || (match[2] && typeOnly(match[2]))) continue;
      const specifier = match[3] || match[4];
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(file), specifier);
        const found = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
        ].find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
        if (found && !parent.has(found)) {
          parent.set(found, file);
          queue.push(found);
        }
      } else if (!specifier.includes('?')) {
        const parts = specifier.split('/');
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!packages.has(name)) packages.set(name, file);
      }
    }
  }
  const chain = (file) => {
    const steps = [];
    for (let at = file; at; at = parent.get(at)) steps.unshift(relative(resolve('.'), at));
    return steps.join(' -> ');
  };
  return { packages, chain };
}

test('startup modules never import pdf-lib', () => {
  const { packages, chain } = startupPackages(resolve('src/main.tsx'));
  assert.ok(packages.has('react'), 'the walk should reach react');
  assert.ok(
    !packages.has('pdf-lib'),
    `pdf-lib is loaded at startup via ${packages.has('pdf-lib') ? chain(packages.get('pdf-lib')) : ''}`,
  );
});
