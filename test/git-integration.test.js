import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileVersion, blameFile, commitMessage, isSafeRealFile, isProbablyText } from '../index.js';
import { makeCtx, git } from '../helpers.mjs';

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Tester']);
  return dir;
}

test('fileVersion changes when HEAD advances, even if the file bytes are identical (P1-2)', async () => {
  const dir = await makeRepo();
  const ctx = makeCtx({ cwd: dir });
  try {
    const target = path.join(dir, 'target.txt');
    const other = path.join(dir, 'other.txt');
    await writeFile(target, 'hello\n');
    await writeFile(other, 'one\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    const v1 = await fileVersion(ctx, dir, target);

    await writeFile(other, 'two\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c2']);
    const v2 = await fileVersion(ctx, dir, target);

    const [head1, blob1] = v1.split(':');
    const [head2, blob2] = v2.split(':');
    assert.equal(blob1, blob2, 'same content => same blob hash');
    assert.notEqual(head1, head2, 'different HEAD => different snapshot');
    assert.notEqual(v1, v2, 'version must change across commits');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('commitMessage passes the revision after --end-of-options (P1-1)', async () => {
  const dir = await makeRepo();
  const ctx = makeCtx({ cwd: dir });
  try {
    await writeFile(path.join(dir, 'f.txt'), 'x\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'Subject', '-m', 'Body text']);
    const sha = git(dir, ['rev-parse', 'HEAD']).trim();
    const message = await commitMessage(ctx, dir, sha);
    assert.match(message, /Subject/);
    const showCall = ctx.calls.find((call) => call.argv.includes('show'));
    assert.ok(showCall, 'git show was invoked');
    const idx = showCall.argv.indexOf('--end-of-options');
    assert.ok(idx >= 0, '--end-of-options present');
    assert.equal(showCall.argv[idx + 1], sha);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('blameFile parses SHA-256 repositories instead of returning an empty success (P2-6)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb256-'));
  try {
    const init = await import('node:child_process').then(({ spawnSync }) =>
      spawnSync('git', ['init', '-q', '--object-format=sha256'], { cwd: dir, encoding: 'utf8' }));
    if (init.status !== 0) {
      t.skip('git does not support --object-format=sha256');
      return;
    }
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'Tester']);
    await writeFile(path.join(dir, 'f.txt'), 'alpha\nbeta\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'c1']);
    const ctx = makeCtx({ cwd: dir });
    const result = await blameFile(ctx, dir, path.join(dir, 'f.txt'));
    assert.equal(result.ok, true);
    assert.equal(result.lines.length, 2);
    assert.match(result.lines[0].sha, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isSafeRealFile rejects a symlink that escapes the session directory (P1-3)', async () => {
  const dir = await makeRepo();
  const outside = await mkdtemp(path.join(tmpdir(), 'gb-out-'));
  try {
    await writeFile(path.join(dir, 'regular.txt'), 'ok\n');
    await writeFile(path.join(outside, 'secret.txt'), 'SECRET\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    assert.equal(await isSafeRealFile(dir, path.join(dir, 'regular.txt')), true);
    assert.equal(await isSafeRealFile(dir, path.join(dir, 'link.txt')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('isProbablyText rejects NUL bytes even with a text-looking extension (P2-7)', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(path.join(dir, 'blob.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));
    await writeFile(path.join(dir, 'plain.dat'), 'just text\n');
    assert.equal(await isProbablyText(path.join(dir, 'blob.dat')), false);
    assert.equal(await isProbablyText(path.join(dir, 'plain.dat')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
