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
- Results are cached per file+line for the lifetime of the page.
- Files outside a Git repository, or lines that are not tracked, show a short
  explanatory message instead of a commit.
