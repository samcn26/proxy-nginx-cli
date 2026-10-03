# Changelog

## Unreleased

### Added
- `pn template list|edit`, `pn logs`, `pn migrate`, `pn rollback`, `pn status --json`.
- `pn migrate --yes --run` rolls back automatically when the restart fails.
- Site options: `--alias`, `--www`, `--redirect-aliases`, `--template static|spa|redirect`,
  `--allow`, `--max-body-size`, `--timeout`, `--access-log`, `--hsts-subdomains`.
- `pn cert --email`, `--staging`, `--force-renew`; `pn remove --run`, `--purge-cert`; `pn reset --yes`.
- Certificate expiry, self-signed/staging/expiring flags in `pn status`.
- Agent skill pack in `skills/proxy-nginx-cli/`.
- CI with unit tests and a Docker integration job.
- Input validation for domains, upstream hosts/ports, target URLs, network names, emails.

### Changed
- `pn add/remove --run` re-render, test, and reload inside the running container (no restart,
  rollback on failure). `pn up`/`restart`/`network --run` test the new config first.
- nginx and certbot images are pinned (`NGINX_IMAGE`, `CERTBOT_IMAGE` in `.env`).
- Sites send `Connection: upgrade` only for upgrade requests (`$connection_upgrade` map) so
  upstream keepalive works.
- HSTS no longer sends `includeSubDomains` by default.
- `docker-compose.yml` network edits use a YAML parser; the generated certbot `command`
  uses a literal block.
- `bin/pn` is a Node entry; compose detection runs lazily; version comes from `package.json`.

### Fixed
- Renewed certificates were never reloaded by nginx; new projects reload periodically.
- `host:80` / `https://host:443` targets were rejected as missing a port.
- HTTP-only sites could never later obtain a certificate (missing ACME path).
- Unknown TLS server names were answered with another site's certificate.
- certbot `--cert-name` is pinned to the domain; `certbot` lock conflicts with the renewal
  service are avoided.
- Nginx logs now rotate by size.
