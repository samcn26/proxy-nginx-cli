const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_SOON_DAYS = 14;

function certsDirOf(cwd) {
  return path.join(cwd, 'ssl', 'certs');
}

function renewalConfPath(cwd, name) {
  return path.join(certsDirOf(cwd), 'renewal', `${name}.conf`);
}

function hasRenewalConfig(cwd, name) {
  try {
    return fs.statSync(renewalConfPath(cwd, name)).size > 0;
  } catch {
    return false;
  }
}

function isStagingLineage(cwd, name) {
  try {
    return /acme-staging/.test(fs.readFileSync(renewalConfPath(cwd, name), 'utf8'));
  } catch {
    return false;
  }
}

function readCertificateInfo(cwd, name, now = new Date()) {
  try {
    const cert = new X509Certificate(
      fs.readFileSync(path.join(certsDirOf(cwd), 'live', name, 'fullchain.pem'))
    );
    const expires = new Date(cert.validTo);
    return {
      expires: expires.toISOString().slice(0, 10),
      daysLeft: Math.floor((expires.getTime() - now.getTime()) / DAY_MS),
      selfSigned: cert.subject === cert.issuer,
      staging: /STAGING|Fake LE/i.test(cert.issuer),
    };
  } catch {
    // Missing or unreadable (for example root-owned) certificate.
    return {};
  }
}

// Certificates known to the project: certbot lineages and live directories
// (including the self-signed development certificates generated at start).
function certificateReport(cwd, now = new Date()) {
  const certsDir = certsDirOf(cwd);
  const names = new Set();

  const renewalDir = path.join(certsDir, 'renewal');
  if (fs.existsSync(renewalDir)) {
    for (const filename of fs.readdirSync(renewalDir)) {
      if (filename.endsWith('.conf') && hasRenewalConfig(cwd, filename.slice(0, -5))) {
        names.add(filename.slice(0, -5));
      }
    }
  }

  const liveDir = path.join(certsDir, 'live');
  if (fs.existsSync(liveDir)) {
    for (const entry of fs.readdirSync(liveDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.includes('.bak.')) {
        names.add(entry.name);
      }
    }
  }

  return [...names].sort().map((name) => ({
    name,
    renewal: hasRenewalConfig(cwd, name),
    ...readCertificateInfo(cwd, name, now),
  }));
}

function formatCertificate(cert) {
  let line = cert.name;
  if (cert.expires) {
    line += ` (expires ${cert.expires}, ${cert.daysLeft} days left)`;
  }

  const flags = [];
  if (cert.selfSigned) {
    flags.push('self-signed');
  }
  if (cert.staging) {
    flags.push('staging');
  }
  if (cert.daysLeft !== undefined && cert.daysLeft < 0) {
    flags.push('EXPIRED');
  } else if (cert.daysLeft !== undefined && cert.daysLeft <= EXPIRING_SOON_DAYS) {
    flags.push('expiring soon');
  }
  if (!cert.renewal && !cert.selfSigned) {
    flags.push('not managed by certbot');
  }

  return flags.length > 0 ? `${line} [${flags.join(', ')}]` : line;
}

module.exports = {
  certificateReport,
  certsDirOf,
  formatCertificate,
  hasRenewalConfig,
  isStagingLineage,
  readCertificateInfo,
  renewalConfPath,
};
