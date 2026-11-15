# markdown-render-speed-02 — a faster marked-compatible renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Revaaa28/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Revaaa28/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Entry to make.fun's [“Make Markdown rendering faster” bounty](https://make.fun/bounty/markdown-render-speed-02).

`parse.js` is a dependency-free JavaScript module exporting `parse(markdown)`
that returns, byte for byte, the HTML that marked 18.1.3 renders with its
default options (GFM on), while using substantially less CPU time than marked
itself. `main.ts` is the harness driver: it reads `/input/cases.json`,
renders each case with `parse()`, and writes `/output/html.json`.

## How it works

The pipeline mirrors marked's architecture — a block pass that collects link
reference definitions, an inline pass over each block's text, then rendering —
but the hot paths are hand-written index scanners instead of anchored regexes
run over shrinking substrings:

- Block structure (blank runs, indented and fenced code, ATX headings,
  thematic breaks, HTML blocks, link definitions, tables, setext headings,
  paragraphs) is recognized by line-based scanners that walk the source once
  with an index, allocating only the slices that become token text.
- Blockquotes and lists follow marked's own grouping and indentation
  arithmetic exactly, including lazy continuation lines, loose/tight
  detection, and task-list checkbox fixups.
- The inline pass scans text with a character-level state machine
  (escapes, code spans, hard breaks, autolinks and GFM URL/email linking),
  and uses marked's delimiter-run machinery for emphasis, strikethrough and
  link labels, so edge-case output matches the reference renderer exactly.
- Rendering is a pure walk of the token tree producing marked's exact
  strings.

Correctness was verified by diffing against the vendored marked 18.1.3 on
the full CommonMark 0.31.2 + GFM spec suites and on generated README-style
documents from the competition's own generator across multiple seeds:
720/720 cases byte-identical in every run.

## License

MIT. The delimiter-scan patterns and masking passes in `parse.js` are
derived from marked (MIT, Copyright (c) 2011-2025 Christopher Jeffrey,
Copyright (c) 2018+ The MarkedJS contributors), vendored with the
competition kit as the reference implementation.
