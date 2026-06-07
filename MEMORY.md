# MEMORY.md

Short-term project memory for `proxy-nginx-cli`. This is meant to survive context resets and new chats.

## Current State

- Repo: `git@github.com:samcn26/proxy-nginx-cli.git`
- Branch: `dev`
- Latest pushed commit known in this memory: `16885c0 Add proxy network management commands`
- CLI command name: `pn`
- Package name planned for npm: `proxy-nginx-cli`
- npm publication is still a later TODO.

## Product Direction

This is a general-purpose Docker-based Nginx reverse proxy CLI:

- Initialize a deployable proxy project.
- Add/remove reverse proxy domains.
- Support HTTP and HTTPS.
- Issue Let's Encrypt certificates.
- Keep certbot renewal running for production.
- Provide runnable local/online examples.
- Let users attach the proxy container to one or more external Docker networks.
- Eventually support custom templates.

## Important Design Decisions

- JavaScript is enough; project uses Node.js with `commander`.
- The npm binary is `pn`.
- Generic public examples use `test.example.cn`, `app.example.com`, or `local.example.test`.
- Do not commit the real validation domain.
- `--run` means "apply immediately" by recreating the proxy nginx container through `pn up`.
- `--cert` means HTTPS cert should be issued and the certbot renewal service should run.
- `127.0.0.1:<port>` and `localhost:<port>` upstreams are mapped to `host.docker.internal:<port>` because the proxy runs inside Docker.
- `pn network add/remove` edits `docker-compose.yml`; it does not create/delete Docker networks.

## Implemented Commands

```bash
pn --help
pn --help cn
pn init
pn reset
pn add <domain> -H <host> -p <port>
pn add <domain> <target-url>
pn add <domain> <host:port> --run
pn add <domain> <host:port> --run --cert
pn remove <domain>
pn network add <network>
pn network add <network> --run
pn network remove <network>
pn network remove <network> --run
pn up
pn reload
pn cert <domain>
pn example
pn example --run
pn example <domain> --run
pn example <domain> --run --cert
pn example --stop
```

## Verified Locally

- `npm test`: 30/30 pass after network module.
- `./bin/pn --help`: works.
- `./bin/pn --help cn`: works.
- `./bin/pn network --help`: works.
- `npm pack --dry-run`: works and package includes `README.md`, `bin`, and `lib`.
- Sensitive-domain scan was clean. Before public pushes, scan for the private validation domain and owner-specific strings without committing those strings into docs.

## Verified On Server

- Server SSH alias: `jestar`
- Working directory: `/home/jestar/devops/proxy-nginx-cli`
- Server successfully pulled `dev` after commit `16885c0`.
- Server `npm test`: 30/30 pass.
- Earlier manual HTTPS validation succeeded with Let's Encrypt and proxying through nginx.
- Example services were stopped after validation.

## Useful Next Steps

- Try the real production scenario with `pn init`, `pn add ... --run --cert`, and optional `pn network add ... --run`.
- Consider adding command docs/examples for custom templates.
- Consider improving compose YAML editing with a real YAML parser if the compose format becomes more flexible.
- Prepare npm publishing metadata when ready.
