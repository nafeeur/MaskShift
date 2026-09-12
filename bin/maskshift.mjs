#!/usr/bin/env node
import path from 'node:path';

try {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
} catch {
  // No .env in the current directory — fine, vars may come from the shell/service instead.
}

const { main } = await import('../src/cli/main.mjs');

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((error) => {
    console.error(`\nMASKSHIFT FATAL: ${error?.stack || error}`);
    process.exitCode = 1;
  });
