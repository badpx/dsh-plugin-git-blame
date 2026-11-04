# Git Blame on Hover

A DeepSeek Harness plugin. When a text or source file is opened in the right
sidebar's file preview, hovering a line shows a small card with that line's
`git blame` information (author, short commit hash, date, and commit summary).

## Install

Requires DeepSeek Harness; this plugin targets DSH `^0.2.1-rc.5`.

- **From npm**: open the Plugins page → **添加插件 / Add plugin** and enter the
  package name `dsh-plugin-git-blame`, or run `dsh plugin add dsh-plugin-git-blame`.
- **From this repository (git)**: in the same dialog paste the repository URL, or
  run `dsh plugin add github:badpx/dsh-plugin-git-blame`.

### Discoverability (plugin market)

DSH does not crawl GitHub or npm on its own. Third-party plugins are surfaced by
the experimental **plugin market**: a *Discover* tab that reads **plugin market
index** JSON documents whose URLs you add in Settings. The index follows format 1
of `@deepseek-ai/dsh-plugin-market-index`; its `plugins[].versions[].source` is
either `{ "type": "npm" }` or a git entry pinned to a full 40-hex commit:

```json
{
  "format": 1,
  "title": { "en": "My DSH plugins" },
  "plugins": [
    {
      "name": "dsh-plugin-git-blame",
      "title": { "en": "Git Blame" },
      "description": { "en": "Inline git blame gutter and hover bubble in the file preview." },
      "repository": { "url": "https://github.com/badpx/dsh-plugin-git-blame" },
      "icon": "https://raw.githubusercontent.com/badpx/dsh-plugin-git-blame/main/icon.svg",
      "versions": [
        {
          "version": "0.1.0",
          "publishTimestamp": 1740000000,
          "source": {
            "type": "git",
            "url": "https://github.com/badpx/dsh-plugin-git-blame",
            "commit": "<40-hex-commit-sha>"
          }
        }
      ]
    }
  ]
}
```

Host the index over https and add that URL in the Discover/Settings UI. This
repository ships a ready-made [`market-index.json`](./market-index.json); add its
raw URL
`https://raw.githubusercontent.com/badpx/dsh-plugin-git-blame/main/market-index.json`
as an index source. After publishing to npm you can switch a version to
`"source": { "type": "npm" }` (the installer builds the exact `name@version`).
Git sources are commit-pinned, so refresh the `commit` on each release.

## How it works

- **Host** (`index.js`): registers `GET /plugin/git-blame?sessionId=&path=&line=`.
  It resolves the file against the Session's working directory, runs
  `git blame --line-porcelain -L <line>,<line> -- <file>`, and returns JSON.
  Only files inside the Session working directory are eligible.
- **Client** (`client.js`): registers one occupant of `shell.overlay`. A
  pointer-move listener detects when the pointer is over a line in
  `[data-code-preview]` or `[data-textpreview-plain]` inside the right sidebar,
  maps the hovered tab to its `dsh-resource://file/...` address, and asks the
  Host route for the blame of that line.

A toggle button in the preview header turns the inline blame column on or off and
remembers the choice. Both the toggle and the column only appear for files that
are **text and tracked by Git**; untracked or binary files show neither.

## Inline blame column

For the built-in highlighted code preview the plugin injects a fixed-width
gutter column just left of the line numbers. Each row shows `date + author`
(truncated with an ellipsis), and rows are tinted by commit SHA so the same
commit shares one colour. Hovering that column shows the blame bubble; hovering
the code lines themselves shows nothing.

A shortcut command **"显示/关闭 Git Blame 气泡"** is registered but left unbound;
assign it a key in Settings → Shortcuts, and the current keycaps appear in the
toggle's tooltip.

## Notes

- The preview is read-only, so the interaction uses the mouse pointer rather
  than a text caret.
- Hovering the blame gutter column shows the bubble immediately; leaving the
  column hides it immediately.
- The bubble follows just below the cursor. When there is not enough room near
  the bottom edge it flips above the cursor while keeping the same gap.
- The card is slightly translucent (opacity 0.85). After ~9 s without pointer
  movement it fades over 1 s to opacity 0.15 so it stops hiding the code below;
  any pointer movement restores it.
- The commit message is shown as a bold first-line title plus a normal body; the
  body is capped at 5 lines and ends with an ellipsis when truncated. When a
  commit has only a single-line message, that line wraps and uses the full
  5-line budget instead of being clamped to one line.
- Blame is shared per file+commit: consecutive rows belonging to the same commit
  reuse a single cache entry, so moving the pointer across them is instant and
  triggers no reload. Uncommitted rows keep per-line caching.

## Caching

- **Whole-file blame cache (`gutterCache`)**: an in-memory LRU keyed by
  `file address + snapshot version`, holding the parsed per-line array the gutter
  renders. Bounded by a **64 MB byte budget, at most 200 entries**, and a single
  file whose line data exceeds 16 MB is not cached; least-recently-used entries
  are evicted (no clear-all cliff). Concurrent reads of the same file+version are
  coalesced into one request, and the bubble reuses the mapping the sidebar already
  holds — so even a too-large-to-cache file never refetches blame per hover.
- **Client bubble cache**: a bounded LRU (2000 entries, 600 s TTL). For committed
  rows the key is `file address + commit SHA`, so every row of one commit shares
  a single entry and moving the pointer across those rows is instant (no reload).
  Uncommitted rows are keyed by `file address + content version + line`. The
  snapshot version is `HEAD + file size + mtime + ctime` from one safe open (reused
  for ~1 s), and the host confirms HEAD is unchanged across the read and blame, so
  switching branches or editing shifts each line to the right commit and stale
  blame is never served — without hashing whole files on every probe.
- **Host commit-message cache**: keyed by full commit SHA with a 500-entry LRU.
  Failures are never cached, so a transient `git show` error is retried.
- Files outside a Git repository, or lines that are not tracked, show a short
  explanatory message instead of a commit.
