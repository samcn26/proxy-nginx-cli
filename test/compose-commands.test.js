const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  certProject,
  createComposeRunner,
  reloadProject,
  upProject,
} = require('../lib/commands');

function makeComposeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-compose-'));
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), 'services: {}\n');
  return cwd;
}

test('pn up starts proxy nginx with docker compose', () => {
  const cwd = makeComposeProject();
  const calls = [];
  const runner = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { status: 0 };
  };

  const output = upProject(cwd, runner);

  assert.equal(output, 'Started proxy nginx.');
  assert.deepEqual(calls, [
    {
      args: ['up', '-d', '--build', 'proxy-nginx'],
      cwd,
    },
  ]);
});

test('pn reload validates nginx config and reloads the running proxy', () => {
  const cwd = makeComposeProject();
  const calls = [];
  const runner = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { status: 0 };
  };

  const output = reloadProject(cwd, runner);

  assert.equal(output, 'Reloaded proxy nginx.');
  assert.deepEqual(calls, [
    {
      args: ['exec', 'proxy-nginx', 'nginx', '-t'],
      cwd,
    },
    {
      args: ['exec', 'proxy-nginx', 'nginx', '-s', 'reload'],
      cwd,
    },
  ]);
});

test('pn cert issues a certificate and reloads nginx', () => {
  const cwd = makeComposeProject();
  const calls = [];
  const runner = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { status: 0 };
  };

  const output = certProject('test.example.cn', cwd, runner);

  assert.equal(output, 'Issued certificate for test.example.cn and reloaded proxy nginx.');
  assert.deepEqual(calls, [
    {
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
      cwd,
    },
    {
      args: ['exec', 'proxy-nginx', 'nginx', '-t'],
      cwd,
    },
    {
      args: ['exec', 'proxy-nginx', 'nginx', '-s', 'reload'],
      cwd,
    },
  ]);
});

test('pn cert backs up self-signed live certs before requesting a certificate', () => {
  const cwd = makeComposeProject();
  const liveDir = path.join(cwd, 'ssl', 'certs', 'live', 'test.example.cn');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'fullchain.pem'), 'self signed');

  const runner = () => ({ status: 0 });

  certProject('test.example.cn', cwd, runner, () => '20260607153000');

  assert.equal(fs.existsSync(liveDir), false);
  assert.equal(
    fs.existsSync(
      path.join(
        cwd,
        'ssl',
        'certs',
        'live',
        'test.example.cn.bak.selfsigned.20260607153000',
        'fullchain.pem'
      )
    ),
    true
  );
});

test('compose runner uses docker-compose', () => {
  const attempts = [];
  const execFileSync = (command, args) => {
    attempts.push([command, ...args]);
    return '';
  };

  const runner = createComposeRunner(execFileSync);
  runner(['config'], { cwd: '/project' });

  assert.deepEqual(attempts, [
    ['docker-compose', 'config'],
  ]);
});
