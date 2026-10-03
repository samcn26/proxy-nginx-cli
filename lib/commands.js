const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');

const { readProxyNetworks, writeProxyNetworks } = require('./compose-file');
const {
  certificateReport,
  certsDirOf,
  formatCertificate,
  hasRenewalConfig,
  isStagingLineage,
  renewalConfPath,
} = require('./certs');
const { BASE_TEMPLATES, listSiteDomains, readSites } = require('./sites');

const UP_ARGS = ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'];
const DEFAULT_NGINX_IMAGE = 'nginx:1.30';
const DEFAULT_CERTBOT_IMAGE = 'certbot/certbot:v5.8.0';

function initProject(cwd = process.cwd()) {
  ensureDir(path.join(cwd, 'nginx', 'templates'));
  ensureDir(path.join(cwd, 'nginx', 'docker-entrypoint.d'));
  ensureDir(path.join(cwd, 'ssl', 'certs'));
  ensureDir(path.join(cwd, 'ssl', 'www'));
  ensureDir(path.join(cwd, 'logs'));
  ensureDir(path.join(cwd, 'sites'));

  writeFileIfMissing(path.join(cwd, 'Dockerfile'), dockerfileTemplate());
  writeFileIfMissing(path.join(cwd, 'docker-compose.yml'), composeTemplate());
  writeFileIfMissing(path.join(cwd, '.env'), envTemplate());
  writeFileIfMissing(path.join(cwd, 'nginx', 'nginx.conf'), nginxConfTemplate());
  writeFileIfMissing(
    path.join(cwd, 'nginx', 'docker-entrypoint.d', '40-generate-dev-certs.sh'),
    devCertEntrypointTemplate(),
    0o755
  );
  writeFileIfMissing(
    path.join(cwd, 'nginx', 'docker-entrypoint.d', '50-reload-renewed-certs.sh'),
    reloadRenewedCertsEntrypointTemplate(),
    0o755
  );
  writeFileIfMissing(
    path.join(cwd, 'nginx', 'docker-entrypoint.d', '60-rotate-logs.sh'),
    rotateLogsEntrypointTemplate(),
    0o755
  );
  writeFileIfMissing(
    path.join(cwd, 'nginx', 'templates', '00-unmatched-host.conf.template'),
    unmatchedHostTemplate()
  );
  ensureConnectionUpgradeTemplate(path.join(cwd, 'nginx', 'templates'));

  return 'Initialized proxy nginx project.';
}

function ensureConnectionUpgradeTemplate(templatesDir) {
  writeFileIfMissing(
    path.join(templatesDir, '00-connection-upgrade.conf.template'),
    connectionUpgradeTemplate()
  );
}

function addSite(domain, target, options = {}, cwd = process.cwd()) {
  domain = normalizeDomain(domain);

  const templatesDir = path.join(cwd, 'nginx', 'templates');
  if (!fs.existsSync(templatesDir)) {
    throw new Error('No nginx/templates directory found. Run pn init first.');
  }

  const upstream = parseTarget(target, options);
  const ssl = options.ssl !== false;
  if (options.cert && !ssl) {
    throw new Error('--cert cannot be used with --no-ssl.');
  }
  const runCompose = options.runCompose || defaultComposeRunner;
  const config = siteTemplate({
    domain,
    host: upstream.host,
    port: upstream.port,
    protocol: upstream.protocol,
    ssl,
    hstsSubdomains: Boolean(options.hstsSubdomains),
  });

  const filePath = path.join(templatesDir, `${domain}.conf.template`);
  if (fs.existsSync(filePath) && !options.force) {
    return `Site template already exists for ${domain}. Use --force to overwrite.`;
  }

  ensureConnectionUpgradeTemplate(templatesDir);
  writeFile(filePath, config);

  let output = `Added ${domain} -> ${upstream.protocol}://${upstream.host}:${upstream.port}${ssl ? ' with SSL.' : ' without SSL.'}`;
  if (ssl && !options.cert) {
    output += `\nUntil you run \`pn cert ${domain}\`, a self-signed certificate is served and HTTP redirects to HTTPS (when FORCE_HTTPS=true).`;
  }

  if (options.run || options.cert) {
    output += `\n${applyProject(cwd, runCompose)}`;
  }

  if (options.cert) {
    output += `\n${certProject(domain, cwd, runCompose, timestamp, options)}`;
  }

  return output;
}

function resetProject(cwd = process.cwd()) {
  initProject(cwd);

  const templatesDir = path.join(cwd, 'nginx', 'templates');
  for (const filename of fs.readdirSync(templatesDir)) {
    if (!filename.endsWith('.conf.template')) {
      continue;
    }

    if (BASE_TEMPLATES.includes(filename)) {
      continue;
    }

    fs.rmSync(path.join(templatesDir, filename), { force: true });
  }

  return 'Reset proxy nginx project.';
}

function removeSite(domain, cwd = process.cwd(), options = {}) {
  domain = normalizeDomain(domain);

  const filePath = path.join(cwd, 'nginx', 'templates', `${domain}.conf.template`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No site template found for ${domain}.`);
  }

  fs.rmSync(filePath, { force: true });

  const runCompose = options.runCompose || defaultComposeRunner;
  let output = `Removed ${domain}.`;
  if (options.run) {
    output += `\n${applyProject(cwd, runCompose)}`;
  }

  if (options.purgeCert) {
    output += `\n${purgeCertificate(domain, cwd, runCompose)}`;
  }

  return output;
}

function networkAdd(name, options = {}) {
  assertNetworkName(name);
  const cwd = options.cwd || process.cwd();
  const runCompose = options.runCompose || defaultComposeRunner;
  const composePath = path.join(cwd, 'docker-compose.yml');
  assertProject(cwd);

  const compose = fs.readFileSync(composePath, 'utf8');
  const networks = readProxyNetworks(compose);
  if (networks.includes(name)) {
    return `Network ${name} already exists.`;
  }

  fs.writeFileSync(composePath, writeProxyNetworks(compose, [...networks, name]), 'utf8');

  let output = `Added network ${name}.`;
  if (options.run) {
    output += `\n${upProject(cwd, runCompose)}`;
  }

  return output;
}

function networkRemove(name, options = {}) {
  assertNetworkName(name);
  const cwd = options.cwd || process.cwd();
  const runCompose = options.runCompose || defaultComposeRunner;
  const composePath = path.join(cwd, 'docker-compose.yml');
  assertProject(cwd);

  const compose = fs.readFileSync(composePath, 'utf8');
  const networks = readProxyNetworks(compose);
  if (!networks.includes(name)) {
    return `Network ${name} does not exist.`;
  }

  fs.writeFileSync(
    composePath,
    writeProxyNetworks(compose, networks.filter((network) => network !== name)),
    'utf8'
  );

  let output = `Removed network ${name}.`;
  if (options.run) {
    output += `\n${upProject(cwd, runCompose)}`;
  }

  return output;
}

function assertNetworkName(name) {
  if (!name) {
    throw new Error('Network name is required.');
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name === 'default') {
    throw new Error(`Invalid Docker network name: ${name}`);
  }
}

function createExample(options = {}) {
  const cwd = options.cwd || process.cwd();
  const domain = options.domain ? normalizeDomain(options.domain) : undefined;
  if (options.cert && !domain) {
    throw new Error('--cert requires a domain.');
  }

  const exampleDir = path.join(cwd, 'example');
  const backendDir = path.join(exampleDir, 'backend');
  const proxyDir = path.join(exampleDir, 'proxy');
  const siteDomain = domain || 'local.example.test';
  const siteSsl = Boolean(domain);

  ensureDir(backendDir);
  writeFileIfMissing(path.join(backendDir, 'package.json'), examplePackageTemplate());
  writeFileIfMissing(path.join(backendDir, 'server.js'), exampleServerTemplate());

  initProject(proxyDir);
  if (domain) {
    writeFile(path.join(proxyDir, '.env'), envTemplate({ forceHttps: false }));
  }
  addSite(
    siteDomain,
    'http://host.docker.internal:6666',
    { ssl: siteSsl },
    proxyDir
  );

  if (!options.run) {
    return `Created example project at ${exampleDir}.`;
  }

  const isPortOpen = options.isPortOpen || defaultPortInUseChecker;
  for (const port of [6666, 80, 443]) {
    if (isPortOpen(port)) {
      throw new Error(`Port ${port} is already in use. Stop that service and try again.`);
    }
  }

  const spawnBackend = options.spawnBackend || spawnDetachedBackend;
  const runCompose = options.runCompose || defaultComposeRunner;
  const backendProcess = spawnBackend('node', ['server.js'], { cwd: backendDir });
  if (backendProcess && typeof backendProcess.unref === 'function') {
    backendProcess.unref();
  }

  runCompose(UP_ARGS, { cwd: proxyDir });

  let certMessage = '';
  if (options.cert) {
    certProject(domain, proxyDir, runCompose, timestamp, options);
    certMessage = `
Certificate requested for ${domain}.`;
  }

  const proxyUrl = domain ? `http://${domain}/` : 'http://127.0.0.1/';
  const curlHost = domain || 'local.example.test';

  return `Example is running.

Backend: http://127.0.0.1:6666
Proxy:   curl -H 'Host: ${curlHost}' ${proxyUrl}${certMessage}
Stop:    pn example --stop`;
}

function stopExample(options = {}) {
  const cwd = options.cwd || process.cwd();
  const proxyDir = path.join(cwd, 'example', 'proxy');

  if (!fs.existsSync(path.join(proxyDir, 'docker-compose.yml'))) {
    throw new Error('No example proxy project found. Run pn example first.');
  }

  const runCompose = options.runCompose || defaultComposeRunner;
  const stopPort = options.stopPort || stopPortListeners;

  runCompose(['down'], { cwd: proxyDir });
  stopPort(6666);

  return 'Stopped example.';
}

function upProject(cwd = process.cwd(), runCompose = defaultComposeRunner) {
  assertProject(cwd);
  validateBeforeRecreate(cwd, runCompose);
  runCompose(UP_ARGS, { cwd });
  return 'Started proxy nginx.';
}

// Re-render templates, test, and reload inside the running container. Falls back
// to a normal start when the proxy is not running.
function applyProject(cwd = process.cwd(), runCompose = defaultComposeRunner) {
  assertProject(cwd);

  if (!isProxyRunning(cwd, runCompose)) {
    runCompose(UP_ARGS, { cwd });
    return 'Started proxy nginx.';
  }

  const script = fs.readFileSync(path.join(__dirname, 'scripts', 'apply-sites.sh'), 'utf8');
  runCompose(['exec', '-T', 'proxy-nginx', 'sh', '-c', script], { cwd });
  return 'Applied site changes and reloaded proxy nginx without restarting.';
}

function isServiceRunning(cwd, runCompose, service) {
  try {
    runCompose(['exec', '-T', service, 'true'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isProxyRunning(cwd, runCompose) {
  return isServiceRunning(cwd, runCompose, 'proxy-nginx');
}

// A recreate drops every connection and fails to start on invalid config, so test
// the new configuration in a throwaway container before touching the running one.
function validateBeforeRecreate(cwd, runCompose) {
  if (!isProxyRunning(cwd, runCompose)) {
    return;
  }

  try {
    runCompose(['run', '--rm', '-T', '--no-deps', 'proxy-nginx', 'nginx', '-t'], { cwd });
  } catch {
    throw new Error('nginx config test failed; the running proxy was not touched. Fix nginx/templates and retry.');
  }
}

function stopProject(cwd = process.cwd(), runCompose = defaultComposeRunner) {
  assertProject(cwd);
  runCompose(['stop'], { cwd });
  return 'Stopped proxy nginx project.';
}

function downProject(cwd = process.cwd(), runCompose = defaultComposeRunner) {
  assertProject(cwd);
  runCompose(['down'], { cwd });
  return 'Stopped and removed proxy nginx project containers.';
}

function restartProject(cwd = process.cwd(), runCompose = defaultComposeRunner) {
  assertProject(cwd);
  validateBeforeRecreate(cwd, runCompose);
  runCompose(UP_ARGS, { cwd });
  return 'Restarted proxy nginx.';
}

function statusData(cwd, runCompose = defaultComposeRunner) {
  const compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  return {
    proxy: { running: isProxyRunning(cwd, runCompose) },
    sites: readSites(cwd),
    networks: readProxyNetworks(compose),
    certificates: certificateReport(cwd),
  };
}

function statusProject(cwd = process.cwd(), runCompose = defaultComposeRunner, options = {}) {
  assertProject(cwd);

  if (options.json) {
    return JSON.stringify(statusData(cwd, runCompose), null, 2);
  }

  runCompose(['ps'], { cwd });

  const compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  const sites = readSites(cwd).map((site) => {
    let line = site.domain;
    if (site.upstream) {
      line += ` -> ${site.upstream}`;
    }
    if (site.aliases.length > 0) {
      line += ` (aliases: ${site.aliases.join(', ')})`;
    }
    return line;
  });

  return [
    'Proxy nginx project status.',
    formatList('Sites', sites),
    formatList('Networks', readProxyNetworks(compose)),
    formatList('Certificates', certificateReport(cwd).map(formatCertificate)),
  ].join('\n');
}

function reloadProject(cwd = process.cwd(), runCompose = defaultComposeRunner) {
  assertProject(cwd);
  runCompose(['exec', 'proxy-nginx', 'nginx', '-t'], { cwd });
  runCompose(['exec', 'proxy-nginx', 'nginx', '-s', 'reload'], { cwd });
  return 'Reloaded proxy nginx.';
}

function certProject(
  domain,
  cwd = process.cwd(),
  runCompose = defaultComposeRunner,
  now = timestamp,
  options = {}
) {
  domain = normalizeDomain(domain);
  if (options.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)) {
    throw new Error(`Invalid email: ${options.email}`);
  }

  assertProject(cwd);
  backupSelfSignedCert(domain, cwd, now);

  // Moving a lineage from staging to production needs a forced renewal, otherwise
  // certbot keeps the (untrusted) staging certificate until it expires.
  const forceRenew = Boolean(options.forceRenew) || (!options.staging && isStagingLineage(cwd, domain));

  // The renewal service holds certbot's lock; pause it while we issue.
  const certbotWasRunning = isServiceRunning(cwd, runCompose, 'certbot');
  if (certbotWasRunning) {
    runCompose(['stop', 'certbot'], { cwd });
  }

  try {
    runCompose([
      'run',
      '--rm',
      '--entrypoint',
      'certbot',
      'certbot',
      'certonly',
      '--webroot',
      '-w',
      '/var/www/certbot',
      '--cert-name',
      domain,
      ...certDomains(cwd, domain).flatMap((name) => ['-d', name]),
      '--agree-tos',
      ...(options.email ? ['--email', options.email] : ['--register-unsafely-without-email']),
      '--no-eff-email',
      '--non-interactive',
      forceRenew ? '--force-renewal' : '--keep-until-expiring',
      ...(options.staging ? ['--staging'] : []),
    ], { cwd });
  } catch (error) {
    if (certbotWasRunning) {
      runCompose(['up', '-d', 'certbot'], { cwd });
    }
    throw error;
  }

  reloadProject(cwd, runCompose);
  runCompose(['up', '-d', 'certbot'], { cwd });

  return `Issued certificate for ${domain}, reloaded proxy nginx, and started certificate renewal.`;
}

// The primary domain plus any aliases declared in its site template, so one
// certificate covers every name the site answers to.
function certDomains(cwd, domain) {
  const site = readSites(cwd).find((candidate) => candidate.domain === domain);
  const aliases = (site ? site.aliases : []).filter((name) => {
    try {
      return normalizeDomain(name) === name;
    } catch {
      return false;
    }
  });

  return [domain, ...aliases];
}

function purgeCertificate(domain, cwd, runCompose) {
  const certsDir = certsDirOf(cwd);

  if (hasRenewalConfig(cwd, domain)) {
    const certbotWasRunning = isServiceRunning(cwd, runCompose, 'certbot');
    if (certbotWasRunning) {
      runCompose(['stop', 'certbot'], { cwd });
    }

    try {
      runCompose([
        'run',
        '--rm',
        '--entrypoint',
        'certbot',
        'certbot',
        'delete',
        '--cert-name',
        domain,
        '--non-interactive',
      ], { cwd });
    } finally {
      if (certbotWasRunning) {
        runCompose(['up', '-d', 'certbot'], { cwd });
      }
    }

    return `Deleted certificate lineage for ${domain}.`;
  }

  const liveDir = path.join(certsDir, 'live', domain);
  if (!fs.existsSync(liveDir)) {
    return `No certificate found for ${domain}.`;
  }

  try {
    fs.rmSync(liveDir, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') {
      throw error;
    }

    runInCertsDirAsRoot(certsDir, projectNginxImage(cwd), `rm -rf ${shellQuote(`/certs/live/${domain}`)}`);
  }

  return `Removed self-signed certificate for ${domain}.`;
}

function backupSelfSignedCert(domain, cwd, now) {
  const certsDir = certsDirOf(cwd);
  const liveDir = path.join(certsDir, 'live', domain);
  const renewalConf = renewalConfPath(cwd, domain);

  if (!fs.existsSync(liveDir)) {
    return;
  }

  if (fs.existsSync(renewalConf)) {
    if (fs.statSync(renewalConf).size > 0) {
      return;
    }

    fs.rmSync(renewalConf, { force: true });
  }

  const backupDir = path.join(
    certsDir,
    'live',
    `${domain}.bak.selfsigned.${now()}`
  );
  try {
    fs.renameSync(liveDir, backupDir);
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') {
      throw error;
    }

    moveCertDirAsRoot(certsDir, domain, path.basename(backupDir), projectNginxImage(cwd));
  }
}

function projectNginxImage(cwd) {
  try {
    const env = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
    const match = env.match(/^NGINX_IMAGE=(\S+)\s*$/m);
    if (match) {
      return match[1];
    }
  } catch {
    // No .env: use the default image.
  }

  return DEFAULT_NGINX_IMAGE;
}

function moveCertDirAsRoot(certsDir, domain, backupName, image) {
  runInCertsDirAsRoot(
    certsDir,
    image,
    `mv ${shellQuote(`/certs/live/${domain}`)} ${shellQuote(`/certs/live/${backupName}`)}`
  );
}

// Certificates created by the nginx container are root-owned; use a throwaway
// container to modify them when the current user cannot.
function runInCertsDirAsRoot(certsDir, image, command) {
  execFileSync('docker', [
    'run',
    '--rm',
    '-v',
    `${certsDir}:/certs`,
    image,
    'sh',
    '-c',
    command,
  ], {
    stdio: 'inherit',
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function createComposeRunner(execFile = execFileSync) {
  const composeCommand = resolveComposeCommand(execFile);

  return (args, options = {}) => {
    const [command, ...commandArgs] = composeCommand;
    return execFile(command, [...commandArgs, ...args], {
      stdio: 'inherit',
      ...options,
    });
  };
}

function upgradeCli(options = {}) {
  const execFile = options.execFile || execFileSync;
  const packageRoot = options.packageRoot || path.join(__dirname, '..');

  if (fs.existsSync(path.join(packageRoot, '.git'))) {
    execFile('git', ['-C', packageRoot, 'pull', '--ff-only'], {
      stdio: 'inherit',
    });
    execFile('npm', ['install'], {
      cwd: packageRoot,
      stdio: 'inherit',
    });
    return 'Upgraded proxy-nginx-cli from git checkout.';
  }

  execFile('npm', ['install', '-g', 'proxy-nginx-cli@latest'], {
    stdio: 'inherit',
  });
  return 'Upgraded proxy-nginx-cli from npm.';
}

let cachedComposeRunner;

// Detect docker-compose vs docker compose on first use, not on every CLI start.
function defaultComposeRunner(args, options) {
  cachedComposeRunner = cachedComposeRunner || createComposeRunner();
  return cachedComposeRunner(args, options);
}

const defaultPortInUseChecker = createPortInUseChecker();

function resolveComposeCommand(execFile) {
  try {
    const output = execFile('docker-compose', ['version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (/Docker Compose/i.test(output)) {
      return ['docker-compose'];
    }
  } catch {
    // Fall through to Docker Compose v2 plugin.
  }

  return ['docker', 'compose'];
}

function spawnDetachedBackend(command, args, options = {}) {
  return spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    ...options,
  });
}

function createPortInUseChecker(execFile = execFileSync) {
  return (port) => {
    const numericPort = Number(port);
    try {
      execFile('sh', [
        '-c',
        `if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:${numericPort} -sTCP:LISTEN | awk 'NR > 1 { found = 1 } END { exit found ? 0 : 1 }'
elif command -v ss >/dev/null 2>&1; then
  ss -ltn "sport = :${numericPort}" | awk 'NR > 1 { found = 1 } END { exit found ? 0 : 1 }'
else
  exit 2
fi`,
      ], {
        stdio: 'ignore',
      });
      return true;
    } catch (error) {
      if (error.status !== 2) {
        return false;
      }
    }

    try {
      execFile(process.execPath, [
        '-e',
        `const net=require('node:net');
const port=${JSON.stringify(numericPort)};
const server=net.createServer();
server.once('error', error => process.exit(error.code === 'EADDRINUSE' ? 0 : 1));
server.once('listening',()=>server.close(()=>process.exit(1)));
server.listen(port,'0.0.0.0');`,
      ], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
}

function stopPortListeners(port) {
  const numericPort = Number(port);
  try {
    execFileSync('sh', [
      '-c',
      `if command -v lsof >/dev/null 2>&1; then
  lsof -tiTCP:${numericPort} -sTCP:LISTEN | xargs -r kill
elif command -v fuser >/dev/null 2>&1; then
  fuser -k ${numericPort}/tcp >/dev/null 2>&1 || true
elif command -v ss >/dev/null 2>&1; then
  pid=$(ss -ltnp | awk '/:${numericPort}/ { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4) } }' | head -1)
  [ -z "$pid" ] || kill "$pid"
fi`,
    ], {
      stdio: 'ignore',
    });
  } catch {
    // No listener, or lsof is unavailable. Stopping the proxy is still useful.
  }
}

function parseTarget(target, options) {
  if (target) {
    const normalizedTarget = normalizeTarget(target);
    let url;
    try {
      url = new URL(normalizedTarget);
    } catch {
      throw new Error(`Invalid target URL: ${target}`);
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Target URL protocol must be http or https.');
    }

    // URL drops default ports (http:80, https:443), so read an explicit one from the input.
    const port = url.port || (/^[a-z]+:\/\/[^/?#]*:(\d+)\/?$/i.exec(normalizedTarget) || [])[1];
    if (!port) {
      throw new Error('Target URL must include a port.');
    }

    if ((url.pathname && url.pathname !== '/') || url.search || url.hash || url.username) {
      throw new Error('Target URL must only include protocol, host, and port.');
    }

    return {
      protocol: url.protocol.slice(0, -1),
      host: normalizeUpstreamHost(assertUpstreamHost(url.hostname)),
      port: assertPort(port),
    };
  }

  if (!options.host || !options.port) {
    throw new Error('Provide either a target URL or both --host and --port.');
  }

  return {
    protocol: 'http',
    host: normalizeUpstreamHost(assertUpstreamHost(options.host)),
    port: assertPort(options.port),
  };
}

function normalizeDomain(domain) {
  if (!domain) {
    throw new Error('Domain is required.');
  }

  const normalized = String(domain).trim().toLowerCase().replace(/\.$/, '');
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (normalized.length > 253 || !new RegExp(`^${label}(?:\\.${label})*$`).test(normalized)) {
    throw new Error(`Invalid domain: ${domain}`);
  }

  return normalized;
}

function assertUpstreamHost(host) {
  const value = String(host);
  if (!/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)$/.test(value)) {
    throw new Error(`Invalid upstream host: ${host}`);
  }

  return value;
}

function assertPort(port) {
  const value = String(port);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`Invalid upstream port: ${port}`);
  }

  return String(Number(value));
}

function normalizeTarget(target) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return target;
  }

  if (/^[^/:]+:\d+$/.test(target)) {
    return `http://${target}`;
  }

  return target;
}

function normalizeUpstreamHost(host) {
  if (host === '127.0.0.1' || host === 'localhost') {
    return 'host.docker.internal';
  }

  return host;
}

function assertProject(cwd) {
  if (!fs.existsSync(path.join(cwd, 'docker-compose.yml'))) {
    throw new Error('No docker-compose.yml found. Run pn init first.');
  }
}

function siteTemplate({ domain, host, port, protocol, ssl, hstsSubdomains }) {
  const upstreamName = upstreamNameForDomain(domain);

  if (!ssl) {
    return `upstream ${upstreamName} {
    server ${host}:${port};
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    client_max_body_size 50m;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
${proxyBlock(protocol, upstreamName, host)}
    }
}
`;
  }

  return `upstream ${upstreamName} {
    server ${host}:${port};
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    set $force_https "\${FORCE_HTTPS}";
    client_max_body_size 50m;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        if ($force_https = "true") {
            return 301 https://$host$request_uri;
        }
${proxyBlock(protocol, upstreamName, host)}
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${domain};

    ssl_certificate     /etc/nginx/certs/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/live/${domain}/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=\${HSTS_MAX_AGE}${hstsSubdomains ? '; includeSubDomains' : ''}" always;
    client_max_body_size 50m;

    location / {
${proxyBlock(protocol, upstreamName, host)}
    }
}
`;
}

function proxyBlock(protocol, upstreamName, host) {
  return `        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;${protocol === 'https' ? `
        proxy_ssl_server_name on;
        proxy_ssl_name ${host};` : ''}
        proxy_pass ${protocol}://${upstreamName};`;
}

function upstreamNameForDomain(domain) {
  return `${domain.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_backend`;
}

function dockerfileTemplate() {
  return `ARG NGINX_IMAGE=${DEFAULT_NGINX_IMAGE}
FROM \${NGINX_IMAGE}

RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/docker-entrypoint.d/ /docker-entrypoint.d/
`;
}

function composeTemplate() {
  return `services:
  proxy-nginx:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        NGINX_IMAGE: \${NGINX_IMAGE:-${DEFAULT_NGINX_IMAGE}}
    container_name: proxy-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      FORCE_HTTPS: \${FORCE_HTTPS:-true}
      HSTS_MAX_AGE: \${HSTS_MAX_AGE:-31536000}
      CERT_RELOAD_INTERVAL: \${CERT_RELOAD_INTERVAL:-12h}
      LOG_ROTATE_SIZE_MB: \${LOG_ROTATE_SIZE_MB:-50}
      LOG_ROTATE_KEEP: \${LOG_ROTATE_KEEP:-5}
    volumes:
      - ./nginx/templates:/etc/nginx/templates:ro
      - ./sites:/srv/sites:ro
      - ./ssl/certs:/etc/nginx/certs
      - ./ssl/www:/var/www/certbot
      - ./logs:/var/log/nginx
    extra_hosts:
      - "host.docker.internal:host-gateway"

  certbot:
    image: \${CERTBOT_IMAGE:-${DEFAULT_CERTBOT_IMAGE}}
    container_name: proxy-certbot
    restart: unless-stopped
    volumes:
      - ./ssl/certs:/etc/letsencrypt
      - ./ssl/www:/var/www/certbot
    entrypoint: /bin/sh -c
    command: |
      "trap exit TERM;
      while :; do
        certbot renew --webroot -w /var/www/certbot --quiet;
        sleep 12h & wait $$!;
      done"
`;
}

function examplePackageTemplate() {
  return `{
  "name": "proxy-nginx-cli-example-backend",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "start": "node server.js"
  }
}
`;
}

function exampleServerTemplate() {
  return `const http = require('node:http');

const port = 6666;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(\`proxy-nginx-cli example backend\\nhost: \${req.headers.host}\\nurl: \${req.url}\\n\`);
});

server.listen(port, '0.0.0.0', () => {
  console.log(\`proxy-nginx-cli example backend listening on http://0.0.0.0:\${port}\`);
});
`;
}

function envTemplate(options = {}) {
  const forceHttps = options.forceHttps === false ? 'false' : 'true';
  const hstsMaxAge = options.forceHttps === false ? '0' : '31536000';
  return `# Before issuing Let's Encrypt certificates, keep FORCE_HTTPS=false if needed.
FORCE_HTTPS=${forceHttps}
HSTS_MAX_AGE=${hstsMaxAge}

# Pinned image versions. Change them deliberately, then run: pn up
NGINX_IMAGE=${DEFAULT_NGINX_IMAGE}
CERTBOT_IMAGE=${DEFAULT_CERTBOT_IMAGE}

# Optional tuning (defaults shown):
# CERT_RELOAD_INTERVAL=12h
# LOG_ROTATE_SIZE_MB=50
# LOG_ROTATE_KEEP=5
`;
}

function nginxConfTemplate() {
  return `user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    keepalive_timeout  65;
    server_tokens off;

    gzip on;
    gzip_proxied any;
    gzip_types text/plain text/css text/xml application/json application/javascript
               application/xml application/rss+xml image/svg+xml;

    include /etc/nginx/conf.d/*.conf;
}
`;
}

function devCertEntrypointTemplate() {
  return `#!/bin/sh
set -eu

if [ ! -d /etc/nginx/conf.d ]; then
  exit 0
fi

grep -Rho '/etc/nginx/certs/live/[^/]*/fullchain.pem' /etc/nginx/conf.d 2>/dev/null \\
  | sed 's#/etc/nginx/certs/live/##; s#/fullchain.pem##' \\
  | sort -u \\
  | while read -r name; do
      [ -z "$name" ] && continue
      cert_dir="/etc/nginx/certs/live/$name"
      fullchain="$cert_dir/fullchain.pem"
      privkey="$cert_dir/privkey.pem"

      if [ -f "$fullchain" ] && [ -f "$privkey" ]; then
        echo "[entrypoint] TLS cert exists for $name, skip self-signed cert"
        continue
      fi

      echo "[entrypoint] TLS cert missing for $name, generating local self-signed cert"
      mkdir -p "$cert_dir"
      openssl req -x509 -nodes -newkey rsa:2048 \\
        -days 365 \\
        -subj "/CN=$name" \\
        -keyout "$privkey" \\
        -out "$fullchain" >/dev/null 2>&1
    done
`;
}

function reloadRenewedCertsEntrypointTemplate() {
  return `#!/bin/sh
# The certbot service renews certificates but cannot signal this container.
# Reload nginx periodically so renewed certificates are picked up.
set -eu

interval="\${CERT_RELOAD_INTERVAL:-12h}"

(
  while :; do
    sleep "$interval"
    nginx -s reload >/dev/null 2>&1 || true
  done
) &

echo "[entrypoint] nginx will reload every $interval to pick up renewed certificates"
`;
}

function rotateLogsEntrypointTemplate() {
  return `#!/bin/sh
# Rotate nginx logs by size so ./logs cannot grow without limit.
# Tunables: LOG_ROTATE_SIZE_MB (50), LOG_ROTATE_KEEP (5), LOG_ROTATE_INTERVAL (1h).
set -eu

log_dir="\${LOG_DIR:-/var/log/nginx}"
max_mb="\${LOG_ROTATE_SIZE_MB:-50}"
keep="\${LOG_ROTATE_KEEP:-5}"
interval="\${LOG_ROTATE_INTERVAL:-1h}"

rotate_logs() {
  max_bytes=$((max_mb * 1024 * 1024))
  rotated=0
  for file in "$log_dir"/*.log; do
    [ -f "$file" ] || continue
    size=$(wc -c < "$file")
    [ "$size" -gt "$max_bytes" ] || continue
    i="$keep"
    while [ "$i" -gt 1 ]; do
      prev=$((i - 1))
      if [ -f "$file.$prev" ]; then
        mv -f "$file.$prev" "$file.$i"
      fi
      i="$prev"
    done
    mv -f "$file" "$file.1"
    rotated=1
  done
  if [ "$rotated" = 1 ]; then
    nginx -s reopen >/dev/null 2>&1 || true
  fi
}

if [ "\${1:-}" = "--once" ]; then
  rotate_logs
  exit 0
fi

(
  while :; do
    sleep "$interval"
    rotate_logs
  done
) &

echo "[entrypoint] nginx logs rotate at \${max_mb}MB, keeping $keep files"
`;
}

function connectionUpgradeTemplate() {
  return `# Only send "Connection: upgrade" for real WebSocket upgrade requests so
# upstream keepalive connections stay reusable for normal requests.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';
}
`;
}

function unmatchedHostTemplate() {
  return `server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 404;
    }
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFileIfMissing(filePath, content, mode) {
  if (fs.existsSync(filePath)) {
    return;
  }

  writeFile(filePath, content, mode);
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  if (mode) {
    fs.chmodSync(filePath, mode);
  }
}

function formatList(label, values) {
  if (values.length === 0) {
    return `${label}:\n  - none`;
  }

  return `${label}:\n${values.map((value) => `  - ${value}`).join('\n')}`;
}

module.exports = {
  addSite,
  applyProject,
  certProject,
  createComposeRunner,
  createExample,
  createPortInUseChecker,
  downProject,
  initProject,
  listSiteDomains,
  networkAdd,
  networkRemove,
  parseTarget,
  reloadProject,
  removeSite,
  restartProject,
  resetProject,
  statusData,
  statusProject,
  stopExample,
  stopProject,
  upProject,
  upgradeCli,
};
