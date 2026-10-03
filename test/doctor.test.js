const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { addSite, certPreflight, doctorProject, initProject } = require('../lib/commands');
const { formatDoctor, letsEncryptAllowed } = require('../lib/doctor');

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-doctor-'));
  initProject(cwd);
  addSite('app.example.com', '127.0.0.1:3000', { www: true }, cwd);
  return cwd;
}

// A docker stand-in: every service "runs" unless listed in options.down, `run` (nginx -t) can fail.
function fakeCompose({ down = [], badConfig = false, noCompose = false } = {}) {
  return (args) => {
    if (noCompose) {
      throw new Error('docker: command not found');
    }
    if (args[0] === 'version') {
      return 'Docker Compose version v2.99.0\n';
    }
    if (args[0] === 'exec' && down.includes(args[2])) {
      throw new Error('not running');
    }
    if (args[0] === 'exec' && args.includes('nginx -v 2>&1')) {
      return 'nginx version: nginx/1.30.1\n';
    }
    if (args[0] === 'run' && badConfig) {
      throw new Error('nginx: [emerg] unknown directive');
    }
    return undefined;
  };
}

const noRecords = () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' }));

function fakeDns({ a = {}, aaaa = {}, caa = {} } = {}) {
  const answer = (table) => (name) => (table[name] ? Promise.resolve(table[name]) : noRecords());
  return { resolve4: answer(a), resolve6: answer(aaaa), resolveCaa: answer(caa) };
}

const DNS_OK = fakeDns({ a: { 'app.example.com': ['203.0.113.10'], 'www.app.example.com': ['203.0.113.10'] } });

// Serves the test file the way nginx would when it is reachable.
function servingHttp(cwd, { reachable = true, status = 200, v6 = reachable } = {}) {
  const requests = [];
  const get = async (url, options = {}) => {
    requests.push({ url, family: options.family });
    if (options.family === 6 ? !v6 : !reachable) {
      throw Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' });
    }
    const name = url.split('/').pop();
    const file = path.join(cwd, 'ssl', 'www', '.well-known', 'acme-challenge', name);
    return { status, body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
  };
  get.requests = requests;
  return get;
}

const VALID_CERTS = () => [{ name: 'app.example.com', renewal: true, expires: '2027-01-01', daysLeft: 90 }];

const tlsFine = async () => ({ issuer: "Let's Encrypt", validTo: '2027-01-01', selfSigned: false });

function statusOf(report, id) {
  return report.checks.find((entry) => entry.id === id);
}

test('project checks: healthy running proxy', async () => {
  const cwd = makeProject();
  const report = await doctorProject(undefined, {
    cwd,
    runCompose: fakeCompose(),
    certificateReport: () => [],
  });

  assert.equal(statusOf(report, 'compose').status, 'ok');
  assert.match(statusOf(report, 'compose').message, /v2\.99\.0/);
  assert.equal(statusOf(report, 'schema').status, 'ok');
  assert.match(statusOf(report, 'proxy').message, /running \(nginx 1\.30\.1\)/);
  assert.equal(statusOf(report, 'config').status, 'ok');
  assert.equal(statusOf(report, 'ports'), undefined);
  assert.equal(report.summary.fail, 0);
});

test('project checks: missing docker, pending migration, invalid templates', async () => {
  const cwd = makeProject();
  fs.writeFileSync(path.join(cwd, 'nginx', 'nginx.conf'), '# old\n');

  const missing = await doctorProject(undefined, { cwd, runCompose: fakeCompose({ noCompose: true }), certificateReport: () => [] });
  assert.equal(statusOf(missing, 'compose').status, 'fail');
  assert.match(statusOf(missing, 'compose').hint, /Install Docker/);
  assert.equal(statusOf(missing, 'schema').status, 'warn');
  assert.match(statusOf(missing, 'schema').hint, /pn migrate/);

  const broken = await doctorProject(undefined, { cwd, runCompose: fakeCompose({ badConfig: true }), certificateReport: () => [] });
  assert.equal(statusOf(broken, 'config').status, 'fail');
  assert.match(statusOf(broken, 'config').message, /running proxy keeps its previous configuration/);
});

test('project checks: stopped proxy and ports in use', async () => {
  const cwd = makeProject();
  const common = { cwd, runCompose: fakeCompose({ down: ['proxy-nginx', 'certbot'] }), certificateReport: () => [] };

  const free = await doctorProject(undefined, { ...common, isPortInUse: () => false });
  assert.equal(statusOf(free, 'proxy').status, 'warn');
  assert.match(statusOf(free, 'proxy').hint, /pn up/);
  assert.match(statusOf(free, 'ports').message, /free/);

  const busy = await doctorProject(undefined, { ...common, isPortInUse: (port) => port === 80 });
  assert.equal(statusOf(busy, 'ports').status, 'fail');
  assert.match(statusOf(busy, 'ports').message, /Port 80 is already used/);
});

test('certificate checks flag expired, expiring, self-signed, staging and missing certificates', async () => {
  const cwd = makeProject();
  const certs = [
    { name: 'app.example.com', renewal: true, expires: '2026-01-01', daysLeft: -5 },
    { name: 'soon.example.com', renewal: true, expires: '2026-10-10', daysLeft: 7 },
    { name: 'dev.example.com', renewal: false, expires: '2027-01-01', daysLeft: 90, selfSigned: true },
    { name: 'test.example.com', renewal: true, expires: '2027-01-01', daysLeft: 90, staging: true },
  ];

  const report = await doctorProject(undefined, { cwd, runCompose: fakeCompose(), certificateReport: () => certs });

  assert.equal(statusOf(report, 'cert:app.example.com').status, 'fail');
  assert.match(statusOf(report, 'cert:app.example.com').hint, /pn cert app\.example\.com --force-renew/);
  assert.equal(statusOf(report, 'cert:soon.example.com').status, 'warn');
  assert.match(statusOf(report, 'cert:dev.example.com').message, /self-signed/);
  assert.match(statusOf(report, 'cert:test.example.com').message, /staging/);

  const none = await doctorProject(undefined, { cwd, runCompose: fakeCompose(), certificateReport: () => [] });
  assert.equal(statusOf(none, 'cert:app.example.com').status, 'warn');
  assert.match(statusOf(none, 'cert:app.example.com').hint, /pn cert app\.example\.com/);
});

test('a stopped certbot service is reported when certificates depend on renewal', async () => {
  const cwd = makeProject();
  const certs = [{ name: 'app.example.com', renewal: true, expires: '2027-01-01', daysLeft: 90 }];

  const report = await doctorProject(undefined, { cwd, runCompose: fakeCompose({ down: ['certbot'] }), certificateReport: () => certs });

  assert.equal(statusOf(report, 'renewal').status, 'warn');
  assert.match(statusOf(report, 'renewal').message, /will not renew/);
});

test('domain checks: everything reachable', async () => {
  const cwd = makeProject();
  const http = servingHttp(cwd);

  const report = await doctorProject('app.example.com', {
    cwd,
    runCompose: fakeCompose(),
    certificateReport: VALID_CERTS,
    dns: DNS_OK,
    httpGet: http,
    tlsProbe: tlsFine,
    localAddresses: () => ['203.0.113.10', '10.0.0.4'],
    randomToken: (() => { let n = 0; return () => `t${n += 1}`; })(),
  });

  assert.equal(statusOf(report, 'site').status, 'ok');
  assert.match(statusOf(report, 'site').message, /names: app\.example\.com, www\.app\.example\.com/);
  assert.match(statusOf(report, 'dns:app.example.com').message, /-> 203\.0\.113\.10/);
  assert.equal(statusOf(report, 'dns:www.app.example.com').status, 'ok');
  assert.equal(statusOf(report, 'address').status, 'ok');
  assert.equal(statusOf(report, 'caa').status, 'ok');
  assert.equal(statusOf(report, 'challenge:app.example.com').status, 'ok');
  assert.equal(statusOf(report, 'challenge:www.app.example.com').status, 'ok');
  assert.match(statusOf(report, 'https').message, /Let's Encrypt, valid until 2027-01-01/);
  assert.equal(report.summary.fail + report.summary.warn, 0);
  // The temporary test files are gone.
  const dir = path.join(cwd, 'ssl', 'www', '.well-known', 'acme-challenge');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('domain checks: no DNS record is a failure with a fix', async () => {
  const cwd = makeProject();

  const report = await doctorProject('app.example.com', {
    cwd,
    runCompose: fakeCompose(),
    certificateReport: () => [],
    dns: fakeDns({ a: { 'www.app.example.com': ['203.0.113.10'] } }),
    httpGet: servingHttp(cwd),
    tlsProbe: tlsFine,
  });

  const missing = statusOf(report, 'dns:app.example.com');
  assert.equal(missing.status, 'fail');
  assert.match(missing.message, /no A or AAAA record/);
  assert.match(missing.hint, /dig \+short app\.example\.com/);
  assert.equal(statusOf(report, 'challenge:app.example.com'), undefined);
  assert.equal(report.summary.fail, 1);
});

test('domain checks: DNS address versus this server', async () => {
  const cwd = makeProject();
  const base = { cwd, runCompose: fakeCompose(), certificateReport: () => [], dns: DNS_OK, httpGet: servingHttp(cwd), tlsProbe: tlsFine };

  const matches = await doctorProject('app.example.com', { ...base, ip: '203.0.113.10' });
  assert.match(statusOf(matches, 'address').message, /points at 203\.0\.113\.10, as expected/);

  const wrong = await doctorProject('app.example.com', { ...base, ip: '198.51.100.7' });
  assert.equal(statusOf(wrong, 'address').status, 'fail');
  assert.match(statusOf(wrong, 'address').message, /203\.0\.113\.10 but this server is 198\.51\.100\.7/);

  const unknown = await doctorProject('app.example.com', { ...base, localAddresses: () => ['10.0.0.4'] });
  assert.equal(statusOf(unknown, 'address').status, 'info');
  assert.match(statusOf(unknown, 'address').hint, /--ip <public address>/);

  await assert.rejects(() => doctorProject('app.example.com', { ...base, ip: 'not-an-ip' }), /Invalid --ip/);
});

test('domain checks: CAA records are inherited and must allow Let\'s Encrypt', async () => {
  const cwd = makeProject();
  const base = { cwd, runCompose: fakeCompose(), certificateReport: () => [], httpGet: servingHttp(cwd), tlsProbe: tlsFine };
  const a = { 'app.example.com': ['203.0.113.10'], 'www.app.example.com': ['203.0.113.10'] };

  const forbidden = await doctorProject('app.example.com', {
    ...base,
    dns: fakeDns({ a, caa: { 'example.com': [{ critical: 0, issue: 'digicert.com' }] } }),
  });
  assert.equal(statusOf(forbidden, 'caa').status, 'fail');
  assert.match(statusOf(forbidden, 'caa').message, /CAA on example\.com does not allow Let's Encrypt \(allowed: digicert\.com\)/);
  assert.match(statusOf(forbidden, 'caa').hint, /0 issue "letsencrypt\.org"/);

  const allowed = await doctorProject('app.example.com', {
    ...base,
    dns: fakeDns({ a, caa: { 'app.example.com': [{ critical: 0, issue: 'letsencrypt.org' }, { critical: 0, issue: 'digicert.com' }] } }),
  });
  assert.equal(statusOf(allowed, 'caa').status, 'ok');

  assert.equal(letsEncryptAllowed([{ issuewild: 'digicert.com' }]), true);
  assert.equal(letsEncryptAllowed([{ issue: ';' }]), false);
  assert.equal(letsEncryptAllowed([{ issue: 'letsencrypt.org; accounturi=x' }]), true);
});

test('domain checks: HTTP reachability problems are warnings, not failures', async () => {
  const cwd = makeProject();
  const base = { cwd, runCompose: fakeCompose(), certificateReport: () => [], dns: DNS_OK, tlsProbe: tlsFine };

  const timeout = await doctorProject('app.example.com', { ...base, httpGet: servingHttp(cwd, { reachable: false }) });
  assert.equal(statusOf(timeout, 'challenge:app.example.com').status, 'warn');
  assert.match(statusOf(timeout, 'challenge:app.example.com').message, /not served by this proxy \(ETIMEDOUT\)/);
  assert.match(statusOf(timeout, 'challenge:app.example.com').hint, /port 80 is open.*hairpin/);
  assert.equal(timeout.summary.fail, 0);

  const notFound = await doctorProject('app.example.com', { ...base, httpGet: servingHttp(cwd, { status: 404 }) });
  assert.match(statusOf(notFound, 'challenge:app.example.com').message, /HTTP 404/);

  const stopped = await doctorProject('app.example.com', { ...base, runCompose: fakeCompose({ down: ['proxy-nginx'] }), isPortInUse: () => false, httpGet: servingHttp(cwd) });
  assert.equal(statusOf(stopped, 'challenge').status, 'info');
  assert.match(statusOf(stopped, 'challenge').hint, /pn up/);
});

test('domain checks: an AAAA record that does not reach the proxy is called out', async () => {
  const cwd = makeProject();
  const dns = fakeDns({
    a: { 'app.example.com': ['203.0.113.10'], 'www.app.example.com': ['203.0.113.10'] },
    aaaa: { 'app.example.com': ['2001:db8::10'] },
  });

  const broken = await doctorProject('app.example.com', {
    cwd, runCompose: fakeCompose(), certificateReport: () => [], dns, tlsProbe: tlsFine,
    httpGet: servingHttp(cwd, { reachable: true, v6: false }),
  });
  assert.equal(statusOf(broken, 'ipv6:app.example.com').status, 'warn');
  assert.match(statusOf(broken, 'ipv6:app.example.com').hint, /prefers IPv6/);

  const working = await doctorProject('app.example.com', {
    cwd, runCompose: fakeCompose(), certificateReport: () => [], dns, tlsProbe: tlsFine,
    httpGet: servingHttp(cwd),
  });
  assert.equal(statusOf(working, 'ipv6:app.example.com').status, 'ok');
  assert.equal(statusOf(working, 'ipv6:www.app.example.com'), undefined);
});

test('domain checks: HTTPS probe results', async () => {
  const cwd = makeProject();
  const base = { cwd, runCompose: fakeCompose(), certificateReport: () => [], dns: DNS_OK, httpGet: servingHttp(cwd) };

  const selfSigned = await doctorProject('app.example.com', { ...base, tlsProbe: async () => ({ issuer: 'app', selfSigned: true }) });
  assert.equal(statusOf(selfSigned, 'https').status, 'warn');
  assert.match(statusOf(selfSigned, 'https').hint, /pn cert app\.example\.com/);

  const refused = await doctorProject('app.example.com', { ...base, tlsProbe: async () => ({ error: 'ECONNREFUSED' }) });
  assert.match(statusOf(refused, 'https').message, /not reachable \(ECONNREFUSED\)/);
});

test('a domain without a site template is still checked, with a pointer to pn add', async () => {
  const cwd = makeProject();

  const report = await doctorProject('other.example.com', {
    cwd, runCompose: fakeCompose(), certificateReport: () => [], tlsProbe: tlsFine, httpGet: servingHttp(cwd),
    dns: fakeDns({ a: { 'other.example.com': ['203.0.113.20'] } }),
  });

  assert.equal(statusOf(report, 'site').status, 'warn');
  assert.match(statusOf(report, 'site').hint, /pn add other\.example\.com/);
  assert.equal(statusOf(report, 'dns:other.example.com').status, 'ok');
});

test('cert preflight blocks only on problems that make issuing impossible', async () => {
  const cwd = makeProject();
  const base = { cwd, runCompose: fakeCompose(), certificateReport: () => [], tlsProbe: tlsFine };

  const good = await certPreflight('app.example.com', { ...base, dns: DNS_OK, httpGet: servingHttp(cwd, { reachable: false }) });
  assert.deepEqual(good.blockers, []);
  assert.ok(good.warnings.length > 0);
  assert.equal(good.report.sections.length, 1);
  assert.equal(good.report.sections[0].title, 'Domain app.example.com');

  const noDns = await certPreflight('app.example.com', { ...base, dns: fakeDns(), httpGet: servingHttp(cwd) });
  assert.ok(noDns.blockers.length >= 2);
  assert.ok(noDns.blockers.every((entry) => entry.status === 'fail'));
});

test('formatDoctor prints sections, hints, and a summary', async () => {
  const cwd = makeProject();
  const report = await doctorProject('app.example.com', {
    cwd, runCompose: fakeCompose({ noCompose: true }), certificateReport: () => [], dns: fakeDns(), httpGet: servingHttp(cwd), tlsProbe: tlsFine,
  });

  const text = formatDoctor(report);

  assert.match(text, /^Project:\n {2}\[FAIL\] Docker Compose is not available\n {9}-> Install Docker/m);
  assert.match(text, /^Domain app\.example\.com:/m);
  assert.match(text, /\d+ problem\(s\), \d+ warning\(s\)\.$/);
  assert.equal(JSON.parse(JSON.stringify(report)).summary.fail, report.summary.fail);

  const fine = await doctorProject(undefined, { cwd, runCompose: fakeCompose(), certificateReport: VALID_CERTS });
  assert.match(formatDoctor(fine), /Everything looks fine\.$/);
});
