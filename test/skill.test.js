const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

test('the agent skill has valid front matter and only documents real commands', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'proxy-nginx-cli', 'SKILL.md'), 'utf8');
  const match = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);

  assert.ok(match, 'front matter with name and description');
  assert.equal(match[1], 'proxy-nginx-cli');
  assert.ok(match[2].length > 40);

  const { createProgram } = require('../lib/cli');
  const commands = createProgram().commands.map((command) => command.name());
  const used = [...skill.matchAll(/^pn ([a-z]+)/gm)].map((found) => found[1]);
  assert.ok(used.length > 10);
  for (const name of new Set(used)) {
    assert.ok(commands.includes(name), `pn ${name} is documented but does not exist`);
  }
});

test('package files ship the skill and scripts', () => {
  const pkg = require('../package.json');

  assert.ok(pkg.files.includes('skills'));
  assert.ok(pkg.files.includes('lib'));
  assert.ok(fs.existsSync(path.join(root, 'lib', 'scripts', 'apply-sites.sh')));
  assert.ok(fs.existsSync(path.join(root, 'LICENSE')));
});
