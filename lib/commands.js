const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');

function initProject(cwd = process.cwd()) {
  ensureDir(path.join(cwd, 'nginx', 'templates'));
  ensureDir(path.join(cwd, 'nginx', 'docker-entrypoint.d'));
  ensureDir(path.join(cwd, 'ssl', 'certs'));
  ensureDir(path.join(cwd, 'ssl', 'www'));
  ensureDir(path.join(cwd, 'logs'));

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
    path.join(cwd, 'nginx', 'templates', '00-unmatched-host.conf.template'),
    unmatchedHostTemplate()
  );

  return 'Initialized proxy nginx project.';
}

function addSite(domain, target, options = {}, cwd = process.cwd()) {
  if (!domain) {
    throw new Error('Domain is required.');
  }

  const templatesDir = path.join(cwd, 'nginx', 'templates');
  if (!fs.existsSync(templatesDir)) {
    throw new Error('No nginx/templates directory found. Run pn init first.');
  }

  const upstream = parseTarget(target, options);
  const ssl = options.ssl !== false;
  const config = siteTemplate({
    domain,
    host: upstream.host,
    port: upstream.port,
    protocol: upstream.protocol,
    ssl,
  });

  const filePath = path.join(templatesDir, `${domain}.conf.template`);
  writeFile(filePath, config);

  return `Added ${domain} -> ${upstream.protocol}://${upstream.host}:${upstream.port}${ssl ? ' with SSL.' : ' without SSL.'}`;
}

function resetProject(cwd = process.cwd()) {
  initProject(cwd);

  const templatesDir = path.join(cwd, 'nginx', 'templates');
  for (const filename of fs.readdirSync(templatesDir)) {
    if (!filename.endsWith('.conf.template')) {
      continue;
    }

    if (filename === '00-unmatched-host.conf.template') {
      continue;
    }

    fs.rmSync(path.join(templatesDir, filename), { force: true });
  }

  return 'Reset proxy nginx project.';
}

function removeSite(domain, cwd = process.cwd()) {
  if (!domain) {
    throw new Error('Domain is required.');
  }

  const filePath = path.join(cwd, 'nginx', 'templates', `${domain}.conf.template`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No site template found for ${domain}.`);
  }

  fs.rmSync(filePath, { force: true });
  return `Removed ${domain}.`;
}

function createExample(options = {}) {
  const cwd = options.cwd || process.cwd();
  const domain = options.domain;
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

  if (options.cert && !domain) {
    throw new Error('--cert requires a domain.');
  }

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

  runCompose(['up', '-d', '--build', 'proxy-nginx'], { cwd: proxyDir });

  let certMessage = '';
  if (options.cert) {
    certProject(domain, proxyDir, runCompose);
    certMessage = `
Certificate requested for ${domain}.`;
  }

  const proxyUrl = domain ? `http://${domain}/` : 'http://127.0.0.1/';
  const curlHost = domain || 'local.example.test';

  return `Example is running.

Backend: http://127.0.0.1:6666
Proxy:   curl -H 'Host: ${curlHost}' ${proxyUrl}${certMessage}
Stop:    cd ${proxyDir} && docker-compose down`;
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
  runCompose(['up', '-d', '--build', 'proxy-nginx'], { cwd });
  return 'Started proxy nginx.';
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
  now = timestamp
) {
  if (!domain) {
    throw new Error('Domain is required.');
  }

  assertProject(cwd);
  backupSelfSignedCert(domain, cwd, now);
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
    '-d',
    domain,
    '--agree-tos',
    '--register-unsafely-without-email',
    '--no-eff-email',
    '--non-interactive',
    '--keep-until-expiring',
  ], { cwd });
  reloadProject(cwd, runCompose);

  return `Issued certificate for ${domain} and reloaded proxy nginx.`;
}

function backupSelfSignedCert(domain, cwd, now) {
  const certsDir = path.join(cwd, 'ssl', 'certs');
  const liveDir = path.join(certsDir, 'live', domain);
  const renewalConf = path.join(certsDir, 'renewal', `${domain}.conf`);

  if (!fs.existsSync(liveDir) || fs.existsSync(renewalConf)) {
    return;
  }

  const backupDir = path.join(
    certsDir,
    'live',
    `${domain}.bak.selfsigned.${now()}`
  );
  fs.renameSync(liveDir, backupDir);
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

const defaultComposeRunner = createComposeRunner();
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
    let url;
    try {
      url = new URL(target);
    } catch {
      throw new Error(`Invalid target URL: ${target}`);
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Target URL protocol must be http or https.');
    }

    if (!url.port) {
      throw new Error('Target URL must include a port.');
    }

    return {
      protocol: url.protocol.slice(0, -1),
      host: url.hostname,
      port: url.port,
    };
  }

  if (!options.host || !options.port) {
    throw new Error('Provide either a target URL or both --host and --port.');
  }

  return {
    protocol: 'http',
    host: options.host,
    port: String(options.port),
  };
}

function assertProject(cwd) {
  if (!fs.existsSync(path.join(cwd, 'docker-compose.yml'))) {
    throw new Error('No docker-compose.yml found. Run pn init first.');
  }
}

function siteTemplate({ domain, host, port, protocol, ssl }) {
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

    location / {
${proxyBlock(protocol, upstreamName)}
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

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        if ($force_https = "true") {
            return 301 https://$host$request_uri;
        }
${proxyBlock(protocol, upstreamName)}
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

    add_header Strict-Transport-Security "max-age=\${HSTS_MAX_AGE}; includeSubDomains" always;
    client_max_body_size 50m;

    location / {
${proxyBlock(protocol, upstreamName)}
    }
}
`;
}

function proxyBlock(protocol, upstreamName) {
  return `        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_pass ${protocol}://${upstreamName};`;
}

function upstreamNameForDomain(domain) {
  return `${domain.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_backend`;
}

function dockerfileTemplate() {
  return `FROM nginx:latest

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
    container_name: proxy-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      FORCE_HTTPS: \${FORCE_HTTPS:-true}
      HSTS_MAX_AGE: \${HSTS_MAX_AGE:-31536000}
    volumes:
      - ./nginx/templates:/etc/nginx/templates:ro
      - ./ssl/certs:/etc/nginx/certs
      - ./ssl/www:/var/www/certbot
      - ./logs:/var/log/nginx
    extra_hosts:
      - "host.docker.internal:host-gateway"

  certbot:
    image: certbot/certbot:latest
    container_name: proxy-certbot
    restart: unless-stopped
    volumes:
      - ./ssl/certs:/etc/letsencrypt
      - ./ssl/www:/var/www/certbot
    entrypoint: /bin/sh -c
    command: >
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

module.exports = {
  addSite,
  certProject,
  createComposeRunner,
  createExample,
  createPortInUseChecker,
  initProject,
  parseTarget,
  reloadProject,
  removeSite,
  resetProject,
  stopExample,
  upProject,
};
