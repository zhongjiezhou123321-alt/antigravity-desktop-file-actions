'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const afaMain = require('../src/afaMain');
const { readAsar, computeIntegrity } = require('../src/asar');
const {
  getDefaultAsarPath,
  getPatchStatus,
  installPatch,
  uninstallPatch
} = require('../src/patcher');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function countUnpacked(node) {
  let count = 0;
  for (const entry of Object.values(node.files || {})) {
    if (entry.files) {
      count += countUnpacked(entry);
    } else if (entry.unpacked) {
      count++;
    }
  }
  return count;
}

function runUnitTests() {
  console.log('1. 运行路径解析与环境隔离单元测试...');

  // stripLineAndColSuffix
  assert.strictEqual(afaMain.stripLineAndColSuffix('C:\\test\\a.js#L10-L20'), 'C:\\test\\a.js');
  assert.strictEqual(afaMain.stripLineAndColSuffix('C:\\test\\a.js:12:4'), 'C:\\test\\a.js');
  assert.strictEqual(afaMain.stripLineAndColSuffix('C:\\test\\a.ts(10,5)'), 'C:\\test\\a.ts');

  // resolveToWindowsPath
  assert.strictEqual(
    afaMain.resolveToWindowsPath('file:///c:/Users/a/demo%20file/中文.md#L10-L20'),
    'C:\\Users\\a\\demo file\\中文.md'
  );
  assert.strictEqual(
    afaMain.resolveToWindowsPath('`g:/workspace/proj/README.md`'),
    'G:\\workspace\\proj\\README.md'
  );
  assert.strictEqual(
    afaMain.resolveToWindowsPath('\\\\server\\share\\folder\\test.txt'),
    '\\\\server\\share\\folder\\test.txt'
  );
  assert.strictEqual(
    afaMain.resolveToWindowsPath('[link](file:///D:/a%20(1)/test%2520.txt)'),
    'D:\\a (1)\\test%20.txt'
  );

  // Relative path resolution against current project
  const projectRoot = path.resolve(__dirname, '..');
  const relResolved = afaMain.resolveToWindowsPath('src/afaMain.js', [projectRoot]);
  assert.strictEqual(relResolved, path.win32.join(projectRoot, 'src', 'afaMain.js'));
  const relStatus = afaMain.inspectPathStatus('src/afaMain.js', [projectRoot]);
  assert.strictEqual(relStatus.ok, true);
  assert.strictEqual(relStatus.exists, true);
  assert.strictEqual(relStatus.isDangerous, true); // .js is in DANGEROUS_EXTS

  // Dangerous extensions
  for (const ext of ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.msi', '.reg']) {
    assert.ok(afaMain.DANGEROUS_EXTS.has(ext), `Missing dangerous ext: ${ext}`);
  }

  // Clean external env
  const dirtyEnv = {
    PATH: 'C:\\Windows\\System32',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: 'true',
    VSCODE_IPC_HOOK: '\\\\.\\pipe\\test',
    ANTIGRAVITY_FOO: 'bar',
    NODE_OPTIONS: '--inspect',
    CHROME_CRASHPAD_PIPE_NAME: 'pipe'
  };
  const cleanEnv = afaMain.buildCleanExternalEnv(dirtyEnv);
  assert.strictEqual(cleanEnv.PATH, 'C:\\Windows\\System32');
  assert.strictEqual('ELECTRON_RUN_AS_NODE' in cleanEnv, false);
  assert.strictEqual('ELECTRON_NO_ATTACH_CONSOLE' in cleanEnv, false);
  assert.strictEqual('VSCODE_IPC_HOOK' in cleanEnv, false);
  assert.strictEqual('ANTIGRAVITY_FOO' in cleanEnv, false);
  assert.strictEqual('NODE_OPTIONS' in cleanEnv, false);
  assert.strictEqual('CHROME_CRASHPAD_PIPE_NAME' in cleanEnv, false);

  // Syntax check for injected modules
  const afaMainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'afaMain.js'), 'utf8');
  const afaRendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'afaRenderer.js'), 'utf8');
  new Function('require', 'module', 'exports', '__dirname', '__filename', afaMainSrc);
  new Function('require', 'module', 'exports', '__dirname', '__filename', afaRendererSrc);

  console.log('   单元测试通过！');
}

function runAsarRoundTripTest() {
  const realAsarPath = getDefaultAsarPath();
  if (!fs.existsSync(realAsarPath)) {
    console.log(`2. 跳过 ASAR 往返测试（未找到 ${realAsarPath}）`);
    return;
  }

  console.log('2. 运行临时副本 ASAR 安装/幂等/卸载往返测试（不修改真实 app.asar）...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afa-desktop-test-'));
  const tmpAsar = path.join(tmpDir, 'app.asar');

  try {
    const realBackupPath = `${realAsarPath}.afa-backup`;
    const sourceAsar = fs.existsSync(realBackupPath) ? realBackupPath : realAsarPath;
    fs.copyFileSync(sourceAsar, tmpAsar);
    const origHash = sha256File(tmpAsar);
    const origAsar = readAsar(tmpAsar);
    const origUnpackedCount = countUnpacked(origAsar.header);

    // Install patch
    const st1 = installPatch(tmpAsar);
    assert.strictEqual(st1.installed, true);
    assert.strictEqual(st1.versionCurrent, true);
    assert.strictEqual(st1.backupExists, true);
    assert.strictEqual(st1.mainPatched, true);
    assert.strictEqual(st1.preloadPatched, true);
    assert.strictEqual(st1.hasAfaMain, true);

    // Validate patched JS syntax, inlined sandbox-safe preload, unpacked count, and integrity hashes
    const patchedAsar = readAsar(tmpAsar);
    assert.strictEqual(countUnpacked(patchedAsar.header), origUnpackedCount);
    assert.strictEqual(patchedAsar.hasFile('dist/afaRenderer.js'), false);

    const preloadSrc = patchedAsar.readFileUtf8('dist/preload.js');
    assert.strictEqual(preloadSrc.includes("require('./afaRenderer')"), false);
    assert.strictEqual(preloadSrc.includes('installAfaDesktopRenderer'), true);

    for (const rel of ['dist/main.js', 'dist/preload.js', 'dist/afaMain.js']) {
      const buf = patchedAsar.readFileBuffer(rel);
      const entry = patchedAsar.getEntry(rel);
      const expectedIntegrity = computeIntegrity(buf);
      assert.deepStrictEqual(entry.integrity, expectedIntegrity, `Integrity mismatch for ${rel}`);
      new Function('require', 'module', 'exports', '__dirname', '__filename', buf.toString('utf8'));
    }

    // Idempotent re-install
    const st2 = installPatch(tmpAsar);
    assert.strictEqual(st2.installed, true);
    assert.strictEqual(st2.versionCurrent, true);

    // Uninstall and verify byte-for-byte restoration
    const st3 = uninstallPatch(tmpAsar);
    assert.strictEqual(st3.installed, false);
    assert.strictEqual(st3.backupExists, false);
    const restoredHash = sha256File(tmpAsar);
    assert.strictEqual(restoredHash, origHash, 'Restored ASAR SHA-256 does not match original');

    console.log(`   ASAR 往返测试通过！（保留 unpacked 文件数: ${origUnpackedCount}，恢复后 SHA-256 完全一致）`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runUnitTests();
runAsarRoundTripTest();
console.log('全部测试通过！');
