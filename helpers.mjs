// Test-only helpers (not shipped: package.json "files" excludes this file).
import { spawnSync } from 'node:child_process';

/** A synthetic SubprocessHandle whose readers report the given output and lossy flag. */
export function fakeHandle({ stdout = '', stderr = '', lossy = false, exitCode = 0 } = {}) {
  const out = Buffer.from(stdout);
  const err = Buffer.from(stderr);
  return {
    collected: {
      stdout: { readFrom: () => ({ text: out.toString('utf8'), nextOffset: out.length, lossy }) },
      stderr: { readFrom: () => ({ text: err.toString('utf8'), nextOffset: err.length, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate() {},
    waitForExit: async () => true,
  };
}

/**
 * A minimal `ctx` whose subprocess service runs real git via spawnSync, or returns
 * an override handle for matching calls (used to simulate truncation/injection).
 */
export function makeCtx({ cwd = process.cwd(), overrides } = {}) {
  const calls = [];
  return {
    calls,
    sessions: { get: () => ({}) },
    workingDirectory: { get: () => cwd },
    subprocess: {
      spawn(spec) {
        calls.push({ argv: spec.argv, cwd: spec.cwd, signal: spec.signal });
        if (overrides) {
          const handle = overrides(spec, calls);
          if (handle) return handle;
        }
        const [bin, ...args] = spec.argv;
        const child = spawnSync(bin, args, { cwd: spec.cwd, env: process.env, maxBuffer: 256 * 1024 * 1024 });
        const stdout = child.stdout || Buffer.alloc(0);
        const stderr = child.stderr || Buffer.alloc(0);
        const maxOut = spec.stdio && spec.stdio.stdout && typeof spec.stdio.stdout === 'object'
          ? spec.stdio.stdout.maxBytes
          : Infinity;
        const lossy = stdout.length > maxOut;
        const kept = lossy ? stdout.subarray(stdout.length - maxOut) : stdout;
        return {
          collected: {
            stdout: { readFrom: () => ({ text: kept.toString('utf8'), nextOffset: kept.length, lossy }) },
            stderr: { readFrom: () => ({ text: stderr.toString('utf8'), nextOffset: stderr.length, lossy: false }) },
          },
          done: Promise.resolve({ exitCode: child.status, signal: child.signal }),
          terminate() {},
          waitForExit: async () => true,
        };
      },
    },
  };
}

/** Run git synchronously for test setup. */
export function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
