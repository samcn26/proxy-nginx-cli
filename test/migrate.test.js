const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { addSite, initProject, migrateProject, networkAdd, rollbackProject } = require('../lib/commands');
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

const UP = ['up', '-d', '--build', '--force-recreate', 'proxy-nginx'];

// Everything pn migrate may touch, so rollback can be compared byte for byte.
const MIGRATED_PATHS = [
  'Dockerfile',
  'docker-compose.yml',
  '.env',
  'nginx/nginx.conf',
  'nginx/docker-entrypoint.d/50-reload-renewed-certs.sh',
  'nginx/docker-entrypoint.d/60-rotate-logs.sh',
  'nginx/templates/00-connection-upgrade.conf.template',
  'nginx/templates/00-unmatched-host.conf.template',
  'nginx/templates/app.example.com.conf.template',
  '.pn.json',
];

function snapshot(cwd) {
  return Object.fromEntries(
    MIGRATED_PATHS.map((file) => {
      const target = path.join(cwd, file);
      return [file, fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null];
    })
  );
}

test('pn migrate --yes writes a manifest listing what it changed and created', () => {
  const cwd = makeLegacyProject();

  migrateProject({ cwd, yes: true, now: new Date('2026-10-03T08:09:10Z') });

  const manifest = JSON.parse(read(cwd, '.pn-backup', '20261003080910', 'manifest.json'));
  const byPath = Object.fromEntries(manifest.files.map((file) => [file.path, file.action]));
  assert.equal(manifest.schemaVersionBefore, 1);
  assert.equal(manifest.schemaVersionAfter, 2);
  assert.equal(byPath.Dockerfile, 'update');
  assert.equal(byPath['docker-compose.yml'], 'update');
  assert.equal(byPath['nginx/docker-entrypoint.d/60-rotate-logs.sh'], 'create');
  assert.equal(byPath['.pn.json'], 'create');
  assert.ok(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
});

test('pn rollback previews by default and --yes restores the project byte for byte', () => {
  const cwd = makeLegacyProject();
  const before = snapshot(cwd);
  migrateProject({ cwd, yes: true });
  const migrated = snapshot(cwd);
  assert.notDeepEqual(migrated, before);

  const preview = rollbackProject({ cwd });
  assert.match(preview, /Rollback of backup \d+:/);
  assert.match(preview, /~ Dockerfile/);
  assert.match(preview, /- nginx\/docker-entrypoint\.d\/60-rotate-logs\.sh {2}\(created by the migration/);
  assert.deepEqual(snapshot(cwd), migrated);

  const output = rollbackProject({ cwd, yes: true });

  assert.match(output, /Rolled back backup \d+: \d+ file\(s\) restored, \d+ removed\./);
  assert.match(output, /pn restart/);
  assert.deepEqual(snapshot(cwd), before);
  assert.match(read(cwd, 'nginx', 'templates', 'app.example.com.conf.template'), /proxy_pass/);
});

test('pn rollback keeps files edited after the migration unless --force is given', () => {
  const cwd = makeLegacyProject();
  migrateProject({ cwd, yes: true });
  fs.appendFileSync(path.join(cwd, 'nginx', 'nginx.conf'), '# edited after migrate\n');

  const output = rollbackProject({ cwd, yes: true });

  assert.match(output, /1 file\(s\) were modified after the migration and kept: nginx\/nginx\.conf/);
  assert.match(read(cwd, 'nginx', 'nginx.conf'), /# edited after migrate/);
  assert.match(read(cwd, 'Dockerfile'), /^FROM nginx:latest/);

  // The backup is already rolled back, so name it to retry with --force.
  const [name] = fs.readdirSync(path.join(cwd, '.pn-backup'));
  assert.match(rollbackProject({ cwd, backup: name, yes: true, force: true }), /restored/);
  assert.equal(read(cwd, 'nginx', 'nginx.conf'), 'user nginx;\n# old\n');
});

test('pn rollback --list, backup names, and already rolled back backups', () => {
  const cwd = makeLegacyProject();
  assert.match(rollbackProject({ cwd, list: true }), /No backups/);
  assert.match(rollbackProject({ cwd }), /No backups to roll back/);

  migrateProject({ cwd, yes: true, now: new Date('2026-10-03T08:00:00Z') });
  assert.match(rollbackProject({ cwd, list: true }), /20261003080000 {2}2026-10-03T08:00:00\.000Z {2}\d+ file\(s\)\n?$/);
  assert.throws(() => rollbackProject({ cwd, backup: 'nope' }), /No backup named nope/);

  rollbackProject({ cwd, yes: true });
  assert.match(rollbackProject({ cwd, list: true }), /rolled back 20\d\d-/);
  assert.match(rollbackProject({ cwd }), /No backups to roll back/);
});

test('pn rollback undoes the newest migration first', () => {
  const cwd = makeLegacyProject();
  migrateProject({ cwd, yes: true, now: new Date('2026-10-03T08:00:00Z') });
  // Make the project need migrating again, then migrate a second time.
  fs.writeFileSync(path.join(cwd, 'Dockerfile'), 'FROM nginx:latest\n');
  migrateProject({ cwd, yes: true, now: new Date('2026-10-03T09:00:00Z') });

  const output = rollbackProject({ cwd, yes: true });

  assert.match(output, /Rolled back backup 20261003090000/);
  assert.equal(read(cwd, 'Dockerfile'), 'FROM nginx:latest\n');
});

test('pn rollback --yes --run recreates the proxy', () => {
  const cwd = makeLegacyProject();
  migrateProject({ cwd, yes: true });
  const calls = [];

  const output = rollbackProject({ cwd, yes: true, run: true, runCompose: (args) => calls.push(args) });

  assert.match(output, /Started proxy nginx\./);
  assert.deepEqual(calls[calls.length - 1], UP);
});

test('pn migrate --yes --run rolls back automatically when the restart fails', () => {
  const cwd = makeLegacyProject();
  const before = snapshot(cwd);
  const calls = [];
  let failed = false;

  assert.throws(
    () =>
      migrateProject({
        cwd,
        yes: true,
        run: true,
        runCompose: (args) => {
          calls.push(args);
          if (args[0] === 'exec') {
            throw new Error('not running');
          }
          if (args[0] === 'up' && !failed) {
            failed = true;
            throw new Error('nginx exited with code 1');
          }
        },
      }),
    (error) => {
      assert.match(error.message, /Restart after migrating failed: nginx exited with code 1/);
      assert.match(error.message, /Rolled back backup \d+/);
      assert.match(error.message, /Started proxy nginx\./);
      return true;
    }
  );

  assert.deepEqual(snapshot(cwd), before);
  assert.equal(calls.filter((args) => args[0] === 'up').length, 2);
});

test('pn migrate --yes --run reports when the restart after rollback also fails', () => {
  const cwd = makeLegacyProject();

  assert.throws(
    () =>
      migrateProject({
        cwd,
        yes: true,
        run: true,
        runCompose: (args) => {
          throw new Error(args[0] === 'up' ? 'docker daemon unavailable' : 'not running');
        },
      }),
    /Restarting with the previous files also failed: docker daemon unavailable/
  );
});

const APP_COMPOSE = 'services:\n  web:\n    image: app\n  db:\n    image: postgres\n';

test('pn commands refuse a directory whose compose file has other services but no proxy-nginx', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-notpn-'));
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), APP_COMPOSE);

  for (const run of [
    () => migrateProject({ cwd }),
    () => rollbackProject({ cwd }),
    () => networkAdd('frontend', { cwd }),
  ]) {
    assert.throws(run, /defines web, db but no proxy-nginx service, so this is not a pn project directory\. Run pn from the directory where you ran pn init\./);
  }

  assert.deepEqual(fs.readdirSync(cwd), ['docker-compose.yml']);
  assert.equal(read(cwd, 'docker-compose.yml'), APP_COMPOSE);
});

test('the error points at a pn project in a subdirectory or a parent directory', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-notpn-'));
  fs.writeFileSync(path.join(app, 'docker-compose.yml'), APP_COMPOSE);
  const proxy = path.join(app, 'proxy');
  fs.mkdirSync(proxy);
  initProject(proxy);

  assert.throws(() => migrateProject({ cwd: app }), /A pn project is at: proxy\. cd there/);

  // From a nested directory without any compose file, the parent project is found.
  const nested = path.join(proxy, 'sites');
  assert.throws(() => migrateProject({ cwd: nested }), /No docker-compose\.yml found\. Run pn init first\. A pn project is at: \.\.\. cd there/);

  // The proxy directory itself is fine.
  assert.equal(migrateProject({ cwd: proxy }), 'Project is up to date (schema 2).');
});

test('compose files without any services are still treated as projects', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-notpn-'));
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), 'services: {}\n');

  assert.doesNotThrow(() => require('../lib/commands').stopProject(cwd, () => {}));
});
