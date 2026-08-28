import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray,
} from 'electron';
import {
  AnalyticsWorkerSupervisor,
  type AnalyticsWorkerSupervisorState,
} from '@zhiyun/analytics-worker-client';
import type { RuntimeBootstrap } from '@zhiyun/contracts';
import { HostCapabilityServer } from './host-capability-server.js';
import { RuntimeSupervisor } from './runtime-supervisor.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// Unpackaged Electron apps otherwise share the generic "Electron" lock namespace.
app.setName('ZhiYun');
const singleInstance = app.requestSingleInstanceLock();
console.info('[desktop] single instance lock', {
  acquired: singleInstance,
  userData: app.getPath('userData'),
});
if (!singleInstance) {
  app.exit(0);
  process.exit(0);
}

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const developmentUrl = process.env.ZHIYUN_DESKTOP_DEV_URL;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let supervisor: RuntimeSupervisor | undefined;
let analyticsSupervisor: AnalyticsWorkerSupervisor | undefined;
let hostServer: HostCapabilityServer | undefined;
let bootstrap: RuntimeBootstrap | undefined;
let quitting = false;
let shutdownFinished = false;
let traySummary = { running: 0, failed: 0, schedulingPaused: false };
const bootstrapWaiters: Array<(value: RuntimeBootstrap) => void> = [];

function publishBootstrap(value: RuntimeBootstrap): void {
  bootstrap = value;
  for (const resolveWaiter of bootstrapWaiters.splice(0)) resolveWaiter(value);
  mainWindow?.webContents.send('runtime:bootstrap-changed', value);
}

function getBootstrap(): Promise<RuntimeBootstrap> {
  if (bootstrap) return Promise.resolve(bootstrap);
  return new Promise((resolveWaiter) => bootstrapWaiters.push(resolveWaiter));
}

function safeExternal(target: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(target).protocol);
  } catch {
    return false;
  }
}

function installAppProtocol(): void {
  const rendererRoot = resolve(moduleDirectory, 'renderer');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    let target = normalize(resolve(rendererRoot, `.${requested}`));
    if (!target.startsWith(rendererRoot) || !existsSync(target))
      target = join(rendererRoot, 'index.html');
    return net.fetch(pathToFileURL(target).toString());
  });
}

async function promptCredential(kind: string): Promise<string | null> {
  if (!mainWindow) return null;
  const channel = `credential:${crypto.randomUUID()}`;
  const modal = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    show: false,
    width: 480,
    height: 390,
    resizable: false,
    title: kind,
    webPreferences: {
      preload: join(moduleDirectory, 'credential-preload.cjs'),
      additionalArguments: [`--credential-channel=${channel}`, `--credential-kind=${kind}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const result = new Promise<string | null>((resolveResult) => {
    let settled = false;
    ipcMain.once(channel, (_event, payload: { value?: string; canceled?: boolean }) => {
      settled = true;
      resolveResult(payload.canceled ? null : (payload.value ?? null));
      modal.close();
    });
    modal.once('closed', () => {
      if (!settled) resolveResult(null);
    });
  });
  if (developmentUrl) await modal.loadURL(`${developmentUrl}/credential.html`);
  else await modal.loadURL('app://zhiyun/credential.html');
  modal.show();
  return result;
}

async function captureLoginSession(target: string): Promise<unknown | null> {
  const parsed = new URL(target);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Login URL must use HTTP or HTTPS');
  const loginWindow = new BrowserWindow({
    ...(mainWindow ? { parent: mainWindow } : {}),
    width: 1080,
    height: 760,
    title: '登录完成后关闭窗口 · ZhiYun',
    webPreferences: {
      partition: `zhiyun-login-${crypto.randomUUID()}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let capturing = false;
  const result = new Promise<unknown | null>((resolveResult) => {
    loginWindow.on('close', (event) => {
      if (capturing) return;
      event.preventDefault();
      capturing = true;
      void (async () => {
        try {
          const currentUrl = loginWindow.webContents.getURL() || target;
          const currentOrigin = new URL(currentUrl).origin;
          const [cookies, localStorage] = await Promise.all([
            loginWindow.webContents.session.cookies.get({}),
            loginWindow.webContents.executeJavaScript(
              'Object.entries(window.localStorage).map(([name,value]) => ({name,value}))',
              true,
            ) as Promise<Array<{ name: string; value: string }>>,
          ]);
          resolveResult({
            cookies: cookies.map((cookie) => ({
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              expires: cookie.expirationDate ?? -1,
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite:
                cookie.sameSite === 'no_restriction'
                  ? 'None'
                  : cookie.sameSite === 'strict'
                    ? 'Strict'
                    : 'Lax',
            })),
            origins: [{ origin: currentOrigin, localStorage }],
          });
        } catch {
          resolveResult(null);
        } finally {
          loginWindow.destroy();
        }
      })();
    });
    loginWindow.once('closed', () => {
      if (!capturing) resolveResult(null);
    });
  });
  await loginWindow.loadURL(target);
  return result;
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'ZhiYun 织云',
    webPreferences: {
      preload: join(moduleDirectory, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = developmentUrl
      ? url.startsWith(developmentUrl)
      : url.startsWith('app://zhiyun');
    if (!allowed) event.preventDefault();
  });
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (developmentUrl) await mainWindow.loadURL(developmentUrl);
  else await mainWindow.loadURL('app://zhiyun/');
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setToolTip(`ZhiYun 织云 · ${traySummary.running} 个任务运行中`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示织云', click: () => mainWindow?.show() },
      { label: `运行中：${traySummary.running} / 失败：${traySummary.failed}`, enabled: false },
      {
        label: traySummary.schedulingPaused ? '恢复调度' : '暂停调度',
        click: () => {
          void supervisor
            ?.request(`/api/v2/scheduler/${traySummary.schedulingPaused ? 'resume' : 'pause'}`, {
              method: 'POST',
            })
            .then(() => refreshTraySummary());
        },
      },
      { label: '重启 Runtime', click: () => supervisor?.restart() },
      { type: 'separator' },
      { label: '退出', click: () => void orderlyQuit() },
    ]),
  );
}

async function refreshTraySummary(): Promise<void> {
  try {
    traySummary = await supervisor!.request<typeof traySummary>('/api/v2/runtime/summary');
    updateTrayMenu();
  } catch {
    // Runtime supervisor diagnostics remain available while it is restarting.
  }
}

function createTray(): void {
  const trayIcon = process.platform === 'darwin' ? 'tray-icon.png' : 'tray-icon-32.png';
  const iconPath = join(moduleDirectory, '..', 'resources', 'icons', trayIcon);
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  updateTrayMenu();
  const timer = setInterval(() => void refreshTraySummary(), 5_000);
  timer.unref?.();
  tray.on('click', () => mainWindow?.show());
}

function setDockIcon(): void {
  if (process.platform !== 'darwin') return;
  const iconPath = join(moduleDirectory, '..', 'resources', 'icons', 'icon.png');
  if (existsSync(iconPath)) app.dock?.setIcon(iconPath);
}

function createApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: '重启 Runtime', click: () => supervisor?.restart() },
          { type: 'separator' },
          { label: '退出织云', accelerator: 'CmdOrCtrl+Q', click: () => void orderlyQuit() },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

function bundledBrowserDirectory(): string | undefined {
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'playwright')
    : join(moduleDirectory, '..', 'resources', 'playwright');
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory).some((entry) => entry.startsWith('chromium'))
    ? directory
    : undefined;
}

function analyticsWorkerLaunch(): { command: string; args: string[] } {
  if (!app.isPackaged) {
    const workspaceRoot = resolve(moduleDirectory, '../../..');
    const python =
      process.platform === 'win32'
        ? join(workspaceRoot, 'services', 'analytics-worker', '.venv', 'Scripts', 'python.exe')
        : join(workspaceRoot, 'services', 'analytics-worker', '.venv', 'bin', 'python');
    return { command: python, args: ['-m', 'zhiyun_analytics_worker'] };
  }
  const platform =
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const root = join(process.resourcesPath, 'analytics-worker', `${platform}-${architecture}`);
  const executable = process.platform === 'win32' ? 'analytics-worker.exe' : 'analytics-worker';
  const candidates = [join(root, executable), join(root, 'analytics-worker', executable)];
  return {
    command:
      candidates.find((candidate) => {
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      }) ?? candidates[0]!,
    args: [],
  };
}

function publishAnalyticsWorkerState(state: AnalyticsWorkerSupervisorState): void {
  if (state.status === 'degraded') {
    console.warn('[desktop] analytics worker degraded', state.reason);
  } else {
    console.info('[desktop] analytics worker state', state.status, state.generation);
  }
  if (state.status === 'ready') {
    supervisor?.setAnalyticsWorker(analyticsSupervisor?.connection(), 'ready');
  } else if (state.status === 'degraded') {
    supervisor?.setAnalyticsWorker(undefined, 'degraded');
  }
}

async function orderlyQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  mainWindow?.hide();
  await supervisor?.stop();
  await analyticsSupervisor?.stop();
  await hostServer?.close();
  shutdownFinished = true;
  app.quit();
}

app.on('second-instance', () => {
  mainWindow?.show();
  mainWindow?.focus();
});
app.on('window-all-closed', () => undefined);
app.on('before-quit', (event) => {
  if (!shutdownFinished) {
    event.preventDefault();
    void orderlyQuit();
  }
});

if (singleInstance) {
  void app
    .whenReady()
    .then(async () => {
      console.info('[desktop] app ready');
      setDockIcon();
      if (!developmentUrl) installAppProtocol();
      ipcMain.handle('runtime:get-bootstrap', async () => {
        await getBootstrap();
        return supervisor!.issueBootstrap();
      });
      const hostToken =
        crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      hostServer = new HostCapabilityServer({
        dataDirectory: app.getPath('userData'),
        token: hostToken,
        promptCredential,
        loginCredential: captureLoginSession,
        windowStatus: () => ({ visible: mainWindow?.isVisible() ?? false, tray: Boolean(tray) }),
        diagnostics: () => ({
          runtime: supervisor?.diagnostics() ?? { running: false },
          analyticsWorker: analyticsSupervisor?.diagnostics() ?? { status: 'unavailable' },
        }),
        restartRuntime: () => supervisor?.restart(),
      });
      const hostBaseUrl = await hostServer.start();
      const workerLaunch = analyticsWorkerLaunch();
      analyticsSupervisor = new AnalyticsWorkerSupervisor({
        ...workerLaunch,
        workspaceRoot: join(app.getPath('userData'), 'job-workspaces'),
        onStateChange: publishAnalyticsWorkerState,
        onLog(stream, message) {
          const output = stream === 'stdout' ? process.stdout : process.stderr;
          output.write(`[analytics-worker] ${message}`);
        },
      });
      const analyticsWorker = await analyticsSupervisor.start().catch((error: unknown) => {
        console.warn(
          '[desktop] analytics worker unavailable; collection Runtime will continue',
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      });
      supervisor = new RuntimeSupervisor({
        dataDirectory: app.getPath('userData'),
        hostBaseUrl,
        hostToken,
        ...(analyticsWorker ? { analyticsWorker } : {}),
        analyticsWorkerStatus: analyticsWorker ? 'ready' : 'degraded',
        ...(developmentUrl ? { rendererOrigin: developmentUrl } : {}),
        ...(bundledBrowserDirectory() ? { browserResources: bundledBrowserDirectory()! } : {}),
        onReady(value) {
          publishBootstrap(value);
          setTimeout(() => void refreshTraySummary(), 250);
        },
        onDegraded(reason) {
          void dialog.showErrorBox('ZhiYun Runtime unavailable', reason);
        },
      });
      supervisor.start();
      createTray();
      createApplicationMenu();
      await createMainWindow();
    })
    .catch((error) => {
      console.error('[desktop] startup failed', error);
      app.exit(1);
    });
}
