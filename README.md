# proxy-nginx-cli

English | [简体中文](README.zh-CN.md)

`pn` is a command-line tool for running a small, standard **website hosting setup on one server**: a Docker-based Nginx reverse proxy with Let's Encrypt certificates. You describe sites with one command each (`pn add app.example.com 127.0.0.1:3000 --run --cert`) and `pn` generates the Nginx configuration, requests and renews certificates, applies changes without downtime, and keeps the project upgradable.

- Reverse proxy sites, static sites, single-page apps and redirects, with aliases (`www`), per-site limits, IP allow-lists and HTTP basic auth.
- Automatic HTTPS with Let's Encrypt (HTTP-01), renewal service, expiry reporting, preflight DNS/CAA checks.
- Safe operation: configuration is tested before it is applied, a bad change never takes the running proxy down, upgrades are previewed, backed up and reversible.
- Plain files you can read and edit: everything lives in one project directory.

## Contents

- [Requirements and install](#requirements-and-install)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [Guides](#guides): [sites](#sites) · [certificates](#certificates) · [basic auth](#basic-auth) · [applying changes](#how-changes-are-applied) · [networks](#docker-networks) · [logs](#logs) · [upgrading](#upgrading-and-rolling-back) · [several projects on one server](#several-projects-on-one-server) · [other services and existing setups](#other-services-and-existing-setups) · [examples](#examples)
- [Project layout and configuration](#project-layout-and-configuration)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Agent skill](#agent-skill) · [Development](#development)

## Requirements and install

- A Linux server with **Docker** and the **Docker Compose** plugin (`docker compose`) or `docker-compose`. `pn` detects which one works.
- **Node.js 18+** to run `pn` itself.
- Ports **80** and **443** free on the server, and (for certificates) DNS records pointing at it.
- Your applications run on the same host (reached through `host.docker.internal`) or on a Docker network the proxy joins (see [Docker networks](#docker-networks)).

Install:

```bash
# From source (current way)
git clone https://github.com/samcn26/proxy-nginx-cli.git
cd proxy-nginx-cli && npm install && npm link
pn --help          # English help
pn --help cn       # Chinese help

# From npm (planned, the package is not published yet)
npm install -g proxy-nginx-cli
```

Update the tool itself later with `pn upgrade` (see [pn upgrade](#pn-upgrade)).

## Quick start

```bash
mkdir proxy && cd proxy
pn init                                          # create the project files in this directory
pn up                                            # build and start Nginx
pn add app.example.com 127.0.0.1:3000 --run --cert   # proxy a local app, with HTTPS
pn status                                        # sites, certificates, networks
```

Before `--cert` works, `app.example.com` must resolve to this server and ports 80/443 must be reachable from the internet. Check this first with `pn doctor app.example.com`.

Everything `pn` does happens relative to the **current directory**, so run it inside the project directory (the one that contains `docker-compose.yml`). If you run it somewhere else, it tells you where your project is.

## Command reference

Conventions: `<name>` is required, `[name]` is optional, `...` means the option can be repeated. Every command exits with status 1 on error. Commands that change the project print what they did; commands that would change running services say whether the change is already active.

### Overview

| Group | Commands |
|---|---|
| Project | [`init`](#pn-init) · [`reset`](#pn-reset) · [`migrate`](#pn-migrate) · [`rollback`](#pn-rollback) · [`upgrade`](#pn-upgrade) |
| Sites | [`add`](#pn-add) · [`remove`](#pn-remove) · [`template list/edit`](#pn-template) · [`auth`](#pn-auth) |
| Certificates | [`cert`](#pn-cert) · [`doctor`](#pn-doctor) |
| Running the proxy | [`up`](#pn-up) · [`restart`](#pn-restart) · [`reload`](#pn-reload) · [`stop`](#pn-stop) · [`down`](#pn-down) · [`network`](#pn-network) |
| Inspecting | [`status`](#pn-status) · [`logs`](#pn-logs) · [`doctor`](#pn-doctor) |
| Try it out | [`example`](#pn-example) |

Global options: `-V, --version` prints the version, `-h, --help` prints help. `pn --help cn` prints the help in Chinese.

### pn init

Create a proxy project in the current directory.

```
pn init
```

Creates the directories `nginx/templates`, `nginx/docker-entrypoint.d`, `nginx/auth`, `ssl/certs`, `ssl/www`, `sites` and `logs`, and the files `Dockerfile`, `docker-compose.yml`, `.env`, `nginx/nginx.conf`, the entrypoint hooks, two base templates and `.pn.json` (project schema version). It only creates what is missing: running it again never overwrites your files. See [Project layout](#project-layout-and-configuration) for what each file is for.

### pn reset

Re-create missing skeleton files and **delete every site template**.

```
pn reset [-y, --yes]
```

- Base files (`Dockerfile`, `docker-compose.yml`, `.env`, `nginx.conf`, hooks) are kept if present or re-created if missing; the base templates are kept.
- Site templates (`nginx/templates/<domain>.conf.template`) are deleted. Certificates (`ssl/`), logs, `sites/` content and `.env` are not touched. Running containers keep serving until the next `pn up`/`pn restart`.
- On a terminal it lists the sites and asks for confirmation. `--yes` skips the question. Without a terminal (scripts) it does not ask.

### pn add

Add a site (write its Nginx template). Without `--run` nothing is applied yet.

```
pn add <domain> [target] [options]
```

`<domain>` is validated and lower-cased. `[target]` depends on the template type:

| `--template` | `[target]` | Result |
|---|---|---|
| `proxy` (default) | `http://host:port`, `https://host:port`, or `host:port`; or use `-H/-p` | Reverse proxy to the upstream |
| `static` | none | Serve files from `sites/<domain>/` |
| `spa` | none | Like `static`, unknown paths fall back to `index.html` |
| `redirect` | destination URL, for example `https://new.example.com` | 301 redirect that keeps the path and query string |

Upstream rules: the port is required; `127.0.0.1` and `localhost` are mapped to `host.docker.internal` (the proxy runs in a container and reaches host services through it); the upstream may be a hostname, IPv4/IPv6 address or a container name on a joined Docker network; an `https://` upstream is contacted with TLS and SNI. A target URL must not contain a path.

Options:

| Option | Meaning |
|---|---|
| `-H, --host <host>`, `-p, --port <port>` | Upstream host and port (alternative to `[target]`). |
| `--no-ssl` | HTTP-only site (no 443 server, no certificate). Cannot be combined with `--cert`. |
| `-t, --template <name>` | `proxy` (default), `static`, `spa`, `redirect`. |
| `-a, --alias <domain>` | Extra domain for this site; repeatable. The certificate covers all of them. |
| `--www` | Shortcut for `--alias www.<domain>`. |
| `--redirect-aliases` | Aliases answer with a 301 to the main domain instead of serving the site. Needs at least one alias. |
| `--max-body-size <size>` | `client_max_body_size`, for example `10m`, `1g`, `0` (unlimited). Default `50m`. |
| `--timeout <seconds>` | Proxy read/send timeout, 1–86400. Default `300`. |
| `--allow <cidr>` | Only allow this IP or CIDR (IPv4/IPv6); repeatable. Everything else gets 403. The ACME challenge path stays open. |
| `--access-log` | Write `logs/<domain>.access.log` (read it with `pn logs <domain>`). |
| `--force-https` / `--no-force-https` | Always / never redirect this site from HTTP to HTTPS, regardless of `FORCE_HTTPS` in `.env`. SSL sites only. |
| `--hsts-subdomains` | Add `includeSubDomains` to the HSTS header (off by default). |
| `--run` | Apply now: if the proxy is running, re-render, test and reload without restarting; otherwise start it. |
| `--cert` | Implies `--run`, then request a certificate (see [`pn cert`](#pn-cert)), reload, and start the renewal service. |
| `--email <email>`, `--staging` | Let's Encrypt account email / staging environment; only used with `--cert`. |
| `--force` | Overwrite an existing site template. Without it an existing template is kept and reported. |

Examples:

```bash
pn add app.example.com 127.0.0.1:3000                       # write the template only
pn add app.example.com -H host.docker.internal -p 3000 --run
pn add api.example.com https://10.0.0.6:8443 --timeout 60 --run
pn add example.com 127.0.0.1:3000 --www --redirect-aliases --run --cert
pn add docs.example.com --template static --run
pn add old.example.com https://new.example.com --template redirect --run
pn add admin.example.com 127.0.0.1:8080 --allow 203.0.113.0/24 --max-body-size 10m --run
pn add hooks.example.com 127.0.0.1:9000 --no-force-https --run
pn add test.example.com 127.0.0.1:3000 --no-ssl --run
```

By default SSL sites serve HTTPS with a self-signed certificate (generated when the container starts) until you run `pn cert`; plain HTTP redirects to HTTPS when `FORCE_HTTPS=true`.

### pn remove

Remove a site.

```
pn remove <domain> [--run] [--purge-cert]
```

Deletes the site template and its basic-auth user file. With `--run` the removal is applied immediately (without restarting). With `--purge-cert` the certificate for the domain is deleted too (the certbot lineage, or the self-signed directory). Without `--run`, nginx keeps serving the old configuration until you apply it.

### pn template

Inspect and edit site templates.

```
pn template list
pn template edit <domain> [--run]
```

- `list` shows every site with its type, upstream, SSL mode, aliases, per-site HTTPS redirect mode and basic auth.
- `edit` opens `nginx/templates/<domain>.conf.template` in `$VISUAL` or `$EDITOR` (default `vi`), then runs `nginx -t` against the result when the proxy is running. With `--run` the edit is applied (and rolled back by nginx's own test if it is invalid); otherwise apply it with `pn up`.

### pn auth

Protect a site with a username and password (HTTP basic auth).

```
pn auth add <domain> <user> [--password-stdin] [--run]
pn auth remove <domain> <user>
pn auth disable <domain> [--run]
pn auth list [domain]
```

- `add` asks for the password twice (not echoed). Use `--password-stdin` to pipe it in. It creates the user, or changes the password if the user exists. The first user switches basic auth on in the site template; `--run` applies that.
- `remove` deletes a user. The **last** user cannot be removed (everyone would be locked out): use `disable`.
- `disable` turns auth off and deletes the site's users.
- `list` shows the protected sites and their user names.

Details are in [Basic auth](#basic-auth).

### pn cert

Request a Let's Encrypt certificate for a domain (HTTP-01, webroot).

```
pn cert <domain> [--email <email>] [--staging] [--force-renew] [--skip-checks]
```

What it does, in order: runs the DNS/CAA preflight checks; backs up the self-signed certificate directory if there is no real lineage yet; pauses the certbot renewal service (it holds certbot's lock); runs certbot for the domain and every alias in its site template (certificate name = the domain); reloads Nginx; starts the renewal service.

| Option | Meaning |
|---|---|
| `--email <email>` | Account email registered with Let's Encrypt (default: none). |
| `--staging` | Use the staging environment: no rate limits, certificates not trusted by browsers. Good for a dry run. |
| `--force-renew` | Renew even if the certificate is not due. Moving a lineage from `--staging` to production does this automatically. |
| `--skip-checks` | Skip the preflight checks. |

Preflight blocks only on problems that make issuing impossible (a name without any DNS record, a CAA record that forbids Let's Encrypt); everything else is printed as a warning. See [`pn doctor`](#pn-doctor) for the full checks.

### pn doctor

Check that the project is healthy and, for a domain, that certificates can be issued. It only reads, apart from a short-lived test file in `ssl/www` that is deleted right away.

```
pn doctor [domain] [--ip <address>] [--json]
```

Project checks: Docker Compose works; no other pn project owns the `proxy-nginx` container; project files are up to date (`pn migrate` pending?); the proxy container is running (and its nginx version); the templates on disk pass `nginx -t`; ports 80/443 are free when the proxy is stopped; certificates are valid, not expiring, not self-signed or staging, and the renewal service is running.

With a domain (and each of its aliases): the site template exists; DNS A/AAAA records exist; the address matches this server; no CAA record forbids Let's Encrypt; a test file under `/.well-known/acme-challenge/` is served over HTTP by this proxy (and over IPv6 when an AAAA record exists, since Let's Encrypt prefers IPv6); HTTPS on port 443 serves a certificate.

Output lines are `[ok]`, `[info]`, `[warn]` or `[FAIL]`, each with a hint on how to fix it. The exit status is 1 when something failed. Cloud servers often cannot see their own public address, so address comparison needs `--ip <public IPv4>` to be conclusive. Testing HTTP reachability from the server itself can fail because of hairpin NAT even when the site works from outside, so that check is a warning, not a failure. `--json` prints the report for scripts and agents.

### pn up

Build (if needed) and start or recreate the `proxy-nginx` container.

```
pn up [--pull]
```

When the proxy is already running, the new configuration is first tested in a throwaway container; if it is invalid, the running proxy is left untouched and the error is shown. Recreating drops open connections briefly; for site changes prefer `--run` on `add`/`remove`/`template edit`/`auth`, which does not restart. `--pull` rebuilds with `--pull` and pulls the certbot image first (new patch releases of the pinned tags), then validates against the new image.

### pn restart

Recreate the container so all templates are rendered again.

```
pn restart [--pull]
```

Same behavior as `pn up` (validation first, optional `--pull`). Use it after editing `nginx/templates/*.template` by hand, `.env`, or the Dockerfile.

### pn reload

Test and reload the running Nginx process without recreating the container.

```
pn reload
```

Runs `nginx -t` then `nginx -s reload` inside the container. It does not re-render templates, so it is for changes Nginx reads itself (for example certificates). To apply template edits use `--run` on the editing command, or `pn up`.

### pn stop

Stop the project containers but keep them (`docker compose stop`). Start again with `pn up`.

```
pn stop
```

If `docker-compose.yml` also defines services of your own (a database, an app), only pn's services (`proxy-nginx`, `certbot`) are stopped and the others keep running.

### pn down

Stop **and remove** the containers and the default network (`docker compose down`).

```
pn down
```

Files, templates, certificates and logs stay on disk. Start again with `pn up`.

If `docker-compose.yml` also defines services of your own, `pn down` removes only `proxy-nginx` and `certbot` (`docker compose rm -s -f`) and leaves the others and the compose network alone.

### pn network

Attach the proxy to existing external Docker networks, so it can reach containers by name.

```
pn network add <name> [--run]
pn network remove <name> [--run]
```

Edits `docker-compose.yml` (through a YAML parser; comments and your own settings are kept). The network must already exist (`docker network create`). Without `--run` only the file changes; with `--run` the proxy is recreated (validated first). See [Docker networks](#docker-networks).

### pn status

Show the project state.

```
pn status [--json]
```

Prints `docker compose ps`, then: whether the proxy is running (and its nginx version), the sites (upstream and aliases), the attached networks, and the certificates (expiry date, days left, flags such as `self-signed`, `staging`, `expiring soon`, `EXPIRED`). `--json` prints the same data as JSON (`proxy`, `sites`, `networks`, `certificates`) without calling `docker compose ps`.

### pn logs

Show the end of the Nginx logs in `./logs`.

```
pn logs [domain] [-n, --lines <count>] [-f, --follow] [--error]
```

Without arguments: `logs/access.log`. `--error`: `logs/error.log`. With a domain: `logs/<domain>.access.log`, which exists for sites added with `--access-log`. `-n` sets the number of lines (default 100), `-f` keeps following (uses `tail -f`). Logs rotate automatically; see [Logs](#logs).

### pn migrate

Update an existing project to the files this version of `pn` generates.

```
pn migrate [-y, --yes] [--run]
```

Run it in the project directory after upgrading `pn`. Without `--yes` it only **previews** the changes. With `--yes` it writes them after backing up every changed file to `.pn-backup/<timestamp>/` (with a manifest). Your site templates, certificates, logs and existing `.env` values are never touched. `--run` recreates the proxy afterwards; if that fails, the migration is rolled back automatically and the proxy is restarted with the previous files. It is idempotent: when nothing is pending it says the project is up to date.

### pn rollback

Undo `pn migrate`.

```
pn rollback [backup] [-y, --yes] [--run] [--force] [--list]
```

By default it targets the newest backup that has not been rolled back; pass a backup name to choose another. Without `--yes` it previews. With `--yes` it restores the previous versions and removes the files the migration created. Files you edited after the migration are kept (and reported) unless you pass `--force`. `--list` shows the backups. `--run` recreates the proxy afterwards; otherwise apply with `pn restart`.

### pn upgrade

Upgrade the `pn` command itself (not a project).

```
pn upgrade
```

For a git checkout it runs `git pull --ff-only` and `npm install`; for an npm installation it runs `npm install -g proxy-nginx-cli@latest`. Afterwards run `pn migrate` in your projects to see whether generated files need updating.

### pn example

Create (and optionally run) a self-contained example project, for trying `pn` out.

```
pn example [domain] [--run] [--cert] [--email <email>] [--staging] [--stop]
```

- `pn example` creates `example/` (a tiny backend and a proxy project) in the current directory.
- `--run` also starts the backend on port 6666 and the proxy (ports 6666, 80 and 443 must be free). Locally, test with `curl -H 'Host: local.example.test' http://127.0.0.1/`.
- `pn example <domain> --run` makes an online HTTP example for a real domain; add `--cert` (and `--email`/`--staging`) to also get HTTPS.
- `--stop` stops the example.

## Guides

### Sites

A site is one file, `nginx/templates/<domain>.conf.template`, generated by `pn add`. Nginx renders it at container start (only `${FORCE_HTTPS}` and `${HSTS_MAX_AGE}` style variables are substituted; Nginx's own `$variables` are untouched). A generated proxy site contains:

- an `upstream` block with keepalive;
- a port-80 server: ACME challenge location, optional redirect to HTTPS, then the proxied location;
- a port-443 server: TLS settings (TLS 1.2/1.3), HSTS, the proxied location;
- proxy headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, and WebSocket upgrade handling that only sends `Connection: upgrade` for real upgrade requests, so keepalive works;
- `client_max_body_size 50m` and 300 s timeouts unless you changed them.

You may edit the file by hand. `pn add` never overwrites it without `--force`, `pn migrate` never touches it, and `pn template edit` tests your change.

Unknown host names get a default server that answers 404 on port 80 (keeping the ACME path open) and rejects the TLS handshake on 443, so one site's certificate is never shown for another name.

Aliases, `--redirect-aliases`, `--allow`, `--max-body-size`, `--timeout`, `--access-log`, `--force-https` and the `static`/`spa`/`redirect` templates are described under [pn add](#pn-add). Static sites put their files in `sites/<domain>/` (an `index.html` placeholder is created, never overwriting yours).

### Certificates

Typical flow for a new site:

```bash
pn doctor app.example.com                       # DNS, CAA and reachability
pn add app.example.com 127.0.0.1:3000 --run
pn cert app.example.com --staging               # optional dry run, no rate limits
pn cert app.example.com --email you@example.com # the real one
pn status                                       # expiry dates
```

Or in one go: `pn add app.example.com 127.0.0.1:3000 --run --cert`.

- Certificates are stored in `ssl/certs/` (Let's Encrypt layout). Back this directory up or keep it when moving servers.
- The `certbot` service checks for renewal every 12 hours. Nginx reloads every 12 hours (`CERT_RELOAD_INTERVAL` in `.env`) so renewed certificates are served without a restart.
- `FORCE_HTTPS=true` (default) redirects HTTP to HTTPS for sites using the project default; the ACME path is never redirected. Set `FORCE_HTTPS=false` in `.env` to serve both, or use `--force-https`/`--no-force-https` per site.
- HSTS is sent on HTTPS with `max-age=${HSTS_MAX_AGE}` (default one year). `includeSubDomains` is opt-in per site (`--hsts-subdomains`) because on an apex domain it forces HTTPS on every sibling subdomain.
- Let's Encrypt validates every name in the certificate; one name without DNS fails the whole request, which is why `pn cert` and `pn doctor` check them all.

### Basic auth

Put a login in front of a site without changing the application behind it (admin panels, staging sites, small tools).

```bash
pn auth add admin.example.com alice --run   # asks for the password; the first user turns auth on
pn auth add admin.example.com bob           # more users, or change a password
pn auth remove admin.example.com bob
pn auth list
pn auth disable admin.example.com --run     # turn auth off again (deletes the users)
```

- Visitors get a browser login prompt; without valid credentials the request never reaches your application. The ACME challenge path stays open so certificates keep renewing, and alias hosts that only redirect are not asked for a login.
- Adding, changing or removing users takes effect immediately (Nginx reads the user file on every request). Turning auth on or off edits the site template, so it needs `--run` (or `pn up`); until then the site keeps its previous state, and the command says so.
- Removing the **last** user is refused because it would lock everyone out; use `pn auth disable`.
- Passwords are stored as apr1 hashes in `nginx/auth/<domain>.htpasswd` (mounted read-only into the container) and are never taken from the command line. Scripts can pipe one in: `printf '%s\n' "$PW" | pn auth add <domain> <user> --password-stdin`. Minimum length 8.
- Only for sites with SSL (otherwise passwords would travel in clear text). If the site can still be reached over plain HTTP (`FORCE_HTTPS=false` or `--no-force-https`), `pn auth add` warns you.
- Projects created before this feature need `pn migrate --yes` once (it adds the `nginx/auth` mount).
- It combines with `--allow`: the allow-list is checked first, then the login.

### How changes are applied

| Change | Command | Effect |
|---|---|---|
| Add/remove a site, edit a template, enable/disable auth | `... --run` | Re-render, `nginx -t`, reload **without restarting**. If the test fails, the previous configuration is restored and the command fails. |
| Add/change/remove a user | `pn auth add/remove` | Immediate. |
| Change `.env`, Dockerfile, compose file | `pn restart` | Container recreated; configuration tested first. |
| New certificate or other file Nginx reads itself | `pn reload` | Reload only. |
| New nginx / certbot patch release | `pn up --pull` | Pull, rebuild, test, recreate. |

A running proxy is never replaced by a configuration that fails `nginx -t`.

### Docker networks

By default the proxy reaches host services through `host.docker.internal`. To reach containers by name instead, attach the proxy to their network:

```bash
docker network create backend            # if it does not exist yet
pn network add backend --run
pn add app.example.com http://myapp:8080 --run   # myapp is a container on that network
pn network remove backend --run
```

`pn network` never creates or deletes Docker networks.

### Logs

Nginx writes `logs/access.log`, `logs/error.log` and per-site `logs/<domain>.access.log`. Inside the container logs rotate by size: when a file exceeds `LOG_ROTATE_SIZE_MB` (default 50) it is renamed to `.1`, older ones shift up, `LOG_ROTATE_KEEP` (default 5) files are kept, and Nginx reopens its files. Read them with `pn logs`.

### Upgrading and rolling back

```bash
pn upgrade                 # the tool itself
cd /path/to/project
pn migrate                 # preview what changed in the generated files
pn migrate --yes --run     # apply, back up, restart; automatic rollback if the restart fails
pn rollback                # preview undoing the last migration
pn rollback --yes && pn restart
```

Check the running Nginx version with `pn status`. Images are pinned in `.env` (`NGINX_IMAGE`, `CERTBOT_IMAGE`); a plain `pn up` keeps what is built. To take new patch releases of the pinned tags use `pn up --pull`; to move to another minor version change `NGINX_IMAGE` first.

### Several projects on one server

A server has one pair of ports 80/443, so it runs **one** pn proxy, and that proxy serves **all** of your projects. Do not run `pn init` in every project; the generated containers are named `proxy-nginx` and `proxy-certbot`, so a second proxy cannot start next to the first one.

```text
/srv/proxy/        the pn project (pn init here): the only proxy, all sites are added here
/srv/project-a/    project A's own docker-compose.yml (app, database, ...)
/srv/project-b/    project B's own docker-compose.yml
```

Add every project's domains to the one proxy:

```bash
cd /srv/proxy
pn add a.example.com 127.0.0.1:3001 --run --cert     # project A
pn add b.example.com 127.0.0.1:3002 --run --cert     # project B
pn status                                            # all sites in one place
```

How the proxy reaches an application:

1. **Published host port (simplest).** Publish the port in the application's compose file (`ports: ["127.0.0.1:3001:3000"]`) and use `127.0.0.1:3001` as the target (it is mapped to `host.docker.internal`). Give each project its own host port.
2. **Shared Docker network.** `docker network create shared`, put the application's containers on it (`networks: { shared: { external: true } }`), run `pn network add shared --run`, and use the container name: `pn add a.example.com http://a-web:3000 --run`. Container names must be unique on that network.

If you run `pn up` in a second pn project while the first one's proxy exists, `pn` stops and tells you which project owns the proxy; `pn doctor` reports it too. Keeping the proxy in a neutral directory (instead of inside one project) means redeploying or deleting a project never touches the proxy. To move it: `pn down` in the old directory, copy the whole directory (`ssl/certs`, `.env`, `nginx/templates`, `nginx/auth`, `sites`), `pn up` in the new one, and check with `pn doctor`. Two proxies on one machine would need separate public IP addresses and edited ports and container names in the compose files; `pn` does not manage that.

### Other services and existing setups

**Can I edit `docker-compose.yml`, or put my own services in it?** Yes. `pn` edits that file in two situations only, always through a YAML parser that keeps comments, ordering and everything it does not manage:

| Command | What it changes |
|---|---|
| `pn network add/remove` | `networks` of `proxy-nginx` and the matching top-level `networks` entry (an entry still used by another service is kept). |
| `pn migrate --yes` | Only adds what is missing: the `NGINX_IMAGE` build argument, the tuning variables, the `./sites` and `./nginx/auth` mounts; pins `certbot/certbot` / `certbot/certbot:latest` to `CERTBOT_IMAGE`. Values you already set (restart policy, ports, extra mounts, a custom certbot tag) are never changed. |

Your own services, ports, mounts, environment, volumes and networks are left as they are, and `pn migrate` keeps them (a backup of the previous file is still written to `.pn-backup/`). Two service names must stay: `proxy-nginx` and `certbot`. `pn up`/`pn restart` recreate only `proxy-nginx`; `pn stop` and `pn down` act only on `proxy-nginx` and `certbot` when other services exist; `pn status` lists everything.

**Recommendation for databases and other non-HTTP services** (for example TimescaleDB on port 5432): keep them in their **own compose project**, not in the proxy's file. Nginx only proxies HTTP(S), so the proxy never needs to reach the database; your applications connect to it directly (publish the port, or put both on a shared Docker network). Separate projects mean `pn down`, `pn migrate` or re-creating the proxy project can never affect the database. Bind the port to localhost when only local applications need it: `"127.0.0.1:5432:5432"`.

**Moving a service (and its data) out of the proxy's compose file without losing data:**

1. Note the image tag, environment and mounts of the service.
2. Stop it: `docker compose stop <service>`. For a bind-mounted data directory (`./data/<name>`) the data stays on disk. Named volumes would **not** follow a new project name, so copy those explicitly.
3. Make a backup of the data directory while the service is stopped (`sudo cp -a data/<name> data/<name>.bak`).
4. Create the new project (for example `~/services/<name>/docker-compose.yml`) with the **same image tag**, the same environment, and the data directory mounted from the same place (an absolute path avoids moving anything). Join an external network (`networks: { shared: { external: true } }`) if other containers reach it by name.
5. Remove the old container (`docker rm <container_name>`; the data is on the host) and delete the service from the old compose file, then start the new project.
6. Check the application connects, then remove the backup.

**Adopting a hand-made proxy setup.** Do not run `pn migrate` in a directory that `pn init` did not create: it replaces the generated files (with a backup) and would overwrite your own `Dockerfile`, `nginx.conf` and base templates. Instead create a fresh project next to it (`mkdir proxy-new && cd proxy-new && pn init`), re-create the sites with `pn add` (compare with `pn template list`), copy the Let's Encrypt data (`cp -a old/ssl/certs proxy-new/ssl/certs`, same layout if the old setup used `/etc/letsencrypt`) to avoid re-issuing, then switch: stop the old proxy (ports 80/443), `pn up --pull` in the new project, and check with `pn doctor <domain>`. Rolling back is starting the old proxy again.

### Examples

```bash
# Local trial, nothing public
pn example --run && curl -H 'Host: local.example.test' http://127.0.0.1/ ; pn example --stop

# Several apps on one server
pn add shop.example.com 127.0.0.1:3000 --www --redirect-aliases --run --cert
pn add api.example.com 127.0.0.1:4000 --max-body-size 100m --timeout 120 --run --cert
pn add admin.example.com 127.0.0.1:5000 --allow 203.0.113.0/24 --run --cert
pn auth add admin.example.com sam --run

# Static site and a moved domain
pn add docs.example.com --template static --run --cert
pn add old.example.com https://new.example.com --template redirect --run --cert
```

## Project layout and configuration

`pn init` creates:

```text
docker-compose.yml        proxy-nginx (Nginx) and certbot (renewal) services
Dockerfile                Nginx image with the hooks below
.env                      settings (see below)
.pn.json                  project schema version, used by pn migrate
nginx/
  nginx.conf              main Nginx configuration (gzip, logging)
  templates/              one *.conf.template per site, plus two base templates
  auth/                   <domain>.htpasswd files for basic auth
  docker-entrypoint.d/    hooks: dev certificates, periodic reload, log rotation
ssl/
  certs/                  Let's Encrypt data (certificates, account, renewal configs)
  www/                    webroot for the ACME challenge
sites/                    files for static and spa sites (sites/<domain>/)
logs/                     Nginx logs
.pn-backup/               created by pn migrate (backups and manifests)
```

`.env` settings:

| Variable | Default | Meaning |
|---|---|---|
| `FORCE_HTTPS` | `true` | Redirect HTTP to HTTPS for sites without their own `--force-https`/`--no-force-https`. |
| `HSTS_MAX_AGE` | `31536000` | HSTS max-age in seconds (the online example uses 0). |
| `NGINX_IMAGE` | pinned `nginx:1.x` | Nginx base image. |
| `CERTBOT_IMAGE` | pinned `certbot/certbot:v…` | certbot image. |
| `CERT_RELOAD_INTERVAL` | `12h` | How often Nginx reloads to pick up renewed certificates. |
| `LOG_ROTATE_SIZE_MB` | `50` | Rotate a log when it exceeds this size. |
| `LOG_ROTATE_KEEP` | `5` | Rotated files to keep. |

Back up: `nginx/templates/`, `nginx/auth/`, `sites/`, `.env`, `ssl/certs/`. To move to a new server copy the project directory, point DNS at the new server, then `pn up`.

## Troubleshooting and FAQ

- **`pn cert` fails.** Run `pn doctor <domain>`. The usual causes are DNS not pointing at this server, ports 80/443 closed in a firewall or cloud security group, a CAA record that forbids Let's Encrypt, or an AAAA record whose IPv6 does not reach the proxy. Use `--staging` while testing to avoid rate limits.
- **Browser shows a certificate warning after `pn add`.** Expected until `pn cert` succeeds: a self-signed certificate is served meanwhile.
- **502 Bad Gateway.** The upstream is not reachable from the container. A host service must listen on `0.0.0.0` (not only `127.0.0.1`) because the proxy reaches it through `host.docker.internal`; check the port and that the app is running.
- **`pn` says the directory is not a pn project.** Its `docker-compose.yml` has no `proxy-nginx` service. Go to the directory where you ran `pn init` (the error message lists nearby projects). `docker inspect proxy-nginx --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'` prints it.
- **`nginx config test failed; the running proxy was not touched.** Nginx's own error is printed above it. Fix the template (`pn template edit <domain>`) and apply again.
- **Ports 80/443 already in use.** Another service owns them. `pn doctor` shows this when the proxy is stopped; find it with `ss -ltnp | grep -E ':(80|443) '`.
- **WebSockets.** Supported out of the box; no extra option needed.
- **Can I edit the generated files?** Site templates, `.env`, the compose file: yes. Base files (`nginx.conf`, hooks, Dockerfile) can be edited too, but `pn migrate` will propose to replace them (with a backup) when a new version changes them.
- **Can I have a pn project for project A and another for project B on one server?** No: one pn proxy per server, shared by all projects. See [Several projects on one server](#several-projects-on-one-server).
- **Can I put my own services (a database) in `docker-compose.yml`?** Yes, `pn` leaves them alone, but a separate compose project is cleaner. See [Other services and existing setups](#other-services-and-existing-setups).
- **How do I install without npm's public registry?** From GitHub: `npm install -g github:samcn26/proxy-nginx-cli`; from a tarball: run `npm pack` in the repository and `npm install -g ./proxy-nginx-cli-<version>.tgz` on the server; or keep a git checkout and `npm link` it, which `pn upgrade` updates with `git pull`. `pn upgrade` on a copy installed from a tarball or GitHub looks for the package on the npm registry, so reinstall the same way instead.
- **Is a wildcard certificate supported?** Not yet (it needs DNS-01 validation).

## Agent skill

`skills/proxy-nginx-cli/SKILL.md` is a ready-to-use skill for coding agents: workflows, safety rules and certbot recovery steps for this CLI. Copy it into your agent's skills directory (for example `.claude/skills/proxy-nginx-cli/`). `pn status --json` and `pn doctor --json` give agents structured data.

## Development

```bash
npm install
npm test                    # unit tests (no Docker needed)
./bin/pn --help
npm pack --dry-run
```

CI (`.github/workflows/ci.yml`) runs the tests on Node 18/20/22 and an integration job that builds the generated project with real Docker and checks applying, rollback on invalid configuration, basic auth, `--pull` and removal. See `AGENTS.md` for conventions and `CHANGELOG.md` for changes. License: MIT.
