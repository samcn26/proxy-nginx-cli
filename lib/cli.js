const { Command } = require('commander');
const {
  addSite,
  certProject,
  createExample,
  initProject,
  reloadProject,
  removeSite,
  resetProject,
  stopExample,
  upProject,
} = require('./commands');

function createProgram() {
  const program = new Command();

  program
    .name('pn')
    .description('Proxy Nginx CLI')
    .version('0.0.1')
    .addHelpText(
      'after',
      `

Examples:
  $ pn --help
  $ pn init
  $ pn reset
  $ pn add test.example.cn -H host.docker.internal -p 6666
  $ pn add test.example.cn http://host.docker.internal:6666 --no-ssl
  $ pn remove test.example.cn
  $ pn example
  $ pn example test.example.cn --run
  $ pn example test.example.cn --run --cert
  $ pn example --run
  $ pn example --stop
  $ pn cert test.example.cn
  $ pn up
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
    .action(() => {
      runCommand(() => resetProject());
    });

  program
    .command('add')
    .description('Add a domain proxy site')
    .argument('<domain>', 'domain name to proxy')
    .argument('[target]', 'target URL, for example http://host.docker.internal:6666')
    .option('-H, --host <host>', 'upstream host')
    .option('-p, --port <port>', 'upstream port')
    .option('--no-ssl', 'generate an HTTP-only site')
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
    .command('remove')
    .description('Remove a domain proxy site')
    .argument('<domain>', 'domain name to remove')
    .action((domain) => {
      runCommand(() => removeSite(domain));
    });

  program
    .command('example')
    .description('Create a local example project')
    .argument('[domain]', 'domain name for an online example')
    .option('--run', 'create and run the local example')
    .option('--cert', 'request a certificate after starting the domain example')
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
    .action((domain) => {
      runCommand(() => certProject(domain));
    });

  program
    .command('reload')
    .description('Validate and reload the running proxy nginx service')
    .action(() => {
      runCommand(() => reloadProject());
    });

  return program;
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
  reset                            重置项目骨架并删除已添加站点
  add [选项] <域名> [目标地址]     添加域名反向代理站点
  remove <域名>                    删除域名反向代理站点
  example [选项] [域名]            创建本地或线上示例项目
  cert <域名>                      为域名申请 Let’s Encrypt 证书
  up                               构建并启动 proxy nginx 服务
  reload                           校验并重载正在运行的 proxy nginx 服务

示例:
  $ pn --help
  $ pn --help cn
  $ pn init
  $ pn reset
  $ pn add test.example.cn -H host.docker.internal -p 6666
  $ pn add test.example.cn http://host.docker.internal:6666 --no-ssl
  $ pn remove test.example.cn
  $ pn example
  $ pn example test.example.cn --run
  $ pn example test.example.cn --run --cert
  $ pn example --run
  $ pn example --stop
  $ pn cert test.example.cn
  $ pn up
  $ pn reload

说明:
  add 默认生成 SSL 配置；使用 --no-ssl 只生成 HTTP 代理。
  cert 需要域名 DNS 指向当前服务器，且 80/443 已放行。
  up/reload 使用 docker-compose。
`;
}

function runCommand(command) {
  try {
    console.log(command());
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  if (shouldPrintChineseHelp(process.argv)) {
    console.log(chineseHelpText());
    process.exit(0);
  }

  createProgram().parse();
}

module.exports = {
  createProgram,
  chineseHelpText,
  shouldPrintChineseHelp,
};
