const crypto = require('node:crypto');
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

const BACKUP_ROOT = '.pn-backup';
const MANIFEST_FILE = 'manifest.json';

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

function backupRoot(cwd) {
  return path.join(cwd, BACKUP_ROOT);
}

function uniqueBackupName(cwd, base) {
  let name = base;
  for (let suffix = 2; fs.existsSync(path.join(backupRoot(cwd), name)); suffix += 1) {
    name = `${base}-${suffix}`;
  }

  return name;
}

// Without options.yes this only reports; with it, changed files are backed up to
// .pn-backup/<timestamp>/ (with a manifest that pn rollback uses) and rewritten.
function migrateProject(cwd, options = {}) {
  const version = projectSchemaVersion(cwd);
  const plan = planMigration(cwd).map((file) => ({ ...file, cwd }));
  const metadataPath = path.join(cwd, PROJECT_METADATA_FILE);
  const metadataBefore = readIfExists(metadataPath);
  const needsMetadata = version < PROJECT_SCHEMA_VERSION || metadataBefore === null;

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
        'Run `pn migrate --yes` to apply. Changed files are backed up to .pn-backup/ and `pn rollback` undoes the migration.',
      ].join('\n'),
    };
  }

  const backupName = uniqueBackupName(cwd, timestamp(options.now));
  const backupDir = path.join(backupRoot(cwd), backupName);
  fs.mkdirSync(backupDir, { recursive: true });

  const writes = [...plan];
  if (needsMetadata || plan.length > 0) {
    writes.push({
      path: PROJECT_METADATA_FILE,
      action: metadataBefore === null ? 'create' : 'update',
      content: projectMetadata(),
      notes: [],
    });
  }

  const manifest = {
    createdAt: (options.now || new Date()).toISOString(),
    schemaVersionBefore: version,
    schemaVersionAfter: PROJECT_SCHEMA_VERSION,
    files: [],
  };

  for (const file of writes) {
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

    manifest.files.push({ path: file.path, action: file.action, sha256: sha256(file.content) });
  }

  fs.mkdirSync(path.join(cwd, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(backupDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const updated = manifest.files.filter((file) => file.action === 'update').length;
  const created = manifest.files.filter((file) => file.action === 'create').length;
  return {
    applied: true,
    changed: true,
    backupName,
    output: [
      `Migrated project to schema ${PROJECT_SCHEMA_VERSION}: ${updated} file(s) updated, ${created} created.`,
      `Previous versions are in ${path.relative(cwd, backupDir)}/. Undo with \`pn rollback --yes\`.`,
      'Apply with `pn restart` (or run `pn migrate --yes --run`).',
    ].join('\n'),
  };
}

function readManifest(backupDir) {
  const content = readIfExists(path.join(backupDir, MANIFEST_FILE));
  if (content === null) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Backups, oldest first. A backup without a manifest (not made by pn migrate) can
// still be restored file by file.
function listBackups(cwd) {
  const root = backupRoot(cwd);
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, dir: path.join(root, name), manifest: readManifest(path.join(root, name)) }));
}

function filesBelow(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(full, base) : [path.relative(base, full)];
  });
}

function backupEntries(backup) {
  if (backup.manifest) {
    return backup.manifest.files;
  }

  return filesBelow(backup.dir)
    .filter((file) => file !== MANIFEST_FILE)
    .map((file) => ({ path: file, action: 'update' }));
}

function describeBackup(backup) {
  const manifest = backup.manifest;
  const parts = [backup.name];
  if (manifest) {
    parts.push(manifest.createdAt, `${manifest.files.length} file(s)`);
    if (manifest.rolledBackAt) {
      parts.push(`rolled back ${manifest.rolledBackAt}`);
    }
  } else {
    parts.push('no manifest');
  }

  return `  ${parts.join('  ')}`;
}

// Restores the files a migration changed and removes the ones it created.
// Without options.yes this only reports. Files edited after the migration are
// kept unless options.force is set.
function rollbackProject(cwd, options = {}) {
  const backups = listBackups(cwd);

  if (options.list) {
    return {
      applied: false,
      output: backups.length === 0
        ? 'No backups. pn migrate --yes creates them in .pn-backup/.'
        : ['Backups (oldest first):', ...backups.map(describeBackup)].join('\n'),
    };
  }

  let backup;
  if (options.backup) {
    backup = backups.find((candidate) => candidate.name === options.backup);
    if (!backup) {
      throw new Error(`No backup named ${options.backup}. Run pn rollback --list.`);
    }
  } else {
    backup = [...backups].reverse().find((candidate) => !(candidate.manifest && candidate.manifest.rolledBackAt));
  }

  if (!backup) {
    return { applied: false, output: 'No backups to roll back. Run pn rollback --list to see them.' };
  }

  const plan = backupEntries(backup).map((entry) => {
    const target = path.join(cwd, entry.path);
    const current = readIfExists(target);
    const modified = entry.sha256 !== undefined && current !== null && sha256(current) !== entry.sha256;

    if (modified && !options.force) {
      return { ...entry, step: 'skip', note: 'modified since the migration; kept (use --force to overwrite)' };
    }
    if (entry.action === 'create') {
      return current === null
        ? { ...entry, step: 'none', note: 'already gone' }
        : { ...entry, step: 'remove', note: 'created by the migration; will be removed' };
    }

    return { ...entry, step: 'restore', note: 'restore the previous version' };
  });

  const symbols = { restore: '~', remove: '-', skip: '!', none: '=' };
  const lines = plan.map((item) => `  ${symbols[item.step]} ${item.path}  (${item.note})`);
  const skipped = plan.filter((item) => item.step === 'skip').length;

  if (!options.yes) {
    return {
      applied: false,
      backupName: backup.name,
      output: [
        `Rollback of backup ${backup.name}:`,
        ...lines,
        '',
        'Run `pn rollback --yes` to apply, then `pn restart` (or add --run). Site templates are never touched.',
      ].join('\n'),
    };
  }

  for (const item of plan) {
    const target = path.join(cwd, item.path);
    if (item.step === 'restore') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(backup.dir, item.path), target);
    } else if (item.step === 'remove') {
      fs.rmSync(target, { force: true });
    }
  }

  if (backup.manifest) {
    const updated = { ...backup.manifest, rolledBackAt: (options.now || new Date()).toISOString() };
    fs.writeFileSync(path.join(backup.dir, MANIFEST_FILE), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  }

  const restored = plan.filter((item) => item.step === 'restore').length;
  const removed = plan.filter((item) => item.step === 'remove').length;
  return {
    applied: true,
    backupName: backup.name,
    output: [
      `Rolled back backup ${backup.name}: ${restored} file(s) restored, ${removed} removed.`,
      skipped > 0 ? `${skipped} file(s) were modified after the migration and kept: ${plan.filter((item) => item.step === 'skip').map((item) => item.path).join(', ')}` : '',
      'Apply with `pn restart` (or run `pn rollback --yes --run`).',
    ].filter(Boolean).join('\n'),
  };
}

module.exports = {
  listBackups,
  migrateProject,
  planMigration,
  projectSchemaVersion,
  rollbackProject,
};
