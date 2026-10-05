# Pre-Level 2 Baseline

> Captured: 2026-08-28
>
> Git commit: `c6de38b`
>
> Git tag: `pre-level2-refactor`

## Quality gates

- ESLint: passed
- Prettier check: passed
- Generated client drift: passed
- TypeScript typecheck: passed
- Workspace build: passed
- Package tests: 83 passed, 1 skipped
- API integration: 7 passed
- Desktop E2E: 3 passed

当时的 Package tests 依赖 PostgreSQL/Redis，并使用历史路径 `apps/desktop/resources/playwright` 下随桌面端提供的 Chromium；当前对应路径为 `desktop/resources/playwright`。

## Size baseline

- Desktop packaged output: approximately 1.7 GiB
- Bundled Playwright resources: approximately 556 MiB
- Runtime utility bundle: approximately 20.17 MiB
- Desktop Renderer JavaScript: approximately 457 KiB before gzip

These values are comparison baselines, not release budgets. ZhiYun 1.0 budgets are defined in the Level 2 refactor architecture proposal.
