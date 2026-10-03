const fs = require('node:fs');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const { readProxyNetworks, serviceNames, writeProxyNetworks } = require('./compose-file');
const {
  certificateReport,
  certsDirOf,
  formatCertificate,
  hasRenewalConfig,
  isStagingLineage,
  renewalConfPath,
} = require('./certs');
const {
  DEFAULT_NGINX_IMAGE,
  PROJECT_METADATA_FILE,
  composeTemplate,
  envTemplate,
  managedFiles,
  projectMetadata,
} = require('./project-files');
const { migrateProject: runMigration, rollbackProject: runRollback } = require('./migrate');
const {
  apr1,
  assertPassword,
  assertUsername,
  disableAuth,
  enableAuth,
  htpasswdPath,
  isAuthEnabled,
  readUsers,
  writeUsers,
} = require('./auth');
const { runDoctor } = require('./doctor');
const { PRESETS, renderSite } = require('./site-template');
const { BASE_TEMPLATES, listSiteDomains, readSite, readSites, siteTemplatePath } = require('./sites');

const UP_ARGS = ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'];

function initProject(cwd = process.cwd()) {
  ensureDir(path.join(cwd, 'nginx', 'templates'));
  ensureDir(path.join(cwd, 'nginx', 'docker-entrypoint.d'));
  ensureDir(path.join(cwd, 'ssl', 'certs'));
  ensureDir(path.join(cwd, 'ssl', 'www'));
  ensureDir(path.join(cwd, 'logs'));
  ensureDir(path.join(cwd, 'sites'));
  ensureDir(path.join(cwd, 'nginx', 'auth'));

  writeFileIfMissing(path.join(cwd, 'docker-compose.yml'), composeTemplate());
  writeFileIfMissing(path.join(cwd, '.env'), envTemplate());
  for (const file of managedFiles()) {
    writeFileIfMissing(path.join(cwd, file.path), file.content, file.mode);
  }
  writeFileIfMissing(path.join(cwd, PROJECT_METADATA_FILE), projectMetadata());

  return 'Initialized proxy nginx project.';
}

function ensureConnectionUpgradeTemplate(templatesDir) {
  const file = managedFiles().find((candidate) => candidate.path.endsWith('00-connection-upgrade.conf.template'));
  writeFileIfMissing(path.join(templatesDir, '00-connection-upgrade.conf.template'), file.content);
}

function addSite(domain, target, options = {}, cwd = process.cwd()) {
  domain = normalizeDomain(domain);

  const templatesDir = path.join(cwd, 'nginx', 'templates');
  if (!fs.existsSync(templatesDir)) {
    throw new Error('No nginx/templates directory found. Run pn init first.');
  }

  const preset = options.template || 'proxy';
  if (!PRESETS.includes(preset)) {
    throw new Error(`Unknown template: ${preset}. Use one of: ${PRESETS.join(', ')}.`);
  }

  const ssl = options.ssl !== false;
  if (options.cert && !ssl) {
    throw new Error('--cert cannot be used with --no-ssl.');
  }

  const aliases = normalizeAliases(domain, options);
  if (options.redirectAliases && aliases.length === 0) {
    throw new Error('--redirect-aliases needs at least one --alias (or --www).');
  }

  const spec = {
    domain,
    aliases,
    redirectAliases: Boolean(options.redirectAliases),
    preset,
    ssl,
    hstsSubdomains: Boolean(options.hstsSubdomains),
    accessLog: Boolean(options.accessLog),
    ...siteLimits(options),
  };
  if (options.forceHttps !== undefined) {
    if (!ssl) {
      throw new Error('--force-https and --no-force-https need SSL; they cannot be used with --no-ssl.');
    }
    spec.forceHttps = Boolean(options.forceHttps);
  }
  let description;

  if (preset === 'proxy') {
    const upstream = parseTarget(target, options);
    Object.assign(spec, upstream);
    description = `${upstream.protocol}://${upstream.host}:${upstream.port}`;
  } else if (preset === 'redirect') {
    spec.redirectTarget = parseRedirectTarget(target);
    description = `redirect to ${spec.redirectTarget}`;
  } else {
    if (target || options.host || options.port) {
      throw new Error(`The ${preset} template serves files from sites/${domain}; it takes no target.`);
    }
    assertComposeMount(cwd, '/srv/sites');
    description = `static files in sites/${domain}`;
  }

  const runCompose = options.runCompose || defaultComposeRunner;
  const filePath = siteTemplatePath(cwd, domain);
  if (fs.existsSync(filePath) && !options.force) {
    return `Site template already exists for ${domain}. Use --force to overwrite.`;
  }

  ensureConnectionUpgradeTemplate(templatesDir);
  writeFile(filePath, renderSite(spec));
  if (preset === 'static' || preset === 'spa') {
    writeFileIfMissing(
      path.join(cwd, 'sites', domain, 'index.html'),
      `<!doctype html>\n<title>${domain}</title>\n<h1>${domain}</h1>\n<p>Served by proxy-nginx-cli. Replace this file.</p>\n`
    );
  }

  let output = `Added ${domain} -> ${description}${ssl ? ' with SSL.' : ' without SSL.'}`;
  if (aliases.length > 0) {
    output += `\nAliases: ${aliases.join(', ')}${spec.redirectAliases ? ' (redirect to ' + domain + ')' : ''}.`;
  }

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

function normalizeAliases(domain, options) {
  const requested = [...(options.alias || [])];
  if (options.www) {
    requested.push(`www.${domain}`);
  }

  return [...new Set(requested.map(normalizeDomain))].filter((name) => name !== domain);
}

function siteLimits(options) {
  const limits = {};

  if (options.maxBodySize !== undefined) {
    if (!/^\d+[kKmMgG]?$/.test(String(options.maxBodySize))) {
      throw new Error(`Invalid --max-body-size: ${options.maxBodySize} (examples: 10m, 1g, 0).`);
    }
    limits.maxBodySize = String(options.maxBodySize);
  }

  if (options.timeout !== undefined) {
    const timeout = Number(options.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) {
      throw new Error(`Invalid --timeout: ${options.timeout} (seconds, 1-86400).`);
    }
    limits.timeout = timeout;
  }

  if (options.allow && options.allow.length > 0) {
    for (const cidr of options.allow) {
      assertIpOrCidr(cidr);
    }
    limits.allow = [...options.allow];
  }

  return limits;
}

function assertIpOrCidr(value) {
  const [address, prefix, ...rest] = String(value).split('/');
  const version = net.isIP(address);
  const maxPrefix = version === 4 ? 32 : 128;
  const validPrefix = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix);
  if (version === 0 || !validPrefix || rest.length > 0) {
    throw new Error(`Invalid --allow address: ${value} (use an IP or CIDR such as 10.0.0.0/8).`);
  }
}

function parseRedirectTarget(target) {
  if (!target) {
    throw new Error('The redirect template needs a target URL, for example https://new.example.com.');
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`Invalid redirect URL: ${target}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Redirect URL protocol must be http or https.');
  }

  if ((url.pathname && url.pathname !== '/') || url.search || url.hash || url.username) {
    throw new Error('Redirect URL must only include protocol, host, and optional port.');
  }

  assertUpstreamHost(url.hostname);
  return `${url.protocol}//${url.host}`;
}

// Some features need a host directory mounted into the proxy container. Projects created
// before that mount existed do not have it until pn migrate adds it.
function assertComposeMount(cwd, containerPath) {
  const composePath = path.join(cwd, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    return;
  }

  if (!new RegExp(`:${containerPath}(?::|\\s|$)`, 'm').test(fs.readFileSync(composePath, 'utf8'))) {
    throw new Error(`docker-compose.yml has no mount for ${containerPath}. Run pn migrate --yes first.`);
  }
}

const LOG_TAIL_MAX_BYTES = 8 * 1024 * 1024;

// Prints the end of an nginx log from ./logs. A domain selects its per-site access
// log (sites added with --access-log); --error selects the shared error log.
function logsProject(domain, options = {}) {
  const cwd = options.cwd || process.cwd();
  assertProject(cwd);

  const lines = options.lines === undefined ? 100 : Number(options.lines);
  if (!Number.isInteger(lines) || lines < 1) {
    throw new Error(`Invalid --lines: ${options.lines}`);
  }

  let name;
  if (domain) {
    name = `${normalizeDomain(domain)}.access.log`;
  } else {
    name = options.error ? 'error.log' : 'access.log';
  }

  const filePath = path.join(cwd, 'logs', name);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      domain
        ? `No log for ${domain}. Add the site with --access-log to get logs/${name}.`
        : `No log file at logs/${name} yet.`
    );
  }

  if (options.follow) {
    (options.runTail || runTailFollow)(filePath, lines);
    return '';
  }

  return readLastLines(filePath, lines);
}

function readLastLines(filePath, lines) {
  const { size } = fs.statSync(filePath);
  const length = Math.min(size, LOG_TAIL_MAX_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }

  const all = buffer.toString('utf8').split('\n');
  if (all[all.length - 1] === '') {
    all.pop();
  }

  return all.slice(-lines).join('\n');
}

function runTailFollow(filePath, lines) {
  spawnSync('tail', ['-n', String(lines), '-f', filePath], { stdio: 'inherit' });
}

function readSiteForAuth(domain, cwd) {
  const normalized = normalizeDomain(domain);
  assertProject(cwd);
  const site = readSite(cwd, normalized);
  if (!site) {
    throw new Error(`No site template found for ${normalized}.`);
  }

  return { domain: normalized, site, templatePath: siteTemplatePath(cwd, normalized) };
}

function httpsMayBeOptional(cwd, site) {
  if (site.httpsRedirect === 'off') {
    return true;
  }

  const env = readEnvValue(cwd, 'FORCE_HTTPS');
  return site.httpsRedirect === 'env' && env === 'false';
}

function readEnvValue(cwd, key) {
  try {
    const match = new RegExp(`^${key}=(\\S*)\\s*$`, 'm').exec(fs.readFileSync(path.join(cwd, '.env'), 'utf8'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Adds or updates a user. The first user also switches basic auth on in the site
// template (until it is applied, the site stays open).
function authAdd(domain, user, password, options = {}) {
  const cwd = options.cwd || process.cwd();
  assertUsername(user);
  assertPassword(password);
  const { domain: name, site, templatePath } = readSiteForAuth(domain, cwd);

  if (!site.ssl) {
    throw new Error(`${name} has no SSL; basic auth would send passwords in clear text. Add the site with SSL first.`);
  }
  if (site.preset === 'redirect') {
    throw new Error(`${name} is a redirect site; there is nothing to protect.`);
  }
  assertComposeMount(cwd, '/etc/nginx/auth');

  const content = fs.readFileSync(templatePath, 'utf8');
  let edited = null;
  if (!isAuthEnabled(content)) {
    edited = enableAuth(content, name);
    if (edited.count === 0) {
      throw new Error(`Could not find a "location / {" block in ${name}'s template to protect. Add auth_basic by hand.`);
    }
  }

  const file = htpasswdPath(cwd, name);
  const users = readUsers(file);
  const existed = users.has(user);
  users.set(user, apr1(password));
  writeUsers(file, users);

  const lines = [existed ? `Updated the password of ${user} for ${name}.` : `Added user ${user} to ${name}.`];
  if (edited) {
    fs.writeFileSync(templatePath, edited.content, 'utf8');
    if (options.run) {
      lines.push(applyProject(cwd, options.runCompose || defaultComposeRunner));
    } else {
      lines.push(`Basic auth is NOT active yet: apply it with \`pn up\` or \`pn template edit ${name} --run\` (until then the site is open).`);
    }
    if (httpsMayBeOptional(cwd, site)) {
      lines.push('Warning: this site can still be reached over plain HTTP; passwords would be sent in clear text. Use FORCE_HTTPS=true or --force-https.');
    }
  } else {
    lines.push('Takes effect immediately (nginx reads the user file on every request).');
  }

  return lines.join('\n');
}

function authRemove(domain, user, options = {}) {
  const cwd = options.cwd || process.cwd();
  assertUsername(user);
  const { domain: name, site } = readSiteForAuth(domain, cwd);
  if (!site.auth) {
    throw new Error(`Basic auth is not enabled for ${name}.`);
  }

  const file = htpasswdPath(cwd, name);
  const users = readUsers(file);
  if (!users.has(user)) {
    throw new Error(`${name} has no user ${user}. Users: ${[...users.keys()].join(', ') || 'none'}.`);
  }
  if (users.size === 1) {
    throw new Error(`${user} is the last user of ${name}. Removing it would lock everyone out; run \`pn auth disable ${name}\` to turn basic auth off instead.`);
  }

  users.delete(user);
  writeUsers(file, users);
  return `Removed user ${user} from ${name}. Takes effect immediately.`;
}

// Turns basic auth off for a site and deletes its user file.
function authDisable(domain, options = {}) {
  const cwd = options.cwd || process.cwd();
  const { domain: name, site, templatePath } = readSiteForAuth(domain, cwd);
  if (!site.auth) {
    throw new Error(`Basic auth is not enabled for ${name}.`);
  }

  fs.writeFileSync(templatePath, disableAuth(fs.readFileSync(templatePath, 'utf8')), 'utf8');
  fs.rmSync(htpasswdPath(cwd, name), { force: true });

  const lines = [`Basic auth disabled for ${name}; its users were deleted.`];
  if (options.run) {
    lines.push(applyProject(cwd, options.runCompose || defaultComposeRunner));
  } else {
    lines.push(`The site stays protected until you apply this: \`pn up\` or \`pn template edit ${name} --run\`.`);
  }

  return lines.join('\n');
}

function authList(domain, options = {}) {
  const cwd = options.cwd || process.cwd();
  assertProject(cwd);
  const domains = domain ? [readSiteForAuth(domain, cwd).domain] : listSiteDomains(cwd);
  const lines = domains
    .map((name) => readSite(cwd, name))
    .filter((site) => site.auth)
    .map((site) => `${site.domain}: ${[...readUsers(htpasswdPath(cwd, site.domain)).keys()].join(', ') || 'no users'}`);

  return lines.length === 0 ? 'No sites use basic auth.' : lines.join('\n');
}

function templateList(cwd = process.cwd()) {
  assertProject(cwd);
  const sites = readSites(cwd);
  if (sites.length === 0) {
    return 'No site templates.';
  }

  return sites
    .map((site) => {
      const target = site.upstream ? ` -> ${site.upstream}` : '';
      const flags = [site.preset, site.ssl ? 'ssl' : 'http-only'];
      if (site.httpsRedirect === 'on' || site.httpsRedirect === 'off') {
        flags.push(`https redirect: ${site.httpsRedirect}`);
      }
      if (site.auth) {
        flags.push(`basic auth: ${site.authUsers} user(s)`);
      }
      if (site.aliases.length > 0) {
        flags.push(`aliases: ${site.aliases.join(', ')}`);
      }
      return `${site.domain}${target} [${flags.join(', ')}]`;
    })
    .join('\n');
}

// Opens the site template in $VISUAL/$EDITOR, then checks the result. Without --run the
// change is only validated (when the proxy is up); with --run it is applied.
function templateEdit(domain, options = {}) {
  domain = normalizeDomain(domain);
  const cwd = options.cwd || process.cwd();
  const runCompose = options.runCompose || defaultComposeRunner;
  assertProject(cwd);

  const filePath = siteTemplatePath(cwd, domain);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No site template found for ${domain}.`);
  }

  const edit = options.edit || defaultEditor;
  edit(filePath);

  if (options.run) {
    return `Edited ${domain}.\n${applyProject(cwd, runCompose)}`;
  }

  if (!isProxyRunning(cwd, runCompose)) {
    return `Edited ${domain}. The proxy is not running; start it with pn up.`;
  }

  try {
    runCompose(['run', '--rm', '-T', '--no-deps', 'proxy-nginx', 'nginx', '-t'], { cwd });
  } catch {
    throw new Error(`Edited ${domain}, but nginx -t failed. Fix the template (pn template edit ${domain}); the running proxy was not changed.`);
  }

  return `Edited ${domain}; nginx -t passed. Apply it with \`pn up\`, or edit with --run next time.`;
}

function defaultEditor(filePath) {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const result = spawnSync(`${editor} ${shellQuote(filePath)}`, { shell: true, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}.`);
  }
}

// Brings a project created by an older pn up to date. Reports only, unless options.yes.
// With --run, a failed restart rolls the files back so the project matches what was
// running before.
function migrateProject(options = {}) {
  const cwd = options.cwd || process.cwd();
  assertProject(cwd);

  const result = runMigration(cwd, options);
  if (!(result.applied && options.run)) {
    return result.output;
  }

  const runCompose = options.runCompose || defaultComposeRunner;
  try {
    return `${result.output}\n${upProject(cwd, runCompose)}`;
  } catch (error) {
    const rollback = runRollback(cwd, { yes: true, backup: result.backupName });
    let recovery;
    try {
      recovery = upProject(cwd, runCompose);
    } catch (second) {
      recovery = `Restarting with the previous files also failed: ${second.message}`;
    }

    throw new Error(`Restart after migrating failed: ${error.message}\n${rollback.output}\n${recovery}`);
  }
}

// Undoes pn migrate using the backups in .pn-backup/. Reports only, unless options.yes.
function rollbackProject(options = {}) {
  const cwd = options.cwd || process.cwd();
  assertProject(cwd);

  const result = runRollback(cwd, options);
  if (result.applied && options.run) {
    return `${result.output}\n${upProject(cwd, options.runCompose || defaultComposeRunner)}`;
  }

  return result.output;
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
  fs.rmSync(htpasswdPath(cwd, domain), { force: true });

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

function upProject(cwd = process.cwd(), runCompose = defaultComposeRunner, options = {}) {
  assertProject(cwd);
  if (options.pull) {
    pullImages(cwd, runCompose);
  }
  validateBeforeRecreate(cwd, runCompose);
  runCompose(UP_ARGS, { cwd });
  return 'Started proxy nginx.';
}

// Picks up new patch releases of the pinned tags. The proxy image is rebuilt first, so
// the pre-recreate validation below runs against the new nginx.
function pullImages(cwd, runCompose) {
  runCompose(['build', '--pull', 'proxy-nginx'], { cwd });
  runCompose(['pull', 'certbot'], { cwd });
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

function restartProject(cwd = process.cwd(), runCompose = defaultComposeRunner, options = {}) {
  assertProject(cwd);
  if (options.pull) {
    pullImages(cwd, runCompose);
  }
  validateBeforeRecreate(cwd, runCompose);
  runCompose(UP_ARGS, { cwd });
  return 'Restarted proxy nginx.';
}

function proxyNginxVersion(cwd, runCompose) {
  try {
    const output = runCompose(['exec', '-T', 'proxy-nginx', 'sh', '-c', 'nginx -v 2>&1'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const match = /nginx\/(\S+)/.exec(String(output || ''));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function statusData(cwd, runCompose = defaultComposeRunner) {
  const compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  const running = isProxyRunning(cwd, runCompose);
  return {
    proxy: { running, nginxVersion: running ? proxyNginxVersion(cwd, runCompose) : null },
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

  const { proxy } = statusData(cwd, runCompose);
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

  const proxyLine = proxy.running
    ? `Proxy: running${proxy.nginxVersion ? `, nginx ${proxy.nginxVersion}` : ''}`
    : 'Proxy: not running';

  return [
    'Proxy nginx project status.',
    proxyLine,
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

// Health checks for the project and, with a domain, for DNS, CAA and reachability.
// Network helpers can be replaced through options (used by the tests).
async function doctorProject(domain, options = {}) {
  const cwd = options.cwd || process.cwd();
  assertProject(cwd);

  const runCompose = options.runCompose || defaultComposeRunner;
  const name = domain ? normalizeDomain(domain) : undefined;
  const injected = {};
  for (const key of ['dns', 'httpGet', 'tlsProbe', 'localAddresses', 'randomToken', 'certificateReport']) {
    if (options[key]) {
      injected[key] = options[key];
    }
  }

  return runDoctor({
    scope: options.scope,
    cwd,
    domain: name,
    names: name ? certDomains(cwd, name) : [],
    runCompose,
    ip: options.ip,
    isServiceRunning: (service) => isServiceRunning(cwd, runCompose, service),
    nginxVersion: () => proxyNginxVersion(cwd, runCompose),
    isPortInUse: options.isPortInUse || defaultPortInUseChecker,
    ...injected,
  });
}

// What pn cert checks before asking Let's Encrypt: only checks that make issuing
// impossible (no DNS record, CAA forbids it) block; everything else is a warning.
async function certPreflight(domain, options = {}) {
  const report = await doctorProject(domain, { ...options, scope: 'domain' });
  return {
    report,
    blockers: report.checks.filter((entry) => entry.status === 'fail'),
    warnings: report.checks.filter((entry) => entry.status === 'warn'),
  };
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
  const composePath = path.join(cwd, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    throw new Error(`No docker-compose.yml found. Run pn init first.${nearbyProjectHint(cwd, ' ')}`);
  }

  // A compose file that defines other services but no proxy-nginx belongs to something
  // else (for example the application next to the proxy), not to a pn project.
  const services = serviceNames(fs.readFileSync(composePath, 'utf8'));
  if (services.length > 0 && !services.includes('proxy-nginx')) {
    throw new Error(
      `${composePath} defines ${services.join(', ')} but no proxy-nginx service, so this is not a pn project directory.${nearbyProjectHint(cwd, ' ') || ' Run pn from the directory where you ran pn init.'}`
    );
  }
}

const PROJECT_SEARCH_SKIP = new Set(['node_modules', 'ssl', 'logs', 'nginx', 'sites']);

function looksLikePnProject(dir) {
  try {
    return (
      fs.statSync(path.join(dir, 'nginx', 'templates')).isDirectory() &&
      serviceNames(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')).includes('proxy-nginx')
    );
  } catch {
    return false;
  }
}

// pn projects in parent directories and up to two levels of subdirectories.
function findNearbyProjects(cwd) {
  const found = [];

  let dir = cwd;
  for (let level = 0; level < 3; level += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
    if (looksLikePnProject(dir)) {
      found.push(dir);
    }
  }

  const walk = (base, depth) => {
    if (depth > 2 || found.length >= 5) {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || PROJECT_SEARCH_SKIP.has(entry.name)) {
        continue;
      }

      const child = path.join(base, entry.name);
      if (looksLikePnProject(child)) {
        found.push(child);
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(cwd, 1);

  return found.slice(0, 5);
}

function nearbyProjectHint(cwd, prefix = '') {
  const found = findNearbyProjects(cwd);
  if (found.length === 0) {
    return '';
  }

  const shown = found.map((dir) => path.relative(cwd, dir) || '.').join(', ');
  return `${prefix}A pn project is at: ${shown}. cd there and run the command again.`;
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
  authAdd,
  authDisable,
  authList,
  authRemove,
  certProject,
  certPreflight,
  createComposeRunner,
  createExample,
  doctorProject,
  createPortInUseChecker,
  downProject,
  initProject,
  listSiteDomains,
  logsProject,
  migrateProject,
  networkAdd,
  networkRemove,
  parseTarget,
  reloadProject,
  removeSite,
  restartProject,
  resetProject,
  rollbackProject,
  statusData,
  statusProject,
  templateEdit,
  templateList,
  stopExample,
  stopProject,
  upProject,
  upgradeCli,
};
