import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { unlinkSync, symlinkSync } from 'node:fs';
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

test('readSafeFile reads a regular file and fingerprints exactly its bytes (P1-3)', async () => {
  const dir = await makeRepo();
  try {
    const file = path.join(dir, 'f.txt');
    await writeFile(file, 'hello\n');
    const safe = await readSafeFile(dir, file);
    assert.equal(safe.ok, true);
    assert.equal(safe.text, true);
    assert.equal(contentHash(safe.buffer), sha('hello\n'));
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
    await writeFile(path.join(outside, 'secret.txt'), secret);

    // Swap the path to an out-of-session symlink right as git runs ls-files,
    // i.e. after readSafeFile already captured the bytes.
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
    const fingerprint = body.version.split(':')[1];
    assert.equal(fingerprint, sha(original), 'fingerprint must be of the original safe bytes');
    assert.notEqual(fingerprint, sha(secret), 'must not fingerprint the swapped-in secret');
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
