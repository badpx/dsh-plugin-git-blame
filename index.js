/**
 * Host half of the Git Blame on Hover plugin.
 *
 * It registers one HTTP route the Web client calls while the pointer rests on a
 * source line inside the right-sidebar file preview. The route resolves the
 * Session's working directory, runs `git blame --line-porcelain` for exactly
 * that line, then reads the full commit message, and answers with small JSON
 * describing the commit.
 */
import path from 'node:path';

/** Route prefix; keep in sync with the Client half. */
const ROUTE_PATH = '/plugin/git-blame';

/** Services this plugin needs before it can activate. */
export const inject = ['webServer', 'sessions', 'workingDirectory', 'subprocess'];

/** Bound every git invocation so a stuck repository cannot pin a request. */
const GIT_TIMEOUT_MS = 8000;

/** Small cache of commit messages, keyed by full SHA. */
const MESSAGE_CACHE_LIMIT = 500;
const messageCache = new Map();

/** File suffixes treated as non-text (binary, media, office, images). */
const NON_TEXT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tif', 'tiff', 'avif',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', '7z', 'rar',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'wasm', 'o', 'a',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
]);

/** Extension-based text check; unknown extensions count as text (the preview does the same). */
function isTextPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return !NON_TEXT_EXTENSIONS.has(ext);
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
 * Resolve the absolute file path for one Session, refusing paths that escape
 * the Session's working directory.
 * @returns {string | undefined}
 */
function resolveFile(ctx, session, requestedPath) {
  const cwd = ctx.workingDirectory.get(session);
  const absolute = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(cwd, requestedPath);
  const root = path.resolve(cwd);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return undefined;
  return absolute;
}

/**
 * Run one managed git command and collect its output.
 * @returns {Promise<{ ok: boolean, exitCode?: number | null, stdout: string, stderr: string, message?: string }>}
 */
async function runGit(ctx, cwd, argv, maxStdoutBytes = 1024 * 1024) {
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
      graceMs: GIT_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', message: String((error && error.message) || error) };
  }

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', message: String((error && error.message) || error) };
  }

  return {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    stdout: handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '',
    stderr: handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '',
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
 * @returns {Promise<string>}
 */
async function commitMessage(ctx, cwd, sha) {
  const cached = messageGet(sha);
  if (cached !== undefined) return cached;
  const result = await runGit(ctx, cwd, ['git', '-C', cwd, 'show', '-s', '--format=%B', sha]);
  if (!result.ok) return '';
  const message = result.stdout.replace(/\s+$/, '');
  messageSet(sha, message);
  return message;
}

/**
 * Content version of a working-tree file: its Git blob hash. Changes whenever
 * the file's bytes change (committed or not), so it invalidates stale blame.
 * @returns {Promise<string>}
 */
async function fileVersion(ctx, cwd, absolutePath) {
  const result = await runGit(ctx, cwd, ['git', '-C', cwd, 'hash-object', '--', absolutePath]);
  return result.ok ? result.stdout.trim() : '';
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
 * Parse `git blame --line-porcelain` output for a single line.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parsePorcelain(text) {
  const header = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n')).trim();
  if (header === '') return { ok: false, message: 'git blame returned no output' };
  const sha = header.split(/\s+/)[0];
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
 * @returns {Array<Record<string, unknown> | null>}
 */
function parseFullPorcelain(text) {
  const out = [];
  let current;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('\t')) {
      if (current !== undefined) {
        out[current.finalLine - 1] = current.record;
        current = undefined;
      }
      continue;
    }
    const headerMatch = /^\^?([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?\s*$/.exec(raw);
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
  const result = [];
  for (let i = 0; i < out.length; i += 1) result.push(out[i] === undefined ? null : out[i]);
  return result;
}

/**
 * Blame the whole file, returning a per-line array of commit summaries.
 * @returns {Promise<Record<string, unknown>>}
 */
async function blameFile(ctx, cwd, absolutePath) {
  const result = await runGit(ctx, cwd, ['git', '-C', cwd, 'blame', '--line-porcelain', '--', absolutePath], 32 * 1024 * 1024);
  if (result.exitCode === undefined) {
    return { ok: false, code: 'spawn-failed', message: result.message };
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
  const lines = parseFullPorcelain(result.stdout);
  if (lines.length > 50000) return { ok: false, code: 'too-large', message: 'File is too large for inline blame' };
  return { ok: true, lines };
}

/**
 * Run git blame for one line, then attach the commit message title/body.
 * @returns {Promise<Record<string, unknown>>}
 */
async function blameLine(ctx, cwd, absolutePath, line) {
  const result = await runGit(ctx, cwd, [
    'git', '-C', cwd,
    'blame', '--line-porcelain', '-L', `${line},${line}`, '--', absolutePath,
  ]);

  if (result.exitCode === undefined) {
    return { ok: false, code: 'spawn-failed', message: result.message };
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

  info.message = await commitMessage(ctx, cwd, info.sha);
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

    const absolutePath = resolveFile(ctx, session, filePath);
    if (!absolutePath) {
      sendJson(res, 403, { ok: false, message: 'Path is outside the session working directory' });
      return;
    }

    const cwd = ctx.workingDirectory.get(session);

    if (isStatusRequest) {
      const relative = path.relative(cwd, absolutePath) || path.basename(absolutePath);
      const trackedResult = await runGit(ctx, cwd, ['git', '-C', cwd, 'ls-files', '--error-unmatch', '--', relative]);
      const tracked = trackedResult.ok;
      const text = isTextPath(absolutePath);
      const version = tracked ? await fileVersion(ctx, cwd, absolutePath) : '';
      sendJson(res, 200, { ok: true, tracked, text, version });
      return;
    }

    if (isFileRequest) {
      const fileResult = await blameFile(ctx, cwd, absolutePath);
      sendJson(res, 200, fileResult);
      return;
    }

    const line = Number(url.searchParams.get('line'));
    if (!Number.isInteger(line) || line < 1) {
      sendJson(res, 400, { ok: false, message: 'Missing or invalid line' });
      return;
    }

    const providedVersion = url.searchParams.get('version') || '';
    const result = await blameLine(ctx, cwd, absolutePath, line);
    if (result.ok) {
      result.version = providedVersion || await fileVersion(ctx, cwd, absolutePath);
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
