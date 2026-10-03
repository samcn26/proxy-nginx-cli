const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Basic auth for site templates. Passwords are stored as apr1 (Apache MD5-crypt)
// hashes, which nginx reads natively, so no htpasswd tool is needed on the host.

const ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const AUTH_MARKER = '# pn:auth';
const AUTH_DIR_IN_CONTAINER = '/etc/nginx/auth';
const MIN_PASSWORD_LENGTH = 8;

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();

function to64(value, count) {
  let out = '';
  let remaining = value;
  for (let i = 0; i < count; i += 1) {
    out += ALPHABET[remaining & 0x3f];
    remaining >>= 6;
  }
  return out;
}

function randomSalt() {
  return [...crypto.randomBytes(8)].map((byte) => ALPHABET[byte % 64]).join('');
}

function apr1(password, salt = randomSalt()) {
  const pw = Buffer.from(password, 'utf8');
  const saltBytes = Buffer.from(salt, 'ascii');
  const alternate = md5(pw, saltBytes, pw);

  const context = [pw, Buffer.from('$apr1$'), saltBytes];
  for (let length = pw.length; length > 0; length -= 16) {
    context.push(alternate.subarray(0, Math.min(16, length)));
  }
  for (let bits = pw.length; bits > 0; bits >>= 1) {
    context.push(bits & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  }

  let final = md5(...context);
  for (let round = 0; round < 1000; round += 1) {
    const parts = [round & 1 ? pw : final];
    if (round % 3) {
      parts.push(saltBytes);
    }
    if (round % 7) {
      parts.push(pw);
    }
    parts.push(round & 1 ? final : pw);
    final = md5(...parts);
  }

  const f = final;
  const encoded =
    to64((f[0] << 16) | (f[6] << 8) | f[12], 4) +
    to64((f[1] << 16) | (f[7] << 8) | f[13], 4) +
    to64((f[2] << 16) | (f[8] << 8) | f[14], 4) +
    to64((f[3] << 16) | (f[9] << 8) | f[15], 4) +
    to64((f[4] << 16) | (f[10] << 8) | f[5], 4) +
    to64(f[11], 2);

  return `$apr1$${salt}$${encoded}`;
}

function assertUsername(user) {
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(user || '')) {
    throw new Error(`Invalid user name: ${user} (letters, digits and . _ @ - only, up to 64 characters).`);
  }
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || /[\r\n\0]/.test(password)) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters on a single line.`);
  }
}

function htpasswdPath(cwd, domain) {
  return path.join(cwd, 'nginx', 'auth', `${domain}.htpasswd`);
}

function readUsers(filePath) {
  const users = new Map();
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return users;
  }

  for (const line of content.split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      users.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }

  return users;
}

function writeUsers(filePath, users) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = [...users].map(([user, hash]) => `${user}:${hash}`).join('\n');
  // Read by the nginx worker user inside the container, so it cannot be owner-only.
  fs.writeFileSync(filePath, `${content}\n`, { encoding: 'utf8', mode: 0o644 });
  fs.chmodSync(filePath, 0o644);
}

function isAuthEnabled(content) {
  return content.includes(AUTH_MARKER);
}

// Adds auth_basic to every content `location / {` of a site template. Locations that
// only redirect (alias hosts) are left open on purpose. Returns { content, count }.
function enableAuth(content, domain) {
  const lines = content.split('\n');
  const output = [];
  let count = 0;

  for (let index = 0; index < lines.length; index += 1) {
    output.push(lines[index]);
    const match = /^(\s*)location \/ \{\s*$/.exec(lines[index]);
    if (!match || /^\s*return 301\b/.test(lines[index + 1] || '')) {
      continue;
    }

    const pad = `${match[1]}    `;
    output.push(
      `${pad}auth_basic "Restricted"; ${AUTH_MARKER}`,
      `${pad}auth_basic_user_file ${AUTH_DIR_IN_CONTAINER}/${domain}.htpasswd; ${AUTH_MARKER}`
    );
    count += 1;
  }

  return { content: output.join('\n'), count };
}

function disableAuth(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes(AUTH_MARKER))
    .join('\n');
}

module.exports = {
  AUTH_DIR_IN_CONTAINER,
  AUTH_MARKER,
  MIN_PASSWORD_LENGTH,
  apr1,
  assertPassword,
  assertUsername,
  disableAuth,
  enableAuth,
  htpasswdPath,
  isAuthEnabled,
  readUsers,
  writeUsers,
};
