#!/usr/bin/env node
import { main } from '../src/server.mjs';

main(process.argv.slice(2)).catch((error) => {
  console.error(`\nMASKSHIFT FATAL: ${error?.stack || error}`);
  process.exitCode = 1;
});
