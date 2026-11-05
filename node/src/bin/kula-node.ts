#!/usr/bin/env node
import { main } from '../cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
);
