---
name: proxy-nginx-cli
description: Operate a Docker-based Nginx reverse proxy with the `pn` CLI (proxy-nginx-cli). Use when asked to add, change, remove, inspect or troubleshoot websites or domains behind the proxy, issue or renew Let's Encrypt certificates, attach Docker networks, or update a pn project.
---

# proxy-nginx-cli (`pn`)

`pn` manages a project directory that runs Nginx + certbot with Docker Compose. Every
command works on the **current directory**, so `cd` into the project first. Read state
with `pn status --json` before changing anything.

## Safety rules

- Never overwrite a site template without `--force`. `pn add` on an existing domain is a
  no-op that says so. Hand-edited templates are the user's work.
- Prefer `pn add ... --run` / `pn remove ... --run` / `pn template edit ... --run` to
  apply site changes: they re-render, run `nginx -t`, and reload **without restarting**,
  and restore the previous config if the test fails.
- `pn up`, `pn restart` and `pn network ... --run` recreate the container (brief outage).
  They test the new config first and refuse to touch a running proxy if it is invalid.
- `pn reload` only reloads what is already rendered. After editing
  `nginx/templates/*.template` by hand use `pn up`/`pn restart` or `pn template edit --run`.
- `pn reset` deletes all site templates. Do not run it without the user asking; on a
  terminal it asks for confirmation, in scripts it does not (use only with explicit intent).
- Do not commit real domains, certificates (`ssl/`), `.env`, or `logs/` anywhere public.
  Use `example.com` / `example.test` in docs and examples.
- Certificates: use `--staging` while testing to avoid Let's Encrypt rate limits; the
  staging certificate is not trusted by browsers. Moving to production later forces a
  renewal automatically.

## Inspect

```bash
pn doctor [domain] --json   # checks[] with status ok|info|warn|fail and a fix hint; exit 1 on fail
pn status --json        # proxy.running, sites[], networks[], certificates[]
pn template list        # domain -> upstream [preset, ssl, aliases]
pn logs [domain] -n 200 # access log; --error for the error log; -f follows
```

`certificates[]` has `expires`, `daysLeft`, `selfSigned`, `staging`, `renewal`. A
`selfSigned: true` entry means the development certificate is still served: run `pn cert`.

## Common workflows

**Initialize a project**

```bash
mkdir proxy && cd proxy && pn init && pn up
```

**Add a service** (upstream on the same host: `127.0.0.1:PORT` is mapped to
`host.docker.internal:PORT`)

```bash
pn add app.example.com 127.0.0.1:3000 --run          # HTTP now, self-signed TLS
pn add app.example.com 127.0.0.1:3000 --run --cert   # also request a certificate
pn add app.example.com --www --redirect-aliases 127.0.0.1:3000
```

DNS must point at the server and ports 80/443 must be reachable before `--cert`.

**Other site types**

```bash
pn add docs.example.com --template static --run      # serves ./sites/docs.example.com
pn add app.example.com --template spa --run          # static + index.html fallback
pn add old.example.com https://new.example.com --template redirect --run
pn add admin.example.com 127.0.0.1:8080 --allow 203.0.113.0/24 --max-body-size 10m --run
```

**Issue / renew certificates**

```bash
pn doctor app.example.com                # DNS, CAA, HTTP reachability first
pn cert app.example.com --email ops@example.com
pn cert app.example.com --staging        # test the flow first
pn cert app.example.com --force-renew
```

`pn cert` covers every name the site template declares (aliases). It pauses the renewal
service while issuing. Renewal runs every 12 h; nginx reloads on a timer to pick it up.

**Attach Docker networks** (the network must already exist)

```bash
pn network add backend-net --run
pn network remove backend-net --run
```

**Edit a template safely**

```bash
pn template edit app.example.com --run   # opens $EDITOR, tests, applies, rolls back on error
```

**Remove a site**

```bash
pn remove app.example.com --run
pn remove app.example.com --run --purge-cert   # also delete its certificate
```

**Protect a site with a login (basic auth)**

```bash
pn auth add admin.example.com alice --run        # interactive, no echo; first user enables auth
printf '%s\n' "$PASSWORD" | pn auth add admin.example.com bob --password-stdin   # scripts
pn auth remove admin.example.com bob             # not the last user (that would lock everyone out)
pn auth disable admin.example.com --run          # turn it off
pn auth list
```

Never put passwords on the command line or in files you commit. Only SSL sites; user changes apply
immediately, enabling/disabling needs `--run`. Old projects need `pn migrate --yes` first.

**Update nginx / certbot images** (images are pinned; patch releases are not automatic)

```bash
pn up --pull         # rebuild with --pull, pull certbot, validate, recreate
```

To change the minor version, set `NGINX_IMAGE` in `.env` first. `pn status` shows the running nginx version.

**One site must stay on plain HTTP** (webhook, legacy client) while others redirect:

```bash
pn add hooks.example.com 127.0.0.1:9000 --no-force-https --run
```

**Update a project made by an older pn**

```bash
pn migrate            # preview only
pn migrate --yes      # apply; backups go to .pn-backup/; site templates untouched
pn restart            # or: pn migrate --yes --run (rolls back automatically if the restart fails)
```

If something is wrong after migrating: `pn rollback` (preview), `pn rollback --yes`, `pn restart`.
Edited-since-migrate files are kept unless `--force`.

## Recover from certbot failures

0. `pn doctor <domain> [--ip <public ip>]`: it names the usual causes (no DNS record, wrong address,
   CAA forbidding Let's Encrypt, port 80 not reaching this proxy, AAAA record without working IPv6).
   `pn cert` runs the DNS/CAA part itself before asking Let's Encrypt (`--skip-checks` to bypass).
1. `pn cert <domain> --staging` to see the real error without burning rate limits.
2. Check DNS (`dig +short <domain>`), firewall for 80/443, and that
   `http://<domain>/.well-known/acme-challenge/x` returns 404 (not a timeout or redirect to
   another host). Unknown hosts are served by the default 404 server, which keeps the
   challenge path open.
3. A failed attempt can leave an empty `ssl/certs/renewal/<domain>.conf`; `pn cert` ignores
   and replaces empty ones.
4. "Another instance of Certbot is already running": `pn cert` pauses the renewal service
   itself; if it still happens, `docker compose stop certbot` and retry.
5. Persistent trouble with a lineage: `pn remove <domain> --purge-cert`, re-add, re-issue.

## Troubleshooting

- `nginx config test failed; the running proxy was not touched`: the message above it is
  nginx's own error; fix the template (`pn template edit <domain>`).
- Site shows a certificate warning right after `pn add`: expected until `pn cert`.
- 502 from a host service: upstream must listen on `0.0.0.0` (not only `127.0.0.1`), because
  the proxy reaches the host through `host.docker.internal`.
