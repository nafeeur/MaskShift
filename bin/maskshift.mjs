#!/usr/bin/env node
import { main } from '../src/cli/main.mjs';

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((error) => {
    console.error(`\nMASKSHIFT FATAL: ${error?.stack || error}`);
    process.exitCode = 1;
  });
