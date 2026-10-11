const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'build-windows-native.ps1')], { cwd: root, stdio: 'inherit', windowsHide: true });
else if (process.platform === 'darwin') execFileSync('swiftc', ['native/ClawLinkBridge.swift', '-o', 'native/ClawLinkBridge', '-framework', 'Cocoa', '-framework', 'ApplicationServices'], { cwd: root, stdio: 'inherit' });
else throw new Error('原生窗口连接器需要 Windows 或 macOS');
