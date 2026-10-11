const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
let window, tray, child, endpoint, quitting = false, ready = false, log;
const dataDir = path.resolve(process.env.CLAWLINK_DATA_DIR || path.join(app.getPath('appData'), 'ClawLink'));
app.setPath('userData', dataDir); app.setAppUserModelId('dev.clawlink.app');
function sameOrigin(url) { try { return endpoint && new URL(url).origin === new URL(endpoint).origin; } catch { return false; } }
function openExternal(url) { if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
function settings() {
  const value = app.getLoginItemSettings({ path: process.execPath, args: ['--autostart'] });
  return { launchAtLogin: value.openAtLogin, loginStatus: value.openAtLogin ? 'enabled' : 'notRegistered', appPath: process.execPath, platform: 'win32' };
}
function show() {
  if (!endpoint) return;
  if (!window) {
    window = new BrowserWindow({ title: 'ClawLink', width: 1280, height: 860, minWidth: 720, minHeight: 560, show: false,
      icon: path.join(process.resourcesPath, 'icons/ClawLink.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'clawlink-console' } });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url)) { event.preventDefault(); openExternal(url); } });
    window.webContents.on('will-redirect', (event, url) => { if (!sameOrigin(url)) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window?.webContents && sameOrigin(contents.getURL()) && permission === 'clipboard-sanitized-write'));
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    window.on('closed', () => { window = null; });
    window.webContents.on('did-finish-load', async () => {
      // Nonsecret diagnostic used by the packaged-app smoke test.
      try {
        const result = await window.webContents.executeJavaScript("(async()=>{for(let i=0;i<100;i++){if(window.clawlinkNative && document.querySelector('#serviceStatus')?.textContent.includes('本地服务')){const s=await window.clawlinkNative('getSettings');return {embedded:true,bridge:!!s.loginStatus,title:document.title};}await new Promise(r=>setTimeout(r,100));}throw Error('UI unavailable');})()");
        fs.writeFileSync(path.join(dataDir, 'window-status.json'), JSON.stringify(result));
      } catch (error) { log?.write(`UI: ${error.message}\n`); }
    });
    window.loadURL(endpoint); window.once('ready-to-show', () => window.show());
  }
  if (window.isMinimized()) window.restore(); window.show(); window.focus();
}
function fail(message) { if (quitting) return; dialog.showErrorBox('ClawLink 无法启动', message); app.quit(); }
async function start() {
  fs.mkdirSync(dataDir, { recursive: true });
  // Windows ignores POSIX chmod. Protect the data directory with the current
  // user's SID; children inherit this ACL. Never change a parent directory.
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const sid = execFileSync(path.join(system, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/^S-1-[\d-]+$/.test(sid)) throw new Error('无法确认本机用户，未启动服务');
  execFileSync(path.join(system, 'icacls.exe'), [dataDir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  log = fs.createWriteStream(path.join(dataDir, 'service.log'), { flags: 'w' });
  log.on('error', () => fail('无法写入本地日志，请检查数据目录权限'));
  const code = path.join(process.resourcesPath, 'service');
  const env = { ...process.env, PORT: '0', NODE_ENV: 'production', CLAWLINK_DATA_DIR: dataDir, CLAWLINK_PUBLIC_DIR: path.join(code, 'public'), CLAWLINK_PARENT_PID: String(process.pid) };
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(process.resourcesPath, 'runtime/node.exe'), [path.join(code, 'server/index.js')], { cwd: code, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  const deadline = setTimeout(() => fail('本地服务启动超时，请查看数据目录中的 service.log'), 20000);
  child.stderr.on('data', bytes => log.write(bytes)); child.stdout.on('data', bytes => {
    log.write(bytes); output = (output + bytes.toString()).slice(-4000);
    const match = output.match(/ClawLink: http:\/\/localhost:(\d+)/);
    if (!endpoint && match) {
      endpoint = `http://127.0.0.1:${match[1]}`; clearTimeout(deadline);
      fs.writeFileSync(path.join(dataDir, 'endpoint.json'), JSON.stringify({ url: endpoint, pid: child.pid }));
      tray.setToolTip('ClawLink 正在运行'); if (!process.argv.includes('--autostart') || process.env.CLAWLINK_TEST_WINDOW === '1') show();
    }
  });
  child.on('error', error => { clearTimeout(deadline); fail(error.message); });
  child.on('exit', code => { clearTimeout(deadline); if (!quitting) fail(`本地服务已停止（${code}）。请查看 ${path.join(dataDir, 'service.log')}`); });
}
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on('second-instance', show); app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting || !child || child.exitCode !== null) return;
    event.preventDefault(); quitting = true;
    const timer = setTimeout(() => { child.kill(); app.exit(0); }, 4000);
    child.once('exit', () => { clearTimeout(timer); log?.end(); app.exit(0); });
    try { child.send({ action: 'stop' }); } catch { child.kill(); }
  });
  app.whenReady().then(async () => {
    ready = true;
    tray = new Tray(path.join(process.resourcesPath, 'icons/tray.png')); tray.setToolTip('ClawLink 服务启动中');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 ClawLink', click: show }, { label: '查看本地数据', click: () => shell.openPath(dataDir) }, { type: 'separator' }, { label: '退出并停止机器人', click: () => app.quit() }]));
    tray.on('double-click', show);
    ipcMain.handle('clawlink:settings', async (event, request) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !sameOrigin(event.senderFrame.url)) throw new Error('拒绝外部页面操作 App');
      if (request?.action === 'getSettings') return settings();
      if (request?.action === 'setLaunchAtLogin') {
        if (!app.isPackaged || typeof request.enabled !== 'boolean') throw new Error('请在安装后的 ClawLink 中设置自启');
        app.setLoginItemSettings({ openAtLogin: request.enabled, path: process.execPath, args: ['--autostart'] }); return settings();
      }
      if (request?.action === 'openLoginSettings') { await shell.openExternal('ms-settings:startupapps'); return settings(); }
      throw new Error('不支持的 App 操作');
    });
    await start();
  }).catch(error => { if (ready) fail(error.message); else app.exit(1); });
}
