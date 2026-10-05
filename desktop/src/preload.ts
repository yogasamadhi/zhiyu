import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeBootstrap } from '@zhiyun/contracts';

contextBridge.exposeInMainWorld('zhiyunRuntime', {
  getBootstrap: () => ipcRenderer.invoke('runtime:get-bootstrap') as Promise<RuntimeBootstrap>,
  onBootstrapChanged: (listener: (bootstrap: RuntimeBootstrap) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, bootstrap: RuntimeBootstrap) =>
      listener(bootstrap);
    ipcRenderer.on('runtime:bootstrap-changed', handler);
    return () => ipcRenderer.off('runtime:bootstrap-changed', handler);
  },
});

contextBridge.exposeInMainWorld('zhiyunCloud', {
  summary: () => ipcRenderer.invoke('cloud:summary') as Promise<unknown>,
  login: () => ipcRenderer.invoke('cloud:login') as Promise<unknown>,
  logout: () => ipcRenderer.invoke('cloud:logout') as Promise<unknown>,
  select: (mode: 'byok' | 'hosted', model: string) =>
    ipcRenderer.invoke('cloud:select', { mode, model }) as Promise<unknown>,
  portal: () => ipcRenderer.invoke('cloud:portal') as Promise<void>,
});
