const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { addSite, initProject } = require('../lib/commands');

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-templates-'));
  initProject(cwd);
  return cwd;
}

function read(cwd, ...parts) {
  return fs.readFileSync(path.join(cwd, ...parts), 'utf8');
}

test('generated project pins nginx and certbot images and allows overriding them', () => {
  const cwd = makeProject();

  const compose = read(cwd, 'docker-compose.yml');
  assert.match(compose, /NGINX_IMAGE: \$\{NGINX_IMAGE:-nginx:\d+\.\d+\}/);
  assert.match(compose, /image: \$\{CERTBOT_IMAGE:-certbot\/certbot:v\d+\.\d+\.\d+\}/);
  assert.doesNotMatch(compose, /:latest/);

  const env = read(cwd, '.env');
  assert.match(env, /^NGINX_IMAGE=nginx:\d+\.\d+$/m);
  assert.match(env, /^CERTBOT_IMAGE=certbot\/certbot:v\d+\.\d+\.\d+$/m);
});

test('sites use the connection upgrade map so upstream keepalive works', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);

  const site = read(cwd, 'nginx', 'templates', 'app.example.com.conf.template');
  assert.match(site, /proxy_set_header Connection \$connection_upgrade;/);
  assert.doesNotMatch(site, /Connection "upgrade"/);

  const map = read(cwd, 'nginx', 'templates', '00-connection-upgrade.conf.template');
  assert.match(map, /map \$http_upgrade \$connection_upgrade \{/);
});

test('pn add restores the connection upgrade map for projects created by older versions', () => {
  const cwd = makeProject();
  fs.rmSync(path.join(cwd, 'nginx', 'templates', '00-connection-upgrade.conf.template'));

  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);

  assert.ok(fs.existsSync(path.join(cwd, 'nginx', 'templates', '00-connection-upgrade.conf.template')));
});

test('nginx.conf enables gzip', () => {
  assert.match(read(makeProject(), 'nginx', 'nginx.conf'), /^\s*gzip on;/m);
});

test('compose mounts the static sites directory and passes tuning variables', () => {
  const cwd = makeProject();
  const compose = read(cwd, 'docker-compose.yml');

  assert.ok(fs.statSync(path.join(cwd, 'sites')).isDirectory());
  assert.match(compose, /- \.\/sites:\/srv\/sites:ro/);
  assert.match(compose, /LOG_ROTATE_SIZE_MB: \$\{LOG_ROTATE_SIZE_MB:-50\}/);
  assert.match(compose, /CERT_RELOAD_INTERVAL: \$\{CERT_RELOAD_INTERVAL:-12h\}/);
});

test('log rotation script rotates only oversized logs, keeps N files, and reopens nginx', () => {
  const cwd = makeProject();
  const script = path.join(cwd, 'nginx', 'docker-entrypoint.d', '60-rotate-logs.sh');
  const logDir = path.join(cwd, 'logs');
  const binDir = path.join(cwd, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'nginx'), `#!/bin/sh\necho "$@" >> "${cwd}/nginx-calls"\n`, { mode: 0o755 });

  fs.writeFileSync(path.join(logDir, 'access.log'), Buffer.alloc(2 * 1024 * 1024, 'a'));
  fs.writeFileSync(path.join(logDir, 'access.log.1'), 'older');
  fs.writeFileSync(path.join(logDir, 'access.log.2'), 'oldest');
  fs.writeFileSync(path.join(logDir, 'error.log'), 'small');

  execFileSync('sh', [script, '--once'], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      LOG_DIR: logDir,
      LOG_ROTATE_SIZE_MB: '1',
      LOG_ROTATE_KEEP: '3',
    },
  });

  assert.equal(fs.statSync(path.join(logDir, 'access.log.1')).size, 2 * 1024 * 1024);
  assert.equal(read(cwd, 'logs', 'access.log.2'), 'older');
  assert.equal(read(cwd, 'logs', 'access.log.3'), 'oldest');
  assert.ok(!fs.existsSync(path.join(logDir, 'access.log')));
  assert.equal(read(cwd, 'logs', 'error.log'), 'small');
  assert.equal(read(cwd, 'nginx-calls').trim(), '-s reopen');
});
