const fs = require('node:fs');
const path = require('node:path');

// Generated base templates shared by every site; they are not sites themselves.
const BASE_TEMPLATES = [
  '00-connection-upgrade.conf.template',
  '00-unmatched-host.conf.template',
];

const TEMPLATE_SUFFIX = '.conf.template';

function templatesDir(cwd) {
  return path.join(cwd, 'nginx', 'templates');
}

function siteTemplatePath(cwd, domain) {
  return path.join(templatesDir(cwd), `${domain}${TEMPLATE_SUFFIX}`);
}

function listSiteDomains(cwd) {
  const dir = templatesDir(cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((filename) => filename.endsWith(TEMPLATE_SUFFIX))
    .filter((filename) => !BASE_TEMPLATES.includes(filename))
    .map((filename) => filename.slice(0, -TEMPLATE_SUFFIX.length))
    .sort();
}

// Reads what a site template declares. Works on hand-edited templates too: it only
// looks at the first server_name / upstream server / preset marker it finds.
function parseSiteTemplate(domain, content) {
  const serverName = /^\s*server_name\s+([^;]+);/m.exec(content);
  const names = serverName ? serverName[1].trim().split(/\s+/).filter((name) => name !== '_') : [domain];
  const upstream = /^\s*server\s+([^\s;{]+);/m.exec(content);
  const preset = /^# pn: preset=(\S+)/m.exec(content);

  return {
    domain,
    aliases: names.filter((name) => name !== domain),
    upstream: upstream ? upstream[1] : null,
    ssl: /^\s*listen\s+443\b/m.test(content),
    preset: preset ? preset[1] : 'custom-or-proxy',
  };
}

function readSite(cwd, domain) {
  const filePath = siteTemplatePath(cwd, domain);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const site = parseSiteTemplate(domain, fs.readFileSync(filePath, 'utf8'));
  if (site.preset === 'custom-or-proxy') {
    site.preset = site.upstream ? 'proxy' : 'custom';
  }
  return site;
}

function readSites(cwd) {
  return listSiteDomains(cwd).map((domain) => readSite(cwd, domain));
}

module.exports = {
  BASE_TEMPLATES,
  listSiteDomains,
  parseSiteTemplate,
  readSite,
  readSites,
  siteTemplatePath,
  templatesDir,
};
