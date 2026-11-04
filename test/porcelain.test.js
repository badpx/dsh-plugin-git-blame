import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelain, parseFullPorcelain, splitMessage } from '../index.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function porcelain(sha, author = 'Ada', line = 1) {
  return [
    `${sha} 1 ${line} 1`,
    `author ${author}`,
    'author-mail <ada@example.com>',
    'author-time 1700000000',
    'summary subject line',
    '',
    '\tconst x = 1;',
  ].join('\n');
}

test('parsePorcelain accepts a 40-hex SHA', () => {
  const info = parsePorcelain(porcelain(SHA1));
  assert.equal(info.ok, true);
  assert.equal(info.sha, SHA1);
  assert.equal(info.author, 'Ada');
  assert.equal(info.date, '2023-11-14');
});

test('parsePorcelain accepts a 64-hex (SHA-256) id', () => {
  const info = parsePorcelain(porcelain(SHA256));
  assert.equal(info.ok, true);
  assert.equal(info.sha, SHA256);
});

test('parsePorcelain rejects an option-like header (injection attempt)', () => {
  const info = parsePorcelain('--output=/tmp/pwned 1 1 1\nauthor Evil\n\tx\n');
  assert.equal(info.ok, false);
  assert.equal(info.code, 'parse-failed');
});

test('parsePorcelain rejects a short/abbreviated or non-hex header', () => {
  assert.equal(parsePorcelain('deadbeef 1 1 1\n').ok, false);
  assert.equal(parsePorcelain('ZZZ 1 1 1\n').ok, false);
  assert.equal(parsePorcelain('').ok, false);
});

test('parseFullPorcelain parses 40- and 64-hex records', () => {
  const text = [
    `${SHA1} 1 1 1`, 'author A', 'author-time 1700000000', '\tline1',
    `${SHA256} 2 2 1`, 'author B', 'author-time 1700000100', '\tline2',
  ].join('\n');
  const { lines, parsedCount } = parseFullPorcelain(text);
  assert.equal(parsedCount, 2);
  assert.equal(lines[0].sha, SHA1);
  assert.equal(lines[1].sha, SHA256);
});

test('parseFullPorcelain returns 0 parsed for garbage output', () => {
  const { lines, parsedCount } = parseFullPorcelain('not a blame at all\nrandom');
  assert.equal(parsedCount, 0);
  assert.equal(lines.length, 0);
});

test('splitMessage separates title and body', () => {
  assert.deepEqual(splitMessage('title only'), { title: 'title only', body: '' });
  assert.deepEqual(splitMessage('title\n\nbody line'), { title: 'title', body: 'body line' });
});
