# TODO

Public roadmap for `proxy-nginx-cli`. Work is tracked as GitHub issues; see the
roadmap issue: https://github.com/samcn26/proxy-nginx-cli/issues/1

## Next Release: npm Publish

Done in code: package metadata, `LICENSE`, Node `bin/pn` entry (works with npm's
Windows shims), CI (`.github/workflows/ci.yml`), pinned images.

- [ ] Decide whether the public binary name `pn` is acceptable long term.
- [ ] Confirm the package name `proxy-nginx-cli` is available on npm.
- [ ] Run release checks: `npm test`, `./bin/pn --help`, `./bin/pn --help cn`, `npm pack --dry-run`, owner-specific string scan, and the CI `docker` job on the release commit.
- [ ] Bump the version (`npm version`) and move `CHANGELOG.md` "Unreleased" under it.
- [ ] Publish to npm (needs npm credentials).
- [ ] Test from npm in a clean temporary project: `npm install -g proxy-nginx-cli`, `pn --help`, `pn init`, `pn add app.example.com 127.0.0.1:3000`, `pn status`.
- [ ] Verify `pn upgrade` works for an npm-installed CLI.

## Agent Skills

- [x] Skill pack: `skills/proxy-nginx-cli/SKILL.md` (workflows, safety rules, certbot recovery).
- [ ] Publish the skill pack where agents can install it (plugin/marketplace), once the npm release is out.

## MCP Evaluation

- [x] `pn status --json` provides the structured project/site/certificate inventory.
- Decision: do not build an MCP server yet. The skill plus `--json` covers the workflow;
  revisit if agents need structured results from more commands (then add `--json` to
  `pn template list` first, and wrap `lib/commands.js` rather than shelling out).

## Future CLI Improvements

- [ ] Basic auth per site (`--basic-auth`), needs password hashing (apr1/bcrypt) without extra system tools.
- [ ] `pn add --template` presets for common stacks (PHP-FPM, WebSocket-only, gRPC).
- [ ] Wildcard certificates (DNS-01) for aliases that are not individually routable.
- [ ] `--json` for `template list`, `migrate`, and `cert` results.
