const YAML = require('yaml');

const PROXY_SERVICE = 'proxy-nginx';

function parseCompose(compose) {
  const doc = YAML.parseDocument(compose);
  if (doc.errors.length > 0) {
    throw new Error(`docker-compose.yml is not valid YAML: ${doc.errors[0].message}`);
  }

  if (!YAML.isMap(doc.getIn(['services', PROXY_SERVICE], true))) {
    throw new Error(`docker-compose.yml must include a ${PROXY_SERVICE} service.`);
  }

  return doc;
}

function networkNames(node) {
  if (YAML.isSeq(node)) {
    return node.items.map((item) => String(YAML.isScalar(item) ? item.value : item));
  }

  if (YAML.isMap(node)) {
    return node.items.map((pair) => String(YAML.isScalar(pair.key) ? pair.key.value : pair.key));
  }

  return [];
}

function readProxyNetworks(compose) {
  const doc = parseCompose(compose);
  return networkNames(doc.getIn(['services', PROXY_SERVICE, 'networks'], true)).filter(
    (name) => name !== 'default'
  );
}

function writeProxyNetworks(compose, networks) {
  const names = [...new Set(networks)];
  const doc = parseCompose(compose);
  const path = ['services', PROXY_SERVICE, 'networks'];
  const previous = networkNames(doc.getIn(path, true)).filter((name) => name !== 'default');
  const node = doc.getIn(path, true);

  if (names.length === 0) {
    doc.deleteIn(path);
  } else if (YAML.isMap(node)) {
    // Keep per-network options (aliases, ipv4_address, ...) the user may have added.
    for (const name of previous) {
      if (!names.includes(name)) {
        node.delete(name);
      }
    }
    if (!node.has('default')) {
      node.items.unshift(doc.createPair('default', null));
    }
    for (const name of names) {
      if (!node.has(name)) {
        node.set(name, null);
      }
    }
  } else {
    doc.setIn(path, doc.createNode(['default', ...names]));
  }

  syncExternalNetworks(doc, names, previous);
  return doc.toString({ lineWidth: 0 });
}

function syncExternalNetworks(doc, names, previous) {
  for (const name of names) {
    if (!doc.hasIn(['networks', name])) {
      doc.setIn(['networks', name], doc.createNode({ external: true }));
    }
  }

  for (const name of previous) {
    if (names.includes(name) || usedByOtherService(doc, name)) {
      continue;
    }

    if (doc.getIn(['networks', name, 'external']) === true) {
      doc.deleteIn(['networks', name]);
    }
  }

  const networks = doc.get('networks', true);
  if (YAML.isMap(networks) && networks.items.length === 0) {
    doc.delete('networks');
    return;
  }

  const pair = YAML.isMap(doc.contents) && doc.contents.items.find(
    (item) => YAML.isScalar(item.key) && item.key.value === 'networks'
  );
  if (pair && pair.key) {
    pair.key.spaceBefore = true;
  }
}

function usedByOtherService(doc, name) {
  const services = doc.get('services', true);
  if (!YAML.isMap(services)) {
    return false;
  }

  return services.items.some((pair) => {
    const serviceName = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
    return serviceName !== PROXY_SERVICE && networkNames(pair.value && pair.value.get && pair.value.get('networks', true)).includes(name);
  });
}

// Brings a docker-compose.yml written by an older pn up to the current layout without
// touching anything the user customized. Returns { content, changes }.
function migrateCompose(compose, { nginxImage, certbotImage }) {
  const doc = parseCompose(compose);
  const proxy = ['services', PROXY_SERVICE];
  const changes = [];

  const build = doc.getIn([...proxy, 'build'], true);
  if (YAML.isScalar(build)) {
    doc.setIn([...proxy, 'build'], doc.createNode({ context: build.value }));
  }
  if (YAML.isMap(doc.getIn([...proxy, 'build'], true)) && !doc.hasIn([...proxy, 'build', 'args', 'NGINX_IMAGE'])) {
    doc.setIn([...proxy, 'build', 'args', 'NGINX_IMAGE'], `\${NGINX_IMAGE:-${nginxImage}}`);
    changes.push('pin the nginx image through a NGINX_IMAGE build argument');
  }

  const tuning = {
    CERT_RELOAD_INTERVAL: '12h',
    LOG_ROTATE_SIZE_MB: '50',
    LOG_ROTATE_KEEP: '5',
  };
  const environment = doc.getIn([...proxy, 'environment'], true);
  for (const [key, fallback] of Object.entries(tuning)) {
    const value = `\${${key}:-${fallback}}`;
    if (YAML.isSeq(environment)) {
      if (!environment.items.some((item) => String(item.value ?? item).split('=')[0] === key)) {
        environment.add(`${key}=${value}`);
        changes.push(`pass ${key} to the proxy container`);
      }
    } else if (!doc.hasIn([...proxy, 'environment', key])) {
      doc.setIn([...proxy, 'environment', key], value);
      changes.push(`pass ${key} to the proxy container`);
    }
  }

  const requiredMounts = [
    { container: '/srv/sites', volume: './sites:/srv/sites:ro', note: 'mount ./sites at /srv/sites for static sites' },
    { container: '/etc/nginx/auth', volume: './nginx/auth:/etc/nginx/auth:ro', note: 'mount ./nginx/auth for site basic auth' },
  ];
  for (const mount of requiredMounts) {
    const volumes = doc.getIn([...proxy, 'volumes'], true);
    const present = YAML.isSeq(volumes) && volumes.items.some(
      (item) => String(item.value ?? '').split(':')[1] === mount.container
    );
    if (present) {
      continue;
    }

    if (YAML.isSeq(volumes)) {
      volumes.add(mount.volume);
    } else {
      doc.setIn([...proxy, 'volumes'], doc.createNode([mount.volume]));
    }
    changes.push(mount.note);
  }

  const image = doc.getIn(['services', 'certbot', 'image']);
  if (typeof image === 'string' && /^certbot\/certbot(?::latest)?$/.test(image)) {
    doc.setIn(['services', 'certbot', 'image'], `\${CERTBOT_IMAGE:-${certbotImage}}`);
    changes.push('pin the certbot image through CERTBOT_IMAGE');
  }

  return { content: doc.toString({ lineWidth: 0 }), changes };
}

function serviceNames(compose) {
  try {
    const services = YAML.parseDocument(compose).get('services', true);
    return YAML.isMap(services)
      ? services.items.map((pair) => String(YAML.isScalar(pair.key) ? pair.key.value : pair.key))
      : [];
  } catch {
    return [];
  }
}

module.exports = {
  migrateCompose,
  serviceNames,
  parseCompose,
  readProxyNetworks,
  writeProxyNetworks,
};
