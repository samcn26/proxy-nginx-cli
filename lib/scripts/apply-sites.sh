#!/bin/sh
# Runs inside the running proxy-nginx container.
# Re-renders nginx/templates, validates the result, and reloads nginx without
# restarting the container. If anything fails, the previous configuration is
# restored and the running nginx keeps serving it.
set -eu

conf="${PN_CONF_DIR:-/etc/nginx/conf.d}"
hooks="${PN_ENTRYPOINT_DIR:-/docker-entrypoint.d}"
backup=$(mktemp -d)
ok=0

cleanup() {
  if [ "$ok" != 1 ]; then
    rm -f "$conf"/*.conf
    cp -a "$backup"/. "$conf"/
    echo "pn: nginx config test failed; previous configuration restored, running proxy unchanged." >&2
  fi
  rm -rf "$backup"
}
trap cleanup EXIT

cp -a "$conf"/. "$backup"/
rm -f "$conf"/*.conf
"$hooks"/20-envsubst-on-templates.sh
"$hooks"/40-generate-dev-certs.sh
nginx -t
ok=1
nginx -s reload
