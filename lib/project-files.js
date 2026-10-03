const DEFAULT_NGINX_IMAGE = 'nginx:1.30';
const DEFAULT_CERTBOT_IMAGE = 'certbot/certbot:v5.8.0';

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
      - ./nginx/auth:/etc/nginx/auth:ro
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

// Bump when a pn release changes generated base files; pn migrate records it in .pn.json.
const PROJECT_SCHEMA_VERSION = 3;
const PROJECT_METADATA_FILE = '.pn.json';

function projectMetadata() {
  return `${JSON.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION }, null, 2)}\n`;
}

// Generated files that are the same in every project. Site templates are never listed.
function managedFiles() {
  return [
    { path: 'Dockerfile', content: dockerfileTemplate() },
    { path: 'nginx/nginx.conf', content: nginxConfTemplate() },
    {
      path: 'nginx/docker-entrypoint.d/40-generate-dev-certs.sh',
      content: devCertEntrypointTemplate(),
      mode: 0o755,
    },
    {
      path: 'nginx/docker-entrypoint.d/50-reload-renewed-certs.sh',
      content: reloadRenewedCertsEntrypointTemplate(),
      mode: 0o755,
    },
    {
      path: 'nginx/docker-entrypoint.d/60-rotate-logs.sh',
      content: rotateLogsEntrypointTemplate(),
      mode: 0o755,
    },
    {
      path: 'nginx/templates/00-unmatched-host.conf.template',
      content: unmatchedHostTemplate(),
    },
    {
      path: 'nginx/templates/00-connection-upgrade.conf.template',
      content: connectionUpgradeTemplate(),
    },
  ];
}

module.exports = {
  DEFAULT_CERTBOT_IMAGE,
  PROJECT_METADATA_FILE,
  PROJECT_SCHEMA_VERSION,
  managedFiles,
  projectMetadata,
  DEFAULT_NGINX_IMAGE,
  composeTemplate,
  connectionUpgradeTemplate,
  devCertEntrypointTemplate,
  dockerfileTemplate,
  envTemplate,
  nginxConfTemplate,
  reloadRenewedCertsEntrypointTemplate,
  rotateLogsEntrypointTemplate,
  unmatchedHostTemplate,
};
