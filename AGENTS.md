# AGENTS.md

This file is the handoff guide for coding agents working on `proxy-nginx-cli`.

## Project

- Public npm CLI project: `proxy-nginx-cli`
- CLI binary: `pn`
- Language: plain Node.js CommonJS
- Main files:
  - `bin/pn`: shell shim for local/npm command execution
  - `lib/cli.js`: commander CLI definitions and help text
  - `lib/commands.js`: command implementations
  - `lib/project-files.js`: generated project files (Dockerfile, compose, nginx.conf, hooks)
  - `lib/site-template.js`: site template rendering (proxy/static/spa/redirect)
  - `lib/sites.js`, `lib/certs.js`: read site templates and certificates (status, cert domains)
  - `lib/compose-file.js`: YAML edits of `docker-compose.yml` (networks, migration)
  - `lib/migrate.js`: `pn migrate`
  - `lib/scripts/apply-sites.sh`: runs inside the container to re-render, test, and reload
  - `skills/proxy-nginx-cli/SKILL.md`: agent skill for this CLI
  - `.github/workflows/ci.yml`: unit tests plus a Docker integration job
  - `test/*.test.js`: Node test runner tests
  - `README.md`: user-facing docs
- Main branch for tested CLI work: `master`
- Development branch may still be used for incremental work: `dev`
- Git remote: `git@github.com:samcn26/proxy-nginx-cli.git`

## Working Style

- Prefer small incremental changes with tests.
- Use `rg` / `rg --files` for search.
- Use `apply_patch` for manual edits.
- Do not remove user changes or generated runtime data unless explicitly asked.
- Keep public examples generic. Do not add real private validation domains to committed docs or tests.
- Generated `example/` output should not be committed.
- Before claiming completion, run fresh verification commands and report the result.

## Command Semantics

- `pn init`: create the proxy nginx project skeleton in the current directory.
- `pn reset`: reinitialize skeleton and remove added site templates.
- `pn add <domain> -H <host> -p <port>`: add a proxy site.
- `pn add <domain> <target>`: add a proxy site from URL or `host:port` shorthand.
- `pn add ... --force`: overwrite an existing site template. Without `--force`, existing site templates are preserved.
- `pn add ... --run`: apply immediately. If the proxy is running, re-render templates in the container, `nginx -t`, reload (no restart, rollback on failure); otherwise start it.
- `pn add ... --cert`: implies apply, request cert, reload nginx, and start certbot renewal service.
- `pn add ... --alias/--www/--redirect-aliases`: extra names; certs cover all names in the site template.
- `pn add ... --template static|spa|redirect`, `--allow`, `--max-body-size`, `--timeout`, `--access-log`, `--hsts-subdomains`.
- `pn template list|edit <domain> [--run]`, `pn logs [domain] [-f] [--error]`, `pn migrate [--yes] [--run]`, `pn rollback [backup] [--yes] [--run] [--force] [--list]`.
- `pn remove <domain>`: remove a site template.
- `pn remove <domain> --run [--purge-cert]`: remove a site template, apply like `pn add --run`, optionally delete its certificate.
- `pn up`: build/start/recreate `proxy-nginx`; tests the new config in a throwaway container first when the proxy is running.
- `pn stop`: stop compose containers without deleting them.
- `pn down`: run compose down; remove containers/default network while keeping files, templates, logs, and certs.
- `pn restart`: recreate `proxy-nginx`; use after editing `nginx/templates/*.template`.
- `pn status [--json]`: show compose status plus sites, attached networks, and certificates with expiry.
- `pn upgrade`: upgrade the CLI itself, not a proxy project. Git-linked installs pull and npm install; npm installs run global npm install latest.
- `pn reload`: run `nginx -t` then `nginx -s reload` in the running proxy container.
- `pn cert <domain>`: request Let's Encrypt cert with certbot webroot (`--cert-name <domain>`), reload nginx, then start certbot renewal service.
- `pn cert ... --email <email>` / `--staging` / `--force-renew`: account email, Let's Encrypt staging, forced renewal (automatic when moving a staging lineage to production). `pn cert` pauses the certbot renewal service while issuing.
- Domains, upstream hosts/ports, and network names are validated; `--cert` with `--no-ssl` is rejected.
- `pn example`: create an example project.
- `pn example --run`: run local example.
- `pn example <domain> --run`: run online HTTP example.
- `pn example <domain> --run --cert`: run online example and issue HTTPS cert.
- `pn example --stop`: stop example services.
- `pn network add <name>`: attach `proxy-nginx` to an existing external Docker network in `docker-compose.yml`.
- `pn network remove <name>`: detach `proxy-nginx` from that external Docker network.
- `pn network add/remove ... --run`: apply network changes by recreating `proxy-nginx`.

## Docker Compose Behavior

- The implementation prefers `docker-compose` only when `docker-compose version` is a real compose command.
- If `docker-compose` is only a Docker alias, it falls back to `docker compose`.
- `pn up`, `pn restart` and `pn network ... --run` recreate the container:

```bash
up -d --build --force-recreate proxy-nginx
```

- `pn add/remove/template edit --run` use `exec -T proxy-nginx sh -c <lib/scripts/apply-sites.sh>` instead (no restart).
- Images are pinned (`NGINX_IMAGE`, `CERTBOT_IMAGE` in `.env`); update the defaults in `lib/project-files.js` deliberately.
- Changing a generated base file means bumping `PROJECT_SCHEMA_VERSION` in `lib/project-files.js` so `pn migrate` can carry it to existing projects.
- `pn migrate --yes` writes backups plus `manifest.json` to `<project>/.pn-backup/<timestamp>/`; `pn rollback` relies on the manifest (file list, created vs updated, sha256 of what was written).

## Testing

Primary verification:

```bash
npm test
./bin/pn --help
./bin/pn --help cn
./bin/pn network --help
npm pack --dry-run
rg -n "<private validation domain or owner-specific string>" -g '!node_modules/**' -g '!package-lock.json' . || true
```

Expected current test count: 114 passing tests.

Docker is not available in every agent sandbox. The `docker` CI job covers real Docker behavior; locally, render templates and run `nginx -t` with a host nginx when possible.

## Server Notes

- SSH alias used for validation: `jestar`
- Server working directory used during validation: `/home/jestar/devops/proxy-nginx-cli`
- Validated remote tests after commit `9be2ced`.
- The real domain used during manual validation must stay out of public committed files.
