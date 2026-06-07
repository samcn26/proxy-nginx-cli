# AGENTS.md

This file is the handoff guide for coding agents working on `proxy-nginx-cli`.

## Project

- Public npm CLI project: `proxy-nginx-cli`
- CLI binary: `pn`
- Language: plain Node.js CommonJS
- Main files:
  - `bin/pn`: shell shim for local/npm command execution
  - `lib/cli.js`: commander CLI definitions and help text
  - `lib/commands.js`: command implementations and project templates
  - `test/*.test.js`: Node test runner tests
  - `README.md`: user-facing docs
- Branch currently used for development: `dev`
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
- `pn add ... --run`: apply immediately by running the equivalent of `pn up`.
- `pn add ... --cert`: implies apply, request cert, reload nginx, and start certbot renewal service.
- `pn remove <domain>`: remove a site template.
- `pn up`: build/start/recreate `proxy-nginx`.
- `pn reload`: run `nginx -t` then `nginx -s reload` in the running proxy container.
- `pn cert <domain>`: request Let's Encrypt cert with certbot webroot, reload nginx, then start certbot renewal service.
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
- `pn up` and `--run` use:

```bash
up -d --build --force-recreate proxy-nginx
```

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

Expected current test count: 30 passing tests.

## Server Notes

- SSH alias used for validation: `jestar`
- Server working directory: `/home/jestar/devops/proxy-nginx-cli`
- Validated remote tests after commit `16885c0`.
- The real domain used during manual validation must stay out of public committed files.
