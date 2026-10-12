const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const { serverFiles, documents } = require('./package-files.cjs');
function run(command, args, options = {}) { return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options }); }
function copy(source, destination) { fs.cpSync(source, destination, { recursive: true }); }
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('当前发布脚本支持 macOS Apple Silicon；请在 arm64 主机上构建');
  const release = path.join(root, 'release'); fs.mkdirSync(release, { recursive: true });
  const work = fs.mkdtempSync(path.join(release, '.build-'));
  // Only this build's temporary directory is removed; prior releases and user data stay intact.
  try {
    run('npm', ['run', 'check']); run('npm', ['test']); run('npm', ['run', 'build']);
    const app = path.join(work, 'ClawLink.app');
    const contents = path.join(app, 'Contents'); const resources = path.join(contents, 'Resources');
    const code = path.join(resources, 'app');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); fs.mkdirSync(path.join(resources, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(code, 'native'), { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) copy(path.join(root, file), path.join(code, file));
    fs.mkdirSync(path.join(code, 'server')); for (const file of serverFiles) copy(path.join(root, 'server', file), path.join(code, 'server', file));
    copy(path.join(root, 'dist'), path.join(code, 'public'));
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: code });
    run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', 'native/ClawLinkBridge.swift', '-o', path.join(code, 'native/ClawLinkBridge'), '-framework', 'Cocoa', '-framework', 'ApplicationServices']);
    run('swiftc', ['-O', '-target', 'arm64-apple-macos13.0', 'native/ClawLinkApp.swift', '-o', path.join(contents, 'MacOS/ClawLink'), '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'ServiceManagement']);
    const bundledNode = path.join(resources, 'runtime/node'); copy(process.execPath, bundledNode); fs.chmodSync(bundledNode, 0o755);
    const libraries = execFileSync('otool', ['-L', bundledNode], { encoding: 'utf8' }).split('\n').slice(1).map(x => x.trim().split(' ')[0]).filter(Boolean);
    if (libraries.some(x => !x.startsWith('/System/Library/') && !x.startsWith('/usr/lib/'))) throw new Error('Node 依赖非系统动态库，无法生成独立安装包');
    let nodeLicenseText;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        nodeLicenseText = await response.text(); break;
      } catch { if (attempt === 2) throw new Error('无法获取对应 Node 版本的许可证，请检查网络后重试'); }
    }
    fs.writeFileSync(path.join(resources, 'runtime/LICENSE'), nodeLicenseText);
    for (const file of documents) copy(path.join(root, file), path.join(resources, file));
    fs.writeFileSync(path.join(resources, 'THIRD_PARTY_NOTICES.txt'), `ClawLink includes Node.js ${process.version} (runtime/LICENSE) and QRCode with its npm dependencies. Each dependency's original LICENSE is included under app/node_modules.\n`);
    const icons = path.join(work, 'ClawLink.iconset'); fs.mkdirSync(icons);
    run('swift', ['scripts/icon.swift', icons]); run('iconutil', ['-c', 'icns', icons, '-o', path.join(resources, 'ClawLink.icns')]);
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.clawlink.app</string><key>CFBundleExecutable</key><string>ClawLink</string><key>CFBundleName</key><string>ClawLink</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleIconFile</key><string>ClawLink</string><key>LSUIElement</key><false/><key>LSMinimumSystemVersion</key><string>13.5</string><key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>仅在您允许的通讯账户发送截图指令时，截取主屏幕并回传图片。</string><key>NSAccessibilityUsageDescription</key><string>操作您绑定的 Codex、ChatGPT、Claude、Paseo 或其它本机应用会话，发送消息并读取回复。</string></dict></plist>`);
    const identity = process.env.CLAWLINK_SIGN_IDENTITY || '-';
    const signing = identity === '-' ? [] : ['--options', 'runtime', '--timestamp'];
    const entitlements = path.join(root, 'scripts/node.entitlements.plist');
    run('codesign', ['--force', '--sign', identity, ...signing, '--entitlements', entitlements, bundledNode]);
    run('codesign', ['--force', '--sign', identity, ...signing, path.join(code, 'native/ClawLinkBridge')]);
    run('codesign', ['--force', '--sign', identity, ...signing, app]);
    run('codesign', ['--verify', '--deep', '--strict', app]);
    const finalApp = path.join(release, `ClawLink-${version}-arm64.app`);
    // Replace only build output for this exact version.
    fs.rmSync(finalApp, { recursive: true, force: true }); fs.renameSync(app, finalApp);
    const zip = path.join(release, `ClawLink-${version}-macOS-arm64.zip`);
    fs.rmSync(zip, { force: true }); run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', finalApp, zip]);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    fs.writeFileSync(`${zip}.sha256`, `${sha256}  ${path.basename(zip)}\n`);
    fs.writeFileSync(path.join(release, 'manifest.json'), JSON.stringify({ version, architecture: process.arch, minimumMacOS: '13.5', node: process.version, signing: identity === '-' ? 'ad-hoc' : 'Developer ID', notarized: false, zip: path.basename(zip), sha256, builtAt: new Date().toISOString() }, null, 2));
    console.log(`Release: ${zip}\nSigning: ${identity === '-' ? 'local ad-hoc; not notarized' : 'Developer ID; notarization pending'}`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
