const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { addSite, initProject, migrateProject, networkAdd } = require('../lib/commands');
const { readProxyNetworks } = require('../lib/compose-file');

const OLD_COMPOSE = `# my deployment
services:
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
      - ./extra:/extra  # my own mount
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

// A project as created by pn before pinned images, the connection map, and log rotation.
function makeLegacyProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-migrate-'));
  initProject(cwd);
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);

  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), OLD_COMPOSE);
  fs.writeFileSync(path.join(cwd, '.env'), 'FORCE_HTTPS=false\nHSTS_MAX_AGE=0\n');
  fs.writeFileSync(path.join(cwd, 'Dockerfile'), 'FROM nginx:latest\nRUN rm -f /etc/nginx/conf.d/default.conf\n');
  fs.writeFileSync(path.join(cwd, 'nginx', 'nginx.conf'), 'user nginx;\n# old\n');
  fs.rmSync(path.join(cwd, 'nginx', 'docker-entrypoint.d', '60-rotate-logs.sh'));
  fs.rmSync(path.join(cwd, 'nginx', 'templates', '00-connection-upgrade.conf.template'));
  fs.rmSync(path.join(cwd, '.pn.json'));
  fs.rmSync(path.join(cwd, 'sites'), { recursive: true });
  return cwd;
}

const read = (cwd, ...parts) => fs.readFileSync(path.join(cwd, ...parts), 'utf8');

test('pn migrate only reports changes unless --yes is given', () => {
  const cwd = makeLegacyProject();
  const before = read(cwd, 'docker-compose.yml');

  const output = migrateProject({ cwd });

  assert.match(output, /Project schema 1, latest 2/);
  assert.match(output, /~ Dockerfile/);
  assert.match(output, /\+ nginx\/templates\/00-connection-upgrade\.conf\.template/);
  assert.match(output, /\+ nginx\/docker-entrypoint\.d\/60-rotate-logs\.sh/);
  assert.match(output, /~ docker-compose\.yml\n\s+- pin the nginx image/);
  assert.match(output, /Run `pn migrate --yes` to apply/);
  assert.equal(read(cwd, 'docker-compose.yml'), before);
  assert.ok(!fs.existsSync(path.join(cwd, '.pn-backup')));
});

test('pn migrate --yes updates base files, backs up the old ones, and leaves sites alone', () => {
  const cwd = makeLegacyProject();
  const site = read(cwd, 'nginx', 'templates', 'app.example.com.conf.template');
  fs.writeFileSync(path.join(cwd, 'nginx', 'templates', 'app.example.com.conf.template'), `${site}# my edit\n`);

  const output = migrateProject({ cwd, yes: true, now: new Date('2026-10-03T08:09:10Z') });

  assert.match(output, /Migrated project to schema 2/);
  assert.match(output, /\.pn-backup\/20261003080910\//);
  assert.match(read(cwd, 'Dockerfile'), /^ARG NGINX_IMAGE=/m);
  assert.match(read(cwd, 'nginx', 'nginx.conf'), /gzip on;/);
  assert.equal(read(cwd, '.pn-backup', '20261003080910', 'Dockerfile'), 'FROM nginx:latest\nRUN rm -f /etc/nginx/conf.d/default.conf\n');
  assert.ok(fs.existsSync(path.join(cwd, 'nginx', 'templates', '00-connection-upgrade.conf.template')));
  assert.ok(fs.statSync(path.join(cwd, 'nginx', 'docker-entrypoint.d', '60-rotate-logs.sh')).mode & 0o100);
  assert.ok(fs.statSync(path.join(cwd, 'sites')).isDirectory());
  assert.deepEqual(JSON.parse(read(cwd, '.pn.json')), { schemaVersion: 2 });
  assert.match(read(cwd, 'nginx', 'templates', 'app.example.com.conf.template'), /# my edit\n$/);

  const compose = read(cwd, 'docker-compose.yml');
  assert.match(compose, /^# my deployment/);
  assert.match(compose, /NGINX_IMAGE: \$\{NGINX_IMAGE:-nginx:\d+\.\d+\}/);
  assert.match(compose, /LOG_ROTATE_SIZE_MB: \$\{LOG_ROTATE_SIZE_MB:-50\}/);
  assert.match(compose, /- \.\/sites:\/srv\/sites:ro/);
  assert.match(compose, /- \.\/extra:\/extra # my own mount/);
  assert.match(compose, /image: \$\{CERTBOT_IMAGE:-certbot\/certbot:v\d+\.\d+\.\d+\}/);

  const env = read(cwd, '.env');
  assert.match(env, /^FORCE_HTTPS=false$/m);
  assert.match(env, /^NGINX_IMAGE=nginx:\d+\.\d+$/m);
  assert.match(env, /^CERTBOT_IMAGE=certbot\/certbot:v/m);
});

test('pn migrate is idempotent', () => {
  const cwd = makeLegacyProject();
  migrateProject({ cwd, yes: true });
  const compose = read(cwd, 'docker-compose.yml');
  const env = read(cwd, '.env');

  assert.equal(migrateProject({ cwd }), 'Project is up to date (schema 2).');
  assert.equal(migrateProject({ cwd, yes: true }), 'Project is up to date (schema 2).');
  assert.equal(read(cwd, 'docker-compose.yml'), compose);
  assert.equal(read(cwd, '.env'), env);
});

test('a freshly initialized project needs no migration', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-migrate-'));
  initProject(cwd);

  assert.equal(migrateProject({ cwd }), 'Project is up to date (schema 2).');
});

test('migrated compose files keep working with network commands and static sites', () => {
  const cwd = makeLegacyProject();
  migrateProject({ cwd, yes: true });

  networkAdd('frontend', { cwd });
  addSite('docs.example.com', undefined, { template: 'static' }, cwd);

  assert.deepEqual(readProxyNetworks(read(cwd, 'docker-compose.yml')), ['frontend']);
});

test('pn migrate --yes --run recreates the proxy after migrating', () => {
  const cwd = makeLegacyProject();
  const calls = [];

  const output = migrateProject({ cwd, yes: true, run: true, runCompose: (args) => calls.push(args) });

  assert.match(output, /Started proxy nginx\./);
  assert.deepEqual(calls[calls.length - 1], ['up', '-d', '--build', '--force-recreate', 'proxy-nginx']);
});

test('pn migrate requires a project', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-migrate-'));
  assert.throws(() => migrateProject({ cwd }), /Run pn init first/);
});
