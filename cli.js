'use strict';

const {
  getDefaultAsarPath,
  getPatchStatus,
  installPatch,
  uninstallPatch
} = require('./src/patcher');

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = 'status';
  let asarPath = getDefaultAsarPath();
  let kill = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'install' || a === 'uninstall' || a === 'status' || a === 'help' || a === '--help' || a === '-h') {
      command = a.replace(/^-+/, '');
    } else if (a === '--asar' && i + 1 < args.length) {
      asarPath = args[++i];
    } else if (a === '--kill') {
      kill = true;
    }
  }
  return { command, asarPath, kill };
}

function printStatus(status) {
  console.log('=== Antigravity Desktop File Actions 状态 ===');
  console.log(`目标 app.asar : ${status.asarPath}`);
  console.log(`文件存在      : ${status.exists ? '是' : '否'}`);
  console.log(`原始备份存在  : ${status.backupExists ? '是' : '否'}`);
  console.log(`桌面端运行中  : ${status.running ? '是' : '否'}`);
  console.log(`主进程补丁    : ${status.mainPatched ? '已安装' : '未安装'}`);
  console.log(`预加载补丁    : ${status.preloadPatched ? '已安装' : '未安装'}`);
  console.log(`内置模块完整  : ${status.hasAfaMain ? '是' : '否'}`);
  console.log(`补丁版本最新  : ${status.versionCurrent ? '是' : '否'}`);
  console.log(`总体状态      : ${status.installed ? '已启用' : '未启用'}`);
}

function main() {
  const { command, asarPath, kill } = parseArgs(process.argv);

  if (command === 'help' || command === 'h') {
    console.log([
      '用法: node cli.js <command> [options]',
      '',
      'Commands:',
      '  install     安装/更新 Antigravity 桌面端右键文件操作补丁',
      '  uninstall   卸载补丁并从 app.asar.afa-backup 恢复原始文件',
      '  status      查看当前补丁安装状态（默认）',
      '',
      'Options:',
      '  --asar <path>   指定自定义 app.asar 路径',
      '  --kill          执行前自动结束运行中的 Antigravity.exe 进程'
    ].join('\n'));
    return;
  }

  try {
    if (command === 'status') {
      printStatus(getPatchStatus(asarPath));
      return;
    }

    if (command === 'install') {
      const status = installPatch(asarPath, { kill });
      console.log('补丁安装成功！');
      printStatus(status);
      console.log('\n请重新启动 Antigravity 桌面端使其生效。');
      return;
    }

    if (command === 'uninstall') {
      const status = uninstallPatch(asarPath, { kill });
      console.log('补丁已卸载，已恢复原始 app.asar。');
      printStatus(status);
      console.log('\n请重新启动 Antigravity 桌面端使其生效。');
      return;
    }

    console.error(`未知命令: ${command}`);
    process.exitCode = 1;
  } catch (err) {
    console.error(`操作失败: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
