#!/usr/bin/env node
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

try {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
} catch {
  // No .env in the current directory — fine, vars may come from the shell/service instead.
}

// Persists V8's compiled bytecode for every module this process loads, so a
// CLI invoked as often as this one skips re-parsing/re-compiling its own
// source on each run. Enabling it before the first `import` below is what
// lets it cover the whole module graph, not just this file. Node 22.1+ only
// (the engines.node floor is 22.0.0), and it degrades to a no-op — never an
// error — on an unwritable cache directory.
if (typeof module.enableCompileCache === 'function') {
  const home = process.env.MASKSHIFT_HOME
    ? process.env.MASKSHIFT_HOME.replace(/^~(?=$|\/)/, os.homedir())
    : path.join(os.homedir(), '.maskshift');
  try { module.enableCompileCache(path.join(home, 'compile-cache')); } catch { /* best effort */ }
}

const { main } = await import('../src/cli/main.mjs');

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((error) => {
    console.error(`\nMASKSHIFT FATAL: ${error?.stack || error}`);
    process.exitCode = 1;
  });
