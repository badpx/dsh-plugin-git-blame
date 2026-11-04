import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGit, blameLine, commitMessage } from '../index.js';
import { makeCtx, fakeHandle } from '../helpers.mjs';

const PWNED_HEADER = '--output=/tmp/pwned 1 1 1\n';

test('runGit reports a lossy (truncated) read', async () => {
  const ctx = makeCtx({ overrides: () => fakeHandle({ stdout: PWNED_HEADER, lossy: true }) });
  const result = await runGit(ctx, process.cwd(), ['git', 'blame', 'x']);
  assert.equal(result.stdoutLossy, true);
});

test('truncated single-line output is refused and never reaches git show (P1-1)', async () => {
  const ctx = makeCtx({
    overrides: (spec) => (spec.argv.includes('blame')
      ? fakeHandle({ stdout: PWNED_HEADER, lossy: true })
      : fakeHandle({ stdout: '' })),
  });
  const result = await blameLine(ctx, process.cwd(), '/tmp/whatever', 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'truncated');
  assert.equal(ctx.calls.some((call) => call.argv.includes('show')), false);
});

test('an option-like first token is a parse error, not a SHA (P1-1)', async () => {
  const ctx = makeCtx({
    overrides: (spec) => (spec.argv.includes('blame')
      ? fakeHandle({ stdout: `${PWNED_HEADER}author Evil\n\tx\n`, lossy: false })
      : fakeHandle({ stdout: '' })),
  });
  const result = await blameLine(ctx, process.cwd(), '/tmp/whatever', 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'parse-failed');
  assert.equal(ctx.calls.some((call) => call.argv.includes('show')), false);
});

test('commitMessage refuses a non-object-id revision without spawning git (P1-1)', async () => {
  const ctx = makeCtx();
  const message = await commitMessage(ctx, process.cwd(), '--output=/tmp/pwned');
  assert.equal(message, '');
  assert.equal(ctx.calls.length, 0);
});
