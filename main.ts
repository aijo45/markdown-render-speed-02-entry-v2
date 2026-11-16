// Entry driver for markdown-render-speed-02.
//
// The grader hands the cases over as <input>/cases.json — a JSON array of
// { id, markdown } — and reads the results back from <output>/html.json,
// one HTML string per case, in input order. Each case is rendered on its
// own through parse() from parse.js, so no state leaks between cases.
// Outside a container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override
// the /input and /output defaults.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { parse } from './parse.js';

// This competition scores one cold pass over the whole set, so the work
// is dominated by first-run cost: TurboFan's background optimisation
// spends more wall time than it saves when every function runs only a few
// dozen times. Stay on Maglev/baseline instead. Best-effort only — a
// runtime that rejects the flag keeps its defaults and the output is
// identical either way.
try {
  setFlagsFromString('--no-opt');
} catch {
  // keep the runtime's default flags
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(
  readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'),
) as Case[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
