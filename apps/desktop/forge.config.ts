import { resolve } from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

const desktopRoot = import.meta.dirname;
const iconBase = resolve(desktopRoot, 'resources/icons/icon');
const macSigning = process.env.MAC_CODESIGN_IDENTITY
  ? { identity: process.env.MAC_CODESIGN_IDENTITY }
  : undefined;
const macNotarize =
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    name: 'ZhiYun',
    executableName: 'ZhiYun',
    appBundleId: 'dev.zhiyun.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    icon: iconBase,
    asar: true,
    extraResource: [
      resolve(desktopRoot, 'resources/playwright'),
      resolve(desktopRoot, '.forge-app/analytics-worker'),
    ],
    ...(macSigning ? { osxSign: macSigning } : {}),
    ...(macNotarize ? { osxNotarize: macNotarize } : {}),
    ignore: [
      /^\/src($|\/)/,
      /^\/scripts($|\/)/,
      /^\/e2e($|\/)/,
      /playwright\.config\.ts$/,
      /^\/node_modules\/(?:@electron-forge|@electron\/|@playwright\/test|@types\/|@vitejs\/|electron$|png2icons$|react$|react-dom$|react-router-dom$|sharp$|vite$)/,
    ],
  },
  outDir: resolve(desktopRoot, 'out'),
  rebuildConfig: { force: true, onlyModules: ['better-sqlite3'] },
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ format: 'ULFO', icon: `${iconBase}.icns` }),
    new MakerSquirrel(
      {
        name: 'ZhiYun',
        setupIcon: `${iconBase}.ico`,
        iconUrl: 'https://zhiyun.dev/assets/icon.ico',
        ...(process.env.WINDOWS_CERTIFICATE_FILE && process.env.WINDOWS_CERTIFICATE_PASSWORD
          ? {
              certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
              certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
            }
          : {}),
      },
      ['win32'],
    ),
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
};

export default config;
