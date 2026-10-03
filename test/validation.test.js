const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  addSite,
  certProject,
  initProject,
  networkAdd,
  parseTarget,
  removeSite,
} = require('../lib/commands');

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-validation-'));
  initProject(cwd);
  return cwd;
}

test('pn add rejects domains that are not plain hostnames', () => {
  const cwd = makeProject();

  for (const domain of ['../evil', 'a;b.example.com', 'x.example.com/..', '-bad.example.com', '*.example.com']) {
    assert.throws(() => addSite(domain, '127.0.0.1:3000', {}, cwd), /Invalid domain/);
  }

  assert.deepEqual(fs.readdirSync(path.join(cwd, 'nginx', 'templates')).sort(), [
    '00-connection-upgrade.conf.template',
    '00-unmatched-host.conf.template',
  ]);
});

test('pn add normalizes domain case', () => {
  const cwd = makeProject();

  addSite('App.Example.COM', '127.0.0.1:3000', {}, cwd);

  assert.ok(fs.existsSync(path.join(cwd, 'nginx', 'templates', 'app.example.com.conf.template')));
});

test('pn add rejects invalid upstream hosts, ports, and target paths', () => {
  assert.throws(() => parseTarget(undefined, { host: 'a;b', port: '80' }), /Invalid upstream host/);
  assert.throws(() => parseTarget(undefined, { host: 'app', port: '99999' }), /Invalid upstream port/);
  assert.throws(() => parseTarget(undefined, { host: 'app', port: '80;' }), /Invalid upstream port/);
  assert.throws(() => parseTarget('http://app:3000/api', {}), /only include protocol, host, and port/);
});

test('pn add accepts explicit default ports', () => {
  assert.deepEqual(parseTarget('10.0.0.7:80', {}), {
    protocol: 'http',
    host: '10.0.0.7',
    port: '80',
  });
  assert.deepEqual(parseTarget('https://api.internal:443', {}), {
    protocol: 'https',
    host: 'api.internal',
    port: '443',
  });
});

test('pn add sets upstream SNI for https targets', () => {
  const cwd = makeProject();

  addSite('api.example.com', 'https://api.internal:8443', {}, cwd);

  const config = fs.readFileSync(
    path.join(cwd, 'nginx', 'templates', 'api.example.com.conf.template'),
    'utf8'
  );
  assert.match(config, /proxy_ssl_server_name on;/);
  assert.match(config, /proxy_ssl_name api\.internal;/);
});

test('pn add http-only sites keep the ACME challenge path for later certificates', () => {
  const cwd = makeProject();

  addSite('plain.example.com', '127.0.0.1:3000', { ssl: false }, cwd);

  const config = fs.readFileSync(
    path.join(cwd, 'nginx', 'templates', 'plain.example.com.conf.template'),
    'utf8'
  );
  assert.match(config, /location \/\.well-known\/acme-challenge\//);
});

test('pn add --cert cannot be combined with --no-ssl', () => {
  const cwd = makeProject();

  assert.throws(
    () => addSite('plain.example.com', '127.0.0.1:3000', { ssl: false, cert: true, runCompose: () => {} }, cwd),
    /--cert cannot be used with --no-ssl/
  );
});

test('pn remove --run applies the removal without restarting the proxy', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);
  const calls = [];

  const output = removeSite('app.example.com', cwd, {
    run: true,
    runCompose: (args) => calls.push(args),
  });

  assert.match(output, /Removed app\.example\.com\.\nApplied site changes/);
  assert.deepEqual(calls[0], ['exec', '-T', 'proxy-nginx', 'true']);
  assert.equal(calls[1][3], 'sh');
});

test('pn network add rejects invalid network names', () => {
  const cwd = makeProject();

  for (const name of ['bad name', 'x\n  y', '-x', 'default']) {
    assert.throws(() => networkAdd(name, { cwd }), /Invalid Docker network name/);
  }
});

test('pn cert passes email and staging options to certbot', () => {
  const cwd = makeProject();
  const calls = [];

  certProject('app.example.com', cwd, (args) => calls.push(args), () => 'stamp', {
    email: 'ops@example.com',
    staging: true,
  });

  const certbotArgs = calls.find((args) => args[0] === 'run');
  assert.ok(certbotArgs.includes('--staging'));
  assert.deepEqual(certbotArgs.slice(certbotArgs.indexOf('--email'), certbotArgs.indexOf('--email') + 2), [
    '--email',
    'ops@example.com',
  ]);
  assert.ok(!certbotArgs.includes('--register-unsafely-without-email'));
  assert.throws(
    () => certProject('app.example.com', cwd, () => {}, () => 'stamp', { email: 'not-an-email' }),
    /Invalid email/
  );
});

test('pn init adds certificate reload hook and rejects unknown TLS hosts', () => {
  const cwd = makeProject();

  const hook = path.join(cwd, 'nginx', 'docker-entrypoint.d', '50-reload-renewed-certs.sh');
  assert.ok(fs.statSync(hook).mode & 0o100);
  assert.match(fs.readFileSync(hook, 'utf8'), /nginx -s reload/);

  const unmatched = fs.readFileSync(
    path.join(cwd, 'nginx', 'templates', '00-unmatched-host.conf.template'),
    'utf8'
  );
  assert.match(unmatched, /listen 443 ssl default_server;/);
  assert.match(unmatched, /ssl_reject_handshake on;/);
});
