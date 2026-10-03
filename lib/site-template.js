const PRESETS = ['proxy', 'static', 'spa', 'redirect'];

function upstreamNameForDomain(domain) {
  return `${domain.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_backend`;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${pad}${line}`))
    .join('\n');
}

function proxyLocationBody({ protocol, host, upstreamName, timeout }) {
  return [
    'proxy_http_version 1.1;',
    'proxy_set_header Host $host;',
    'proxy_set_header X-Real-IP $remote_addr;',
    'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    'proxy_set_header X-Forwarded-Proto $scheme;',
    'proxy_set_header Upgrade $http_upgrade;',
    'proxy_set_header Connection $connection_upgrade;',
    `proxy_read_timeout ${timeout}s;`,
    `proxy_send_timeout ${timeout}s;`,
    ...(protocol === 'https' ? ['proxy_ssl_server_name on;', `proxy_ssl_name ${host};`] : []),
    `proxy_pass ${protocol}://${upstreamName};`,
  ].join('\n');
}

function contentBody(spec) {
  switch (spec.preset) {
    case 'static':
      return 'try_files $uri $uri/ =404;';
    case 'spa':
      return 'try_files $uri $uri/ /index.html;';
    case 'redirect':
      return `return 301 ${spec.redirectTarget}$request_uri;`;
    default:
      return proxyLocationBody({ ...spec, upstreamName: upstreamNameForDomain(spec.domain) });
  }
}

function accessRules(allow) {
  if (allow.length === 0) {
    return '';
  }

  return `${allow.map((cidr) => `allow ${cidr};`).join('\n')}\ndeny all;\n`;
}

function serverExtras(spec) {
  const lines = [`client_max_body_size ${spec.maxBodySize};`];
  if (spec.accessLog) {
    lines.push(`access_log /var/log/nginx/${spec.domain}.access.log main;`);
  }
  if (spec.preset === 'static' || spec.preset === 'spa') {
    lines.push(`root /srv/sites/${spec.domain};`, 'index index.html;');
  }
  return lines.join('\n');
}

const ACME_LOCATION = `location /.well-known/acme-challenge/ {
    root /var/www/certbot;
}
`;

function tlsLines(domain) {
  return `ssl_certificate     /etc/nginx/certs/live/${domain}/fullchain.pem;
ssl_certificate_key /etc/nginx/certs/live/${domain}/privkey.pem;
ssl_session_timeout 1d;
ssl_session_cache shared:SSL:10m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers HIGH:!aNULL:!MD5;
ssl_prefer_server_ciphers off;
`;
}

function block(header, body) {
  return `${header} {\n${indent(body.replace(/\n+$/, ''), 4)}\n}\n`;
}

function listen80() {
  return 'listen 80;\nlisten [::]:80;\n';
}

function listen443() {
  return 'listen 443 ssl;\nlisten [::]:443 ssl;\nhttp2 on;\n';
}

// Servers that only exist to send alias names to the canonical domain.
function aliasRedirectServers({ domain, aliases, ssl }) {
  const names = aliases.join(' ');
  const scheme = ssl ? 'https' : 'http';
  const target = `return 301 ${scheme}://${domain}$request_uri;`;
  const servers = [
    block(
      'server',
      `${listen80()}server_name ${names};\n\n${ACME_LOCATION}\nlocation / {\n    ${target}\n}\n`
    ),
  ];

  if (ssl) {
    servers.push(
      block('server', `${listen443()}server_name ${names};\n\n${tlsLines(domain)}\n${target}\n`)
    );
  }

  return servers;
}

// Builds the nginx site template for one domain.
// spec: { domain, aliases, redirectAliases, preset, ssl, protocol, host, port,
//         redirectTarget, hstsSubdomains, maxBodySize, timeout, allow, accessLog,
//         forceHttps (true/false; default: follow FORCE_HTTPS from .env) }
function renderSite(input) {
  const spec = {
    aliases: [],
    redirectAliases: false,
    preset: 'proxy',
    ssl: true,
    hstsSubdomains: false,
    maxBodySize: '50m',
    timeout: 300,
    allow: [],
    accessLog: false,
    forceHttps: undefined,
    ...input,
  };
  const { domain, ssl } = spec;
  const hasAliases = spec.aliases.length > 0;
  const names = spec.redirectAliases ? [domain] : [domain, ...spec.aliases];
  const parts = [`# pn: preset=${spec.preset}\n`];

  if (spec.preset === 'proxy') {
    parts.push(
      block(`upstream ${upstreamNameForDomain(domain)}`, `server ${spec.host}:${spec.port};\nkeepalive 16;\n`)
    );
  }

  const body = `${accessRules(spec.allow)}${contentBody(spec)}`;
  const locationBody = indent(body, 4);

  if (!ssl) {
    parts.push(
      block(
        'server',
        `${listen80()}server_name ${names.join(' ')};\n${serverExtras(spec)}\n\n${ACME_LOCATION}\nlocation / {\n${locationBody}\n}\n`
      )
    );
  } else {
    parts.push(
      block(
        'server',
        `${listen80()}server_name ${names.join(' ')};\nset $force_https "${spec.forceHttps === undefined ? '\${FORCE_HTTPS}' : String(spec.forceHttps)}";\n${serverExtras(spec)}\n\n${ACME_LOCATION}\nlocation / {\n    if ($force_https = "true") {\n        return 301 https://$host$request_uri;\n    }\n${locationBody}\n}\n`
      ),
      block(
        'server',
        `${listen443()}server_name ${names.join(' ')};\n\n${tlsLines(domain)}\nadd_header Strict-Transport-Security "max-age=\${HSTS_MAX_AGE}${spec.hstsSubdomains ? '; includeSubDomains' : ''}" always;\n${serverExtras(spec)}\n\nlocation / {\n${locationBody}\n}\n`
      )
    );
  }

  if (spec.redirectAliases && hasAliases) {
    parts.push(...aliasRedirectServers(spec));
  }

  return parts.join('\n');
}

module.exports = {
  PRESETS,
  renderSite,
  upstreamNameForDomain,
};
