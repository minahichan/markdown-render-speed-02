// The driver the harness runs: node /bot/main.ts on Node 22.
// It reads every case from /input/cases.json (or MAKEFUN_INPUT_DIR when
// run outside a container), renders each one alone with parse() from
// parse.js, and writes the HTML strings, in the cases' order, to
// /output/html.json (or MAKEFUN_OUTPUT_DIR).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  markdown: string;
}[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i]!.markdown);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
