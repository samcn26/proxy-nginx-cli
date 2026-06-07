const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createExample, createPortInUseChecker, stopExample } = require('../lib/commands');

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-example-'));
}

test('pn example creates a runnable local example project', () => {
  const cwd = makeTempProject();

  const output = createExample({ cwd });

  assert.match(output, /Created example project/);
  assert.ok(fs.existsSync(path.join(cwd, 'example', 'backend', 'package.json')));
  assert.ok(fs.existsSync(path.join(cwd, 'example', 'backend', 'server.js')));
  assert.ok(fs.existsSync(path.join(cwd, 'example', 'proxy', 'docker-compose.yml')));
  assert.ok(
    fs.existsSync(
      path.join(
        cwd,
        'example',
        'proxy',
        'nginx',
        'templates',
        'local.example.test.conf.template'
      )
    )
  );

  const backend = fs.readFileSync(
    path.join(cwd, 'example', 'backend', 'server.js'),
    'utf8'
  );
  assert.match(backend, /6666/);
  assert.match(backend, /proxy-nginx-cli example backend/);
});

test('pn example with a domain creates an online example proxy', () => {
  const cwd = makeTempProject();

  const output = createExample({ cwd, domain: 'test.example.cn' });

  assert.match(output, /Created example project/);
  assert.ok(
    fs.existsSync(
      path.join(
        cwd,
        'example',
        'proxy',
        'nginx',
        'templates',
        'test.example.cn.conf.template'
      )
    )
  );

  const env = fs.readFileSync(path.join(cwd, 'example', 'proxy', '.env'), 'utf8');
  assert.match(env, /FORCE_HTTPS=false/);
});

test('pn example --run refuses to start when a required port is busy', () => {
  const cwd = makeTempProject();
  const calls = [];

  assert.throws(
    () =>
      createExample({
        cwd,
        run: true,
        isPortOpen: (port) => port === 6666,
        spawnBackend: () => calls.push('backend'),
        runCompose: () => calls.push('compose'),
      }),
    /Port 6666 is already in use/
  );

  assert.deepEqual(calls, []);
});

test('pn example --run starts backend and proxy when ports are free', () => {
  const cwd = makeTempProject();
  const calls = [];

  const output = createExample({
    cwd,
    run: true,
    isPortOpen: () => false,
    spawnBackend: (_command, args, options) => {
      calls.push({ type: 'backend', args, cwd: options.cwd });
      return { unref() {} };
    },
    runCompose: (args, options) => {
      calls.push({ type: 'compose', args, cwd: options.cwd });
    },
  });

  assert.match(output, /Example is running/);
  assert.deepEqual(calls, [
    {
      type: 'backend',
      args: ['server.js'],
      cwd: path.join(cwd, 'example', 'backend'),
    },
    {
      type: 'compose',
      args: ['up', '-d', '--build', 'proxy-nginx'],
      cwd: path.join(cwd, 'example', 'proxy'),
    },
  ]);
});

test('pn example <domain> --run --cert starts, issues cert, and reloads', () => {
  const cwd = makeTempProject();
  const calls = [];

  const output = createExample({
    cwd,
    domain: 'test.example.cn',
    run: true,
    cert: true,
    isPortOpen: () => false,
    spawnBackend: (_command, args, options) => {
      calls.push({ type: 'backend', args, cwd: options.cwd });
      return { unref() {} };
    },
    runCompose: (args, options) => {
      calls.push({ type: 'compose', args, cwd: options.cwd });
    },
  });

  assert.match(output, /Example is running/);
  assert.match(output, /Certificate requested for test.example.cn/);
  assert.deepEqual(calls, [
    {
      type: 'backend',
      args: ['server.js'],
      cwd: path.join(cwd, 'example', 'backend'),
    },
    {
      type: 'compose',
      args: ['up', '-d', '--build', 'proxy-nginx'],
      cwd: path.join(cwd, 'example', 'proxy'),
    },
    {
      type: 'compose',
      args: [
        'run',
        '--rm',
        '--entrypoint',
        'certbot',
        'certbot',
        'certonly',
        '--webroot',
        '-w',
        '/var/www/certbot',
        '-d',
        'test.example.cn',
        '--agree-tos',
        '--register-unsafely-without-email',
        '--no-eff-email',
        '--non-interactive',
        '--keep-until-expiring',
      ],
      cwd: path.join(cwd, 'example', 'proxy'),
    },
    {
      type: 'compose',
      args: ['exec', 'proxy-nginx', 'nginx', '-t'],
      cwd: path.join(cwd, 'example', 'proxy'),
    },
    {
      type: 'compose',
      args: ['exec', 'proxy-nginx', 'nginx', '-s', 'reload'],
      cwd: path.join(cwd, 'example', 'proxy'),
    },
  ]);
});

test('pn example --run --cert requires a domain', () => {
  const cwd = makeTempProject();

  assert.throws(
    () =>
      createExample({
        cwd,
        run: true,
        cert: true,
        isPortOpen: () => false,
        spawnBackend: () => ({ unref() {} }),
        runCompose: () => {},
      }),
    /--cert requires a domain/
  );
});

test('pn example --stop stops proxy and backend', () => {
  const cwd = makeTempProject();
  createExample({ cwd });
  const calls = [];

  const output = stopExample({
    cwd,
    runCompose: (args, options) => {
      calls.push({ type: 'compose', args, cwd: options.cwd });
    },
    stopPort: (port) => {
      calls.push({ type: 'port', port });
    },
  });

  assert.match(output, /Stopped example/);
  assert.deepEqual(calls, [
    {
      type: 'compose',
      args: ['down'],
      cwd: path.join(cwd, 'example', 'proxy'),
    },
    {
      type: 'port',
      port: 6666,
    },
  ]);
});

test('pn example --stop fails when the example project is missing', () => {
  const cwd = makeTempProject();

  assert.throws(
    () =>
      stopExample({
        cwd,
        runCompose: () => {},
        stopPort: () => {},
      }),
    /No example proxy project found/
  );
});

test('port checker uses listener inspection before bind fallback', () => {
  const calls = [];
  const execFileSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'sh') {
      return '';
    }
    throw new Error('unexpected fallback');
  };

  const isPortInUse = createPortInUseChecker(execFileSync);

  assert.equal(isPortInUse(80), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'sh');
});
