const fs = require('node:fs');
const tty = require('node:tty');
const { Command } = require('commander');
const {
  addSite,
  certProject,
  createExample,
  downProject,
  initProject,
  listSiteDomains,
  logsProject,
  migrateProject,
  networkAdd,
  networkRemove,
  reloadProject,
  removeSite,
  restartProject,
  resetProject,
  statusProject,
  stopExample,
  templateEdit,
  templateList,
  stopProject,
  upProject,
  upgradeCli,
} = require('./commands');
const { version } = require('../package.json');

function createProgram() {
  const program = new Command();

  program
    .name('pn')
    .description('Proxy Nginx CLI')
    .version(version)
    .addHelpText(
      'after',
      `

Examples:
  $ pn --help
  $ pn init
  $ pn reset
  $ pn add test.example.cn -H host.docker.internal -p 6666
  $ pn add test.example.cn http://host.docker.internal:6666 --no-ssl
  $ pn add test.example.cn 127.0.0.1:3000 --run
  $ pn add test.example.cn 127.0.0.1:3000 --run --cert --email ops@example.cn
  $ pn add example.com 127.0.0.1:3000 --www --redirect-aliases
  $ pn add docs.example.com --template static
  $ pn add app.example.com --template spa
  $ pn add old.example.com https://new.example.com --template redirect
  $ pn add admin.example.com 127.0.0.1:3000 --allow 203.0.113.0/24 --max-body-size 10m
  $ pn template list
  $ pn template edit app.example.com --run
  $ pn network add app-net --run
  $ pn network remove app-net --run
  $ pn remove test.example.cn --run
  $ pn remove test.example.cn --run --purge-cert
  $ pn example
  $ pn example test.example.cn --run
  $ pn example test.example.cn --run --cert
  $ pn example --run
  $ pn example --stop
  $ pn cert test.example.cn
  $ pn cert test.example.cn --staging
  $ pn cert test.example.cn --force-renew
  $ pn up
  $ pn stop
  $ pn down
  $ pn restart
  $ pn status
  $ pn status --json
  $ pn logs
  $ pn logs --error -n 50
  $ pn logs app.example.com -f
  $ pn upgrade
  $ pn migrate
  $ pn migrate --yes --run
  $ pn reload

More commands for nginx proxy, SSL, and templates will be added incrementally.
`
    );

  program
    .command('init')
    .description('Create a proxy nginx project in the current directory')
    .action(() => {
      console.log(initProject());
    });

  program
    .command('reset')
    .description('Reset the proxy nginx project skeleton and remove added sites')
    .option('-y, --yes', 'do not ask for confirmation')
    .action((options) => {
      runCommand(() => {
        if (!options.yes && !confirmReset()) {
          return 'Aborted. No changes made.';
        }

        return resetProject();
      });
    });

  program
    .command('add')
    .description('Add a domain proxy site')
    .argument('<domain>', 'domain name to proxy')
    .argument('[target]', 'target URL or host:port (redirect template: destination URL)')
    .option('-H, --host <host>', 'upstream host')
    .option('-p, --port <port>', 'upstream port')
    .option('--no-ssl', 'generate an HTTP-only site')
    .option('--run', 'apply the site immediately')
    .option('--cert', 'request a certificate and start renewal after applying the site')
    .option('--force', 'overwrite an existing site template')
    .option('-t, --template <name>', 'site template: proxy (default), static, spa, redirect')
    .option('-a, --alias <domain>', 'additional domain for this site (repeatable)', collect, [])
    .option('--www', 'also serve www.<domain>')
    .option('--redirect-aliases', 'redirect alias domains to the main domain')
    .option('--max-body-size <size>', 'client_max_body_size, for example 10m (default 50m)')
    .option('--timeout <seconds>', 'proxy read/send timeout in seconds (default 300)')
    .option('--allow <cidr>', 'only allow this IP or CIDR (repeatable)', collect, [])
    .option('--access-log', 'write logs/<domain>.access.log for this site')
    .option('--hsts-subdomains', 'send HSTS with includeSubDomains for this site')
    .option('--email <email>', 'Let’s Encrypt account email used with --cert')
    .option('--staging', 'use the Let’s Encrypt staging environment with --cert')
    .action((domain, target, options) => {
      runCommand(() => addSite(domain, target, options));
    });

  program
    .command('up')
    .description('Build and start the proxy nginx service')
    .action(() => {
      runCommand(() => upProject());
    });

  program
    .command('stop')
    .description('Stop proxy nginx project containers without deleting them')
    .action(() => {
      runCommand(() => stopProject());
    });

  program
    .command('down')
    .description('Stop and remove proxy nginx project containers')
    .action(() => {
      runCommand(() => downProject());
    });

  program
    .command('restart')
    .description('Recreate proxy nginx so templates are regenerated')
    .action(() => {
      runCommand(() => restartProject());
    });

  program
    .command('status')
    .description('Show proxy nginx project status')
    .option('--json', 'print machine-readable JSON')
    .action((options) => {
      runCommand(() => statusProject(process.cwd(), undefined, options));
    });

  program
    .command('upgrade')
    .description('Upgrade the proxy-nginx-cli command')
    .action(() => {
      runCommand(() => upgradeCli());
    });

  program
    .command('remove')
    .description('Remove a domain proxy site')
    .argument('<domain>', 'domain name to remove')
    .option('--run', 'apply the removal immediately')
    .option('--purge-cert', 'also delete the certificate for this domain')
    .action((domain, options) => {
      runCommand(() => removeSite(domain, process.cwd(), options));
    });

  program
    .command('migrate')
    .description('Update an existing project to the files this pn version generates')
    .option('-y, --yes', 'apply the changes (default: only show them)')
    .option('--run', 'recreate proxy-nginx afterwards (with --yes)')
    .action((options) => {
      runCommand(() => migrateProject(options));
    });

  program
    .command('logs')
    .description('Show nginx logs from ./logs')
    .argument('[domain]', 'show logs/<domain>.access.log (sites added with --access-log)')
    .option('-n, --lines <count>', 'number of lines to show (default 100)')
    .option('-f, --follow', 'keep printing new lines')
    .option('--error', 'show the shared error log instead of the access log')
    .action((domain, options) => {
      runCommand(() => logsProject(domain, options));
    });

  const template = program
    .command('template')
    .description('Inspect and edit site templates');

  template
    .command('list')
    .description('List sites with their template type, target, and aliases')
    .action(() => {
      runCommand(() => templateList());
    });

  template
    .command('edit')
    .description('Edit a site template in $EDITOR and check it with nginx -t')
    .argument('<domain>', 'site domain')
    .option('--run', 'apply the edited template immediately')
    .action((domain, options) => {
      runCommand(() => templateEdit(domain, options));
    });

  const network = program
    .command('network')
    .description('Manage external Docker networks for proxy nginx');

  network
    .command('add')
    .description('Attach proxy nginx to an external Docker network')
    .argument('<name>', 'external Docker network name')
    .option('--run', 'apply the network change immediately')
    .action((name, options) => {
      runCommand(() => networkAdd(name, options));
    });

  network
    .command('remove')
    .description('Detach proxy nginx from an external Docker network')
    .argument('<name>', 'external Docker network name')
    .option('--run', 'apply the network change immediately')
    .action((name, options) => {
      runCommand(() => networkRemove(name, options));
    });

  program
    .command('example')
    .description('Create a local example project')
    .argument('[domain]', 'domain name for an online example')
    .option('--run', 'create and run the local example')
    .option('--cert', 'request a certificate after starting the domain example')
    .option('--email <email>', 'Let’s Encrypt account email used with --cert')
    .option('--staging', 'use the Let’s Encrypt staging environment with --cert')
    .option('--stop', 'stop the local example')
    .action((domain, options) => {
      runCommand(() => {
        if (options.stop) {
          return stopExample();
        }

        return createExample({ ...options, domain });
      });
    });

  program
    .command('cert')
    .description('Request a Let’s Encrypt certificate for a domain')
    .argument('<domain>', 'domain name to issue a certificate for')
    .option('--email <email>', 'Let’s Encrypt account email for account notices')
    .option('--staging', 'use the Let’s Encrypt staging environment for testing')
    .option('--force-renew', 'renew even if the current certificate is not due')
    .action((domain, options) => {
      runCommand(() => certProject(domain, undefined, undefined, undefined, options));
    });

  program
    .command('reload')
    .description('Validate and reload the running proxy nginx service')
    .action(() => {
      runCommand(() => reloadProject());
    });

  return program;
}

function collect(value, previous) {
  return [...previous, value];
}

function shouldPrintChineseHelp(argv) {
  const args = argv.slice(2);
  return args.length === 2 && args[0] === '--help' && args[1] === 'cn';
}

function chineseHelpText() {
  return `用法: pn [选项] [命令]

Nginx 反向代理 CLI

选项:
  -V, --version                    输出版本号
  -h, --help                       显示帮助

命令:
  init                             在当前目录创建 proxy nginx 项目
  reset [选项]                     重置项目骨架并删除已添加站点
  add [选项] <域名> [目标地址]     添加域名反向代理站点
  remove [选项] <域名>             删除域名反向代理站点
  example [选项] [域名]            创建本地或线上示例项目
  cert [选项] <域名>               为域名申请 Let’s Encrypt 证书
  template list                    列出站点模板类型、目标和别名
  template edit <域名>             用 $EDITOR 编辑站点模板并用 nginx -t 检查
  network add <名称>               让 proxy-nginx 加入外部 Docker network
  network remove <名称>            让 proxy-nginx 离开外部 Docker network
  up                               构建并启动 proxy nginx 服务
  stop                             停止容器但不删除
  down                             停止并删除容器
  restart                          重建 proxy-nginx，让模板重新渲染
  status [选项]                    显示项目状态（--json 输出 JSON）
  logs [选项] [域名]               查看 nginx 日志（-f 跟随，--error 错误日志）
  upgrade                          升级 pn CLI
  migrate [选项]                   把旧项目更新到当前版本生成的文件（默认只预览）
  reload                           校验并重载正在运行的 proxy nginx 服务

示例:
  $ pn --help
  $ pn --help cn
  $ pn init
  $ pn reset
  $ pn add test.example.cn -H host.docker.internal -p 6666
  $ pn add test.example.cn http://host.docker.internal:6666 --no-ssl
  $ pn add test.example.cn 127.0.0.1:3000 --run
  $ pn add test.example.cn 127.0.0.1:3000 --run --cert --email ops@example.cn
  $ pn add example.com 127.0.0.1:3000 --www --redirect-aliases
  $ pn add docs.example.com --template static
  $ pn add app.example.com --template spa
  $ pn add old.example.com https://new.example.com --template redirect
  $ pn add admin.example.com 127.0.0.1:3000 --allow 203.0.113.0/24 --max-body-size 10m
  $ pn template list
  $ pn template edit app.example.com --run
  $ pn network add app-net --run
  $ pn network remove app-net --run
  $ pn remove test.example.cn --run
  $ pn remove test.example.cn --run --purge-cert
  $ pn example
  $ pn example test.example.cn --run
  $ pn example test.example.cn --run --cert
  $ pn example --run
  $ pn example --stop
  $ pn cert test.example.cn
  $ pn cert test.example.cn --staging
  $ pn cert test.example.cn --force-renew
  $ pn up
  $ pn stop
  $ pn down
  $ pn restart
  $ pn status
  $ pn status --json
  $ pn logs
  $ pn logs --error -n 50
  $ pn logs app.example.com -f
  $ pn upgrade
  $ pn migrate
  $ pn migrate --yes --run
  $ pn reload

说明:
  add 默认生成 SSL 配置；使用 --no-ssl 只生成 HTTP 代理。
  add 默认不会覆盖已有站点模板；使用 --force 才会覆盖。
  add --run 只让配置立即生效；add --cert 才会申请 HTTPS 证书并启动续期服务。
  network add/remove 默认只修改 docker-compose.yml；加 --run 会重建 proxy-nginx。
  reload 不重启容器；restart 会重建 proxy-nginx，适合模板改动后使用。
  目标地址 127.0.0.1:端口 / localhost:端口 会自动映射为 host.docker.internal:端口。
  add/remove --run 在容器内重新渲染模板、nginx -t 校验后 reload，不重启容器；校验失败会自动回滚。
  up/restart/network --run 会重建容器，重建前先在临时容器中校验配置，无效则不动现有服务。
  add --template 支持 proxy（默认）、static、spa（读取 sites/<域名>/）、redirect（目标为跳转 URL）。
  add --alias/--www 增加别名域名，证书会覆盖所有别名；--redirect-aliases 让别名 301 到主域名。
  add --max-body-size/--timeout/--allow/--access-log 调整单个站点（allow 可重复，限制来源 IP）。
  migrate 只预览变更；--yes 才会写入并备份到 .pn-backup/，站点模板不会被改动；--run 同时重建容器。
  logs 查看 logs/ 下的日志；日志按大小自动轮转（LOG_ROTATE_SIZE_MB，默认 50MB，保留 5 份）。
  remove --purge-cert 同时删除该域名的证书。
  reset 在终端中会先确认；-y/--yes 跳过确认。
  HSTS 默认不带 includeSubDomains；站点是主域名且所有子域都走 HTTPS 时，用 add --hsts-subdomains 开启。
  cert --force-renew 强制续期；从 --staging 换到正式环境会自动强制续期。申请时会临时暂停续期服务以避免 certbot 锁冲突。
  cert 需要域名 DNS 指向当前服务器，且 80/443 已放行。
  cert/add --cert 可加 --email 登记账号邮箱；加 --staging 用测试环境，避免触发正式环境频率限制。
  certbot 服务每 12 小时续期；新初始化项目的 proxy-nginx 会定期 reload 以加载续期后的证书。
  up/reload 优先使用 docker-compose，不可用时回退到 docker compose。
`;
}

// Only guards interactive use; scripts (no TTY) keep the previous behavior.
function confirmReset() {
  // tty.isatty() does not touch process.stdin, which would make fd 0 non-blocking.
  if (!tty.isatty(0)) {
    return true;
  }

  const sites = listSiteDomains(process.cwd());
  if (sites.length === 0) {
    return true;
  }

  process.stdout.write(`This removes ${sites.length} site template(s):\n${sites.map((site) => `  - ${site}`).join('\n')}\nContinue? [y/N] `);
  const buffer = Buffer.alloc(256);
  for (;;) {
    try {
      const length = fs.readSync(0, buffer, 0, buffer.length, null);
      return /^y(es)?$/i.test(buffer.toString('utf8', 0, length).trim());
    } catch (error) {
      if (error.code !== 'EAGAIN') {
        return false;
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function runCommand(command) {
  try {
    console.log(command());
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

function run(argv = process.argv) {
  if (shouldPrintChineseHelp(argv)) {
    console.log(chineseHelpText());
    return;
  }

  createProgram().parse(argv);
}

if (require.main === module) {
  run();
}

module.exports = {
  createProgram,
  run,
  chineseHelpText,
  shouldPrintChineseHelp,
};
