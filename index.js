/**
 * Host half of the Git Blame on Hover plugin.
 *
 * It registers the HTTP routes the Web client calls while the pointer rests on a
 * source line inside the right-sidebar file preview. The routes resolve the
 * Session's working directory, run `git blame --line-porcelain`, then read the
 * commit message, and answer with small JSON describing the commit.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';

/** Route prefix; keep in sync with the Client half. */
const ROUTE_PATH = '/plugin/git-blame';

/** Services this plugin needs before it can activate. */
export const inject = ['webServer', 'sessions', 'workingDirectory', 'subprocess'];

/** Execution deadline for one git invocation. */
const GIT_TIMEOUT_MS = 8000;
/** Grace given after a termination signal before the process is killed hard. */
const GIT_KILL_GRACE_MS = 2000;

/** A full object name: SHA-1 (40) or SHA-256 (64) lowercase hex. */
const SHA_SOURCE = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const SHA_RE = new RegExp(`^${SHA_SOURCE}$`);
/** First porcelain line: `<sha> <orig-line> <final-line> [<num-lines>]`. */
const PORCELAIN_HEADER_RE = new RegExp(`^\\^?(${SHA_SOURCE}) \\d+ \\d+(?: \\d+)?$`);
/** One full-porcelain record header (final-line is captured for placement). */
const FULL_HEADER_RE = new RegExp(`^\\^?(${SHA_SOURCE})\\s+\\d+\\s+(\\d+)(?:\\s+\\d+)?\\s*$`);

/** Small cache of commit messages, keyed by full SHA. */
const MESSAGE_CACHE_LIMIT = 500;
const messageCache = new Map();

/** Maximum lines returned by the whole-file blame route. */
const MAX_BLAME_FILE_LINES = 50000;

/** File suffixes treated as non-text (binary, media, office, images). */
const NON_TEXT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tif', 'tiff', 'avif',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', '7z', 'rar',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'wasm', 'o', 'a',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
]);

/** Extension-based fast reject; unknown extensions are then inspected by content. */
function isTextExtension(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return !NON_TEXT_EXTENSIONS.has(ext);
}

/**
 * Decide whether a file looks like text: reject known-binary extensions, then
 * scan the first 8 KiB for NUL bytes / a high share of control bytes. This
 * catches binary files with a text-looking extension (e.g. a `.dat` with NULs).
 * @returns {Promise<boolean>}
 */
async function isProbablyText(absolutePath) {
  if (!isTextExtension(absolutePath)) return false;
  let handle;
  try {
    handle = await fsp.open(absolutePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) return false;
    let control = 0;
    for (const byte of slice) {
      if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
    }
    return bytesRead === 0 || control / bytesRead < 0.3;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Resolve the requested path against the Session's working directory, refusing
 * strings that escape it. Symlink/real-path checks happen separately.
 * @returns {string | undefined}
 */
function resolveFile(cwd, requestedPath) {
  const root = path.resolve(cwd);
  const absolute = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(root, requestedPath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return undefined;
  return absolute;
}

/**
 * Ensure the resolved file is a regular, non-symlink file whose real path stays
 * inside the Session working directory. Prevents a tracked symlink from reading
 * a file outside the session.
 * @returns {Promise<boolean>}
 */
async function isSafeRealFile(cwd, absolutePath) {
  try {
    const stats = await fsp.lstat(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    const real = await fsp.realpath(absolutePath);
    const root = await fsp.realpath(path.resolve(cwd));
    return real === root || real.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

/**
 * Run one managed git command and collect its output.
 * @returns {Promise<{ ok: boolean, exitCode?: number | null, stdout: string, stderr: string,
 *   stdoutLossy: boolean, stderrLossy: boolean, timedOut: boolean, message?: string }>}
 */
async function runGit(ctx, cwd, argv, options = {}) {
  const maxStdoutBytes = options.maxStdoutBytes ?? 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let timedOut = false;
  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: maxStdoutBytes },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: GIT_KILL_GRACE_MS,
      signal,
    });
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', stdoutLossy: false, stderrLossy: false, timedOut, message: String((error && error.message) || error) };
  }

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (handle && typeof handle.terminate === 'function') handle.terminate();
    } catch {
      /* ignore */
    }
    controller.abort();
  }, timeoutMs);

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, stdout: '', stderr: '', stdoutLossy: false, stderrLossy: false, timedOut, message: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }

  const outRead = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0) : undefined;
  const errRead = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0) : undefined;
  return {
    ok: outcome.exitCode === 0 && !timedOut,
    exitCode: outcome.exitCode,
    stdout: outRead ? outRead.text : '',
    stderr: errRead ? errRead.text : '',
    stdoutLossy: Boolean(outRead && outRead.lossy),
    stderrLossy: Boolean(errRead && errRead.lossy),
    timedOut,
  };
}

/**
 * Touch-on-read LRU get for the commit-message cache.
 * @returns {string | undefined}
 */
function messageGet(sha) {
  if (!messageCache.has(sha)) return undefined;
  const value = messageCache.get(sha);
  messageCache.delete(sha);
  messageCache.set(sha, value);
  return value;
}

/** Insert into the commit-message cache, evicting the least-recently-used entry. */
function messageSet(sha, message) {
  if (messageCache.has(sha)) {
    messageCache.delete(sha);
  } else if (messageCache.size >= MESSAGE_CACHE_LIMIT) {
    const oldest = messageCache.keys().next();
    if (!oldest.done) messageCache.delete(oldest.value);
  }
  messageCache.set(sha, message);
}

/**
 * Read one commit's full message (`%B`), cached by SHA. Failures are not cached.
 * The SHA is validated and passed after `--end-of-options`, so a crafted value
 * can never be interpreted as a git option.
 * @returns {Promise<string>}
 */
async function commitMessage(ctx, cwd, sha, options = {}) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return '';
  const cached = messageGet(sha);
  if (cached !== undefined) return cached;
  const result = await runGit(
    ctx,
    cwd,
    ['git', '-C', cwd, 'show', '-s', '--format=%B', '--end-of-options', sha],
    { signal: options.signal, maxStdoutBytes: 256 * 1024 },
  );
  if (!result.ok || result.stdoutLossy) return '';
  const message = result.stdout.replace(/\s+$/, '');
  messageSet(sha, message);
  return message;
}

/**
 * Content version of a working-tree file. Combines the current HEAD commit with
 * the file's Git blob hash so that BOTH a branch switch (same bytes, different
 * history) and an edit (different bytes) change the version and invalidate blame.
 * @returns {Promise<string>}
 */
async function fileVersion(ctx, cwd, absolutePath, options = {}) {
  const signal = options.signal;
  const [blobResult, headResult] = await Promise.all([
    runGit(ctx, cwd, ['git', '-C', cwd, 'hash-object', '--', absolutePath], { signal, maxStdoutBytes: 4096 }),
    runGit(ctx, cwd, ['git', '-C', cwd, 'rev-parse', '--verify', 'HEAD'], { signal, maxStdoutBytes: 4096 }),
  ]);
  const blob = blobResult.ok && !blobResult.stdoutLossy ? blobResult.stdout.trim() : '';
  const head = headResult.ok && !headResult.stdoutLossy ? headResult.stdout.trim() : '';
  return `${head}:${blob}`;
}

/**
 * Split a commit message into its first-line title and remaining body.
 * @returns {{ title: string, body: string }}
 */
function splitMessage(message, fallbackTitle) {
  const text = (message || '').trim();
  if (text === '') return { title: fallbackTitle || '', body: '' };
  const newline = text.indexOf('\n');
  if (newline === -1) return { title: text, body: '' };
  return { title: text.slice(0, newline).trim(), body: text.slice(newline + 1).trim() };
}

/**
 * Parse `git blame --line-porcelain` output for a single line. The header is
 * validated strictly (40/64-hex SHA only); anything else is a parse failure, so
 * truncated or crafted output never yields a value that reaches `git show`.
 * @returns {Record<string, unknown>}
 */
function parsePorcelain(text) {
  const newline = text.indexOf('\n');
  const header = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (header === '') return { ok: false, code: 'parse-failed', message: 'git blame returned no output' };
  const match = PORCELAIN_HEADER_RE.exec(header);
  if (!match) return { ok: false, code: 'parse-failed', message: 'git blame returned an unexpected header' };
  const sha = match[1];
  const uncommitted = /^0+$/.test(sha);

  const info = {
    ok: true,
    sha,
    shortSha: sha.slice(0, 8),
    author: '',
    authorMail: '',
    time: 0,
    date: '',
    summary: '',
    filename: '',
    uncommitted,
  };

  for (const raw of text.split('\n').slice(1)) {
    if (raw.startsWith('\t')) break;
    const space = raw.indexOf(' ');
    if (space < 0) continue;
    const key = raw.slice(0, space);
    const value = raw.slice(space + 1);
    if (key === 'author') info.author = value;
    else if (key === 'author-mail') info.authorMail = value.replace(/^</, '').replace(/>$/, '');
    else if (key === 'author-time') info.time = Number(value) || 0;
    else if (key === 'summary') info.summary = value;
    else if (key === 'filename') info.filename = value;
  }

  if (info.time > 0) {
    const d = new Date(info.time * 1000);
    if (!Number.isNaN(d.getTime())) info.date = d.toISOString().slice(0, 10);
  }
  return info;
}

/**
 * Parse full `git blame --line-porcelain` output into one entry per source line.
 * Accepts SHA-1 and SHA-256 object ids.
 * @returns {{ lines: Array<Record<string, unknown> | null>, parsedCount: number }}
 */
function parseFullPorcelain(text) {
  const out = [];
  let current;
  let parsedCount = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('\t')) {
      if (current !== undefined) {
        out[current.finalLine - 1] = current.record;
        parsedCount += 1;
        current = undefined;
      }
      continue;
    }
    const headerMatch = FULL_HEADER_RE.exec(raw);
    if (headerMatch) {
      const sha = headerMatch[1];
      current = {
        finalLine: Number(headerMatch[2]),
        record: {
          sha,
          shortSha: sha.slice(0, 8),
          author: '',
          date: '',
          uncommitted: /^0+$/.test(sha),
        },
      };
      continue;
    }
    if (current !== undefined && raw !== '') {
      const space = raw.indexOf(' ');
      if (space < 0) continue;
      const key = raw.slice(0, space);
      const value = raw.slice(space + 1);
      if (key === 'author') current.record.author = value;
      else if (key === 'author-time') {
        const time = Number(value);
        if (time > 0) {
          const d = new Date(time * 1000);
          if (!Number.isNaN(d.getTime())) current.record.date = d.toISOString().slice(0, 10);
        }
      }
    }
  }
  const lines = [];
  for (let i = 0; i < out.length; i += 1) lines.push(out[i] === undefined ? null : out[i]);
  return { lines, parsedCount };
}

/**
 * Blame the whole file, returning a per-line array of commit summaries.
 * @returns {Promise<Record<string, unknown>>}
 */
async function blameFile(ctx, cwd, absolutePath, options = {}) {
  const result = await runGit(
    ctx,
    cwd,
    ['git', '-C', cwd, 'blame', '--line-porcelain', '--', absolutePath],
    { signal: options.signal, maxStdoutBytes: 32 * 1024 * 1024 },
  );
  if (result.exitCode === undefined) {
    return { ok: false, code: 'spawn-failed', message: result.message };
  }
  if (result.timedOut) return { ok: false, code: 'timeout', message: 'git blame timed out' };
  if (result.stdoutLossy) {
    return { ok: false, code: 'truncated', message: 'git blame output exceeded the size limit' };
  }
  if (!result.ok) {
    const message = result.stderr.trim() || result.stdout.trim() || 'git blame failed';
    if (/not a git repository/i.test(message)) {
      return { ok: false, code: 'not-repo', message: 'This file is not inside a Git repository' };
    }
    if (/no such path|does not exist in/i.test(message)) {
      return { ok: false, code: 'not-tracked', message: 'File is not tracked by Git' };
    }
    return { ok: false, code: 'git-failed', message: message.split('\n')[0] };
  }
  const parsed = parseFullPorcelain(result.stdout);
  if (parsed.parsedCount === 0 && result.stdout.trim() !== '') {
    return { ok: false, code: 'parse-failed', message: 'git blame returned an unexpected output' };
  }
  if (parsed.lines.length > MAX_BLAME_FILE_LINES) {
    return { ok: false, code: 'too-large', message: 'File is too large for inline blame' };
  }
  return { ok: true, lines: parsed.lines };
}

/**
 * Run git blame for one line, then attach the commit message title/body.
 * @returns {Promise<Record<string, unknown>>}
 */
async function blameLine(ctx, cwd, absolutePath, line, options = {}) {
  const result = await runGit(
    ctx,
    cwd,
    ['git', '-C', cwd, 'blame', '--line-porcelain', '-L', `${line},${line}`, '--', absolutePath],
    { signal: options.signal },
  );

  if (result.exitCode === undefined) {
    return { ok: false, code: 'spawn-failed', message: result.message };
  }
  if (result.timedOut) return { ok: false, code: 'timeout', message: 'git blame timed out' };
  if (result.stdoutLossy) {
    return { ok: false, code: 'truncated', message: 'git blame output exceeded the size limit' };
  }
  if (!result.ok) {
    const message = result.stderr.trim() || result.stdout.trim() || 'git blame failed';
    if (/not a git repository/i.test(message)) {
      return { ok: false, code: 'not-repo', message: 'This file is not inside a Git repository' };
    }
    if (/no such path|does not exist in|has only \d+ lines?/i.test(message)) {
      return { ok: false, code: 'not-tracked', message: 'File is not tracked by Git or the line does not exist' };
    }
    return { ok: false, code: 'git-failed', message: message.split('\n')[0] };
  }

  const info = parsePorcelain(result.stdout);
  if (!info.ok) return info;

  if (info.uncommitted) {
    info.author = info.author || 'Uncommitted change';
    info.message = '';
    info.title = 'Uncommitted change';
    info.body = 'Working tree changes not yet committed';
    return info;
  }

  info.message = await commitMessage(ctx, cwd, info.sha, { signal: options.signal });
  const split = splitMessage(info.message, info.summary);
  info.title = split.title;
  info.body = split.body;
  return info;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleRequest(ctx, req, res) {
  const requestController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) requestController.abort();
  });
  const signal = requestController.signal;

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const filePath = url.searchParams.get('path');
    const isStatusRequest = url.pathname.replace(/\/+$/, '') === '/plugin/git-blame/status';
    const isFileRequest = url.pathname.replace(/\/+$/, '') === '/plugin/git-blame/file';

    if (!sessionId || !filePath) {
      sendJson(res, 400, { ok: false, message: 'Missing sessionId/path' });
      return;
    }

    const session = ctx.sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { ok: false, message: 'Unknown session' });
      return;
    }

    const cwd = ctx.workingDirectory.get(session);
    const absolutePath = resolveFile(cwd, filePath);
    if (!absolutePath) {
      sendJson(res, 403, { ok: false, message: 'Path is outside the session working directory' });
      return;
    }

    if (!(await isSafeRealFile(cwd, absolutePath))) {
      if (isStatusRequest) {
        // Not eligible (symlink/non-regular/missing): answer a settled "no" so the
        // client stops polling instead of retrying forever.
        sendJson(res, 200, { ok: true, tracked: false, text: false, version: '' });
      } else {
        sendJson(res, 403, { ok: false, message: 'File is not a regular file inside the session directory' });
      }
      return;
    }

    if (isStatusRequest) {
      const relative = path.relative(cwd, absolutePath) || path.basename(absolutePath);
      const trackedResult = await runGit(ctx, cwd, ['git', '-C', cwd, 'ls-files', '--error-unmatch', '--', relative], { signal });
      const tracked = trackedResult.ok;
      const text = await isProbablyText(absolutePath);
      const version = tracked ? await fileVersion(ctx, cwd, absolutePath, { signal }) : '';
      sendJson(res, 200, { ok: true, tracked, text, version });
      return;
    }

    if (isFileRequest) {
      const fileResult = await blameFile(ctx, cwd, absolutePath, { signal });
      sendJson(res, 200, fileResult);
      return;
    }

    const line = Number(url.searchParams.get('line'));
    if (!Number.isInteger(line) || line < 1) {
      sendJson(res, 400, { ok: false, message: 'Missing or invalid line' });
      return;
    }

    const providedVersion = url.searchParams.get('version') || '';
    const result = await blameLine(ctx, cwd, absolutePath, line, { signal });
    if (result.ok) {
      result.version = providedVersion || await fileVersion(ctx, cwd, absolutePath, { signal });
    }
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, message: String((error && error.message) || error) });
  }
}

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: (req, res) => handleRequest(ctx, req, res),
    }),
  );
}

// Internals exported for regression tests. The plugin loader only uses `inject`
// and `apply`; extra named exports are inert.
export {
  runGit,
  resolveFile,
  isSafeRealFile,
  isProbablyText,
  fileVersion,
  commitMessage,
  parsePorcelain,
  parseFullPorcelain,
  blameFile,
  blameLine,
  splitMessage,
};
