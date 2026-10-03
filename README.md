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
pn reset
pn add <domain> -H <host> -p <port>
pn add <domain> <target-url>
pn add <domain> <host:port> --run
pn add <domain> <host:port> --run --cert
pn add <domain> <host:port> --force
pn remove <domain>
pn remove <domain> --run
pn network add <network>
pn network add <network> --run
pn network remove <network> --run
pn up
pn stop
pn down
pn restart
pn status
pn upgrade
pn reload
pn cert <domain>
pn cert <domain> --email <email>
pn cert <domain> --staging
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
pn stop
pn down
pn restart
pn reload
pn upgrade
```

`pn stop` maps to `docker compose stop`: containers are stopped but kept.

`pn down` maps to `docker compose down`: containers and the compose default network are removed, while project files, templates, logs, and certificates stay on disk.

`pn reload` validates and reloads the running Nginx process without restarting the container. Use it after certificate changes or when generated Nginx config is already current.

`pn restart` recreates `proxy-nginx`, which reruns the Nginx image entrypoint and regenerates config from `nginx/templates/*.template`. Use it after editing templates.

`pn upgrade` upgrades the `proxy-nginx-cli` command itself. Git-linked installs run `git pull --ff-only` and `npm install`; npm installs run `npm install -g proxy-nginx-cli@latest`.

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
logs/
```

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
