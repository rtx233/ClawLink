const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { serverFiles, documents } = require('./package-files.cjs');
const { writeIcons } = require('./windows-icon.cjs');
const { version } = require('../package.json');
const root = path.resolve(__dirname, '..');
function node(script, args = [], cwd = root) { execFileSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' }); }
function npm(args, cwd = root) {
  if (!process.env.npm_execpath) throw new Error('请使用 npm run release:windows 构建');
  node(process.env.npm_execpath, args, cwd);
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上构建；GitHub Actions 提供 Windows 构建环境');
  const release = path.join(root, 'release'); fs.mkdirSync(release, { recursive: true });
  const work = fs.mkdtempSync(path.join(release, '.windows-build-'));
  try {
    npm(['run', 'check']); npm(['test']); npm(['run', 'build']); npm(['run', 'native:build']);
    const code = path.join(work, 'service'), runtime = path.join(work, 'runtime'), icons = path.join(work, 'icons');
    for (const dir of [path.join(code, 'server'), path.join(code, 'native'), runtime]) fs.mkdirSync(dir, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, file), path.join(code, file));
    for (const file of serverFiles) fs.copyFileSync(path.join(root, 'server', file), path.join(code, 'server', file));
    fs.copyFileSync(path.join(root, 'native/ClawLinkBridge.exe'), path.join(code, 'native/ClawLinkBridge.exe'));
    fs.cpSync(path.join(root, 'dist'), path.join(code, 'public'), { recursive: true });
    npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], code);
    fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
    const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(20000) });
    if (!license.ok) throw new Error('无法获取对应 Node 版本的许可证');
    fs.writeFileSync(path.join(runtime, 'LICENSE'), await license.text());
    writeIcons(icons);
    const notices = path.join(work, 'notices'); fs.mkdirSync(notices);
    for (const file of documents) fs.copyFileSync(path.join(root, file), path.join(notices, file));
    fs.writeFileSync(path.join(notices, 'THIRD_PARTY_NOTICES.txt'), `ClawLink includes Electron (LICENSE.electron.txt / LICENSES.chromium.html), Node.js ${process.version} (runtime/LICENSE), QRCode, the Feishu Node SDK, Discord.js and their npm dependencies (service/node_modules licenses).\n`);
    const config = {
      appId: 'dev.clawlink.app', productName: 'ClawLink', electronVersion: require('electron/package.json').version,
      extraMetadata: { main: 'windows/main.cjs' }, asar: true, npmRebuild: false,
      directories: { output: release, buildResources: icons },
      files: ['windows/main.cjs', 'windows/preload.cjs', 'package.json'],
      extraResources: [{ from: code, to: 'service' }, { from: runtime, to: 'runtime' }, { from: icons, to: 'icons' }, { from: notices, to: 'notices' }],
      win: { icon: path.join(icons, 'ClawLink.ico'), target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], artifactName: `ClawLink-${version}-Windows-\${arch}.\${ext}` },
      nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, artifactName: `ClawLink-${version}-Windows-\${arch}-setup.\${ext}` }
    };
    const configFile = path.join(work, 'builder.json'); fs.writeFileSync(configFile, JSON.stringify(config));
    node(require.resolve('electron-builder/cli.js'), ['--config', configFile, '--win', '--x64', '--publish', 'never']);
    const artifacts = [`ClawLink-${version}-Windows-x64.zip`, `ClawLink-${version}-Windows-x64-setup.exe`];
    const checksums = {};
    for (const file of artifacts) {
      checksums[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(release, file))).digest('hex');
      fs.writeFileSync(path.join(release, `${file}.sha256`), `${checksums[file]}  ${file}\n`);
    }
    fs.writeFileSync(path.join(release, 'manifest-windows.json'), JSON.stringify({ version, platform: 'win32', architecture: 'x64', minimumWindows: '10', node: process.version, electron: config.electronVersion, signed: false, checksums, builtAt: new Date().toISOString() }, null, 2));
    console.log('Windows 安装包已生成，运行 npm run test:windows 验证实际窗口和连接器');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
