/**
 * Host half of the Git Blame on Hover plugin.
 *
 * It registers one HTTP route the Web client calls while the pointer rests on a
 * source line inside the right-sidebar file preview. The route resolves the
 * Session's working directory, runs `git blame --line-porcelain` for exactly
 * that line, and answers with small JSON describing the commit.
 */
import path from 'node:path';

/** Route prefix; keep in sync with the Client half. */
const ROUTE_PATH = '/plugin/git-blame';

/** Services this plugin needs before it can activate. */
export const inject = ['webServer', 'sessions', 'workingDirectory', 'subprocess'];

/** Bound every git invocation so a stuck repository cannot pin a request. */
const GIT_TIMEOUT_MS = 8000;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ status: number, body: unknown }} reply
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
  if (uncommitted) {
    info.author = info.author || 'Uncommitted change';
    info.summary = info.summary || 'Working tree changes not yet committed';
  }
  return info;
}

/**
 * Run git blame for one line and return its parsed or failed outcome.
 * @returns {Promise<Record<string, unknown>>}
 */
async function blameLine(ctx, cwd, absolutePath, line) {
  const argv = [
    'git', '-C', cwd,
    'blame', '--line-porcelain', '-L', `${line},${line}`, '--', absolutePath,
  ];

  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: GIT_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, code: 'spawn-failed', message: String((error && error.message) || error) };
  }

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    return { ok: false, code: 'git-failed', message: String((error && error.message) || error) };
  }

  const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '';
  const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '';

  if (outcome.exitCode !== 0) {
    const message = stderr.trim() || stdout.trim() || 'git blame failed';
    if (/not a git repository/i.test(message)) {
      return { ok: false, code: 'not-repo', message: 'This file is not inside a Git repository' };
    }
    if (/no such path|does not exist in|has only \d+ lines?/i.test(message)) {
      return { ok: false, code: 'not-tracked', message: 'File is not tracked by Git or the line does not exist' };
    }
    return { ok: false, code: 'git-failed', message: message.split('\n')[0] };
  }

  return parsePorcelain(stdout);
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
    const line = Number(url.searchParams.get('line'));

    if (!sessionId || !filePath || !Number.isInteger(line) || line < 1) {
      sendJson(res, 400, { ok: false, message: 'Missing or invalid sessionId/path/line' });
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

    const result = await blameLine(ctx, ctx.workingDirectory.get(session), absolutePath, line);
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
