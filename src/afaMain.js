'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const DANGEROUS_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse',
  '.wsf', '.msi', '.scr', '.hta', '.com', '.pif', '.reg', '.msc', '.jar'
]);

const registeredWorkspaces = new Set();

// -----------------------------------------------------------------------------
// 1. Path Normalization & Workspace Resolution
// -----------------------------------------------------------------------------
function stripLineAndColSuffix(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  // Preserve full path if it literally exists on disk with # in filename
  try {
    if (/^[a-zA-Z]:[\\/]/.test(s) && fs.existsSync(s)) return s;
  } catch (_) { }
  s = s.replace(/#(?:L?\d+(?:[-:–]L?\d+)?|\d+)$/i, '');
  s = s.replace(/\?[^\\/\r\n]+$/, '');
  const match = /^(.*?)((?::\d+){1,2})$/.exec(s);
  if (match && match[1].length > 2) {
    s = match[1];
  }
  const parenMatch = /^(.*?\.[a-zA-Z0-9]{1,10})\(\d+(?:,\s*\d+)?\)$/.exec(s);
  if (parenMatch) {
    s = parenMatch[1];
  }
  return s.trim();
}

function getAllWorkspaceRoots(extraHints = []) {
  const roots = [];
  const addRoot = (p) => {
    if (!p || typeof p !== 'string') return;
    const norm = path.win32.normalize(p.trim());
    if (norm && !roots.some(r => r.toLowerCase() === norm.toLowerCase())) {
      roots.push(norm);
    }
  };

  for (const h of extraHints) addRoot(h);
  for (const reg of registeredWorkspaces) addRoot(reg);

  const defaultScratch = path.win32.join(os.homedir(), '.gemini', 'antigravity', 'scratch');
  try {
    if (fs.existsSync(defaultScratch)) addRoot(defaultScratch);
  } catch (_) { }

  return roots;
}

function resolveToWindowsPath(rawInput, extraHints = []) {
  if (typeof rawInput !== 'string') return undefined;
  let s = rawInput.trim();
  if (!s) return undefined;

  s = s.replace(/^`+|`+$/g, '').replace(/^['"]+|['"]+$/g, '').trim();
  const md = /^\[[^\]]*\]\((.+)\)$/.exec(s);
  if (md) s = md[1].trim().replace(/^<|>$/g, '');

  if (/^file:\/\//i.test(s)) {
    const strippedUri = s.replace(/#(?:L?\d+(?:[-:–]L?\d+)?|\d+)$/i, '');
    let p = strippedUri.replace(/^file:\/\/\/?/i, '');
    try {
      p = decodeURIComponent(p);
    } catch (_) {
      p = p.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
        try { return decodeURIComponent(m); } catch (__) { return m; }
      });
    }
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    s = p;
  }

  s = stripLineAndColSuffix(s);
  if (!s) return undefined;

  // Absolute Windows drive path or UNC path
  if (/^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s)) {
    let norm = path.win32.normalize(s);
    if (/^[a-z]:\\/.test(norm)) {
      norm = norm[0].toUpperCase() + norm.slice(1);
    }
    return norm;
  }

  // Relative path resolution against known workspace roots
  const roots = getAllWorkspaceRoots(extraHints);
  for (const root of roots) {
    const candidate = path.win32.resolve(root, s);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { }
  }

  // Check 1st-level subdirectories of workspace roots for bare/sub-project paths
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const candidate = path.win32.resolve(root, entry.name, s);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (_) { }
  }

  if (roots.length > 0) {
    return path.win32.resolve(roots[0], s);
  }
  return path.win32.normalize(s);
}

function inspectPathStatus(rawInput, extraHints = []) {
  const resolvedPath = resolveToWindowsPath(rawInput, extraHints);
  if (!resolvedPath) {
    return { ok: false, exists: false, resolvedPath: '' };
  }
  let exists = false;
  let isDirectory = false;
  try {
    const stat = fs.statSync(resolvedPath);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch (_) { }
  const ext = path.extname(resolvedPath).toLowerCase();
  const isDangerous = DANGEROUS_EXTS.has(ext);
  return {
    ok: true,
    exists,
    isDirectory,
    isDangerous,
    resolvedPath
  };
}

// -----------------------------------------------------------------------------
// 2. OS File Operations (Windows 10/11)
// -----------------------------------------------------------------------------
const STRIPPED_ENV_EXACT = new Set([
  'CHROME_CRASHPAD_PIPE_NAME',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  'ORIGINAL_XDG_CURRENT_DESKTOP'
]);

const STRIPPED_ENV_PREFIXES = [
  'ELECTRON_',
  'VSCODE_',
  'ANTIGRAVITY_'
];

function buildCleanExternalEnv(baseEnv = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (STRIPPED_ENV_EXACT.has(upper)) continue;
    if (STRIPPED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) continue;
    clean[key] = value;
  }
  return clean;
}

function execPowerShellEncoded(psScript) {
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, env: buildCleanExternalEnv() },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = (stderr || '').trim();
        reject(detail ? new Error(detail) : error);
      }
    );
  });
}

async function defaultOpen(file, options = {}, electronMod = null) {
  if (process.platform !== 'win32') {
    throw new Error('当前插件仅支持 Windows 10/11。');
  }
  const normalized = path.win32.normalize(file);
  const ext = path.extname(normalized).toLowerCase();

  if (DANGEROUS_EXTS.has(ext) && !options.confirmed) {
    if (electronMod?.dialog) {
      const parentWin = electronMod.BrowserWindow?.getFocusedWindow?.() || undefined;
      const result = await electronMod.dialog.showMessageBox(parentWin, {
        type: 'warning',
        buttons: ['取消', '继续打开'],
        defaultId: 0,
        cancelId: 0,
        title: '安全确认：可执行文件或脚本',
        message: `打开 ${path.basename(normalized)} 可能直接运行程序或脚本。`,
        detail: `路径：${normalized}\n确定要继续使用系统默认程序打开吗？`
      });
      if (result.response !== 1) {
        const err = new Error('用户已取消打开可执行文件');
        err.cancelled = true;
        throw err;
      }
    } else {
      const err = new Error('需要安全确认后才能打开可执行文件');
      err.cancelled = true;
      throw err;
    }
  }

  const escaped = normalized.replace(/'/g, "''");
  const workDir = path.dirname(normalized).replace(/'/g, "''");
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `$psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `$psi.FileName = '${escaped}'`,
    `$psi.WorkingDirectory = '${workDir}'`,
    `$psi.UseShellExecute = $true`,
    `[System.Diagnostics.Process]::Start($psi) | Out-Null`
  ].join('; ');
  await execPowerShellEncoded(ps);
}

async function revealInExplorer(file, electronMod = null) {
  if (process.platform !== 'win32') {
    throw new Error('当前插件仅支持 Windows 10/11。');
  }
  const normalized = path.win32.normalize(file);
  const stat = await fs.promises.stat(normalized);

  if (!stat.isDirectory() && electronMod?.shell?.showItemInFolder) {
    try {
      electronMod.shell.showItemInFolder(normalized);
      return;
    } catch (_) { }
  }

  await new Promise((resolve, reject) => {
    const args = stat.isDirectory() ? [`"${normalized}"`] : [`/select,"${normalized}"`];
    const child = spawn('explorer.exe', args, {
      windowsVerbatimArguments: true,
      windowsHide: false,
      env: buildCleanExternalEnv()
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
}

function copyAbsolutePath(file, electronMod = null) {
  const normalized = path.win32.normalize(file);
  if (electronMod?.clipboard?.writeText) {
    electronMod.clipboard.writeText(normalized);
  }
  return normalized;
}

// -----------------------------------------------------------------------------
// 3. Electron IPC Registration (Main Process)
// -----------------------------------------------------------------------------
function registerHints(hints) {
  if (!Array.isArray(hints)) return;
  for (const h of hints) {
    if (typeof h === 'string' && h.trim()) {
      registeredWorkspaces.add(path.win32.normalize(h.trim()));
    }
  }
}

function registerAfaIpcHandlers() {
  if (globalThis.__AFA_DESKTOP_MAIN_INSTALLED__) return;
  globalThis.__AFA_DESKTOP_MAIN_INSTALLED__ = true;

  const electron = require('electron');
  const { ipcMain } = electron;

  ipcMain.on('afa:resolve-sync', (event, payload = {}) => {
    try {
      registerHints(payload.workspaceHints);
      event.returnValue = inspectPathStatus(payload.rawPath || '', payload.workspaceHints);
    } catch (err) {
      event.returnValue = { ok: false, exists: false, resolvedPath: '', error: err?.message || String(err) };
    }
  });

  ipcMain.handle('afa:resolve', async (_event, payload = {}) => {
    try {
      registerHints(payload.workspaceHints);
      return inspectPathStatus(payload.rawPath || '', payload.workspaceHints);
    } catch (err) {
      return { ok: false, exists: false, resolvedPath: '', error: err?.message || String(err) };
    }
  });

  ipcMain.handle('afa:ping', async (_event, payload = {}) => {
    registerHints(payload.workspaceHints);
    return { ok: true };
  });

  ipcMain.handle('afa:action', async (_event, payload = {}) => {
    try {
      registerHints(payload.workspaceHints);
      const action = payload.action;
      const status = inspectPathStatus(payload.rawPath || payload.resolvedPath || '', payload.workspaceHints);
      if (!status.ok || !status.resolvedPath) {
        return { ok: false, error: '无法解析有效的文件路径' };
      }

      if (action === 'copyPath') {
        copyAbsolutePath(status.resolvedPath, electron);
        return { ok: true, resolvedPath: status.resolvedPath };
      }

      if (!status.exists) {
        return { ok: false, error: `文件不存在：${status.resolvedPath}`, resolvedPath: status.resolvedPath };
      }

      if (action === 'open') {
        await defaultOpen(status.resolvedPath, { confirmed: Boolean(payload.confirmed) }, electron);
        return { ok: true, resolvedPath: status.resolvedPath };
      }

      if (action === 'reveal') {
        await revealInExplorer(status.resolvedPath, electron);
        return { ok: true, resolvedPath: status.resolvedPath };
      }

      return { ok: false, error: `未知操作: ${action}` };
    } catch (err) {
      if (err && err.cancelled) {
        return { ok: false, cancelled: true };
      }
      return { ok: false, error: err ? err.message : String(err) };
    }
  });
}

module.exports = {
  registerAfaIpcHandlers,
  resolveToWindowsPath,
  inspectPathStatus,
  buildCleanExternalEnv,
  stripLineAndColSuffix,
  getAllWorkspaceRoots,
  defaultOpen,
  revealInExplorer,
  copyAbsolutePath,
  DANGEROUS_EXTS
};
