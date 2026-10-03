const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const YAML = require('yaml');

const { downProject, initProject, migrateProject, networkAdd, networkRemove, stopProject } = require('../lib/commands');

// A compose file as a user would extend it: an extra database service, an extra mount and
// published port on the proxy, custom top-level volumes and networks, and comments.
const EXTENDED_COMPOSE = `# my deployment
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
      - "8443:8443"  # my extra port
    environment:
      FORCE_HTTPS: \${FORCE_HTTPS:-true}
      HSTS_MAX_AGE: \${HSTS_MAX_AGE:-31536000}
    volumes:
      - ./nginx/templates:/etc/nginx/templates:ro
      - ./ssl/certs:/etc/nginx/certs
      - ./ssl/www:/var/www/certbot
      - ./logs:/var/log/nginx
      - ./extra:/extra
    extra_hosts:
      - "host.docker.internal:host-gateway"

  certbot:
    image: certbot/certbot:latest
    container_name: proxy-certbot
    restart: unless-stopped
    volumes:
      - ./ssl/certs:/etc/letsencrypt
      - ./ssl/www:/var/www/certbot

  # not managed by pn
  timescaledb:
    image: timescale/timescaledb:latest-pg16
    container_name: timescaledb
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - ./data/timescaledb:/var/lib/postgresql/data
    networks:
      - backend

volumes:
  scratch: {}

networks:
  backend:
    external: true
`;

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-extra-'));
  initProject(cwd);
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), EXTENDED_COMPOSE);
  return cwd;
}

const read = (cwd) => fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');

test('pn stop and pn down only touch pn services when the compose file has other services', () => {
  const cwd = makeProject();
  const calls = [];
  const runner = (args) => calls.push(args);

  const stopped = stopProject(cwd, runner);
  const removed = downProject(cwd, runner);

  assert.deepEqual(calls, [['stop', 'proxy-nginx', 'certbot'], ['rm', '-s', '-f', 'proxy-nginx', 'certbot']]);
  assert.match(stopped, /Left running \(not managed by pn\): timescaledb\./);
  assert.match(removed, /Left untouched \(not managed by pn\): timescaledb; the compose network stays/);
});

test('pn stop and pn down keep their plain behavior for a compose file with only pn services', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-plain-'));
  initProject(cwd);
  const calls = [];

  stopProject(cwd, (args) => calls.push(args));
  downProject(cwd, (args) => calls.push(args));

  assert.deepEqual(calls, [['stop'], ['down']]);
});

test('pn migrate keeps extra services, ports, mounts, networks and comments exactly as they were', () => {
  const cwd = makeProject();
  const before = YAML.parse(EXTENDED_COMPOSE);

  migrateProject({ cwd, yes: true });

  const text = read(cwd);
  const after = YAML.parse(text);
  assert.deepEqual(after.services.timescaledb, before.services.timescaledb);
  assert.deepEqual(after.volumes, before.volumes);
  assert.deepEqual(after.networks, before.networks);
  assert.deepEqual(after.services['proxy-nginx'].ports, before.services['proxy-nginx'].ports);
  assert.ok(after.services['proxy-nginx'].volumes.includes('./extra:/extra'));
  assert.match(text, /^# my deployment/);
  assert.match(text, /# not managed by pn/);
  assert.match(text, /# my extra port/);
  // ...while pn's own additions are present.
  assert.ok(after.services['proxy-nginx'].volumes.includes('./nginx/auth:/etc/nginx/auth:ro'));
  assert.match(after.services.certbot.image, /^\$\{CERTBOT_IMAGE:-/);
  assert.equal(migrateProject({ cwd }), 'Project is up to date (schema 3).');
});

test('pn migrate never changes values the user already set', () => {
  const cwd = makeProject();
  const custom = EXTENDED_COMPOSE
    .replace('restart: unless-stopped\n    ports:', 'restart: always\n    ports:')
    .replace('image: certbot/certbot:latest', 'image: certbot/certbot:v9.9.9');
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), custom);

  migrateProject({ cwd, yes: true });

  const after = YAML.parse(read(cwd));
  assert.equal(after.services['proxy-nginx'].restart, 'always');
  assert.equal(after.services.certbot.image, 'certbot/certbot:v9.9.9');
  assert.equal(after.services['proxy-nginx'].environment.FORCE_HTTPS, '${FORCE_HTTPS:-true}');
});

test('pn network add/remove leave the other services and custom networks alone', () => {
  const cwd = makeProject();
  const before = YAML.parse(EXTENDED_COMPOSE);

  networkAdd('frontend', { cwd });
  networkRemove('frontend', { cwd });

  const text = read(cwd);
  const after = YAML.parse(text);
  assert.deepEqual(after.services.timescaledb, before.services.timescaledb);
  assert.deepEqual(after.networks, before.networks);
  assert.deepEqual(after.volumes, before.volumes);
  assert.match(text, /# not managed by pn/);
});

test('a network shared with another service is not removed from the top level', () => {
  const cwd = makeProject();
  networkAdd('backend', { cwd });
  networkRemove('backend', { cwd });

  const after = YAML.parse(read(cwd));
  assert.deepEqual(after.networks, { backend: { external: true } });
  assert.deepEqual(after.services.timescaledb.networks, ['backend']);
});
