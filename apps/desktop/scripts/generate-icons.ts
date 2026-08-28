import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const icons = resolve(import.meta.dir, '../resources/icons');
await mkdir(icons, { recursive: true });
const transparentSource = await readFile(resolve(icons, 'logo-transparent.png'));
const trimmedLogo = await sharp(transparentSource)
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
const dockTileSize = 824;
const dockTileInset = (1024 - dockTileSize) / 2;
const dockLogo = await sharp(trimmedLogo)
  .resize({ width: 676, height: 676, fit: 'inside' })
  .png()
  .toBuffer();
const dockTile = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <rect x="${dockTileInset}" y="${dockTileInset}" width="${dockTileSize}" height="${dockTileSize}" rx="192" fill="#fff"/>
  </svg>
`);
const png1024 = await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    { input: dockTile, top: 0, left: 0 },
    { input: dockLogo, gravity: 'center' },
  ])
  .png()
  .toBuffer();
await writeFile(resolve(icons, 'logo-dock.png'), png1024);
await writeFile(resolve(icons, 'icon.png'), png1024);
await writeFile(
  resolve(icons, 'icon-32.png'),
  await sharp(png1024).resize(32, 32).png().toBuffer(),
);
for (const [filename, size] of [
  ['tray-icon.png', 18],
  ['tray-icon@2x.png', 36],
  ['tray-icon-32.png', 32],
] as const) {
  await writeFile(
    resolve(icons, filename),
    await sharp(trimmedLogo)
      .resize({
        width: size,
        height: size,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer(),
  );
}

const png2icons = (await import('png2icons')).default as unknown as {
  createICNS(input: Buffer, interpolation?: number, shadow?: number): Buffer | null;
  createICO(input: Buffer, interpolation?: number, shadow?: number): Buffer | null;
  BICUBIC2: number;
};
const icns = png2icons.createICNS(png1024, png2icons.BICUBIC2, 0);
const ico = png2icons.createICO(png1024, png2icons.BICUBIC2, 0);
if (!icns || !ico) throw new Error('Could not encode Electron icons');
await writeFile(resolve(icons, 'icon.icns'), icns);
await writeFile(resolve(icons, 'icon.ico'), ico);
