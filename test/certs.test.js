const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { addSite, certProject, initProject, removeSite, statusProject } = require('../lib/commands');
const { certificateReport, formatCertificate, readCertificateInfo } = require('../lib/certs');

// Self-signed certificate for fixture.example.test, valid 2026-10-03 .. 2126-09-09.
const FIXTURE_PEM = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUGQ/+DuBzOZzN7e3WzL5/ADbgYpAwDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUZml4dHVyZS5leGFtcGxlLnRlc3QwIBcNMjYxMDAzMDcw
NjAyWhgPMjEyNjA5MDkwNzA2MDJaMB8xHTAbBgNVBAMMFGZpeHR1cmUuZXhhbXBs
ZS50ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArSRxokhvaRr6
znwFZH4LrhilIJjYAl4o1YD9wuv+xSL3IQ4G3gtIMAQCrieTWSGnMxovC7nDX0MT
MInI9TrESGyOeJ/OfnGQALEkYljoH+7T8G6wr3SvAgDOCQUNMibNuFH6b8bOzleb
NHDw6uZ7TrmSL2ARgGs7xioBnVWXUDUTjfBDk11XGahJth0rzJjc6Kj4enhze/vn
4iK2yXjN3s901Oy4Q95ewOpddzFVDCV6GFYYZlwPO5JtA+uWwBs1aKaCTQTXAoG8
GCKxENelIFi1mSntkATRxWJC7ZdYMRycoqwTFMVhExmmX3C7RtbGY7+x4N97Kaxp
73jXsJehCwIDAQABo1MwUTAdBgNVHQ4EFgQUcbVvOcxfZgwwtZ+1UiRWedzb6q0w
HwYDVR0jBBgwFoAUcbVvOcxfZgwwtZ+1UiRWedzb6q0wDwYDVR0TAQH/BAUwAwEB
/zANBgkqhkiG9w0BAQsFAAOCAQEAkIazW0uZUd0n8cipJdr3V36VOrVgX8x9vwCb
HrscorLPu3bCWYCqMCd4CR0pInI8AukiCx1tGsSf+SXfyReM+LFHjDsDUiAG6Qdi
+54VTdjYmtlcfY9r3M0ykjDfCCUdLo0gFEJNPxQ8sLmfvJ59Yl+/rfclZeJuJmpy
aY7TPRY9nlWG1vTy3uNo4RsagrL+gytmQq2fL2GJT/z4L20vaPKj0OkneF+Nqwgw
wld+Tl8BNYleL+vK6mUkrIWDkor1NSqGCXNtf5E17kjkLM9ZH0xlQfs9CWHqQUWG
XAdWnY239XFCh/Xl+FC5KeFtV1bm+gZ6ZKgQwRqv5qhPgBehAQ==
-----END CERTIFICATE-----
`;

const NOW = new Date('2126-01-01T00:00:00Z');

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-certs-'));
  initProject(cwd);
  return cwd;
}

function writeLiveCert(cwd, name) {
  const dir = path.join(cwd, 'ssl', 'certs', 'live', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fullchain.pem'), FIXTURE_PEM);
}

function writeRenewal(cwd, name, content = 'renewal') {
  const dir = path.join(cwd, 'ssl', 'certs', 'renewal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.conf`), content);
}

test('certificate info reports expiry, days left, and self-signed state', () => {
  const cwd = makeProject();
  writeLiveCert(cwd, 'app.example.com');

  const info = readCertificateInfo(cwd, 'app.example.com', NOW);

  assert.equal(info.expires, '2126-09-09');
  assert.equal(info.daysLeft, 251);
  assert.equal(info.selfSigned, true);
  assert.equal(info.staging, false);
  assert.deepEqual(readCertificateInfo(cwd, 'missing.example.com'), {});
});

test('certificate report merges renewal lineages and live dirs and skips backups', () => {
  const cwd = makeProject();
  writeLiveCert(cwd, 'app.example.com');
  writeRenewal(cwd, 'app.example.com');
  writeRenewal(cwd, 'only-renewal.example.com');
  writeRenewal(cwd, 'empty.example.com', '');
  writeLiveCert(cwd, 'dev.example.com');
  writeLiveCert(cwd, 'app.example.com.bak.selfsigned.20260101000000');

  const report = certificateReport(cwd, NOW);

  assert.deepEqual(report.map((cert) => cert.name), [
    'app.example.com',
    'dev.example.com',
    'only-renewal.example.com',
  ]);
  assert.equal(report[0].renewal, true);
  assert.equal(report[1].renewal, false);
  assert.equal(
    formatCertificate(report[1]),
    'dev.example.com (expires 2126-09-09, 251 days left) [self-signed]'
  );
  assert.equal(
    formatCertificate({ name: 'x.example.com', renewal: true, expires: '2027-01-01', daysLeft: 5 }),
    'x.example.com (expires 2027-01-01, 5 days left) [expiring soon]'
  );
  assert.match(
    formatCertificate({ name: 'x.example.com', renewal: true, expires: '2020-01-01', daysLeft: -3 }),
    /\[EXPIRED\]/
  );
});

test('pn status shows expiry and upstreams, and supports --json', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);
  writeLiveCert(cwd, 'app.example.com');
  const calls = [];
  const runner = (args) => calls.push(args);

  const text = statusProject(cwd, runner);
  assert.match(text, /Sites:\n  - app\.example\.com -> host\.docker\.internal:3000/);
  assert.match(
    text,
    /Certificates:\n  - app\.example\.com \(expires 2126-09-09, -?\d+ days left\) \[self-signed\]/
  );
  assert.deepEqual(calls[0], ['ps']);
  assert.ok(calls.slice(1).every((args) => args[0] === 'exec'));

  calls.length = 0;
  const json = JSON.parse(statusProject(cwd, runner, { json: true }));
  assert.equal(json.proxy.running, true);
  assert.equal(json.sites[0].domain, 'app.example.com');
  assert.equal(json.sites[0].upstream, 'host.docker.internal:3000');
  assert.equal(json.sites[0].ssl, true);
  assert.equal(json.certificates[0].selfSigned, true);
  assert.deepEqual(json.networks, []);
  assert.ok(!calls.some((args) => args[0] === 'ps'));
});

test('pn cert pauses a running certbot service and restores it when issuing fails', () => {
  const cwd = makeProject();
  const calls = [];

  assert.throws(
    () =>
      certProject('app.example.com', cwd, (args) => {
        calls.push(args);
        if (args[0] === 'run') {
          throw new Error('certbot failed');
        }
      }),
    /certbot failed/
  );

  assert.deepEqual(calls.map((args) => args[0]), ['exec', 'stop', 'run', 'up']);
  assert.deepEqual(calls[3], ['up', '-d', 'certbot']);
});

test('pn cert does not stop certbot when the renewal service is not running', () => {
  const cwd = makeProject();
  const calls = [];

  certProject('app.example.com', cwd, (args) => {
    calls.push(args);
    if (args[0] === 'exec' && args[2] === 'certbot') {
      throw new Error('not running');
    }
  });

  assert.ok(!calls.some((args) => args[0] === 'stop'));
});

test('pn cert forces renewal when moving a staging lineage to production', () => {
  const cwd = makeProject();
  writeRenewal(cwd, 'app.example.com', 'server = https://acme-staging-v02.api.letsencrypt.org/directory');
  const runs = [];

  certProject('app.example.com', cwd, (args) => args[0] === 'run' && runs.push(args));
  certProject('app.example.com', cwd, (args) => args[0] === 'run' && runs.push(args), undefined, {
    staging: true,
  });

  assert.ok(runs[0].includes('--force-renewal'));
  assert.ok(!runs[0].includes('--keep-until-expiring'));
  assert.ok(runs[1].includes('--keep-until-expiring'));
  assert.ok(!runs[1].includes('--force-renewal'));
});

test('pn cert --force-renew always forces renewal', () => {
  const cwd = makeProject();
  const runs = [];

  certProject('app.example.com', cwd, (args) => args[0] === 'run' && runs.push(args), undefined, {
    forceRenew: true,
  });

  assert.ok(runs[0].includes('--force-renewal'));
});

test('pn remove --purge-cert deletes the certbot lineage', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);
  writeRenewal(cwd, 'app.example.com');
  const calls = [];

  const output = removeSite('app.example.com', cwd, {
    purgeCert: true,
    runCompose: (args) => calls.push(args),
  });

  assert.match(
    output,
    /Removed app\.example\.com\.\nDeleted certificate lineage for app\.example\.com\./
  );
  const deleteCall = calls.find((args) => args.includes('delete'));
  assert.deepEqual(deleteCall.slice(-3), ['--cert-name', 'app.example.com', '--non-interactive']);
});

test('pn remove --purge-cert removes a self-signed live directory', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);
  writeLiveCert(cwd, 'app.example.com');

  const output = removeSite('app.example.com', cwd, { purgeCert: true, runCompose: () => {} });

  assert.match(output, /Removed self-signed certificate for app\.example\.com\./);
  assert.ok(!fs.existsSync(path.join(cwd, 'ssl', 'certs', 'live', 'app.example.com')));
});

test('HSTS includeSubDomains is opt-in per site', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);
  addSite('apex.example.com', '127.0.0.1:3001', { hstsSubdomains: true }, cwd);

  const read = (name) =>
    fs.readFileSync(path.join(cwd, 'nginx', 'templates', `${name}.conf.template`), 'utf8');
  assert.doesNotMatch(read('app.example.com'), /includeSubDomains/);
  assert.match(read('apex.example.com'), /max-age=\$\{HSTS_MAX_AGE\}; includeSubDomains/);
});

test('pn add explains the self-signed period for SSL sites without --cert', () => {
  const cwd = makeProject();

  assert.match(addSite('app.example.com', '127.0.0.1:3000', {}, cwd), /pn cert app\.example\.com/);
  assert.doesNotMatch(
    addSite('plain.example.com', '127.0.0.1:3000', { ssl: false }, cwd),
    /self-signed/
  );
});
