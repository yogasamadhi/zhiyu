import { contextBridge, ipcRenderer } from 'electron';

const channel = process.argv
  .find((argument) => argument.startsWith('--credential-channel='))
  ?.split('=')[1];
if (!channel) throw new Error('Credential modal channel is missing');
const kind =
  process.argv.find((argument) => argument.startsWith('--credential-kind='))?.split('=')[1] ??
  'credential';

contextBridge.exposeInMainWorld('zhiyunCredential', {
  kind,
  submit(value: string) {
    ipcRenderer.send(channel, { value });
  },
  cancel() {
    ipcRenderer.send(channel, { canceled: true });
  },
});
