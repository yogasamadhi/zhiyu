# Dependency patches

These private, local packages retain upstream source and license notices. They fix two advisories for which the public registry had no patched release on 2026-10-03. They are not published upstream releases. Original tarballs were checked against their registry SHA-512 integrity values before copying the runtime files.

| Local package                          | Upstream                     | License      | Advisory                                                                 | Local change                                                                                           |
| -------------------------------------- | ---------------------------- | ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `@zhiyun-patches/braces`               | `braces@3.0.3`               | MIT          | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Bound parsed nesting; iteratively validate caller AST depth, size and cycles before recursive walks    |
| `@zhiyun-patches/http-cache-semantics` | `http-cache-semantics@4.2.0` | BSD-2-Clause | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | Reject reuse when storage or revalidation security rules prohibit it, before either stale reuse branch |

Package manifests record the upstream version, tarball, integrity and advisory identifiers. License collection includes these private forks and their retained license files. Formatting and linting skip copied JavaScript so that unrelated upstream source remains reviewable; modified code is syntax checked and tested against the actual dependency resolution used by Forge and the crawler.

Registry scanners identify the forks by their local names. To keep upstream vulnerabilities visible, `audit-dependency-patches.ts` queries the original package versions, prints the affected advisories, rejects any additional high or critical advisory that has no verified patch, and runs the security regression tests. A registry audit result alone is not evidence that these patches work. No new audit ignore is added for these issues.

Remove a local override only after a maintained upstream release fixes the issue and passes the same regression and compatibility tests. Do not raise depth limits, delete provenance or bypass the supplemental audit to obtain a passing result.

## Browser cancellation in proxy-chain

`proxy-chain@2.7.1.patch` is a Bun patch of the original `proxy-chain@2.7.1` npm package, not a renamed fork. It changes only `dist/forward.js`: when a downstream response closes before completion, destroy its upstream request and resolve the forwarding operation. The upstream implementation otherwise retains a pending TCP connection if Chromium exits before the destination sends response headers. This prevents the collection worker from exiting after an interrupted browser request.

The change was made for OPT04 on 2026-10-03. The package retains its [Apache-2.0 license and upstream notices](https://github.com/apify/proxy-chain/tree/v2.7.1), its original name/version, and the registry integrity entry in `bun.lock`. Registry audit still examines the original package. `package.json` declares the patch in `patchedDependencies`; [Bun applies the patch during installation](https://bun.com/docs/pm/cli/patch). A frozen install must reproduce the patched resolution used by Crawlee.

The regression uses actual Chromium termination during a held localhost HTTP request, then requires the worker to exit naturally and restart with the same records, statistics and immutable Snapshots as an uninterrupted control. Normal browser completion, pagination and cancellation are covered by the same Collection integration suite. No audit ignore, response cap, retry limit or validation assertion is relaxed. Remove the patch when a maintained upstream release passes this interruption test.
