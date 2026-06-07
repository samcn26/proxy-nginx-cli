# TODO

Public roadmap for `proxy-nginx-cli`.

## Next Release: npm Publish

- [ ] Review package metadata before publishing:
  - [ ] `name`
  - [ ] `version`
  - [ ] `description`
  - [ ] `keywords`
  - [ ] `author`
  - [ ] `license`
  - [ ] `repository`
  - [ ] `bugs`
  - [ ] `homepage`
- [ ] Decide whether the public binary name `pn` is acceptable long term.
- [ ] Run release checks:
  - [ ] `npm test`
  - [ ] `./bin/pn --help`
  - [ ] `./bin/pn --help cn`
  - [ ] `npm pack --dry-run`
  - [ ] scan for private domains or owner-specific strings.
- [ ] Publish to npm.
- [ ] Test from npm in a clean temporary project:
  - [ ] `npm install -g proxy-nginx-cli`
  - [ ] `pn --help`
  - [ ] `pn init`
  - [ ] `pn add app.example.com 127.0.0.1:3000`
  - [ ] `pn status`
- [ ] Verify `pn upgrade` works for npm-installed CLI.

## Agent Skills

- [ ] Draft a small skill pack for agents using this CLI.
- [ ] Include common workflows:
  - [ ] initialize a proxy project
  - [ ] add a frontend service
  - [ ] issue certificates
  - [ ] attach Docker networks
  - [ ] edit custom templates safely
  - [ ] recover from certbot failures
- [ ] Include production safety rules:
  - [ ] do not overwrite existing templates without `--force`
  - [ ] use `pn restart` after template edits
  - [ ] use `pn reload` only for Nginx reloads that do not need template regeneration
  - [ ] avoid committing real domains or secrets

## MCP Evaluation

- [ ] Evaluate whether an MCP server is useful.
- [ ] Prefer skills first if the workflow is mostly instructions and shell commands.
- [ ] Consider MCP only if agents need structured access to:
  - [ ] project status
  - [ ] generated site inventory
  - [ ] certificate inventory
  - [ ] safe command execution wrappers
  - [ ] validation reports
- [ ] If MCP is useful, design it as a thin layer over the same `lib/commands.js` APIs.

## Future CLI Improvements

- [ ] Consider a project-template upgrade command with a name that does not conflict with CLI upgrade, such as `pn migrate` or `pn project upgrade`.
- [ ] Consider a custom template workflow:
  - [ ] `pn template list`
  - [ ] `pn template edit <domain>`
  - [ ] `pn add --template <name>`
- [ ] Consider a YAML parser for more robust `docker-compose.yml` editing.
- [ ] Improve `pn status` output for certificate expiry dates.
- [ ] Add safer certbot lock handling inside `pn cert`.

