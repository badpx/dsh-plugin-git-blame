import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { unlinkSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSafeFile, contentHash, blameFile, handleRequest } from '../index.js';
import { makeCtx, git } from '../helpers.mjs';

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-sec-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Tester']);
  return dir;
}

function sha(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function fakeRes() {
  return {
    writableEnded: false,
    on() {},
    writeHead() {},
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  };
}

async function callRoute(ctx, url) {
  const req = { url, on() {} };
  const res = fakeRes();
  await handleRequest(ctx, req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('readSafeFile classifies text cheaply and reads bytes only on demand (P1-3)', async () => {
  const dir = await makeRepo();
  try {
    const file = path.join(dir, 'f.txt');
    await writeFile(file, 'hello\n');
    const metaOnly = await readSafeFile(dir, file);
    assert.equal(metaOnly.ok, true);
    assert.equal(metaOnly.text, true);
    assert.equal(metaOnly.buffer, undefined, 'status path must not read the whole file');
    assert.equal(metaOnly.size, 6);

    const withBytes = await readSafeFile(dir, file, { readContents: true });
    assert.equal(contentHash(withBytes.buffer), sha('hello\n'));
    assert.equal(withBytes.buffer.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readSafeFile rejects a symlink outright (P1-3)', async () => {
  const dir = await makeRepo();
  const outside = await mkdtemp(path.join(tmpdir(), 'gb-sec-out-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'SECRET\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    const safe = await readSafeFile(dir, path.join(dir, 'link.txt'));
    assert.equal(safe.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('status hashes the safely-opened file even if the path is swapped to a symlink mid-request (P1-3)', async () => {
  const dir = await makeRepo();
  const outside = await mkdtemp(path.join(tmpdir(), 'gb-sec-out-'));
  try {
    const file = path.join(dir, 'f.txt');
    const secret = 'TOP-SECRET-CONTENT\n';
    const original = 'public content\n';
    await writeFile(file, original);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    const originalStat = await stat(file, { bigint: true });
    await writeFile(path.join(outside, 'secret.txt'), secret);
    const secretStat = await stat(path.join(outside, 'secret.txt'), { bigint: true });

    // Swap the path to an out-of-session symlink right as git runs ls-files,
    // i.e. after readSafeFile already captured the opened file's metadata/bytes.
    const ctx = makeCtx({
      cwd: dir,
      overrides: (spec) => {
        if (spec.argv.includes('ls-files')) {
          try {
            unlinkSync(file);
            symlinkSync(path.join(outside, 'secret.txt'), file);
          } catch {
            /* ignore */
          }
        }
        return undefined;
      },
    });

    const { body } = await callRoute(ctx, '/plugin/git-blame/status?sessionId=s&path=f.txt');
    assert.equal(body.ok, true);
    assert.equal(body.tracked, true);
    const parts = body.version.split(':');
    assert.equal(parts[1], String(originalStat.size), 'size must be of the opened original file');
    assert.equal(parts[2], String(originalStat.mtimeNs), 'mtime must be of the opened original file');
    assert.equal(parts[3], String(originalStat.ctimeNs), 'ctime must be of the opened original file');
    const secretFingerprint = `${secretStat.size}:${secretStat.mtimeNs}:${secretStat.ctimeNs}`;
    assert.notEqual(`${parts[1]}:${parts[2]}:${parts[3]}`, secretFingerprint, 'must not describe the swapped-in secret');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('blameFile feeds git --contents from the safe bytes instead of the path (P1-3)', async () => {
  const dir = await makeRepo();
  try {
    const file = path.join(dir, 'f.txt');
    await writeFile(file, 'alpha\nbeta\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    const ctx = makeCtx({ cwd: dir });
    const result = await blameFile(ctx, dir, file, { contentsBuffer: Buffer.from('alpha\nbeta\n') });
    assert.equal(result.ok, true);
    assert.equal(result.lines.length, 2);
    const blameCall = ctx.calls.find((call) => call.argv.includes('blame'));
    const idx = blameCall.argv.indexOf('--contents');
    assert.ok(idx >= 0, 'git blame must use --contents');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the /file response reports the version it actually blamed, not the requested one (P1-2)', async () => {
  const dir = await makeRepo();
  try {
    const file = path.join(dir, 'f.txt');
    await writeFile(file, 'a\nb\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    const ctx = makeCtx({ cwd: dir });
    const status = await callRoute(ctx, '/plugin/git-blame/status?sessionId=s&path=f.txt');
    const fileRes = await callRoute(ctx, '/plugin/git-blame/file?sessionId=s&path=f.txt&version=BOGUS');
    assert.equal(fileRes.body.ok, true);
    assert.equal(fileRes.body.lines.length, 2);
    assert.notEqual(fileRes.body.version, 'BOGUS');
    assert.equal(fileRes.body.version, status.body.version);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the line route reports the actual version, not the requested one (P1-2)', async () => {
  const dir = await makeRepo();
  try {
    const file = path.join(dir, 'f.txt');
    await writeFile(file, 'only line\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    const ctx = makeCtx({ cwd: dir });
    const status = await callRoute(ctx, '/plugin/git-blame/status?sessionId=s&path=f.txt');
    const lineRes = await callRoute(ctx, '/plugin/git-blame?sessionId=s&path=f.txt&line=1&version=BOGUS');
    assert.equal(lineRes.body.ok, true);
    assert.notEqual(lineRes.body.version, 'BOGUS');
    assert.equal(lineRes.body.version, status.body.version);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readSafeFile rejects a FIFO without blocking (P1-3)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('mkfifo is POSIX-only');
    return;
  }
  const dir = await makeRepo();
  try {
    const fifo = path.join(dir, 'pipe');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) {
      t.skip('mkfifo unavailable');
      return;
    }
    const result = await Promise.race([
      readSafeFile(dir, fifo),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000)),
    ]);
    assert.equal(result.timeout, undefined, 'must not block on a FIFO');
    assert.equal(result.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
