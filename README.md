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

## Notes

- The preview is read-only, so the interaction uses the mouse pointer rather
  than a text caret.
- Rest on a line for ~0.5 s and the bubble appears. Once shown it stays while
  the pointer remains inside the right-sidebar column (it follows onto other
  lines), and disappears ~0.5 s after the pointer leaves that column.
- The card is slightly translucent (opacity 0.94) so the code underneath stays
  readable.
- The commit message is shown as a bold first-line title plus a normal body; the
  body is capped at 5 lines and ends with an ellipsis when truncated.
- Results are cached per file+line for the lifetime of the page.

## Caching

- **Client blame cache**: a bounded LRU (2000 entries, 600 s TTL) keyed by
  `file address + content version + line`. Each entry is re-validated by a cheap
  file-version probe (Git blob hash, itself reused for ~1 s), so editing or
  committing a file invalidates its lines instead of serving stale blame.
- **Host commit-message cache**: keyed by full commit SHA with a 500-entry LRU.
  Failures are never cached, so a transient `git show` error is retried.
- Files outside a Git repository, or lines that are not tracked, show a short
  explanatory message instead of a commit.
