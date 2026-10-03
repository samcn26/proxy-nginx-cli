# proxy-nginx-cli

CLI for creating and operating a small Docker-based Nginx reverse proxy with optional Let's Encrypt certificates.

## Install for Local Development

```bash
npm install
npm link
pn --help
pn --help cn
```

## Commands

```bash
pn init
pn reset [--yes]
pn add <domain> -H <host> -p <port>
pn add <domain> <target-url>
pn add <domain> <host:port> --run
pn add <domain> <host:port> --run --cert
pn add <domain> <host:port> --force
pn add <domain> <host:port> --alias <domain> --www --redirect-aliases
pn add <domain> --template static|spa
pn add <domain> <url> --template redirect
pn add <domain> <host:port> --allow <cidr> --max-body-size <size> --timeout <seconds> --access-log
pn add <domain> <host:port> --force-https | --no-force-https
pn remove <domain>
pn remove <domain> --run [--purge-cert]
pn auth add <domain> <user> [--password-stdin] [--run]
pn auth remove <domain> <user>
pn auth disable <domain> [--run]
pn auth list [domain]
pn template list
pn template edit <domain> [--run]
pn logs [domain] [-n <lines>] [-f] [--error]
pn migrate [--yes] [--run]
pn rollback [backup] [--yes] [--run] [--force] [--list]
pn network add <network>
pn network add <network> --run
pn network remove <network> --run
pn up
pn stop
pn down
pn restart
pn status [--json]
pn upgrade
pn reload
pn cert <domain>
pn cert <domain> --email <email>
pn cert <domain> --staging
pn cert <domain> --force-renew
pn example
pn example --run
pn example <domain> --run
pn example <domain> --run --cert
pn example --stop
```

## Add a Proxy Site

```bash
pn init
pn add app.example.com -H host.docker.internal -p 6666
pn up
```

Equivalent URL form:

```bash
pn add app.example.com http://host.docker.internal:6666
```

Host-port shorthand:

```bash
pn add app.example.com 127.0.0.1:3000 --run
```

`127.0.0.1` and `localhost` targets are automatically mapped to `host.docker.internal` because the proxy runs inside Docker and needs to reach services on the host.

By default, `pn add` generates HTTP and HTTPS Nginx config. Use `--no-ssl` for HTTP-only proxying:

```bash
pn add local.example.test http://host.docker.internal:6666 --no-ssl
```

Apply immediately:

```bash
pn add app.example.com 127.0.0.1:3000 --run
```

Apply, request HTTPS, reload Nginx, and start the certificate renewal service:

```bash
pn add app.example.com 127.0.0.1:3000 --run --cert
```

Existing site templates are preserved by default, so custom edits are not overwritten:

```bash
pn add app.example.com 127.0.0.1:3000
```

Overwrite a site template explicitly:

```bash
pn add app.example.com 127.0.0.1:3000 --force
```

Remove a site and apply immediately:

```bash
pn remove app.example.com --run
```

Domains, upstream hosts, ports, and network names are validated before anything is written. Target URLs must contain only protocol, host, and port (no path).

### Aliases and www

```bash
pn add example.com 127.0.0.1:3000 --alias blog.example.com --www
pn add example.com 127.0.0.1:3000 --www --redirect-aliases
```

`--alias` (repeatable) and `--www` add names to the same site. `--redirect-aliases` makes the aliases answer with a `301` to the main domain instead. One certificate covers every name the site template declares, so `pn cert example.com` requests all of them.

### Site types

```bash
pn add docs.example.com --template static        # serves ./sites/docs.example.com
pn add app.example.com --template spa            # static + fallback to index.html
pn add old.example.com https://new.example.com --template redirect
```

`static` and `spa` create `sites/<domain>/index.html` as a placeholder (never overwriting existing files). `redirect` sends every request to the target and keeps the path and query string.

### Per-site options

```bash
pn add admin.example.com 127.0.0.1:3000 \
  --allow 203.0.113.0/24 --allow 2001:db8::/32 \
  --max-body-size 10m --timeout 60 --access-log
```

- `--allow` (repeatable) limits access to those IPs/CIDRs; the ACME challenge path stays open for certificates.
- `--max-body-size` sets `client_max_body_size` (default `50m`), `--timeout` the proxy read/send timeout in seconds (default `300`).
- `--access-log` writes `logs/<domain>.access.log` (read it with `pn logs <domain>`).
- `--hsts-subdomains` adds `includeSubDomains` to HSTS. It is off by default because on an apex domain it forces HTTPS for every sibling subdomain.
- `--force-https` / `--no-force-https` fix the HTTP→HTTPS redirect for this site. Without either flag the site follows `FORCE_HTTPS` from `.env`. Use `--no-force-https` for the one site that must keep answering plain HTTP (webhooks, legacy clients) without turning the redirect off for the whole project.

### Basic auth (username and password)

Put a login in front of a site without changing the application behind it (admin panels, staging sites, small tools):

```bash
pn auth add admin.example.com alice --run   # asks for the password (not echoed); first user turns auth on
pn auth add admin.example.com bob           # more users, or change a password
pn auth remove admin.example.com bob
pn auth list
pn auth disable admin.example.com --run     # turn auth off again (deletes the users)
```

- Visitors get a browser login prompt; without valid credentials the request never reaches your application. The ACME challenge path stays open so certificates keep renewing.
- Adding, changing or removing users takes effect immediately. Turning auth on or off changes the site template, so it needs `--run` (or `pn up`); until then the site keeps its previous state.
- Removing the **last** user is refused, because it would lock everyone out; use `pn auth disable` to switch auth off.
- Passwords are stored as apr1 hashes in `nginx/auth/<domain>.htpasswd` (read-only mount in the container) and are never put on the command line. Scripts can pipe one in: `printf '%s\n' "$PW" | pn auth add <domain> <user> --password-stdin`. Minimum length is 8.
- Only for sites with SSL (passwords would otherwise travel in clear text). If the site can still be reached over plain HTTP (`FORCE_HTTPS=false` or `--no-force-https`) `pn auth add` warns you.
- Projects created before this feature need `pn migrate --yes` once (it adds the `nginx/auth` mount).
- It combines with `--allow`: allow-list first, login second.

### Editing templates

```bash
pn template list
pn template edit app.example.com          # opens $VISUAL/$EDITOR, then runs nginx -t
pn template edit app.example.com --run    # ...and applies it
```

## Certificates

```bash
pn cert app.example.com
pn cert app.example.com --email ops@example.com
pn cert app.example.com --staging
```

- `--email` registers a Let's Encrypt account email instead of `--register-unsafely-without-email`.
- `--staging` uses the Let's Encrypt staging environment, which is useful for testing without hitting production rate limits. Staging certificates are not trusted by browsers.
- The same options work with `pn add ... --cert` and `pn example <domain> --run --cert`.
- `--cert` cannot be combined with `--no-ssl`. HTTP-only sites still serve `/.well-known/acme-challenge/`, so you can later switch them to SSL with `pn add <domain> <target> --force` and run `pn cert`.

The `certbot` service renews certificates every 12 hours. Projects created by `pn init` also include `nginx/docker-entrypoint.d/50-reload-renewed-certs.sh`, which reloads Nginx every 12 hours (`CERT_RELOAD_INTERVAL`) so renewed certificates are actually served.

Existing projects created by older versions can pick up the reload hook without touching their templates:

```bash
pn init      # only writes missing files
pn restart   # rebuilds the image so the new hook is included
```

## Operate Proxy

```bash
pn status
pn status --json
pn logs
pn stop
pn down
pn restart
pn reload
pn upgrade
```

How changes are applied:

- `pn add ... --run`, `pn remove ... --run`, `pn template edit ... --run` re-render the templates **inside the running container**, run `nginx -t`, and reload. The container is not restarted, so connections are not dropped, and if the test fails the previous configuration is restored and the command fails. If the proxy is not running they start it instead.
- `pn up`, `pn restart` and `pn network ... --run` recreate the container. When the proxy is already running, the new configuration is first tested in a throwaway container; if it is invalid the running proxy is left untouched.

Images are pinned, so a plain `pn up` keeps using what is already built. To pick up new patch releases of the pinned tags (nginx security fixes, certbot), run `pn up --pull` (or `pn restart --pull`): it rebuilds with `--pull`, pulls the certbot image, validates the configuration against the new nginx, then recreates the container. To move to another minor version, change `NGINX_IMAGE` in `.env` and run `pn up --pull`.

`pn status` lists sites (with upstream and aliases), networks and certificates (expiry date, days left, and `self-signed` / `staging` / `expiring soon` flags). `pn status --json` prints the same data for scripts and agents.

`pn logs` prints the end of `logs/access.log` (`--error` for the error log, `<domain>` for a per-site log, `-f` to follow). Logs rotate by size inside the container: `LOG_ROTATE_SIZE_MB` (default 50) and `LOG_ROTATE_KEEP` (default 5) in `.env`.

`pn stop` maps to `docker compose stop`: containers are stopped but kept.

`pn down` maps to `docker compose down`: containers and the compose default network are removed, while project files, templates, logs, and certificates stay on disk.

`pn reload` validates and reloads the running Nginx process without restarting the container. Use it after certificate changes or when generated Nginx config is already current.

`pn restart` recreates `proxy-nginx`, which reruns the Nginx image entrypoint and regenerates config from `nginx/templates/*.template`. Use it after editing templates.

`pn upgrade` upgrades the `proxy-nginx-cli` command itself. Git-linked installs run `git pull --ff-only` and `npm install`; npm installs run `npm install -g proxy-nginx-cli@latest`.

## Updating Existing Projects

`pn init` only creates missing files, so projects made by an older `pn` do not receive newer generated files by themselves. Use:

```bash
pn migrate          # preview what would change
pn migrate --yes    # apply; changed files are backed up to .pn-backup/
pn restart
```

`pn migrate` updates the Dockerfile, `nginx/nginx.conf`, entrypoint hooks, base templates, the `docker-compose.yml` (through a YAML parser, keeping your comments and extra settings) and adds image pins to `.env`. It never touches site templates. The project schema version is stored in `.pn.json`.

Run it in the project directory (where `docker-compose.yml` is). Backups go to `<project>/.pn-backup/<timestamp>/`, together with a `manifest.json` of what changed and what was created.

### Rolling back

```bash
pn rollback               # preview: which files would be restored or removed
pn rollback --yes         # restore the previous files, remove files migrate created
pn restart                # apply (or: pn rollback --yes --run)
pn rollback --list        # all backups; pass a backup name to roll back an older one
```

- Site templates, certificates and logs are never touched.
- A file you edited after the migration is kept, and reported; `--force` overwrites it.
- `pn migrate --yes --run` rolls back by itself if the restart fails (invalid config, build or start failure) and restarts with the previous files, so the proxy is not left down.
- A backup that was already rolled back is skipped by the next `pn rollback`.

## Docker Networks

Attach the proxy container to one or more existing external Docker networks:

```bash
pn network add app-net
pn network add internal-api
```

This updates `docker-compose.yml` only. Apply the change immediately by recreating `proxy-nginx`:

```bash
pn network add app-net --run
```

Remove a network attachment:

```bash
pn network remove app-net --run
```

Network commands do not create or delete Docker networks; create the external network with Docker first if it does not already exist.

## Local Example

Generate a local example:

```bash
pn example
```

Run it:

```bash
pn example --run
curl -H 'Host: local.example.test' http://127.0.0.1/
```

Stop it:

```bash
pn example --stop
```

Browser note: local browser testing needs a hosts entry because browsers do not let you manually set the `Host` header:

```text
127.0.0.1 local.example.test
```

Then open:

```text
http://local.example.test
```

## Online Example

Prerequisites:

- Domain DNS points to the server.
- Server firewall/security group allows `80` and `443`.
- Docker and `docker-compose` are installed.
- No other service is using ports `80`, `443`, or `6666`.

Start an HTTP example with a real domain:

```bash
pn example app.example.com --run
```

Open:

```text
http://app.example.com
```

Request a certificate and reload Nginx:

```bash
pn cert app.example.com
pn reload
```

`pn cert` also starts the `certbot` renewal service after a successful issuance.

Or run the online example and request the certificate in one command:

```bash
pn example app.example.com --run --cert
```

Then open:

```text
https://app.example.com
```

## Agent Skill

`skills/proxy-nginx-cli/SKILL.md` is a ready-to-use skill for coding agents: workflows, safety rules, and certbot recovery steps for this CLI. Copy it into your agent's skills directory (for example `.claude/skills/proxy-nginx-cli/`).

## Generated Project Layout

`pn init` creates:

```text
Dockerfile
docker-compose.yml
.env
nginx/
  nginx.conf
  docker-entrypoint.d/
  templates/
ssl/
  certs/
  www/
sites/            # files for --template static|spa
logs/
.pn.json          # project schema version (see pn migrate)
```

Docker images are pinned in `.env` (`NGINX_IMAGE`, `CERTBOT_IMAGE`); change them deliberately and run `pn up`.

`pn example` creates:

```text
example/
  backend/
    package.json
    server.js
  proxy/
    Dockerfile
    docker-compose.yml
    .env
    nginx/
    ssl/
    logs/
```

## Notes

- Compose commands use `docker-compose` when it is a real Compose binary, otherwise `docker compose`.
- `pn cert` uses the compose `certbot` service with HTTP-01 webroot validation.
- Keep `FORCE_HTTPS=false` until the first certificate has been issued if you are manually editing `.env`.
