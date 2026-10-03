const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const script = path.join(__dirname, '..', 'lib', 'scripts', 'apply-sites.sh');

// Fake container: templates -> conf.d like the nginx image's envsubst hook, and an
// nginx stub whose `-t` fails when any rendered config contains BAD.
function makeFakeContainer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-apply-'));
  const dirs = {
    root,
    templates: path.join(root, 'templates'),
    conf: path.join(root, 'conf.d'),
    hooks: path.join(root, 'hooks'),
    bin: path.join(root, 'bin'),
  };
  Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

  fs.writeFileSync(
    path.join(dirs.hooks, '20-envsubst-on-templates.sh'),
    `#!/bin/sh\nfor f in "${dirs.templates}"/*.template; do [ -f "$f" ] && cp "$f" "${dirs.conf}/$(basename "$f" .template)"; done\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(dirs.hooks, '40-generate-dev-certs.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(dirs.bin, 'nginx'),
    `#!/bin/sh
case "$1" in
  -t) ! grep -rq BAD "${dirs.conf}" ;;
  -s) echo "$2" >> "${root}/signals" ;;
esac
`,
    { mode: 0o755 }
  );

  return dirs;
}

function apply(dirs) {
  return spawnSync('sh', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirs.bin}:${process.env.PATH}`,
      PN_CONF_DIR: dirs.conf,
      PN_ENTRYPOINT_DIR: dirs.hooks,
    },
  });
}

const files = (dir) => fs.readdirSync(dir).sort();

test('apply renders templates, drops removed sites, tests, and reloads', () => {
  const dirs = makeFakeContainer();
  fs.writeFileSync(path.join(dirs.templates, 'a.conf.template'), 'server a');
  fs.writeFileSync(path.join(dirs.conf, 'a.conf'), 'old a');
  fs.writeFileSync(path.join(dirs.conf, 'removed.conf'), 'old removed');

  const result = apply(dirs);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files(dirs.conf), ['a.conf']);
  assert.equal(fs.readFileSync(path.join(dirs.conf, 'a.conf'), 'utf8'), 'server a');
  assert.equal(fs.readFileSync(path.join(dirs.root, 'signals'), 'utf8').trim(), 'reload');
});

test('apply restores the previous config and does not reload when nginx -t fails', () => {
  const dirs = makeFakeContainer();
  fs.writeFileSync(path.join(dirs.templates, 'a.conf.template'), 'BAD config');
  fs.writeFileSync(path.join(dirs.conf, 'a.conf'), 'good a');
  fs.writeFileSync(path.join(dirs.conf, 'b.conf'), 'good b');

  const result = apply(dirs);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous configuration restored/);
  assert.deepEqual(files(dirs.conf), ['a.conf', 'b.conf']);
  assert.equal(fs.readFileSync(path.join(dirs.conf, 'a.conf'), 'utf8'), 'good a');
  assert.ok(!fs.existsSync(path.join(dirs.root, 'signals')));
});

test('apply restores the previous config when a render hook fails', () => {
  const dirs = makeFakeContainer();
  fs.writeFileSync(path.join(dirs.conf, 'a.conf'), 'good a');
  fs.writeFileSync(path.join(dirs.hooks, '20-envsubst-on-templates.sh'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });

  const result = apply(dirs);

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(dirs.conf, 'a.conf'), 'utf8'), 'good a');
});
