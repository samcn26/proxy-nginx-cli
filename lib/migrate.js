const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { migrateCompose } = require('./compose-file');
const {
  DEFAULT_CERTBOT_IMAGE,
  DEFAULT_NGINX_IMAGE,
  PROJECT_METADATA_FILE,
  PROJECT_SCHEMA_VERSION,
  managedFiles,
  projectMetadata,
} = require('./project-files');

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function projectSchemaVersion(cwd) {
  const content = readIfExists(path.join(cwd, PROJECT_METADATA_FILE));
  if (content === null) {
    return 1;
  }

  try {
    return Number(JSON.parse(content).schemaVersion) || 1;
  } catch {
    return 1;
  }
}

function envAdditions(env) {
  const lines = [];
  if (!/^NGINX_IMAGE=/m.test(env)) {
    lines.push(`NGINX_IMAGE=${DEFAULT_NGINX_IMAGE}`);
  }
  if (!/^CERTBOT_IMAGE=/m.test(env)) {
    lines.push(`CERTBOT_IMAGE=${DEFAULT_CERTBOT_IMAGE}`);
  }

  return lines;
}

// Works out what would change. Site templates are never touched.
function planMigration(cwd) {
  const plan = [];

  for (const file of managedFiles()) {
    const current = readIfExists(path.join(cwd, file.path));
    if (current === null) {
      plan.push({ ...file, action: 'create', notes: [] });
    } else if (current !== file.content) {
      plan.push({ ...file, action: 'update', current, notes: [] });
    }
  }

  const composeFile = path.join(cwd, 'docker-compose.yml');
  const compose = fs.readFileSync(composeFile, 'utf8');
  const migrated = migrateCompose(compose, {
    nginxImage: DEFAULT_NGINX_IMAGE,
    certbotImage: DEFAULT_CERTBOT_IMAGE,
  });
  if (migrated.changes.length > 0) {
    plan.push({
      path: 'docker-compose.yml',
      action: 'update',
      current: compose,
      content: migrated.content,
      notes: migrated.changes,
    });
  }

  const env = readIfExists(path.join(cwd, '.env'));
  const additions = envAdditions(env || '');
  if (additions.length > 0) {
    plan.push({
      path: '.env',
      action: env === null ? 'create' : 'update',
      current: env === null ? undefined : env,
      content: `${env === null ? '' : `${env.replace(/\n*$/, '\n')}\n# Added by pn migrate\n`}${additions.join('\n')}\n`,
      notes: ['pin image versions'],
    });
  }

  return plan;
}

function unifiedDiff(file) {
  if (file.action === 'create') {
    return '(new file)';
  }

  const result = spawnSync(
    'diff',
    ['-u', '--label', `current/${file.path}`, '--label', `new/${file.path}`, path.join(file.cwd, file.path), '-'],
    { input: file.content, encoding: 'utf8' }
  );

  return result.error || !result.stdout ? '' : result.stdout.trimEnd();
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/\D/g, '').slice(0, 14);
}

// Without options.yes this only reports; with it, changed files are backed up to
// .pn-backup/<timestamp>/ and rewritten.
function migrateProject(cwd, options = {}) {
  const version = projectSchemaVersion(cwd);
  const plan = planMigration(cwd).map((file) => ({ ...file, cwd }));
  const needsMetadata = version < PROJECT_SCHEMA_VERSION;

  if (plan.length === 0 && !needsMetadata) {
    return { applied: false, changed: false, output: `Project is up to date (schema ${version}).` };
  }

  if (!options.yes) {
    const sections = plan.map((file) => {
      const notes = file.notes.map((note) => `    - ${note}`).join('\n');
      const diff = file.action === 'update' && !file.notes.length ? unifiedDiff(file) : '';
      return [`  ${file.action === 'create' ? '+' : '~'} ${file.path}`, notes, diff].filter(Boolean).join('\n');
    });

    return {
      applied: false,
      changed: true,
      output: [
        `Project schema ${version}, latest ${PROJECT_SCHEMA_VERSION}. Pending changes (site templates are never touched):`,
        ...sections,
        '',
        'Run `pn migrate --yes` to apply. Changed files are backed up to .pn-backup/.',
      ].join('\n'),
    };
  }

  const backupDir = path.join(cwd, '.pn-backup', timestamp(options.now));
  for (const file of plan) {
    const target = path.join(cwd, file.path);
    if (file.action === 'update') {
      fs.mkdirSync(path.dirname(path.join(backupDir, file.path)), { recursive: true });
      fs.copyFileSync(target, path.join(backupDir, file.path));
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
    if (file.mode) {
      fs.chmodSync(target, file.mode);
    }
  }

  fs.mkdirSync(path.join(cwd, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(cwd, PROJECT_METADATA_FILE), projectMetadata(), 'utf8');

  const updated = plan.filter((file) => file.action === 'update').length;
  const created = plan.filter((file) => file.action === 'create').length;
  return {
    applied: true,
    changed: true,
    output: [
      `Migrated project to schema ${PROJECT_SCHEMA_VERSION}: ${updated} file(s) updated, ${created} created.`,
      updated > 0 ? `Previous versions are in ${path.relative(cwd, backupDir)}/.` : '',
      'Apply with `pn restart` (or run `pn migrate --yes --run`).',
    ].filter(Boolean).join('\n'),
  };
}

module.exports = {
  migrateProject,
  planMigration,
  projectSchemaVersion,
};
