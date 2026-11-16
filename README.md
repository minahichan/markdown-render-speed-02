# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Minahichan/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Minahichan/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3, written from scratch for the [make.fun](https://make.fun/bounty/markdown-render-speed-02) bounty **markdown-render-speed-02** ("Make Markdown rendering faster").

`parse(markdown)` returns exactly the HTML that `marked.parse(markdown)` returns with marked's defaults (GFM on, breaks off, pedantic off, async off) — byte for byte on the CommonMark 0.31.2 spec examples, the GFM 0.29 extension examples, and generated README documents — but faster.

## Layout

- `parse.js` — the renderer. A dependency-free ES module exporting `parse(markdown)`. Line-based block walk into a small block tree, then a direct-to-HTML render; `*`/`_` emphasis follows marked's regex-based emStrong forward scan, `~` strikethrough uses a delimiter stack.
- `main.ts` — the driver the harness runs as `node /bot/main.ts`. Reads `/input/cases.json`, renders each case with `parse`, writes `/output/html.json`.

## Check it

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set, or /input and /output in a container
```

---

Built for [make.fun](https://make.fun/r/60xrk087) — try the bounties with my referral link: https://make.fun/r/60xrk087
