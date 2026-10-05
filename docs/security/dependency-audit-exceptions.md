# Dependency audit exceptions

ZhiYun release checks fail on unignored high or critical registry advisories. Reviewed on 2026-10-03, the current dependency graph has one retained build-time exception. No exception applies to user content or Runtime data processing.

| Advisory                                                                 | Active dependency path                                     | Reason and actual scope                                                                                                                                                                                                                                                                                                                                                | Removal condition                                                                                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | Electron Forge maker-dmg → appdmg 0.6.6 → image-size 0.7.5 | The old ICNS parser only receives repository-owned application icons during DMG construction and is absent from the packaged Runtime. The fixed image-size 2.0.3 API is not a compatible replacement for appdmg's old callable, file-reading API. This is an existing, restricted exception; unsigned local packaging does not establish signing or production safety. | A maintained appdmg/maker-dmg upgrade, or a separately verified compatible adapter using a fixed parser. Reassess the input boundary before every release. |

Two former ignores were removed after inspecting the current unfiltered registry result and lockfile:

- `GHSA-jmr9-qjv8-65gv`: the active `extract-zip` override already resolves to `@electron-internal/extract-zip@1.0.5`; the affected upstream package is absent from the active lock graph.
- `GHSA-5p2g-fcmc-qvqq`: the remaining image-size is 0.7.5, below this advisory's affected JXL/HEIF range starting at 1.2.0. This removal does not resolve the separate ICNS advisory above.

## Locally fixed upstream issues

Two additional advisories are fixed through source patches, with no new ignores. The upstream registry still reports both original package versions as vulnerable. Provenance, retained licenses and changes are recorded in [dependency patches](../../tooling/dependency-patches/README.md).

| Advisory                                                                 | Upstream source                          | Verification                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | braces 3.0.3, MIT                        | Bound parser nesting and validate caller ASTs before recursive walks; deep/cyclic input and normal expansion tests resolve through the actual Forge dependency graph                   |
| [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | http-cache-semantics 4.2.0, BSD-2-Clause | Deny cache reuse when storage/revalidation security rules prohibit it; shared Cookie, private/no-store/no-cache/proxy-revalidate, serialized policies and ordinary public expiry tests |

`dependency:audit` runs both the normal lockfile audit and the supplemental patch audit. The latter queries the original upstream versions, reports known advisories, rejects newly reported high/critical advisories without a verified local fix, and executes regression and Node syntax checks. The fork names alone are not security evidence.

Registry findings below the high threshold are not described as fixed by this exception policy. Revisit them during dependency maintenance. Test credentials, Mock Provider success and unsigned builds do not establish real messaging, payment, model or release validation.
