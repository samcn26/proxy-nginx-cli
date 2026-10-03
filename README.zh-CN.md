# proxy-nginx-cli

[English](README.md) | 简体中文

`pn` 是一个命令行工具，用来在**一台服务器上搭建标准的网站托管环境**：基于 Docker 的 Nginx 反向代理 + Let's Encrypt 证书。每个站点只需要一条命令（`pn add app.example.com 127.0.0.1:3000 --run --cert`），`pn` 负责生成 Nginx 配置、申请并续期证书、不停机地应用变更，并让项目可以持续升级。

- 支持反向代理站点、静态站点、单页应用（SPA）和跳转，支持别名（`www`）、站点级限制、IP 白名单和 HTTP 基础认证。
- 通过 Let's Encrypt（HTTP-01）自动启用 HTTPS，带续期服务、到期提示、DNS/CAA 预检。
- 操作安全：配置先测试再应用，错误的改动不会让正在运行的代理挂掉；升级可预览、可备份、可回滚。
- 全是你能读懂、能修改的普通文件：所有内容都在一个项目目录里。

## 目录

- [环境要求与安装](#环境要求与安装)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [使用指南](#使用指南)：[站点](#站点) · [证书](#证书) · [基础认证](#基础认证) · [变更如何生效](#变更如何生效) · [Docker 网络](#docker-网络) · [日志](#日志) · [升级与回滚](#升级与回滚) · [一台服务器上的多个项目](#一台服务器上的多个项目) · [与其他服务共存及接入已有环境](#与其他服务共存及接入已有环境) · [示例](#示例)
- [项目结构与配置](#项目结构与配置)
- [故障排查与常见问题](#故障排查与常见问题)
- [Agent 技能包](#agent-技能包) · [开发](#开发)

## 环境要求与安装

- 一台 Linux 服务器，装有 **Docker** 和 **Docker Compose** 插件（`docker compose`）或 `docker-compose`，`pn` 会自动检测哪个可用。
- 运行 `pn` 本身需要 **Node.js 18+**。
- 服务器的 **80** 和 **443** 端口空闲；要申请证书还需要域名 DNS 指向这台服务器。
- 你的应用运行在同一台主机上（通过 `host.docker.internal` 访问），或者在代理加入的 Docker 网络里（见 [Docker 网络](#docker-网络)）。

安装：

```bash
# 从源码安装（目前的方式）
git clone https://github.com/samcn26/proxy-nginx-cli.git
cd proxy-nginx-cli && npm install && npm link
pn --help          # 英文帮助
pn --help cn       # 中文帮助

# 从 npm 安装（计划中，包还没有发布）
npm install -g proxy-nginx-cli
```

以后用 `pn upgrade` 升级工具本身（见 [pn upgrade](#pn-upgrade)）。

## 快速开始

```bash
mkdir proxy && cd proxy
pn init                                          # 在当前目录创建项目文件
pn up                                            # 构建并启动 Nginx
pn add app.example.com 127.0.0.1:3000 --run --cert   # 代理本机应用，并启用 HTTPS
pn status                                        # 站点、证书、网络
```

`--cert` 能成功的前提：`app.example.com` 解析到这台服务器，并且 80/443 端口能从公网访问。可以先用 `pn doctor app.example.com` 检查。

`pn` 的所有操作都针对**当前目录**，所以要在项目目录（包含 `docker-compose.yml` 的那个目录）里运行。在别的目录运行时，它会告诉你项目在哪。

## 命令参考

约定：`<name>` 表示必填，`[name]` 表示可选，`...` 表示该选项可以重复使用。命令出错时退出码为 1。修改项目的命令会打印做了什么；会影响运行中服务的命令会说明变更是否已经生效。

### 总览

| 分组 | 命令 |
|---|---|
| 项目 | [`init`](#pn-init) · [`reset`](#pn-reset) · [`migrate`](#pn-migrate) · [`rollback`](#pn-rollback) · [`upgrade`](#pn-upgrade) |
| 站点 | [`add`](#pn-add) · [`remove`](#pn-remove) · [`template list/edit`](#pn-template) · [`auth`](#pn-auth) |
| 证书 | [`cert`](#pn-cert) · [`doctor`](#pn-doctor) |
| 运行代理 | [`up`](#pn-up) · [`restart`](#pn-restart) · [`reload`](#pn-reload) · [`stop`](#pn-stop) · [`down`](#pn-down) · [`network`](#pn-network) |
| 查看 | [`status`](#pn-status) · [`logs`](#pn-logs) · [`doctor`](#pn-doctor) |
| 试用 | [`example`](#pn-example) |

全局选项：`-V, --version` 输出版本号，`-h, --help` 显示帮助。`pn --help cn` 显示中文帮助。

### pn init

在当前目录创建代理项目。

```
pn init
```

创建目录 `nginx/templates`、`nginx/docker-entrypoint.d`、`nginx/auth`、`ssl/certs`、`ssl/www`、`sites`、`logs`，以及文件 `Dockerfile`、`docker-compose.yml`、`.env`、`nginx/nginx.conf`、启动钩子脚本、两个基础模板和 `.pn.json`（项目版本号）。只创建缺失的文件：重复执行不会覆盖你已有的文件。各文件的用途见 [项目结构](#项目结构与配置)。

### pn reset

补齐缺失的骨架文件，并**删除所有站点模板**。

```
pn reset [-y, --yes]
```

- 基础文件（`Dockerfile`、`docker-compose.yml`、`.env`、`nginx.conf`、钩子脚本）已存在则保留，缺失则重建；基础模板保留。
- 站点模板（`nginx/templates/<域名>.conf.template`）会被删除。证书（`ssl/`）、日志、`sites/` 里的内容和 `.env` 不会被动。运行中的容器在下次 `pn up`/`pn restart` 之前仍按旧配置工作。
- 在终端里会先列出站点并询问确认，`--yes` 跳过确认；在脚本里（没有终端）不会询问。

### pn add

添加站点（生成它的 Nginx 模板）。不加 `--run` 时只写文件，不会生效。

```
pn add <domain> [target] [选项]
```

`<domain>` 会被校验并转成小写。`[target]` 取决于模板类型：

| `--template` | `[target]` | 效果 |
|---|---|---|
| `proxy`（默认） | `http://host:port`、`https://host:port` 或 `host:port`；也可以用 `-H/-p` | 反向代理到上游 |
| `static` | 无 | 提供 `sites/<域名>/` 里的文件 |
| `spa` | 无 | 同 `static`，找不到的路径回退到 `index.html` |
| `redirect` | 目标 URL，例如 `https://new.example.com` | 301 跳转，保留路径和查询参数 |

上游规则：端口必填；`127.0.0.1` 和 `localhost` 会映射成 `host.docker.internal`（代理运行在容器里，通过它访问主机上的服务）；上游可以是主机名、IPv4/IPv6 地址，或者已加入网络的容器名；`https://` 上游会使用 TLS 并带上 SNI；目标 URL 不能带路径。

选项：

| 选项 | 含义 |
|---|---|
| `-H, --host <host>`、`-p, --port <port>` | 上游主机和端口（`[target]` 的替代写法）。 |
| `--no-ssl` | 只生成 HTTP 站点（没有 443、没有证书）。不能和 `--cert` 一起用。 |
| `-t, --template <name>` | `proxy`（默认）、`static`、`spa`、`redirect`。 |
| `-a, --alias <domain>` | 站点的额外域名，可重复；证书会覆盖所有别名。 |
| `--www` | 等价于 `--alias www.<域名>`。 |
| `--redirect-aliases` | 别名不提供站点内容，而是 301 到主域名。至少需要一个别名。 |
| `--max-body-size <size>` | 即 `client_max_body_size`，例如 `10m`、`1g`、`0`（不限制）。默认 `50m`。 |
| `--timeout <seconds>` | 代理读/写超时，1–86400。默认 `300`。 |
| `--allow <cidr>` | 只允许该 IP 或 CIDR（IPv4/IPv6）访问，可重复，其余返回 403。ACME 验证路径保持开放。 |
| `--access-log` | 写 `logs/<域名>.access.log`（用 `pn logs <域名>` 查看）。 |
| `--force-https` / `--no-force-https` | 固定开启/关闭该站点的 HTTP→HTTPS 跳转，不受 `.env` 中 `FORCE_HTTPS` 影响。仅限 SSL 站点。 |
| `--hsts-subdomains` | HSTS 头加上 `includeSubDomains`（默认不加）。 |
| `--run` | 立即生效：代理在运行时，容器内重新渲染、测试、reload（不重启）；没运行则启动它。 |
| `--cert` | 隐含 `--run`，然后申请证书（见 [`pn cert`](#pn-cert)）、reload，并启动续期服务。 |
| `--email <email>`、`--staging` | Let's Encrypt 账号邮箱 / 测试环境；仅与 `--cert` 一起使用。 |
| `--force` | 覆盖已有的站点模板。不加时，已有模板会被保留并给出提示。 |

示例：

```bash
pn add app.example.com 127.0.0.1:3000                       # 只写模板
pn add app.example.com -H host.docker.internal -p 3000 --run
pn add api.example.com https://10.0.0.6:8443 --timeout 60 --run
pn add example.com 127.0.0.1:3000 --www --redirect-aliases --run --cert
pn add docs.example.com --template static --run
pn add old.example.com https://new.example.com --template redirect --run
pn add admin.example.com 127.0.0.1:8080 --allow 203.0.113.0/24 --max-body-size 10m --run
pn add hooks.example.com 127.0.0.1:9000 --no-force-https --run
pn add test.example.com 127.0.0.1:3000 --no-ssl --run
```

SSL 站点在你执行 `pn cert` 之前使用自签名证书（容器启动时自动生成）；`FORCE_HTTPS=true` 时普通 HTTP 会跳转到 HTTPS。

### pn remove

删除站点。

```
pn remove <domain> [--run] [--purge-cert]
```

删除站点模板及其基础认证用户文件。`--run` 立即应用删除（不重启）。`--purge-cert` 同时删除该域名的证书（certbot 证书记录，或自签名目录）。不加 `--run` 时，nginx 仍按旧配置工作，直到你应用它。

### pn template

查看和编辑站点模板。

```
pn template list
pn template edit <domain> [--run]
```

- `list` 列出所有站点：类型、上游、SSL 模式、别名、单站点 HTTPS 跳转模式和基础认证。
- `edit` 用 `$VISUAL` 或 `$EDITOR`（默认 `vi`）打开 `nginx/templates/<域名>.conf.template`，代理在运行时会对结果执行 `nginx -t`。加 `--run` 会立即应用（测试失败则恢复到之前的配置）；不加则用 `pn up` 应用。

### pn auth

用用户名和密码保护站点（HTTP 基础认证）。

```
pn auth add <domain> <user> [--password-stdin] [--run]
pn auth remove <domain> <user>
pn auth disable <domain> [--run]
pn auth list [domain]
```

- `add` 要求输入两次密码（不回显）；`--password-stdin` 可从标准输入读取。用户不存在则创建，存在则修改密码。第一个用户会在站点模板里开启基础认证，`--run` 让它立即生效。
- `remove` 删除用户。**最后一个**用户不能删（否则所有人都被锁在外面），请用 `disable`。
- `disable` 关闭认证并删除该站点的所有用户。
- `list` 列出受保护的站点及其用户名。

详见 [基础认证](#基础认证)。

### pn cert

为域名申请 Let's Encrypt 证书（HTTP-01，webroot 方式）。

```
pn cert <domain> [--email <email>] [--staging] [--force-renew] [--skip-checks]
```

执行顺序：先做 DNS/CAA 预检；如果还没有真正的证书记录，备份自签名证书目录；暂停 certbot 续期服务（它占用 certbot 的锁）；对该域名和站点模板里的所有别名运行 certbot（证书名 = 该域名）；reload Nginx；启动续期服务。

| 选项 | 含义 |
|---|---|
| `--email <email>` | 在 Let's Encrypt 登记的账号邮箱（默认不登记邮箱）。 |
| `--staging` | 使用测试环境：没有频率限制，证书浏览器不信任。适合先演练。 |
| `--force-renew` | 即使证书未到期也强制续期。从 `--staging` 切换到正式环境时会自动强制续期。 |
| `--skip-checks` | 跳过预检。 |

预检只拦截会导致无法签发的问题（某个域名没有任何 DNS 记录、CAA 记录禁止 Let's Encrypt），其余问题只是警告。完整检查见 [`pn doctor`](#pn-doctor)。

### pn doctor

体检：检查项目是否健康，给定域名时检查证书能否签发。除了在 `ssl/www` 里临时放一个马上删除的测试文件外，只做读取。

```
pn doctor [domain] [--ip <address>] [--json]
```

项目检查：Docker Compose 可用；没有被别的 pn 项目占用 `proxy-nginx` 容器；项目文件是否最新（有没有待执行的 `pn migrate`）；代理容器是否在运行（及 nginx 版本）；磁盘上的模板能否通过 `nginx -t`；代理停止时 80/443 端口是否空闲；证书是否有效、是否快到期、是否自签名或测试证书、续期服务是否在运行。

给定域名（及其每个别名）时：站点模板是否存在；是否有 DNS A/AAAA 记录；解析的地址是否是这台服务器；有没有 CAA 记录禁止 Let's Encrypt；`/.well-known/acme-challenge/` 下的测试文件能否通过 HTTP 从本代理读到（有 AAAA 记录时还会测 IPv6，因为 Let's Encrypt 优先使用 IPv6）；443 端口 HTTPS 是否能返回证书。

输出的每一行是 `[ok]`、`[info]`、`[warn]` 或 `[FAIL]`，并附带修复建议；有失败项时退出码为 1。云服务器通常看不到自己的公网地址，要得出确定结论需要加 `--ip <公网 IPv4>`。从服务器自己测试 HTTP 可达性可能因为回环 NAT 失败，即使从外部访问是正常的，所以该项只是警告而不是失败。`--json` 输出报告，供脚本和 agent 使用。

### pn up

构建（如有需要）并启动或重建 `proxy-nginx` 容器。

```
pn up [--pull]
```

代理已在运行时，会先在临时容器里测试新配置；如果无效，正在运行的代理不会被动，并显示错误。重建会短暂断开现有连接；站点变更建议用 `add`/`remove`/`template edit`/`auth` 的 `--run`，它不会重启。`--pull` 会先带 `--pull` 重新构建并拉取 certbot 镜像（固定标签下的新补丁版本），再用新镜像校验。

### pn restart

重建容器，让所有模板重新渲染。

```
pn restart [--pull]
```

行为与 `pn up` 相同（先校验，可选 `--pull`）。手动修改了 `nginx/templates/*.template`、`.env` 或 Dockerfile 后使用。

### pn reload

测试并 reload 正在运行的 Nginx 进程，不重建容器。

```
pn reload
```

在容器里执行 `nginx -t` 然后 `nginx -s reload`。它不会重新渲染模板，只适用于 Nginx 自己会读取的变更（例如证书）。要应用模板修改，请用相应编辑命令的 `--run`，或者 `pn up`。

### pn stop

停止项目容器但保留它们（`docker compose stop`）。之后用 `pn up` 启动。

```
pn stop
```

如果 `docker-compose.yml` 里还有你自己的服务（数据库、应用），只会停止 pn 管理的服务（`proxy-nginx`、`certbot`），其他服务继续运行。

### pn down

停止**并删除**容器和默认网络（`docker compose down`）。

```
pn down
```

文件、模板、证书和日志都保留在磁盘上。之后用 `pn up` 启动。

如果 `docker-compose.yml` 里还有你自己的服务，`pn down` 只删除 `proxy-nginx` 和 `certbot`（`docker compose rm -s -f`），其他服务和 compose 网络都不动。

### pn network

让代理加入已有的外部 Docker 网络，这样就能按容器名访问它们。

```
pn network add <name> [--run]
pn network remove <name> [--run]
```

修改 `docker-compose.yml`（通过 YAML 解析器，保留你的注释和自定义设置）。网络必须已经存在（`docker network create`）。不加 `--run` 只改文件；加 `--run` 会重建代理（先校验）。见 [Docker 网络](#docker-网络)。

### pn status

显示项目状态。

```
pn status [--json]
```

先输出 `docker compose ps`，再输出：代理是否在运行（及 nginx 版本）、站点（上游和别名）、已加入的网络、证书（到期日、剩余天数，以及 `self-signed`、`staging`、`expiring soon`、`EXPIRED` 等标记）。`--json` 以 JSON 输出同样的数据（`proxy`、`sites`、`networks`、`certificates`），不调用 `docker compose ps`。

### pn logs

查看 `./logs` 里 Nginx 日志的末尾。

```
pn logs [domain] [-n, --lines <count>] [-f, --follow] [--error]
```

不带参数：`logs/access.log`。`--error`：`logs/error.log`。带域名：`logs/<域名>.access.log`（用 `--access-log` 添加的站点才有）。`-n` 指定行数（默认 100），`-f` 持续跟随（使用 `tail -f`）。日志会自动轮转，见 [日志](#日志)。

### pn migrate

把已有项目更新到当前版本的 `pn` 生成的文件。

```
pn migrate [-y, --yes] [--run]
```

升级 `pn` 后在项目目录里运行。不加 `--yes` 只**预览**变更；加 `--yes` 会先把每个被改的文件备份到 `.pn-backup/<时间戳>/`（附带清单文件）再写入。你的站点模板、证书、日志和 `.env` 里已有的值都不会被动。`--run` 会在之后重建代理；如果失败，会自动回滚迁移，并用之前的文件重新启动代理。它是幂等的：没有待处理内容时会提示项目已是最新。

### pn rollback

撤销 `pn migrate`。

```
pn rollback [backup] [-y, --yes] [--run] [--force] [--list]
```

默认处理最新的、尚未回滚的备份；传入备份名可选择其他备份。不加 `--yes` 只预览；加 `--yes` 会还原旧版本，并删除迁移新建的文件。迁移之后你又修改过的文件会保留并提示，除非加 `--force`。`--list` 列出备份。`--run` 在之后重建代理，否则请用 `pn restart` 应用。

### pn upgrade

升级 `pn` 命令本身（不是升级某个项目）。

```
pn upgrade
```

git 安装的会执行 `git pull --ff-only` 和 `npm install`；npm 安装的会执行 `npm install -g proxy-nginx-cli@latest`。之后在你的项目里运行 `pn migrate`，看生成的文件是否需要更新。

### pn example

创建（并可运行）一个自包含的示例项目，用来试用 `pn`。

```
pn example [domain] [--run] [--cert] [--email <email>] [--staging] [--stop]
```

- `pn example` 在当前目录创建 `example/`（一个小后端和一个代理项目）。
- `--run` 还会在 6666 端口启动后端并启动代理（6666、80、443 端口必须空闲）。本地测试：`curl -H 'Host: local.example.test' http://127.0.0.1/`。
- `pn example <domain> --run` 用真实域名创建在线 HTTP 示例；再加 `--cert`（以及 `--email`/`--staging`）可同时获得 HTTPS。
- `--stop` 停止示例。

## 使用指南

### 站点

一个站点就是一个文件 `nginx/templates/<域名>.conf.template`，由 `pn add` 生成。Nginx 在容器启动时渲染它（只替换 `${FORCE_HTTPS}`、`${HSTS_MAX_AGE}` 这类环境变量；Nginx 自己的 `$变量` 不受影响）。生成的代理站点包含：

- 带 keepalive 的 `upstream`；
- 80 端口 server：ACME 验证路径、可选的 HTTPS 跳转、然后是代理；
- 443 端口 server：TLS 设置（TLS 1.2/1.3）、HSTS、代理；
- 代理头：`Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`，以及 WebSocket 升级处理（只在真正的升级请求里发送 `Connection: upgrade`，因此 keepalive 可正常复用）；
- 除非你修改，`client_max_body_size 50m` 和 300 秒超时。

你可以手动编辑这个文件。`pn add` 没有 `--force` 绝不会覆盖它，`pn migrate` 绝不会动它，`pn template edit` 会帮你测试修改。

未知域名会落到默认 server：80 端口返回 404（保持 ACME 路径开放），443 端口直接拒绝 TLS 握手，所以不会把某个站点的证书展示给别的域名。

别名、`--redirect-aliases`、`--allow`、`--max-body-size`、`--timeout`、`--access-log`、`--force-https` 以及 `static`/`spa`/`redirect` 模板见 [pn add](#pn-add)。静态站点把文件放在 `sites/<域名>/`（会创建一个 `index.html` 占位页，绝不覆盖你已有的文件）。

### 证书

新站点的典型流程：

```bash
pn doctor app.example.com                       # 检查 DNS、CAA、可达性
pn add app.example.com 127.0.0.1:3000 --run
pn cert app.example.com --staging               # 可选：演练，没有频率限制
pn cert app.example.com --email you@example.com # 正式证书
pn status                                       # 到期日
```

或者一步完成：`pn add app.example.com 127.0.0.1:3000 --run --cert`。

- 证书存放在 `ssl/certs/`（Let's Encrypt 目录结构）。迁移服务器时请备份或保留这个目录。
- `certbot` 服务每 12 小时检查一次续期。Nginx 每 12 小时 reload 一次（`.env` 里的 `CERT_RELOAD_INTERVAL`），续期后的证书不需要重启就会生效。
- `FORCE_HTTPS=true`（默认）会让使用项目默认设置的站点把 HTTP 跳转到 HTTPS；ACME 路径永远不会被跳转。在 `.env` 里设成 `FORCE_HTTPS=false` 则两者都提供，也可以用 `--force-https`/`--no-force-https` 按站点设置。
- HTTPS 响应会带 HSTS：`max-age=${HSTS_MAX_AGE}`（默认一年）。`includeSubDomains` 需要按站点选择开启（`--hsts-subdomains`），因为在主域名上它会强制所有同级子域名使用 HTTPS。
- Let's Encrypt 会验证证书里的每一个域名，只要有一个域名没有 DNS，整个申请都会失败，所以 `pn cert` 和 `pn doctor` 会检查所有域名。

### 基础认证

在站点前面加一道登录，不需要修改站点背后的应用（管理后台、预发布站点、小工具）。

```bash
pn auth add admin.example.com alice --run   # 询问密码；第一个用户会开启认证
pn auth add admin.example.com bob           # 添加更多用户，或修改密码
pn auth remove admin.example.com bob
pn auth list
pn auth disable admin.example.com --run     # 再次关闭认证（删除用户）
```

- 访问者会看到浏览器的登录框；没有有效凭据，请求根本到不了你的应用。ACME 验证路径保持开放，所以证书续期不受影响；只做跳转的别名域名也不需要登录。
- 添加、修改、删除用户立即生效（Nginx 每次请求都会读取用户文件）。开启或关闭认证会修改站点模板，所以需要 `--run`（或 `pn up`）；在此之前站点保持原状，命令也会这样提示。
- 删除**最后一个**用户会被拒绝，因为那会把所有人锁在外面；请使用 `pn auth disable`。
- 密码以 apr1 哈希保存在 `nginx/auth/<域名>.htpasswd`（只读挂载进容器），绝不会从命令行参数读取密码。脚本里可以管道传入：`printf '%s\n' "$PW" | pn auth add <域名> <用户> --password-stdin`。密码至少 8 位。
- 只允许用于有 SSL 的站点（否则密码会明文传输）。如果站点仍可通过 HTTP 访问（`FORCE_HTTPS=false` 或 `--no-force-https`），`pn auth add` 会警告你。
- 在这个功能之前创建的项目需要执行一次 `pn migrate --yes`（它会添加 `nginx/auth` 挂载）。
- 可以和 `--allow` 组合：先检查 IP 白名单，再要求登录。

### 变更如何生效

| 变更 | 命令 | 效果 |
|---|---|---|
| 添加/删除站点、编辑模板、开启/关闭认证 | `... --run` | 重新渲染、`nginx -t`、reload，**不重启**。测试失败则恢复之前的配置，命令报错。 |
| 添加/修改/删除用户 | `pn auth add/remove` | 立即生效。 |
| 修改 `.env`、Dockerfile、compose 文件 | `pn restart` | 重建容器，先测试配置。 |
| 新证书或其他 Nginx 自己会读取的文件 | `pn reload` | 仅 reload。 |
| nginx / certbot 新补丁版本 | `pn up --pull` | 拉取、重建、测试、重建容器。 |

运行中的代理永远不会被没通过 `nginx -t` 的配置替换。

### Docker 网络

默认情况下代理通过 `host.docker.internal` 访问主机上的服务。如果想按容器名访问容器，让代理加入它们所在的网络：

```bash
docker network create backend            # 如果还不存在
pn network add backend --run
pn add app.example.com http://myapp:8080 --run   # myapp 是该网络上的一个容器
pn network remove backend --run
```

`pn network` 不会创建或删除 Docker 网络。

### 日志

Nginx 写入 `logs/access.log`、`logs/error.log` 以及按站点的 `logs/<域名>.access.log`。容器内的日志按大小轮转：文件超过 `LOG_ROTATE_SIZE_MB`（默认 50）时改名为 `.1`，旧的依次后移，保留 `LOG_ROTATE_KEEP`（默认 5）份，并让 Nginx 重新打开文件。用 `pn logs` 查看。

### 升级与回滚

```bash
pn upgrade                 # 工具本身
cd /path/to/project
pn migrate                 # 预览生成文件有哪些变化
pn migrate --yes --run     # 应用、备份、重启；重启失败会自动回滚
pn rollback                # 预览撤销上一次迁移
pn rollback --yes && pn restart
```

用 `pn status` 查看运行中的 Nginx 版本。镜像版本固定在 `.env`（`NGINX_IMAGE`、`CERTBOT_IMAGE`）；普通的 `pn up` 沿用已构建的镜像。要获取固定标签下的新补丁版本，用 `pn up --pull`；要升级到别的次版本，先修改 `NGINX_IMAGE`。

### 一台服务器上的多个项目

一台服务器只有一对 80/443 端口，所以只能运行**一个** pn 代理，由这个代理服务你**所有**的项目。不要在每个项目里都执行 `pn init`：生成的容器固定叫 `proxy-nginx` 和 `proxy-certbot`，第二个代理无法与第一个同时启动。

```text
/srv/proxy/        pn 项目（在这里 pn init）：唯一的代理，所有站点都在这里添加
/srv/project-a/    项目 A 自己的 docker-compose.yml（应用、数据库等）
/srv/project-b/    项目 B 自己的 docker-compose.yml
```

把每个项目的域名都添加到这一个代理上：

```bash
cd /srv/proxy
pn add a.example.com 127.0.0.1:3001 --run --cert     # 项目 A
pn add b.example.com 127.0.0.1:3002 --run --cert     # 项目 B
pn status                                            # 所有站点集中查看
```

代理如何访问应用：

1. **发布主机端口（最简单）。** 在应用自己的 compose 文件里发布端口（`ports: ["127.0.0.1:3001:3000"]`），用 `127.0.0.1:3001` 作为目标（会映射成 `host.docker.internal`）。每个项目用自己的主机端口。
2. **共享 Docker 网络。** `docker network create shared`，让应用的容器加入它（`networks: { shared: { external: true } }`），执行 `pn network add shared --run`，然后用容器名：`pn add a.example.com http://a-web:3000 --run`。容器名在该网络里必须唯一。

如果在第二个 pn 项目里执行 `pn up`，而第一个项目的代理已经存在，`pn` 会停下并告诉你代理属于哪个项目；`pn doctor` 也会报告。把代理放在一个中立的目录（而不是某个项目里面），这样重新部署或删除某个项目都不会影响代理。迁移方法：在旧目录执行 `pn down`，复制整个目录（`ssl/certs`、`.env`、`nginx/templates`、`nginx/auth`、`sites`），在新目录执行 `pn up`，再用 `pn doctor` 检查。同一台机器上跑两个代理，需要各自独立的公网 IP，并修改 compose 文件里的端口和容器名；`pn` 不负责管理这种情况。

### 与其他服务共存及接入已有环境

**可以修改 `docker-compose.yml`，或者往里加自己的服务吗？** 可以。`pn` 只在两种情况下修改这个文件，并且始终通过 YAML 解析器，保留注释、顺序和所有它不管理的内容：

| 命令 | 修改内容 |
|---|---|
| `pn network add/remove` | `proxy-nginx` 的 `networks`，以及对应的顶层 `networks` 条目（仍被其他服务使用的条目会保留）。 |
| `pn migrate --yes` | 只补充缺失的内容：`NGINX_IMAGE` 构建参数、调优变量、`./sites` 和 `./nginx/auth` 挂载；把 `certbot/certbot` / `certbot/certbot:latest` 固定为 `CERTBOT_IMAGE`。你已经设置的值（重启策略、端口、额外挂载、自定义的 certbot 标签）不会被改动。 |

你自己的服务、端口、挂载、环境变量、volumes 和 networks 都保持原样，`pn migrate` 会保留它们（仍会把改动前的文件备份到 `.pn-backup/`）。有两个服务名必须保留：`proxy-nginx` 和 `certbot`。`pn up`/`pn restart` 只重建 `proxy-nginx`；存在其他服务时，`pn stop` 和 `pn down` 只作用于 `proxy-nginx` 和 `certbot`；`pn status` 会列出所有服务。

**数据库等非 HTTP 服务的建议**（例如 5432 端口的 TimescaleDB）：放在**独立的 compose 项目**里，不要放进代理的文件。Nginx 只代理 HTTP(S)，代理根本不需要访问数据库；你的应用直接连数据库（发布端口，或者让两者加入同一个 Docker 网络）。分开之后，`pn down`、`pn migrate` 或重建代理项目都不可能影响数据库。只有本机应用需要访问时，把端口绑定到本地：`"127.0.0.1:5432:5432"`。

**把一个服务（连同数据）从代理的 compose 文件里搬出去，且不丢数据：**

1. 记下该服务的镜像标签、环境变量和挂载。
2. 停止它：`docker compose stop <服务名>`。绑定挂载的数据目录（`./data/<名称>`）数据会留在磁盘上；而具名 volume **不会**跟着新的项目名走，需要单独复制。
3. 服务停止状态下备份数据目录（`sudo cp -a data/<名称> data/<名称>.bak`）。
4. 创建新项目（例如 `~/services/<名称>/docker-compose.yml`），使用**相同的镜像标签**、相同的环境变量，并从同一个位置挂载数据目录（用绝对路径就不需要移动任何东西）。如果其他容器按名称访问它，让它加入一个外部网络（`networks: { shared: { external: true } }`）。
5. 删除旧容器（`docker rm <container_name>`，数据在主机上不受影响），并把该服务从旧 compose 文件中删除，然后启动新项目。
6. 确认应用能连上后，再删除备份。

**接入手工搭建的代理环境。** 不要在不是 `pn init` 创建的目录里运行 `pn migrate`：它会替换生成的文件（有备份），会覆盖你自己的 `Dockerfile`、`nginx.conf` 和基础模板。正确做法是在旁边新建一个项目（`mkdir proxy-new && cd proxy-new && pn init`），用 `pn add` 重新创建站点（可用 `pn template list` 对照），复制 Let's Encrypt 数据避免重新签发（`cp -a old/ssl/certs proxy-new/ssl/certs`，如果旧环境也是 `/etc/letsencrypt` 目录结构），然后切换：停掉旧代理（占用 80/443），在新项目里 `pn up --pull`，再用 `pn doctor <域名>` 检查。回滚就是重新启动旧代理。

### 示例

```bash
# 本地试用，不对外
pn example --run && curl -H 'Host: local.example.test' http://127.0.0.1/ ; pn example --stop

# 一台服务器上的多个应用
pn add shop.example.com 127.0.0.1:3000 --www --redirect-aliases --run --cert
pn add api.example.com 127.0.0.1:4000 --max-body-size 100m --timeout 120 --run --cert
pn add admin.example.com 127.0.0.1:5000 --allow 203.0.113.0/24 --run --cert
pn auth add admin.example.com sam --run

# 静态站点和已迁移的域名
pn add docs.example.com --template static --run --cert
pn add old.example.com https://new.example.com --template redirect --run --cert
```

## 项目结构与配置

`pn init` 会创建：

```text
docker-compose.yml        proxy-nginx（Nginx）和 certbot（续期）两个服务
Dockerfile                带有下面钩子脚本的 Nginx 镜像
.env                      配置项（见下表）
.pn.json                  项目版本号，供 pn migrate 使用
nginx/
  nginx.conf              Nginx 主配置（gzip、日志）
  templates/              每个站点一个 *.conf.template，另有两个基础模板
  auth/                   基础认证用的 <域名>.htpasswd
  docker-entrypoint.d/    钩子脚本：开发用证书、定期 reload、日志轮转
ssl/
  certs/                  Let's Encrypt 数据（证书、账号、续期配置）
  www/                    ACME 验证用的 webroot
sites/                    static 和 spa 站点的文件（sites/<域名>/）
logs/                     Nginx 日志
.pn-backup/               由 pn migrate 创建（备份和清单）
```

`.env` 配置项：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `FORCE_HTTPS` | `true` | 没有单独设置 `--force-https`/`--no-force-https` 的站点是否把 HTTP 跳转到 HTTPS。 |
| `HSTS_MAX_AGE` | `31536000` | HSTS 的 max-age（秒）（在线示例使用 0）。 |
| `NGINX_IMAGE` | 固定的 `nginx:1.x` | Nginx 基础镜像。 |
| `CERTBOT_IMAGE` | 固定的 `certbot/certbot:v…` | certbot 镜像。 |
| `CERT_RELOAD_INTERVAL` | `12h` | Nginx 多久 reload 一次以加载续期后的证书。 |
| `LOG_ROTATE_SIZE_MB` | `50` | 日志超过该大小就轮转。 |
| `LOG_ROTATE_KEEP` | `5` | 保留的轮转文件数。 |

需要备份：`nginx/templates/`、`nginx/auth/`、`sites/`、`.env`、`ssl/certs/`。迁移到新服务器：复制整个项目目录，把 DNS 指向新服务器，然后 `pn up`。

## 故障排查与常见问题

- **`pn cert` 失败。** 运行 `pn doctor <域名>`。常见原因：DNS 没有指向这台服务器、防火墙或云安全组没放行 80/443、CAA 记录禁止 Let's Encrypt、有 AAAA 记录但 IPv6 到不了代理。测试时用 `--staging` 避免触发频率限制。
- **`pn add` 之后浏览器提示证书不安全。** 在 `pn cert` 成功之前这是正常的：这期间提供的是自签名证书。
- **502 Bad Gateway。** 容器访问不到上游。主机上的服务必须监听 `0.0.0.0`（而不只是 `127.0.0.1`），因为代理通过 `host.docker.internal` 访问它；同时检查端口和应用是否在运行。
- **`pn` 提示这个目录不是 pn 项目。** 该目录的 `docker-compose.yml` 里没有 `proxy-nginx` 服务。请进入你执行 `pn init` 的目录（报错信息会列出附近的项目）。`docker inspect proxy-nginx --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'` 可以直接打印出项目目录。
- **`nginx config test failed; the running proxy was not touched。** 上面会打印 Nginx 自己的错误。修改模板（`pn template edit <域名>`）后重新应用。
- **80/443 端口已被占用。** 被别的服务占用了。代理停止时 `pn doctor` 会指出这一点；用 `ss -ltnp | grep -E ':(80|443) '` 找到它。
- **WebSocket。** 开箱即用，不需要额外选项。
- **能手动修改生成的文件吗？** 站点模板、`.env`、compose 文件：可以。基础文件（`nginx.conf`、钩子脚本、Dockerfile）也可以改，但新版本改动它们时，`pn migrate` 会提议替换（并先备份）。
- **一台服务器上能给项目 A、项目 B 各建一个 pn 项目吗？** 不能：一台服务器只有一个 pn 代理，由所有项目共用。见 [一台服务器上的多个项目](#一台服务器上的多个项目)。
- **可以把自己的服务（比如数据库）放进 `docker-compose.yml` 吗？** 可以，`pn` 不会动它们，但单独一个 compose 项目更清晰。见 [与其他服务共存及接入已有环境](#与其他服务共存及接入已有环境)。
- **不用 npm 官方仓库怎么安装？** 从 GitHub：`npm install -g github:samcn26/proxy-nginx-cli`；用压缩包：在仓库里 `npm pack`，再在服务器上 `npm install -g ./proxy-nginx-cli-<版本>.tgz`；或者保留一份 git 仓库并 `npm link`，这种方式 `pn upgrade` 会用 `git pull` 更新。通过压缩包或 GitHub 安装的副本执行 `pn upgrade` 时，会去 npm 仓库找这个包，所以应该用同样的方式重新安装。
- **支持通配符证书吗？** 暂不支持（需要 DNS-01 验证）。

## Agent 技能包

`skills/proxy-nginx-cli/SKILL.md` 是一份可直接给编码 agent 使用的技能说明：包含工作流、安全规则和 certbot 故障恢复步骤。把它复制到你的 agent 技能目录（例如 `.claude/skills/proxy-nginx-cli/`）。`pn status --json` 和 `pn doctor --json` 可以给 agent 提供结构化数据。

## 开发

```bash
npm install
npm test                    # 单元测试（不需要 Docker）
./bin/pn --help
npm pack --dry-run
```

CI（`.github/workflows/ci.yml`）在 Node 18/20/22 上运行测试，并有一个集成任务：用真实 Docker 构建生成的项目，检查应用变更、无效配置时回滚、基础认证、`--pull` 和删除站点。约定见 `AGENTS.md`，变更记录见 `CHANGELOG.md`。许可证：MIT。
