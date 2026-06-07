const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const path = require('node:path');

const cliPath = path.join(__dirname, '..', 'bin', 'pn');

test('prints help for pn --help', () => {
  const output = execFileSync(cliPath, ['--help'], {
    encoding: 'utf8',
  });

  assert.match(output, /Usage: pn/);
  assert.match(output, /Proxy Nginx CLI/);
});

test('prints Chinese help for pn --help cn', () => {
  const output = execFileSync(cliPath, ['--help', 'cn'], {
    encoding: 'utf8',
  });

  assert.match(output, /用法: pn/);
  assert.match(output, /Nginx 反向代理 CLI/);
  assert.match(output, /命令:/);
  assert.match(output, /pn add test\.example\.cn/);
});
