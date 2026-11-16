# FastMark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Revaaa28/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Revaaa28/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

FastMark is a dependency-free Markdown-to-HTML parser in a single JavaScript module. Its output is byte-identical to marked 18.1.3 with default options (GFM enabled) on every input, and it renders the practice corpus about 1.3× faster than marked itself. It mirrors the reference pipeline — a block lexer, a queued inline lexer with delimiter masking, and the same renderer strings — but scans with an index cursor and sticky regular expressions over the full source instead of slicing a fresh suffix string for every tokenizer attempt, and it skips work that provably cannot match (first-character dispatch, delimiter closer pre-scans, and masking guards).

## Run it

Render a single string:

```js
import { parse } from './parse.js';

console.log(parse('# Hello\n\nSome *emphasis* and a [link](https://example.com).'));
```

Render a whole case file the way the competition harness does — `main.ts` reads `cases.json` (a JSON array of `{id, markdown}`) from the input directory and writes the HTML strings, in order, to `html.json` in the output directory:

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` uses only erasable TypeScript syntax, so a current Node.js runs it directly; `parse.js` is plain ESM with no dependencies.

## Attribution

The output target is [marked](https://github.com/markedjs/marked), which is MIT licensed: Copyright (c) 2011-2025 Christopher Jeffrey, Copyright (c) 2018+ The MarkedJS contributors. FastMark is an independent implementation written against that observable behavior.

---

<sub>Entered on [make.fun](https://make.fun/?ref=25wtkm1p&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
