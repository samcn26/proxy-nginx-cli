const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  addSite,
  authAdd,
  authDisable,
  authList,
  authRemove,
  initProject,
  removeSite,
  statusProject,
  templateList,
} = require('../lib/commands');
const { apr1, enableAuth } = require('../lib/auth');

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-auth-'));
  initProject(cwd);
  addSite('admin.example.com', '127.0.0.1:3000', {}, cwd);
  return cwd;
}

const template = (cwd, domain = 'admin.example.com') =>
  fs.readFileSync(path.join(cwd, 'nginx', 'templates', `${domain}.conf.template`), 'utf8');
const htpasswd = (cwd, domain = 'admin.example.com') =>
  fs.readFileSync(path.join(cwd, 'nginx', 'auth', `${domain}.htpasswd`), 'utf8');

test('apr1 hashes match the Apache documentation example and openssl', () => {
  assert.equal(apr1('myPassword', 'r31.....'), '$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/');

  let hasOpenssl = true;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    hasOpenssl = false;
  }
  if (!hasOpenssl) {
    return;
  }

  for (const password of ['a', 'password', 'pässwörd-ünï', 'x'.repeat(15), 'x'.repeat(16), 'x'.repeat(17), 'x'.repeat(40), 'sp ace $pecial "q"']) {
    for (const salt of ['abcdefgh', 'Z9./Z9./']) {
      const expected = execFileSync('openssl', ['passwd', '-apr1', '-salt', salt, password], { encoding: 'utf8' }).trim();
      assert.equal(apr1(password, salt), expected, `${password} / ${salt}`);
    }
  }
});

test('apr1 uses a random salt by default', () => {
  assert.notEqual(apr1('same-password'), apr1('same-password'));
  assert.match(apr1('same-password'), /^\$apr1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}$/);
});

test('the first user turns basic auth on in the template and writes a hashed user file', () => {
  const cwd = makeProject();

  const output = authAdd('admin.example.com', 'alice', 'correct-horse', { cwd });

  assert.match(output, /Added user alice to admin\.example\.com\./);
  assert.match(output, /Basic auth is NOT active yet/);
  const site = template(cwd);
  assert.equal((site.match(/auth_basic "Restricted"; # pn:auth/g) || []).length, 2);
  assert.equal(
    (site.match(/auth_basic_user_file \/etc\/nginx\/auth\/admin\.example\.com\.htpasswd; # pn:auth/g) || []).length,
    2
  );
  assert.match(htpasswd(cwd), /^alice:\$apr1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}\n$/);
  assert.ok(!htpasswd(cwd).includes('correct-horse'));
  assert.equal(fs.statSync(path.join(cwd, 'nginx', 'auth', 'admin.example.com.htpasswd')).mode & 0o777, 0o644);

  // The ACME challenge location stays open.
  const acme = site.slice(site.indexOf('/.well-known/acme-challenge/'), site.indexOf('location / {'));
  assert.doesNotMatch(acme, /auth_basic/);
});

test('further users and password changes take effect without touching the template', () => {
  const cwd = makeProject();
  authAdd('admin.example.com', 'alice', 'correct-horse', { cwd });
  const before = template(cwd);
  const aliceBefore = htpasswd(cwd).split('\n')[0];

  assert.match(authAdd('admin.example.com', 'bob', 'battery-staple', { cwd }), /Added user bob.*\nTakes effect immediately/s);
  assert.match(authAdd('admin.example.com', 'alice', 'new-password-1', { cwd }), /Updated the password of alice/);

  assert.equal(template(cwd), before);
  const lines = htpasswd(cwd).trim().split('\n');
  assert.deepEqual(lines.map((line) => line.split(':')[0]), ['alice', 'bob']);
  assert.notEqual(lines[0], aliceBefore);
});

test('auth add --run applies when it turns auth on, and not for later users', () => {
  const cwd = makeProject();
  const calls = [];
  const runCompose = (args) => calls.push(args);

  assert.match(authAdd('admin.example.com', 'alice', 'correct-horse', { cwd, run: true, runCompose }), /Applied site changes/);
  assert.equal(calls[1][3], 'sh');

  calls.length = 0;
  authAdd('admin.example.com', 'bob', 'battery-staple', { cwd, run: true, runCompose });
  assert.deepEqual(calls, []);
});

test('the last user cannot be removed, which would lock everyone out', () => {
  const cwd = makeProject();
  authAdd('admin.example.com', 'alice', 'correct-horse', { cwd });
  authAdd('admin.example.com', 'bob', 'battery-staple', { cwd });

  assert.match(authRemove('admin.example.com', 'bob', { cwd }), /Removed user bob/);
  assert.throws(
    () => authRemove('admin.example.com', 'alice', { cwd }),
    /last user.*pn auth disable admin\.example\.com/
  );
  assert.throws(() => authRemove('admin.example.com', 'nobody', { cwd }), /has no user nobody\. Users: alice/);
  assert.match(htpasswd(cwd), /^alice:/);
});

test('auth disable removes the directives and the user file, leaving the rest of the template', () => {
  const cwd = makeProject();
  const original = template(cwd);
  authAdd('admin.example.com', 'alice', 'correct-horse', { cwd });

  const output = authDisable('admin.example.com', { cwd });

  assert.match(output, /Basic auth disabled.*users were deleted/s);
  assert.match(output, /stays protected until you apply/);
  assert.equal(template(cwd), original);
  assert.ok(!fs.existsSync(path.join(cwd, 'nginx', 'auth', 'admin.example.com.htpasswd')));
  assert.throws(() => authDisable('admin.example.com', { cwd }), /not enabled/);
});

test('auth disable --run applies', () => {
  const cwd = makeProject();
  authAdd('admin.example.com', 'alice', 'correct-horse', { cwd });
  const calls = [];

  authDisable('admin.example.com', { cwd, run: true, runCompose: (args) => calls.push(args) });

  assert.equal(calls[1][3], 'sh');
});

test('auth list, template list, and status --json show who is protected', () => {
  const cwd = makeProject();
  addSite('open.example.com', '127.0.0.1:3001', {}, cwd);
  assert.equal(authList(undefined, { cwd }), 'No sites use basic auth.');
  authAdd('admin.example.com', 'alice', 'correct-horse', { cwd });
  authAdd('admin.example.com', 'bob', 'battery-staple', { cwd });

  assert.equal(authList(undefined, { cwd }), 'admin.example.com: alice, bob');
  assert.equal(authList('open.example.com', { cwd }), 'No sites use basic auth.');
  assert.match(templateList(cwd), /^admin\.example\.com .*basic auth: 2 user\(s\)/m);
  assert.doesNotMatch(templateList(cwd), /^open\.example\.com .*basic auth/m);

  const sites = JSON.parse(statusProject(cwd, () => {}, { json: true })).sites;
  assert.deepEqual(
    sites.map((site) => [site.domain, site.auth, site.authUsers]),
    [['admin.example.com', true, 2], ['open.example.com', false, 0]]
  );
});

test('removing a site deletes its user file', () => {
  const cwd = makeProject();
  authAdd('admin.example.com', 'alice', 'correct-horse', { cwd });

  removeSite('admin.example.com', cwd);

  assert.ok(!fs.existsSync(path.join(cwd, 'nginx', 'auth', 'admin.example.com.htpasswd')));
});

test('auth refuses sites it cannot protect, and bad input', () => {
  const cwd = makeProject();
  addSite('plain.example.com', '127.0.0.1:3000', { ssl: false }, cwd);
  addSite('old.example.com', 'https://new.example.com', { template: 'redirect' }, cwd);

  assert.throws(() => authAdd('plain.example.com', 'alice', 'correct-horse', { cwd }), /no SSL.*clear text/);
  assert.throws(() => authAdd('old.example.com', 'alice', 'correct-horse', { cwd }), /redirect site/);
  assert.throws(() => authAdd('missing.example.com', 'alice', 'correct-horse', { cwd }), /No site template found/);
  assert.throws(() => authAdd('admin.example.com', 'ali:ce', 'correct-horse', { cwd }), /Invalid user name/);
  assert.throws(() => authAdd('admin.example.com', 'alice', 'short', { cwd }), /at least 8 characters/);
  assert.throws(() => authAdd('admin.example.com', 'alice', 'two\nlines-long', { cwd }), /single line/);
  assert.ok(!fs.existsSync(path.join(cwd, 'nginx', 'auth', 'admin.example.com.htpasswd')));
  assert.doesNotMatch(template(cwd), /auth_basic/);
});

test('auth explains missing mounts for projects created before basic auth existed', () => {
  const cwd = makeProject();
  const compose = path.join(cwd, 'docker-compose.yml');
  fs.writeFileSync(compose, fs.readFileSync(compose, 'utf8').replace('      - ./nginx/auth:/etc/nginx/auth:ro\n', ''));

  assert.throws(
    () => authAdd('admin.example.com', 'alice', 'correct-horse', { cwd }),
    /no mount for \/etc\/nginx\/auth\. Run pn migrate --yes first/
  );
  assert.doesNotMatch(template(cwd), /auth_basic/);
});

test('auth warns when the site can still be reached over plain HTTP', () => {
  const cwd = makeProject();
  addSite('open-http.example.com', '127.0.0.1:3000', { forceHttps: false }, cwd);
  fs.writeFileSync(path.join(cwd, '.env'), 'FORCE_HTTPS=false\n');

  assert.match(authAdd('open-http.example.com', 'alice', 'correct-horse', { cwd }), /Warning: .*plain HTTP/);
  assert.match(authAdd('admin.example.com', 'alice', 'correct-horse', { cwd }), /Warning: .*plain HTTP/);

  fs.writeFileSync(path.join(cwd, '.env'), 'FORCE_HTTPS=true\n');
  addSite('safe.example.com', '127.0.0.1:3000', {}, cwd);
  assert.doesNotMatch(authAdd('safe.example.com', 'alice', 'correct-horse', { cwd }), /Warning/);
});

test('enableAuth skips locations that only redirect and works on hand-edited templates', () => {
  const content = `server {
    server_name a.example.com;
    location / {
        return 301 https://b.example.com$request_uri;
    }
}

server {
    server_name b.example.com;
    location / {
        proxy_pass http://x;
    }
    location /api/ {
        proxy_pass http://y;
    }
}
`;

  const { content: edited, count } = enableAuth(content, 'b.example.com');

  assert.equal(count, 1);
  assert.match(edited, /location \/ \{\n {8}auth_basic "Restricted"; # pn:auth\n {8}auth_basic_user_file [^\n]+; # pn:auth\n {8}proxy_pass http:\/\/x;/);
  assert.equal((edited.match(/auth_basic "Restricted"/g) || []).length, 1);
});

test('aliases that redirect to the main domain are not behind the login', () => {
  const cwd = makeProject();
  addSite('example.com', '127.0.0.1:3000', { www: true, redirectAliases: true }, cwd);

  authAdd('example.com', 'alice', 'correct-horse', { cwd });

  const site = template(cwd, 'example.com');
  assert.equal((site.match(/auth_basic "Restricted"/g) || []).length, 2);
  const redirectServer = site.slice(site.indexOf('server_name www.example.com'));
  assert.doesNotMatch(redirectServer, /auth_basic/);
});
