// FastMark driver: render every case in the input file with parse() and
// write the resulting HTML strings, in the cases' order, to the output
// file. Input and output directories come from the harness environment
// (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR, defaulting to /input and
// /output).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];

// Preallocate the result array at its final size and fill it by index:
// the case count is known up front, so the array never has to grow.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
