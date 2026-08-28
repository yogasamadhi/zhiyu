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
