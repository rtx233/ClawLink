const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['getSettings', 'setLaunchAtLogin', 'openLoginSettings']);
contextBridge.exposeInMainWorld('clawlinkDesktop', {
  platform: 'win32',
  invoke(action, fields = {}) {
    if (!actions.has(action)) return Promise.reject(new Error('不支持的 App 操作'));
    return ipcRenderer.invoke('clawlink:settings', { action, enabled: fields.enabled });
  }
});
