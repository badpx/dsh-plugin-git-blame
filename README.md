# Git Blame on Hover

A DeepSeek Harness plugin. When a text or source file is opened in the right
sidebar's file preview, hovering a line shows a small card with that line's
`git blame` information (author, short commit hash, date, and commit summary).

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
- Rest on a line for ~0.5 s and the bubble appears. Once shown it stays while
  the pointer remains inside the right-sidebar column (it follows onto other
  lines), and disappears ~0.5 s after the pointer leaves that column.
- The card is slightly translucent (opacity 0.85). After ~9 s without pointer
  movement it fades over 1 s to opacity 0.15 so it stops hiding the code below;
  any pointer movement restores it.
- The commit message is shown as a bold first-line title plus a normal body; the
  body is capped at 5 lines and ends with an ellipsis when truncated.
- Blame is shared per file+commit: consecutive rows belonging to the same commit
  reuse a single cache entry, so moving the pointer across them is instant and
  triggers no reload. Uncommitted rows keep per-line caching.

## Caching

- **Client blame cache**: a bounded LRU (2000 entries, 600 s TTL). For committed
  rows the key is `file address + commit SHA`, so every row of one commit shares
  a single entry and moving the pointer across those rows is instant (no reload).
  Uncommitted rows are keyed by `file address + content version + line`. A cheap
  file-version probe (Git blob hash, reused for ~1 s) still runs per hover, so
  switching branches or editing shifts each line to the right commit and stale
  blame is never served.
- **Host commit-message cache**: keyed by full commit SHA with a 500-entry LRU.
  Failures are never cached, so a transient `git show` error is retried.
- Files outside a Git repository, or lines that are not tracked, show a short
  explanatory message instead of a commit.
