const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cliPath = path.join(__dirname, '..', 'bin', 'pn');

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-'));
}

function runCli(cwd, args) {
  return execFileSync(cliPath, args, {
    cwd,
    encoding: 'utf8',
  });
}

function runCliExpectFailure(cwd, args) {
  assert.throws(
    () =>
      execFileSync(cliPath, args, {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (error) => {
      assert.equal(error.status, 1);
      return true;
    }
  );
}

test('pn init creates a proxy nginx project skeleton', () => {
  const cwd = makeTempProject();

  const output = runCli(cwd, ['init']);

  assert.match(output, /Initialized proxy nginx project/);
  assert.ok(fs.existsSync(path.join(cwd, 'docker-compose.yml')));
  assert.ok(fs.existsSync(path.join(cwd, 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(cwd, '.env')));
  assert.ok(fs.existsSync(path.join(cwd, 'nginx', 'nginx.conf')));
  assert.ok(fs.existsSync(path.join(cwd, 'nginx', 'templates')));
  assert.ok(fs.existsSync(path.join(cwd, 'ssl', 'certs')));
  assert.ok(fs.existsSync(path.join(cwd, 'ssl', 'www')));
  assert.ok(fs.existsSync(path.join(cwd, 'logs')));

  const dockerfile = fs.readFileSync(path.join(cwd, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM nginx:latest/);
  assert.doesNotMatch(dockerfile, /apk add/);
  assert.match(dockerfile, /rm -f \/etc\/nginx\/conf\.d\/default\.conf/);
});

test('pn add creates an ssl-enabled site from host and port options', () => {
  const cwd = makeTempProject();
  runCli(cwd, ['init']);

  const output = runCli(cwd, [
    'add',
    'test.example.cn',
    '-H',
    'host.docker.internal',
    '-p',
    '6666',
  ]);

  const configPath = path.join(
    cwd,
    'nginx',
    'templates',
    'test.example.cn.conf.template'
  );
  const config = fs.readFileSync(configPath, 'utf8');

  assert.match(output, /Added test.example.cn/);
  assert.match(config, /server_name test\.example\.cn;/);
  assert.match(config, /server host\.docker\.internal:6666;/);
  assert.match(config, /listen 443 ssl;/);
  assert.match(config, /http2 on;/);
  assert.match(config, /ssl_certificate\s+\/etc\/nginx\/certs\/live\/test\.example\.cn\/fullchain\.pem;/);
});

test('pn add creates an http-only site from a target url when ssl is disabled', () => {
  const cwd = makeTempProject();
  runCli(cwd, ['init']);

  runCli(cwd, [
    'add',
    'local.test',
    'http://host.docker.internal:6666',
    '--no-ssl',
  ]);

  const config = fs.readFileSync(
    path.join(cwd, 'nginx', 'templates', 'local.test.conf.template'),
    'utf8'
  );

  assert.match(config, /server_name local\.test;/);
  assert.match(config, /server host\.docker\.internal:6666;/);
  assert.doesNotMatch(config, /listen 443/);
  assert.doesNotMatch(config, /ssl_certificate/);
});

test('pn reset removes added site templates and keeps the base project skeleton', () => {
  const cwd = makeTempProject();
  runCli(cwd, ['init']);
  runCli(cwd, [
    'add',
    'test.example.cn',
    'http://host.docker.internal:6666',
    '--no-ssl',
  ]);

  const sitePath = path.join(
    cwd,
    'nginx',
    'templates',
    'test.example.cn.conf.template'
  );
  assert.ok(fs.existsSync(sitePath));

  const output = runCli(cwd, ['reset']);

  assert.match(output, /Reset proxy nginx project/);
  assert.ok(fs.existsSync(path.join(cwd, 'docker-compose.yml')));
  assert.ok(fs.existsSync(path.join(cwd, 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(cwd, '.env')));
  assert.ok(fs.existsSync(path.join(cwd, 'nginx', 'nginx.conf')));
  assert.ok(fs.existsSync(path.join(cwd, 'ssl', 'certs')));
  assert.ok(fs.existsSync(path.join(cwd, 'ssl', 'www')));
  assert.ok(fs.existsSync(path.join(cwd, 'logs')));
  assert.ok(
    fs.existsSync(
      path.join(cwd, 'nginx', 'templates', '00-unmatched-host.conf.template')
    )
  );
  assert.equal(fs.existsSync(sitePath), false);
});

test('pn remove deletes a site template by domain', () => {
  const cwd = makeTempProject();
  runCli(cwd, ['init']);
  runCli(cwd, [
    'add',
    'test.example.cn',
    'http://host.docker.internal:6666',
    '--no-ssl',
  ]);

  const sitePath = path.join(
    cwd,
    'nginx',
    'templates',
    'test.example.cn.conf.template'
  );

  const output = runCli(cwd, ['remove', 'test.example.cn']);

  assert.match(output, /Removed test.example.cn/);
  assert.equal(fs.existsSync(sitePath), false);
});

test('pn remove fails when a site template does not exist', () => {
  const cwd = makeTempProject();
  runCli(cwd, ['init']);

  runCliExpectFailure(cwd, ['remove', 'missing.example.cn']);
});
