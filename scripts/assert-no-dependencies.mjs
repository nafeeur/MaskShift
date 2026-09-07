// MaskShift's central claim is that it runs on Node's built-ins alone. That is easy to state
// and easy to break: one `import { x } from 'some-package'` merged into src/ turns the claim
// into a lie long before anyone notices a missing node_modules. This asserts it mechanically.
//
// Two checks:
//   1. package.json declares no runtime dependencies.
//   2. no module under src/, bin/, scripts/ or tests/ imports a bare specifier — every import
//      is either `node:*` or a relative path.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED = ['src', 'bin', 'scripts', 'tests'];
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

// Matched against statement positions rather than anywhere in the text: a specifier-shaped
// string inside a comment or an argument list is not an import, and scanning raw source for
// quotes reports those as dependencies.
//
// Negated classes match newlines, so a multi-line named import is covered by the first rule.
const PATTERNS = [
  // import … from 'x'  /  export … from 'x'
  /^[ \t]*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  // import 'x'  (side-effect only)
  /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
  // import('x') / require('x'), skipping comment lines and member calls like foo.import(…)
  /^(?![ \t]*(?:\/\/|\*))[^\n]*?(?<![.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]/gm,
];

const failures = [];

const manifest = createRequire(import.meta.url)('../package.json');
for (const field of RUNTIME_FIELDS) {
  const names = Object.keys(manifest[field] || {});
  if (names.length) failures.push(`package.json declares ${field}: ${names.join(', ')}`);
}

async function* walk(directory) {
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (full.endsWith('.mjs') || full.endsWith('.js')) yield full;
  }
}

let scanned = 0;
for (const directory of SCANNED) {
  for await (const file of walk(path.join(root, directory))) {
    scanned += 1;
    const source = await fsp.readFile(file, 'utf8');
    for (const pattern of PATTERNS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (!specifier) continue;
        if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) continue;
        failures.push(`${path.relative(root, file)} imports the bare specifier '${specifier}'`);
      }
    }
  }
}

if (failures.length) {
  process.stderr.write(`MaskShift dependency check FAILED\n\n${failures.map((line) => `  - ${line}`).join('\n')}\n\n`);
  process.stderr.write('MaskShift runs on Node built-ins only. Use a node: module or vendor the code.\n');
  process.exit(1);
}

const devCount = Object.keys(manifest.devDependencies || {}).length;
console.log(`MaskShift dependency check PASS (${scanned} modules, 0 runtime dependencies, ${devCount} dev dependencies)`);
