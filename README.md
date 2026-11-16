# Markdown renderer — a faster drop-in for marked

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/minahichan/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/minahichan/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free ES module, `parse.js`, whose `parse(markdown)` returns
exactly the HTML that marked 18.1.3's `marked.parse(markdown)` returns with
marked's default options (GFM on, breaks off, pedantic off, async off),
and `main.ts`, the program the harness runs: it reads every case from
`/input/cases.json`, renders each one alone with `parse`, and writes the
720 HTML strings, in the cases' order, to `/output/html.json`.

See the bounty: https://make.fun/bounty/markdown-render-speed-02

## How it works

`parse.js` is a from-scratch CommonMark 0.31.2 + GFM 0.29 renderer, written
for this competition:

- **Block parsing** walks each line through the open containers
  (block quotes, lists, list items), matching them the way the spec
  describes, with lazy paragraph continuation lines, setext headings,
  link reference definitions, GFM tables and task list items.
- **Inline parsing** scans each block's text once, with a delimiter stack
  for emphasis, strong emphasis and strikethrough, bracket matching for
  links and images (inline, full, collapsed and shortcut references),
  code spans, entities, autolinks and GFM's extended autolinks.
- **Rendering** is plain string building: no dependencies, no regular
  expression backtracking over the whole document, nothing cached from
  one case to the next — `parse` returns for each case what it returns
  for that case alone.

## Running it

```sh
node main.ts
```

Outside a container, set `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` to
point at the cases and the output directory. To grade it on the practice
set from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

## Files

- `parse.js` — the renderer (the whole entry; dependency-free ES module)
- `main.ts` — the driver the harness runs
- `LICENSE` — MIT

## Design notes

The renderer keeps no state between cases: every `parse` call builds its
own block tree and its own reference map from the one string it was given,
so the output for a case never depends on any earlier case. Tabs are
handled by column, not by expanding them up front, so a tab inside a code
block stays a tab while a tab in an indentation is counted as the columns
it spans. Numeric character references are decoded to their character
(`&#35;` becomes `#`); named references pass through verbatim, the way
marked leaves them.
