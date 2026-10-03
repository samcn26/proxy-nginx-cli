const assert = require('node:assert/strict');
const { test } = require('node:test');

const { initProject, networkAdd, networkRemove } = require('../lib/commands');
const { parseCompose, readProxyNetworks, writeProxyNetworks } = require('../lib/compose-file');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function projectWith(compose) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-yaml-'));
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), compose);
  return cwd;
}

test('generated compose file round-trips network changes without other edits', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-nginx-cli-yaml-'));
  initProject(cwd);
  const original = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');

  networkAdd('app-net', { cwd });
  networkRemove('app-net', { cwd });

  assert.equal(fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8'), original);
});

test('network commands work when services are reordered, commented, and indented differently', () => {
  const cwd = projectWith(`# my proxy
services:
  certbot:
    image: certbot/certbot # renewal
  db:
    image: postgres
  proxy-nginx:
    image: nginx   # keep this comment
    ports:
        - "80:80"
`);

  networkAdd('frontend', { cwd });

  const compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /^# my proxy/);
  assert.match(compose, /# renewal/);
  assert.match(compose, /# keep this comment/);
  assert.deepEqual(readProxyNetworks(compose), ['frontend']);
  assert.match(compose, /networks:\n {2}frontend:\n {4}external: true/);
});

test('network commands keep per-network options in map form', () => {
  const cwd = projectWith(`services:
  proxy-nginx:
    image: nginx
    networks:
      default:
      old:
        aliases:
          - proxy
networks:
  old:
    external: true
`);

  networkAdd('frontend', { cwd });
  let compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  assert.deepEqual(readProxyNetworks(compose), ['old', 'frontend']);
  assert.match(compose, /aliases:\n\s+- proxy/);

  networkRemove('old', { cwd });
  compose = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
  assert.deepEqual(readProxyNetworks(compose), ['frontend']);
  assert.doesNotMatch(compose, /old/);
});

test('removing a network keeps its top-level definition while another service uses it', () => {
  const compose = writeProxyNetworks(
    `services:
  proxy-nginx:
    image: nginx
    networks:
      - default
      - shared
  api:
    image: api
    networks:
      - shared
networks:
  shared:
    external: true
`,
    []
  );

  assert.match(compose, /networks:\n {2}shared:\n {4}external: true/);
  assert.deepEqual(readProxyNetworks(compose), []);
});

test('invalid compose files produce clear errors', () => {
  assert.throws(() => parseCompose('services: [unclosed'), /not valid YAML/);
  assert.throws(() => parseCompose('services:\n  other:\n    image: x\n'), /must include a proxy-nginx service/);
});
