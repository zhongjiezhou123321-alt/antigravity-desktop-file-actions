'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readAsar, patchAsar } = require('./asar');

const PATCH_START_MARKER = '/* __ANTIGRAVITY_FILE_ACTIONS_DESKTOP_START__ */';
const PATCH_END_MARKER = '/* __ANTIGRAVITY_FILE_ACTIONS_DESKTOP_END__ */';
const PATCH_VERSION_MARKER = '/* __AFA_DESKTOP_V2__ */';
const BACKUP_SUFFIX = '.afa-backup';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getDefaultAsarPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app.asar');
}

function isAntigravityRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return /Antigravity\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

function killAntigravityProcesses() {
  if (process.platform !== 'win32') return;
  try {
    execSync('taskkill /F /IM Antigravity.exe', { stdio: 'ignore' });
  } catch (_) { }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!isAntigravityRunning()) {
      sleepSync(400);
      return;
    }
    sleepSync(250);
  }
}

function getPatchStatus(asarPath = getDefaultAsarPath()) {
  const backupPath = `${asarPath}${BACKUP_SUFFIX}`;
  const exists = fs.existsSync(asarPath);
  const backupExists = fs.existsSync(backupPath);
  const running = isAntigravityRunning();

  if (!exists) {
    return {
      asarPath,
      backupPath,
      exists: false,
      backupExists,
      running,
      mainPatched: false,
      preloadPatched: false,
      versionCurrent: false,
      hasAfaMain: false,
      hasAfaRenderer: false,
      installed: false
    };
  }

  const asar = readAsar(asarPath);
  const mainJs = asar.hasFile('dist/main.js') ? asar.readFileUtf8('dist/main.js') : '';
  const preloadJs = asar.hasFile('dist/preload.js') ? asar.readFileUtf8('dist/preload.js') : '';

  const mainPatched = mainJs.includes(PATCH_START_MARKER);
  const preloadPatched = preloadJs.includes(PATCH_START_MARKER);
  const versionCurrent = mainJs.includes(PATCH_VERSION_MARKER) && preloadJs.includes(PATCH_VERSION_MARKER);
  const hasAfaMain = asar.hasFile('dist/afaMain.js');

  return {
    asarPath,
    backupPath,
    exists: true,
    backupExists,
    running,
    mainPatched,
    preloadPatched,
    versionCurrent,
    hasAfaMain,
    installed: mainPatched && preloadPatched && hasAfaMain && versionCurrent
  };
}

function buildMainSnippet() {
  return `\n${PATCH_START_MARKER}\n${PATCH_VERSION_MARKER}\ntry { require('./afaMain').registerAfaIpcHandlers(); } catch (err) { console.error('[AntigravityFileActions]', err); }\n${PATCH_END_MARKER}\n`;
}

function buildPreloadSnippet(afaRendererCode) {
  const inlineBody = afaRendererCode
    .replace(/^\s*['"]use strict['"];\s*/m, '')
    .replace(/if\s*\(\s*typeof module\s*!==\s*['"]undefined['"]\s*&&\s*module\.exports\s*\)\s*\{[\s\S]*?\}\s*$/m, '')
    .trim();
  return `\n${PATCH_START_MARKER}\n${PATCH_VERSION_MARKER}\ntry {\n  if (typeof isRemoteWindow === 'undefined' || !isRemoteWindow) {\n    (function() {\n${inlineBody}\n      installAfaDesktopRenderer();\n    })();\n  }\n} catch (err) {\n  console.error('[AntigravityFileActions]', err);\n}\n${PATCH_END_MARKER}\n`;
}

function stripExistingPatch(code) {
  const re = new RegExp(`\\n?\\/\\* __ANTIGRAVITY_FILE_ACTIONS_DESKTOP_START__ \\*\\/[\\s\\S]*?\\/\\* __ANTIGRAVITY_FILE_ACTIONS_DESKTOP_END__ \\*\\/\\n?`, 'g');
  return code.replace(re, '');
}

function installPatch(asarPath = getDefaultAsarPath(), options = {}) {
  if (!fs.existsSync(asarPath)) {
    throw new Error(`找不到 Antigravity Desktop 的 app.asar：${asarPath}`);
  }

  if (options.kill && isAntigravityRunning()) {
    killAntigravityProcesses();
  }

  const backupPath = `${asarPath}${BACKUP_SUFFIX}`;
  const currentAsar = readAsar(asarPath);
  if (!currentAsar.hasFile('dist/main.js') || !currentAsar.hasFile('dist/preload.js')) {
    throw new Error(`app.asar 结构不符合预期，缺少 dist/main.js 或 dist/preload.js：${asarPath}`);
  }

  const currentMain = currentAsar.readFileUtf8('dist/main.js');
  const isCurrentlyPatched = currentMain.includes(PATCH_START_MARKER);

  // If current app.asar is unpatched (e.g., fresh install or after Antigravity auto-update), refresh backup
  if (!isCurrentlyPatched) {
    fs.copyFileSync(asarPath, backupPath);
  } else if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(asarPath, backupPath);
  }

  const basePath = fs.existsSync(backupPath) ? backupPath : asarPath;
  const baseAsar = readAsar(basePath);

  const cleanMain = stripExistingPatch(baseAsar.readFileUtf8('dist/main.js'));
  const cleanPreload = stripExistingPatch(baseAsar.readFileUtf8('dist/preload.js'));

  const afaMainCode = fs.readFileSync(path.join(__dirname, 'afaMain.js'), 'utf8');
  const afaRendererCode = fs.readFileSync(path.join(__dirname, 'afaRenderer.js'), 'utf8');

  try {
    patchAsar(basePath, asarPath, {
      'dist/main.js': cleanMain + buildMainSnippet(),
      'dist/preload.js': cleanPreload + buildPreloadSnippet(afaRendererCode),
      'dist/afaMain.js': afaMainCode,
      'dist/afaRenderer.js': null
    });
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      throw new Error('无法写入 app.asar（文件正在被 Antigravity 桌面端占用）。请先完全退出 Antigravity 桌面端，或使用 --kill 参数重试。');
    }
    throw err;
  }

  return getPatchStatus(asarPath);
}

function uninstallPatch(asarPath = getDefaultAsarPath(), options = {}) {
  const backupPath = `${asarPath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backupPath)) {
    throw new Error(`找不到原始备份文件：${backupPath}`);
  }

  if (options.kill && isAntigravityRunning()) {
    killAntigravityProcesses();
  }

  try {
    fs.copyFileSync(backupPath, asarPath);
    fs.unlinkSync(backupPath);
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      throw new Error('无法恢复 app.asar（文件正在被 Antigravity 桌面端占用）。请先完全退出 Antigravity 桌面端，或使用 --kill 参数重试。');
    }
    throw err;
  }

  return getPatchStatus(asarPath);
}

module.exports = {
  getDefaultAsarPath,
  isAntigravityRunning,
  killAntigravityProcesses,
  getPatchStatus,
  installPatch,
  uninstallPatch,
  PATCH_START_MARKER,
  PATCH_END_MARKER,
  PATCH_VERSION_MARKER
};
