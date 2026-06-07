const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  addSite,
  certProject,
  createComposeRunner,
  networkAdd,
  networkRemove,
  reloadProject,
  upProject,
} = require('../lib/commands');

function makeComposeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-compose-'));
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), 'services: {}\n');
  return cwd;
}

function makeProxyProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-network-'));
  fs.mkdirSync(path.join(cwd, 'nginx', 'templates'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'docker-compose.yml'),
    `services:
  proxy-nginx:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: proxy-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/templates:/etc/nginx/templates:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"

  certbot:
    image: certbot/certbot:latest
`
  );
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
      args: ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'],
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

  assert.equal(output, 'Issued certificate for test.example.cn, reloaded proxy nginx, and started certificate renewal.');
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
    {
      args: ['up', '-d', 'certbot'],
      cwd,
    },
  ]);
});

test('pn add --run applies the site immediately', () => {
  const cwd = makeComposeProject();
  fs.mkdirSync(path.join(cwd, 'nginx', 'templates'), { recursive: true });
  const calls = [];
  const runner = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { status: 0 };
  };

  const output = addSite('test.example.cn', '127.0.0.1:3000', {
    run: true,
    ssl: false,
    runCompose: runner,
  }, cwd);

  assert.match(output, /Started proxy nginx/);
  assert.deepEqual(calls, [
    {
      args: ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'],
      cwd,
    },
  ]);
});

test('pn add --run --cert applies the site and issues a certificate', () => {
  const cwd = makeComposeProject();
  fs.mkdirSync(path.join(cwd, 'nginx', 'templates'), { recursive: true });
  const calls = [];
  const runner = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { status: 0 };
  };

  const output = addSite('test.example.cn', '127.0.0.1:3000', {
    run: true,
    cert: true,
    runCompose: runner,
  }, cwd);

  assert.match(output, /Issued certificate for test.example.cn/);
  assert.deepEqual(calls.map((call) => call.args), [
    ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'],
    [
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
    ['exec', 'proxy-nginx', 'nginx', '-t'],
    ['exec', 'proxy-nginx', 'nginx', '-s', 'reload'],
    ['up', '-d', 'certbot'],
  ]);
});

test('pn network add attaches proxy nginx to multiple external networks', () => {
  const cwd = makeProxyProject();

  assert.equal(networkAdd('frontend', { cwd }), 'Added network frontend.');
  assert.equal(networkAdd('backend', { cwd }), 'Added network backend.');
  assert.equal(networkAdd('frontend', { cwd }), 'Network frontend already exists.');

  const compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /proxy-nginx:[\s\S]*networks:\n      - default\n      - frontend\n      - backend/);
  assert.match(compose, /networks:\n  frontend:\n    external: true\n  backend:\n    external: true\n$/);
});

test('pn network add --run applies network changes immediately', () => {
  const cwd = makeProxyProject();
  const calls = [];

  const output = networkAdd('frontend', {
    cwd,
    run: true,
    runCompose: (args, options) => {
      calls.push({ args, cwd: options.cwd });
    },
  });

  assert.match(output, /Started proxy nginx/);
  assert.deepEqual(calls, [
    {
      args: ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'],
      cwd,
    },
  ]);
});

test('pn network remove detaches a proxy network', () => {
  const cwd = makeProxyProject();
  networkAdd('frontend', { cwd });
  networkAdd('backend', { cwd });

  assert.equal(networkRemove('frontend', { cwd }), 'Removed network frontend.');

  const compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /frontend/);
  assert.match(compose, /backend:\n    external: true/);
});

test('pn network remove --run applies network removal immediately', () => {
  const cwd = makeProxyProject();
  const calls = [];
  networkAdd('frontend', { cwd });

  const output = networkRemove('frontend', {
    cwd,
    run: true,
    runCompose: (args, options) => {
      calls.push({ args, cwd: options.cwd });
    },
  });

  assert.match(output, /Started proxy nginx/);
  assert.deepEqual(calls, [
    {
      args: ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'],
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

test('compose runner uses docker-compose when it works', () => {
  const attempts = [];
  const execFileSync = (command, args) => {
    attempts.push([command, ...args]);
    if (command === 'docker-compose' && args[0] === 'version') {
      return 'Docker Compose version 5.1.3';
    }
    return '';
  };

  const runner = createComposeRunner(execFileSync);
  runner(['config'], { cwd: '/project' });

  assert.deepEqual(attempts, [
    ['docker-compose', 'version'],
    ['docker-compose', 'config'],
  ]);
});

test('compose runner uses docker compose when docker-compose is a docker alias', () => {
  const attempts = [];
  const execFileSync = (command, args) => {
    attempts.push([command, ...args]);
    if (command === 'docker-compose' && args[0] === 'version') {
      return 'Docker version 26.1.3';
    }
    return '';
  };

  const runner = createComposeRunner(execFileSync);
  runner(['up', '-d', '--build', 'proxy-nginx'], { cwd: '/project' });

  assert.deepEqual(attempts, [
    ['docker-compose', 'version'],
    ['docker', 'compose', 'up', '-d', '--build', 'proxy-nginx'],
  ]);
});
