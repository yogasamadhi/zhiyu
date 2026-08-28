# Dependency audit exceptions

ZhiYun release builds fail on unignored high or critical advisories. The following exceptions are
limited to Electron build-time dependencies that do not process user-controlled input in the
released application. They must be reviewed whenever Electron Forge is upgraded and before every
minor release.

| Advisory              | Dependency path                                         | Reason for temporary exception                                                                                                                                                                     | Removal condition                                                                                       |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GHSA-jmr9-qjv8-65gv` | Electron Forge 7.11.2 → Packager 18 → extract-zip 2.0.1 | Upstream has no fixed `extract-zip` release. It only extracts the pinned Electron distribution during the isolated installer build. Checksums and the resulting installer are verified and signed. | Electron Forge adopts Packager 20 / `@electron-internal/extract-zip`, or `extract-zip` publishes a fix. |
| `GHSA-w3rx-r6r6-pgpr` | maker-dmg → appdmg → image-size 0.7.5                   | The vulnerable parser only reads the repository-owned, generated application icon during the macOS build. It is absent from the packaged Runtime.                                                  | maker-dmg/appdmg upgrades to a fixed `image-size`.                                                      |
| `GHSA-5p2g-fcmc-qvqq` | maker-dmg → appdmg → image-size 0.7.5                   | Same constrained build-time input and release-artifact scope as above.                                                                                                                             | maker-dmg/appdmg upgrades to a fixed `image-size`.                                                      |

These exceptions do not cover Runtime dependencies, downloaded user content, Analytics Worker
input, artifacts, or corpus data. Any advisory reaching those paths remains release-blocking.
