const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  addSite,
  certProject,
  initProject,
  logsProject,
  statusProject,
  templateEdit,
  templateList,
} = require('../lib/commands');

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-presets-'));
  initProject(cwd);
  return cwd;
}

function readSite(cwd, domain) {
  return fs.readFileSync(path.join(cwd, 'nginx', 'templates', `${domain}.conf.template`), 'utf8');
}

test('aliases are served by the main server and covered by the certificate', () => {
  const cwd = makeProject();

  const output = addSite('example.com', '127.0.0.1:3000', { alias: ['Blog.Example.com'], www: true }, cwd);

  assert.match(output, /Aliases: blog\.example\.com, www\.example\.com\./);
  const site = readSite(cwd, 'example.com');
  assert.equal((site.match(/server_name example\.com blog\.example\.com www\.example\.com;/g) || []).length, 2);
  assert.match(site, /live\/example\.com\/fullchain\.pem/);

  const runs = [];
  certProject('example.com', cwd, (args) => args[0] === 'run' && runs.push(args));
  const run = runs[0];
  assert.deepEqual(
    run.filter((arg, index) => run[index - 1] === '-d'),
    ['example.com', 'blog.example.com', 'www.example.com']
  );
  assert.deepEqual(run.slice(run.indexOf('--cert-name'), run.indexOf('--cert-name') + 2), [
    '--cert-name',
    'example.com',
  ]);
});

test('--redirect-aliases sends alias hosts to the main domain over the same certificate', () => {
  const cwd = makeProject();

  addSite('example.com', '127.0.0.1:3000', { www: true, redirectAliases: true }, cwd);

  const site = readSite(cwd, 'example.com');
  assert.match(site, /server_name example\.com;/);
  assert.equal((site.match(/server_name www\.example\.com;/g) || []).length, 2);
  assert.match(site, /return 301 https:\/\/example\.com\$request_uri;/);
  assert.equal((site.match(/live\/example\.com\/fullchain\.pem/g) || []).length, 2);

  const runs = [];
  certProject('example.com', cwd, (args) => args[0] === 'run' && runs.push(args));
  assert.ok(runs[0].includes('www.example.com'));
});

test('--redirect-aliases without aliases is rejected', () => {
  assert.throws(
    () => addSite('example.com', '127.0.0.1:3000', { redirectAliases: true }, makeProject()),
    /--redirect-aliases needs at least one --alias/
  );
});

test('aliases are validated like domains', () => {
  assert.throws(
    () => addSite('example.com', '127.0.0.1:3000', { alias: ['bad;alias.com'] }, makeProject()),
    /Invalid domain/
  );
});

test('static template serves sites/<domain> and creates a placeholder page', () => {
  const cwd = makeProject();

  const output = addSite('docs.example.com', undefined, { template: 'static' }, cwd);

  assert.match(output, /Added docs\.example\.com -> static files in sites\/docs\.example\.com with SSL\./);
  const site = readSite(cwd, 'docs.example.com');
  assert.match(site, /^# pn: preset=static$/m);
  assert.match(site, /root \/srv\/sites\/docs\.example\.com;/);
  assert.match(site, /try_files \$uri \$uri\/ =404;/);
  assert.doesNotMatch(site, /proxy_pass|upstream/);
  assert.match(
    fs.readFileSync(path.join(cwd, 'sites', 'docs.example.com', 'index.html'), 'utf8'),
    /docs\.example\.com/
  );
});

test('static placeholder never overwrites existing content', () => {
  const cwd = makeProject();
  fs.mkdirSync(path.join(cwd, 'sites', 'docs.example.com'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'sites', 'docs.example.com', 'index.html'), 'mine');

  addSite('docs.example.com', undefined, { template: 'static' }, cwd);

  assert.equal(fs.readFileSync(path.join(cwd, 'sites', 'docs.example.com', 'index.html'), 'utf8'), 'mine');
});

test('spa template falls back to index.html', () => {
  const cwd = makeProject();

  addSite('app.example.com', undefined, { template: 'spa', ssl: false }, cwd);

  assert.match(readSite(cwd, 'app.example.com'), /try_files \$uri \$uri\/ \/index\.html;/);
});

test('static templates reject targets and projects without the sites mount', () => {
  const cwd = makeProject();
  assert.throws(
    () => addSite('docs.example.com', '127.0.0.1:3000', { template: 'static' }, cwd),
    /takes no target/
  );

  const compose = path.join(cwd, 'docker-compose.yml');
  fs.writeFileSync(compose, fs.readFileSync(compose, 'utf8').replace('      - ./sites:/srv/sites:ro\n', ''));
  assert.throws(
    () => addSite('docs.example.com', undefined, { template: 'static' }, cwd),
    /Run pn migrate --yes first/
  );
});

test('redirect template sends every request to the target, keeping the path', () => {
  const cwd = makeProject();

  addSite('old.example.com', 'https://new.example.com', { template: 'redirect' }, cwd);

  const site = readSite(cwd, 'old.example.com');
  assert.match(site, /return 301 https:\/\/new\.example\.com\$request_uri;/);
  assert.doesNotMatch(site, /proxy_pass/);
});

test('redirect template validates its target', () => {
  const cwd = makeProject();
  assert.throws(() => addSite('old.example.com', undefined, { template: 'redirect' }, cwd), /needs a target URL/);
  assert.throws(
    () => addSite('old.example.com', 'ftp://new.example.com', { template: 'redirect' }, cwd),
    /protocol must be http or https/
  );
  assert.throws(
    () => addSite('old.example.com', 'https://new.example.com/path', { template: 'redirect' }, cwd),
    /must only include protocol, host/
  );
});

test('unknown templates are rejected', () => {
  assert.throws(() => addSite('a.example.com', '1.1.1.1:80', { template: 'php' }, makeProject()), /Unknown template: php/);
});

test('per-site limits, access rules, and access log are rendered', () => {
  const cwd = makeProject();

  addSite('admin.example.com', '127.0.0.1:3000', {
    maxBodySize: '10m',
    timeout: '30',
    allow: ['203.0.113.0/24', '2001:db8::1'],
    accessLog: true,
  }, cwd);

  const site = readSite(cwd, 'admin.example.com');
  assert.match(site, /client_max_body_size 10m;/);
  assert.doesNotMatch(site, /client_max_body_size 50m;/);
  assert.match(site, /proxy_read_timeout 30s;/);
  assert.match(site, /proxy_send_timeout 30s;/);
  assert.match(site, /allow 203\.0\.113\.0\/24;\n\s+allow 2001:db8::1;\n\s+deny all;/);
  assert.match(site, /access_log \/var\/log\/nginx\/admin\.example\.com\.access\.log main;/);
  // ACME validation must stay reachable even when access is restricted.
  const acme = site.slice(site.indexOf('/.well-known/acme-challenge/'), site.indexOf('location / {'));
  assert.doesNotMatch(acme, /deny all/);
});

test('per-site options are validated', () => {
  const cwd = makeProject();
  for (const [options, message] of [
    [{ maxBodySize: '10 m' }, /Invalid --max-body-size/],
    [{ maxBodySize: 'abc' }, /Invalid --max-body-size/],
    [{ timeout: '0' }, /Invalid --timeout/],
    [{ timeout: 'x' }, /Invalid --timeout/],
    [{ allow: ['not-an-ip'] }, /Invalid --allow address/],
    [{ allow: ['10.0.0.0/99'] }, /Invalid --allow address/],
    [{ allow: ['10.0.0.1; deny all'] }, /Invalid --allow address/],
  ]) {
    assert.throws(() => addSite('a.example.com', '1.1.1.1:80', options, cwd), message);
  }
});

test('status and template list show presets, upstreams, and aliases', () => {
  const cwd = makeProject();
  addSite('example.com', '127.0.0.1:3000', { www: true }, cwd);
  addSite('docs.example.com', undefined, { template: 'static', ssl: false }, cwd);

  const status = statusProject(cwd, () => {});
  assert.match(status, /- example\.com -> host\.docker\.internal:3000 \(aliases: www\.example\.com\)/);
  assert.match(status, /- docs\.example\.com\n/);

  const list = templateList(cwd);
  assert.match(list, /^docs\.example\.com \[static, http-only\]$/m);
  assert.match(list, /^example\.com -> host\.docker\.internal:3000 \[proxy, ssl, aliases: www\.example\.com\]$/m);
});

test('template edit validates the edited template while the proxy runs', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);
  const edited = [];
  const calls = [];

  const output = templateEdit('app.example.com', {
    cwd,
    edit: (file) => edited.push(file),
    runCompose: (args) => calls.push(args),
  });

  assert.deepEqual(edited, [path.join(cwd, 'nginx', 'templates', 'app.example.com.conf.template')]);
  assert.match(output, /nginx -t passed/);
  assert.deepEqual(calls.map((args) => args[0]), ['exec', 'run']);
});

test('template edit reports a failed check and --run applies the edit', () => {
  const cwd = makeProject();
  addSite('app.example.com', '127.0.0.1:3000', {}, cwd);

  assert.throws(
    () =>
      templateEdit('app.example.com', {
        cwd,
        edit: () => {},
        runCompose: (args) => {
          if (args[0] === 'run') {
            throw new Error('bad');
          }
        },
      }),
    /nginx -t failed.*running proxy was not changed/
  );

  const calls = [];
  const output = templateEdit('app.example.com', {
    cwd,
    edit: () => {},
    run: true,
    runCompose: (args) => calls.push(args),
  });
  assert.match(output, /Applied site changes/);
  assert.equal(calls[1][3], 'sh');
});

test('template edit fails for unknown sites', () => {
  assert.throws(() => templateEdit('missing.example.com', { cwd: makeProject(), edit: () => {} }), /No site template found/);
});

test('pn logs prints the end of the access, error, and per-site logs', () => {
  const cwd = makeProject();
  const logs = path.join(cwd, 'logs');
  fs.writeFileSync(path.join(logs, 'access.log'), 'a1\na2\na3\n');
  fs.writeFileSync(path.join(logs, 'error.log'), 'e1\n');
  fs.writeFileSync(path.join(logs, 'app.example.com.access.log'), 's1\ns2\n');

  assert.equal(logsProject(undefined, { cwd, lines: 2 }), 'a2\na3');
  assert.equal(logsProject(undefined, { cwd }), 'a1\na2\na3');
  assert.equal(logsProject(undefined, { cwd, error: true }), 'e1');
  assert.equal(logsProject('App.example.com', { cwd }), 's1\ns2');

  const followed = [];
  assert.equal(logsProject(undefined, { cwd, follow: true, lines: 5, runTail: (...args) => followed.push(args) }), '');
  assert.deepEqual(followed, [[path.join(logs, 'access.log'), 5]]);
});

test('pn logs explains missing logs and validates input', () => {
  const cwd = makeProject();
  assert.throws(() => logsProject('app.example.com', { cwd }), /Add the site with --access-log/);
  assert.throws(() => logsProject(undefined, { cwd }), /No log file at logs\/access\.log yet/);
  assert.throws(() => logsProject(undefined, { cwd, lines: 0 }), /Invalid --lines/);
  assert.throws(() => logsProject('../etc/passwd', { cwd }), /Invalid domain/);
});

test('per-site HTTPS redirect: follows FORCE_HTTPS by default, or is fixed on or off', () => {
  const cwd = makeProject();
  addSite('env.example.com', '127.0.0.1:3000', {}, cwd);
  addSite('on.example.com', '127.0.0.1:3000', { forceHttps: true }, cwd);
  addSite('off.example.com', '127.0.0.1:3000', { forceHttps: false }, cwd);

  assert.match(readSite(cwd, 'env.example.com'), /set \$force_https "\$\{FORCE_HTTPS\}";/);
  assert.match(readSite(cwd, 'on.example.com'), /set \$force_https "true";/);
  assert.match(readSite(cwd, 'off.example.com'), /set \$force_https "false";/);

  const list = templateList(cwd);
  assert.match(list, /^off\.example\.com .*https redirect: off/m);
  assert.match(list, /^on\.example\.com .*https redirect: on/m);
  assert.doesNotMatch(list, /^env\.example\.com .*https redirect/m);

  const json = JSON.parse(statusProject(cwd, () => {}, { json: true }));
  const modes = Object.fromEntries(json.sites.map((site) => [site.domain, site.httpsRedirect]));
  assert.deepEqual(modes, { 'env.example.com': 'env', 'off.example.com': 'off', 'on.example.com': 'on' });
});

test('--force-https needs an SSL site', () => {
  assert.throws(
    () => addSite('plain.example.com', '127.0.0.1:3000', { ssl: false, forceHttps: true }, makeProject()),
    /need SSL/
  );
  const cwd = makeProject();
  addSite('plain.example.com', '127.0.0.1:3000', { ssl: false }, cwd);
  assert.equal(JSON.parse(statusProject(cwd, () => {}, { json: true })).sites[0].httpsRedirect, null);
});

test('pn up --pull and pn restart --pull refresh images before validating and recreating', () => {
  const cwd = makeProject();
  const { upProject, restartProject } = require('../lib/commands');

  for (const run of [upProject, restartProject]) {
    const calls = [];
    run(cwd, (args) => calls.push(args), { pull: true });

    assert.deepEqual(calls.slice(0, 2), [['build', '--pull', 'proxy-nginx'], ['pull', 'certbot']]);
    assert.deepEqual(calls[2], ['exec', '-T', 'proxy-nginx', 'true']);
    assert.equal(calls[3][0], 'run');
    assert.deepEqual(calls[4], ['up', '-d', '--build', '--force-recreate', 'proxy-nginx']);
  }
});

test('pn up --pull stops before touching the proxy when a pull fails', () => {
  const cwd = makeProject();
  const { upProject } = require('../lib/commands');
  const calls = [];

  assert.throws(
    () =>
      upProject(cwd, (args) => {
        calls.push(args);
        if (args[0] === 'pull') {
          throw new Error('network unreachable');
        }
      }, { pull: true }),
    /network unreachable/
  );

  assert.deepEqual(calls.map((args) => args[0]), ['build', 'pull']);
});

test('pn up without --pull does not pull', () => {
  const cwd = makeProject();
  const { upProject } = require('../lib/commands');
  const calls = [];

  upProject(cwd, (args) => calls.push(args));

  assert.ok(!calls.some((args) => args[0] === 'build' || args[0] === 'pull'));
});

test('pn status reports the nginx version of the running proxy', () => {
  const cwd = makeProject();
  const runner = (args) => (args.includes('nginx -v 2>&1') ? 'nginx version: nginx/1.30.2\n' : undefined);

  assert.match(statusProject(cwd, runner), /^Proxy: running, nginx 1\.30\.2$/m);
  assert.equal(JSON.parse(statusProject(cwd, runner, { json: true })).proxy.nginxVersion, '1.30.2');

  const stopped = (args) => {
    if (args[0] === 'exec') {
      throw new Error('not running');
    }
  };
  assert.match(statusProject(cwd, stopped), /^Proxy: not running$/m);
  assert.deepEqual(JSON.parse(statusProject(cwd, stopped, { json: true })).proxy, {
    running: false,
    nginxVersion: null,
  });
});
