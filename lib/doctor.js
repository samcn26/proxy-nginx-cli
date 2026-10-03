const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');

const { certificateReport } = require('./certs');
const { planMigration, projectSchemaVersion } = require('./migrate');
const { PROJECT_SCHEMA_VERSION } = require('./project-files');
const { readSites } = require('./sites');

const EXPIRING_SOON_DAYS = 14;
const TLS_TIMEOUT_MS = 5000;

const result = (id, status, message, hint) => ({ id, status, message, ...(hint ? { hint } : {}) });
const ok = (id, message) => result(id, 'ok', message);
const info = (id, message, hint) => result(id, 'info', message, hint);
const warn = (id, message, hint) => result(id, 'warn', message, hint);
const fail = (id, message, hint) => result(id, 'fail', message, hint);

function summarize(checks) {
  return {
    ok: checks.filter((entry) => entry.status === 'ok').length,
    info: checks.filter((entry) => entry.status === 'info').length,
    warn: checks.filter((entry) => entry.status === 'warn').length,
    fail: checks.filter((entry) => entry.status === 'fail').length,
  };
}

function errorText(error) {
  return (error && (error.code || error.message)) || String(error);
}

// ---------------------------------------------------------------- defaults

function defaultHttpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { family: options.family, timeout: 5000, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 1024) {
          body += chunk;
        }
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

function defaultTlsProbe(host, port = 443) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: TLS_TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve({
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'unknown',
        validTo: cert.valid_to ? new Date(cert.valid_to).toISOString().slice(0, 10) : null,
        selfSigned: Boolean(cert.issuer && cert.subject && cert.issuer.CN === cert.subject.CN && cert.issuer.O === cert.subject.O),
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ error: 'timed out' });
    });
    socket.on('error', (error) => resolve({ error: errorText(error) }));
  });
}

function defaultLocalAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && !entry.internal)
    .map((entry) => entry.address);
}

const defaultRandomToken = () => crypto.randomBytes(12).toString('hex');

// ------------------------------------------------------------ project checks

function projectChecks(ctx) {
  const { cwd } = ctx;
  const checks = [];

  try {
    const output = ctx.runCompose(['version'], { cwd, stdio: 'pipe', encoding: 'utf8' });
    const firstLine = String(output || '').split('\n')[0].trim();
    checks.push(ok('compose', `Docker Compose works${firstLine ? ` (${firstLine})` : ''}`));
  } catch {
    checks.push(fail('compose', 'Docker Compose is not available', 'Install Docker with the Compose plugin and make sure this user can run docker.'));
  }

  try {
    const version = projectSchemaVersion(cwd);
    const pending = planMigration(cwd).length;
    if (pending > 0 || version < PROJECT_SCHEMA_VERSION) {
      checks.push(warn(
        'schema',
        `Project files are behind this pn version (schema ${version}, latest ${PROJECT_SCHEMA_VERSION}; ${pending} file(s) differ)`,
        'Preview with: pn migrate   Apply with: pn migrate --yes'
      ));
    } else {
      checks.push(ok('schema', `Project files are up to date (schema ${version})`));
    }
  } catch (error) {
    checks.push(warn('schema', `Could not compare project files with this pn version: ${error.message}`));
  }

  const running = ctx.isServiceRunning('proxy-nginx');
  if (running) {
    const version = ctx.nginxVersion();
    checks.push(ok('proxy', `Proxy container is running${version ? ` (nginx ${version})` : ''}`));
    try {
      ctx.runCompose(['run', '--rm', '-T', '--no-deps', 'proxy-nginx', 'nginx', '-t'], { cwd, stdio: 'pipe' });
      checks.push(ok('config', 'The templates on disk pass nginx -t'));
    } catch {
      checks.push(fail(
        'config',
        'The templates on disk fail nginx -t (the running proxy keeps its previous configuration)',
        'Run: pn reload   to see nginx\'s error, then fix it with: pn template edit <domain>'
      ));
    }
  } else {
    checks.push(warn('proxy', 'Proxy container is not running', 'Start it with: pn up'));
    const busy = [80, 443].filter((port) => ctx.isPortInUse(port));
    if (busy.length > 0) {
      checks.push(fail(
        'ports',
        `Port ${busy.join(' and ')} is already used by another process, so the proxy cannot start`,
        'Find it with: ss -ltnp | grep -E ":(80|443) "   Then stop that service.'
      ));
    } else {
      checks.push(ok('ports', 'Ports 80 and 443 are free'));
    }
  }

  checks.push(...certificateChecks(ctx));

  const managed = certificatesOf(ctx).filter((cert) => cert.renewal);
  if (managed.length > 0 && !ctx.isServiceRunning('certbot')) {
    checks.push(warn(
      'renewal',
      'The certbot renewal service is not running, so certificates will not renew',
      'Start it with: docker compose up -d certbot   (pn cert does this after issuing)'
    ));
  }

  return checks;
}

function certificatesOf(ctx) {
  return ctx.certificateReport ? ctx.certificateReport() : certificateReport(ctx.cwd);
}

function certificateChecks(ctx) {
  const certs = certificatesOf(ctx);
  const byName = new Map(certs.map((cert) => [cert.name, cert]));
  const checks = [];

  for (const site of readSites(ctx.cwd).filter((candidate) => candidate.ssl)) {
    if (!byName.has(site.domain)) {
      checks.push(warn(
        `cert:${site.domain}`,
        `${site.domain} has no certificate yet (nginx generates a self-signed one at start)`,
        `Request one with: pn cert ${site.domain}`
      ));
    }
  }

  for (const cert of certs) {
    if (cert.daysLeft !== undefined && cert.daysLeft < 0) {
      checks.push(fail(`cert:${cert.name}`, `Certificate for ${cert.name} expired on ${cert.expires}`, `Renew it: pn cert ${cert.name} --force-renew`));
    } else if (cert.daysLeft !== undefined && cert.daysLeft <= EXPIRING_SOON_DAYS) {
      checks.push(warn(`cert:${cert.name}`, `Certificate for ${cert.name} expires in ${cert.daysLeft} day(s) (${cert.expires})`, `If renewal is not working: pn cert ${cert.name} --force-renew`));
    } else if (cert.selfSigned) {
      checks.push(warn(`cert:${cert.name}`, `${cert.name} still uses a self-signed certificate (browsers will warn)`, `Request a real one: pn cert ${cert.name}`));
    } else if (cert.staging) {
      checks.push(warn(`cert:${cert.name}`, `${cert.name} has a Let's Encrypt staging certificate (not trusted by browsers)`, `Switch to production: pn cert ${cert.name}`));
    }
  }

  if (checks.length === 0) {
    const dated = certs.filter((cert) => cert.daysLeft !== undefined);
    checks.push(ok(
      'certs',
      certs.length === 0
        ? 'No certificates to check'
        : `${certs.length} certificate(s) look fine${dated.length ? `, the next expires in ${Math.min(...dated.map((cert) => cert.daysLeft))} day(s)` : ''}`
    ));
  }

  return checks;
}

// ------------------------------------------------------------ domain checks

async function lookup(dns, name) {
  const attempt = async (call) => {
    try {
      return await call(name);
    } catch {
      return [];
    }
  };

  return { v4: await attempt(dns.resolve4.bind(dns)), v6: await attempt(dns.resolve6.bind(dns)) };
}

// CAA is inherited from parent names, so climb until a policy is found.
async function caaPolicy(dns, name) {
  const labels = name.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join('.');
    try {
      const records = await dns.resolveCaa(candidate);
      if (records && records.length > 0) {
        return { name: candidate, records };
      }
    } catch {
      // No CAA data at this level: keep climbing.
    }
  }

  return null;
}

function letsEncryptAllowed(records) {
  const issuers = records.filter((record) => Object.prototype.hasOwnProperty.call(record, 'issue'));
  return issuers.length === 0 || issuers.some((record) => String(record.issue).split(';')[0].trim() === 'letsencrypt.org');
}

async function challengeProbe(ctx, name, family) {
  const dir = path.join(ctx.cwd, 'ssl', 'www', '.well-known', 'acme-challenge');
  const token = `pn-doctor-${ctx.randomToken()}`;
  const body = ctx.randomToken();
  const file = path.join(dir, token);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o644 });
  } catch (error) {
    return { error: `could not write the test file (${errorText(error)})` };
  }

  try {
    const response = await ctx.httpGet(`http://${name}/.well-known/acme-challenge/${token}`, family ? { family } : {});
    return response.status === 200 && response.body === body
      ? { reached: true }
      : { reached: false, detail: `HTTP ${response.status}${response.status === 200 ? ' with different content' : ''}` };
  } catch (error) {
    return { reached: false, detail: errorText(error) };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function domainChecks(ctx) {
  const { domain } = ctx;
  const names = ctx.names;
  const checks = [];
  const site = readSites(ctx.cwd).find((candidate) => candidate.domain === domain);
  const proxyRunning = ctx.isServiceRunning('proxy-nginx');

  checks.push(site
    ? ok('site', `Site template found for ${domain}${names.length > 1 ? ` (names: ${names.join(', ')})` : ''}`)
    : warn('site', `No site template for ${domain}; only DNS and reachability are checked`, `Add one: pn add ${domain} <host:port>`));

  const resolved = new Map();
  for (const name of names) {
    const addresses = await lookup(ctx.dns, name);
    resolved.set(name, addresses);
    if (addresses.v4.length === 0 && addresses.v6.length === 0) {
      checks.push(fail(
        `dns:${name}`,
        `${name} has no A or AAAA record, so Let's Encrypt cannot reach it`,
        'Create a DNS record pointing at this server and wait for it to propagate (dig +short ' + name + ').'
      ));
    } else {
      checks.push(ok(`dns:${name}`, `${name} -> ${[...addresses.v4, ...addresses.v6].join(', ')}`));
    }
  }

  checks.push(addressMatchCheck(ctx, resolved));

  const policy = await caaPolicy(ctx.dns, domain);
  if (!policy) {
    checks.push(ok('caa', 'No CAA record restricts certificate issuance'));
  } else if (letsEncryptAllowed(policy.records)) {
    checks.push(ok('caa', `CAA on ${policy.name} allows Let's Encrypt`));
  } else {
    const allowed = policy.records.filter((record) => 'issue' in record).map((record) => String(record.issue) || '(none)').join(', ');
    checks.push(fail(
      'caa',
      `CAA on ${policy.name} does not allow Let's Encrypt (allowed: ${allowed})`,
      'Add a CAA record:  0 issue "letsencrypt.org"  or remove the restrictive one.'
    ));
  }

  if (!proxyRunning) {
    checks.push(info('challenge', 'Proxy is not running, so HTTP reachability was not tested', 'Start it with: pn up   then run pn doctor again.'));
  } else {
    for (const name of names) {
      const addresses = resolved.get(name);
      if (addresses.v4.length === 0 && addresses.v6.length === 0) {
        continue;
      }

      const outcome = await challengeProbe(ctx, name);
      if (outcome.error) {
        checks.push(warn(`challenge:${name}`, `${name}: ${outcome.error}`));
      } else if (outcome.reached) {
        checks.push(ok(`challenge:${name}`, `${name}: a test file under /.well-known/acme-challenge/ was served by this proxy over HTTP`));
      } else {
        checks.push(warn(
          `challenge:${name}`,
          `${name}: the test file was not served by this proxy (${outcome.detail})`,
          'Check that the DNS record points at this server and that port 80 is open (firewall / cloud security group). ' +
            'From the server itself this can also be a hairpin-NAT limitation, so test from another machine: curl -I http://' + name + '/'
        ));
      }

      if (addresses.v6.length > 0) {
        const v6 = await challengeProbe(ctx, name, 6);
        if (v6.reached) {
          checks.push(ok(`ipv6:${name}`, `${name}: IPv6 reaches this proxy`));
        } else if (!v6.error) {
          checks.push(warn(
            `ipv6:${name}`,
            `${name} has an AAAA record but IPv6 did not reach this proxy (${v6.detail})`,
            "Let's Encrypt prefers IPv6 when an AAAA record exists. Fix IPv6 on this server or remove the AAAA record."
          ));
        }
      }
    }
  }

  const https = await ctx.tlsProbe(domain, 443);
  if (https.error) {
    checks.push(warn('https', `HTTPS on ${domain}:443 is not reachable (${https.error})`, 'Check that port 443 is open and that the proxy is running.'));
  } else if (https.selfSigned) {
    checks.push(warn('https', `${domain}:443 serves a self-signed certificate`, `Request a real one: pn cert ${domain}`));
  } else {
    checks.push(ok('https', `${domain}:443 serves a certificate from ${https.issuer}${https.validTo ? `, valid until ${https.validTo}` : ''}`));
  }

  return checks;
}

function addressMatchCheck(ctx, resolved) {
  const v4 = [...new Set([...resolved.values()].flatMap((addresses) => addresses.v4))];
  if (v4.length === 0) {
    return info('address', 'No IPv4 address to compare with this server');
  }

  if (ctx.ip) {
    const wrong = v4.filter((address) => address !== ctx.ip);
    return wrong.length === 0
      ? ok('address', `DNS points at ${ctx.ip}, as expected`)
      : fail('address', `DNS points at ${wrong.join(', ')} but this server is ${ctx.ip}`, 'Update the A record(s) to the server address.');
  }

  const local = ctx.localAddresses();
  if (v4.some((address) => local.includes(address))) {
    return ok('address', 'DNS points at an address of this host');
  }

  return info(
    'address',
    `Could not confirm that ${v4.join(', ')} is this server (cloud providers often hide the public address from the host)`,
    'Compare it yourself or pass the address: pn doctor <domain> --ip <public address>'
  );
}

// --------------------------------------------------------------- entry points

// scope: 'all' (default), 'project' or 'domain'. A domain is only checked when given.
async function runDoctor(input) {
  const ctx = {
    dns: require('node:dns').promises,
    httpGet: defaultHttpGet,
    tlsProbe: defaultTlsProbe,
    localAddresses: defaultLocalAddresses,
    randomToken: defaultRandomToken,
    scope: 'all',
    ...input,
  };

  if (ctx.ip !== undefined && net.isIPv4(ctx.ip) === false) {
    throw new Error(`Invalid --ip: ${ctx.ip} (expected an IPv4 address).`);
  }

  const sections = [];
  if (ctx.scope !== 'domain') {
    sections.push({ title: 'Project', checks: projectChecks(ctx) });
  }
  if (ctx.domain && ctx.scope !== 'project') {
    sections.push({ title: `Domain ${ctx.domain}`, checks: await domainChecks(ctx) });
  }

  const checks = sections.flatMap((section) => section.checks);
  return { sections, checks, summary: summarize(checks) };
}

function formatDoctor(report) {
  const labels = { ok: '[ok]  ', info: '[info]', warn: '[warn]', fail: '[FAIL]' };
  const lines = [];

  for (const section of report.sections) {
    lines.push(`${section.title}:`);
    for (const entry of section.checks) {
      lines.push(`  ${labels[entry.status]} ${entry.message}`);
      if (entry.hint) {
        lines.push(`         -> ${entry.hint}`);
      }
    }
    lines.push('');
  }

  const { fail: failures, warn: warnings } = report.summary;
  lines.push(failures + warnings === 0
    ? 'Everything looks fine.'
    : `${failures} problem(s), ${warnings} warning(s).`);
  return lines.join('\n');
}

module.exports = {
  caaPolicy,
  formatDoctor,
  letsEncryptAllowed,
  runDoctor,
};
