const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { createProgram } = require('../lib/cli');

const root = path.join(__dirname, '..');
const readmes = {
  'README.md': fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
  'README.zh-CN.md': fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8'),
};

function walk(command, prefix = []) {
  return command.commands.flatMap((sub) => {
    const names = [...prefix, sub.name()];
    return [{ names, command: sub }, ...walk(sub, names)];
  });
}

const commands = walk(createProgram());

test('both READMEs document every command and subcommand', () => {
  assert.ok(commands.length >= 25);

  for (const [file, text] of Object.entries(readmes)) {
    for (const { names } of commands) {
      assert.ok(text.includes(`pn ${names.join(' ')}`), `${file} is missing "pn ${names.join(' ')}"`);
    }
  }
});

test('both READMEs mention every option of every command', () => {
  for (const [file, text] of Object.entries(readmes)) {
    for (const { names, command } of commands) {
      for (const option of command.options) {
        assert.ok(text.includes(option.long), `${file} does not mention ${option.long} (pn ${names.join(' ')})`);
      }
    }
  }
});

test('both READMEs have a section per top-level command', () => {
  for (const [file, text] of Object.entries(readmes)) {
    for (const { names } of commands.filter((entry) => entry.names.length === 1)) {
      assert.match(text, new RegExp(`^### pn ${names[0]}$`, 'm'), `${file} has no "### pn ${names[0]}" section`);
    }
  }
});

test('the two READMEs link to each other and share the same section structure', () => {
  assert.match(readmes['README.md'], /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(readmes['README.zh-CN.md'], /\[English\]\(README\.md\)/);

  const headings = (text) => [...text.matchAll(/^(#{2,3}) (pn [a-z]+)$/gm)].map((match) => match[2]);
  assert.deepEqual(headings(readmes['README.zh-CN.md']), headings(readmes['README.md']));

  const sections = (text) => (text.match(/^## /gm) || []).length;
  assert.equal(sections(readmes['README.zh-CN.md']), sections(readmes['README.md']));
});

test('the English and Chinese command help list the same commands', () => {
  const { chineseHelpText } = require('../lib/cli');
  const zh = chineseHelpText();
  for (const { names } of commands.filter((entry) => entry.names.length === 1)) {
    assert.match(zh, new RegExp(`^  ${names[0]}[ \\[<]`, 'm'), `pn --help cn does not list ${names[0]}`);
  }
});
