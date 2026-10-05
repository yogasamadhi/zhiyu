# 仓库目录布局

更新：2026-09-12。仓库按真实运行位置分成 `desktop` 和 `platform` 两个产品域。Electron 应用直接位于根目录 `desktop/`，不再保留中间 `apps/` 层。根目录只保留产品域、文档、通用工程配置和生成数据目录。

```text
zhiyu/
├── desktop/                         Electron 桌面应用根目录
│   ├── src/、scripts/、e2e/、test/    桌面入口、构建与测试
│   ├── analytics-worker/             本地 Python 分析/语料 Worker
│   ├── packages/                     本地 Runtime、UI、插件与能力包
│   │   ├── plugins/                  内置业务模块
│   │   ├── capabilities/             SQLite、队列、Artifact、Worker Client
│   │   └── profiles/                 产品模块组合
│   └── tooling/                      Desktop fixtures、E2E 和依赖说明
├── platform/
│   ├── portal/                       Next.js 官网与账户中心
│   ├── admin/                        React 管理后台
│   ├── server/                       Bun/Hono 商业 API 与后台任务
│   ├── packages/                     cloud-contracts、cloud-client、cloud-ui
│   ├── deploy/                       Docker、Compose、Caddy 和环境示例
│   └── tooling/scripts/              契约、E2E 种子、备份恢复
├── docs/                             架构、产品、决策与验收记录
├── tooling/scripts/                  两端共用的进程管理与许可证工具
├── run-desktop.ts                   桌面开发启动器
└── run-platform.ts                  平台开发启动器
```

## 分组原则

- `desktop` 是完整的本地产品边界。采集、分析、语料、定时任务、导出、助手、SQLite、本地队列和 Python Worker 均在用户设备执行。
- `desktop/packages/platform`、`platform-core`、`platform-testkit` 以及 `plugins/platform` 是桌面本地 Runtime 的业务抽象，不是商业云平台代码。
- `platform` 只包含官网、账户中心、运营后台、商业 API/Worker、三个 `cloud-*` 包及其部署和验收工具。
- Desktop 访问商业平台时只通过 HTTPS API；两个产品域之间没有生产源码包依赖。商业 E2E 可显式启动已打包的 Desktop 产物。
- `tooling/scripts/development.ts` 被两个启动器共用；`generate-node-licenses.ts` 扫描整个根 workspace，因此保留在根目录的通用 `tooling` 中。

## 本次路径迁移

| 原路径                             | 新路径                                     |
| ---------------------------------- | ------------------------------------------ |
| `apps/desktop/*`                   | `desktop/*`                                |
| `analytics-worker/`                | `desktop/analytics-worker/`                |
| `packages/*`（除 `cloud-*`）       | `desktop/packages/*`                       |
| `tooling/e2e/`                     | `desktop/tooling/e2e/`                     |
| `tooling/fixtures/`                | `desktop/tooling/fixtures/`                |
| `tooling/dependencies/`            | `desktop/tooling/dependencies/`            |
| `tooling/scripts/test-isolated.ts` | `desktop/tooling/scripts/test-isolated.ts` |
| `apps/portal/`                     | `platform/portal/`                         |
| `apps/admin/`                      | `platform/admin/`                          |
| `server/`                          | `platform/server/`                         |
| `packages/cloud-*`                 | `platform/packages/cloud-*`                |
| `deploy/cloud/*`                   | `platform/deploy/*`                        |
| `tooling/scripts/cloud/*`          | `platform/tooling/scripts/*`               |

原 `apps/`、`packages/`、`server/`、`analytics-worker/` 和 `deploy/` 一级目录已消失。Bun workspace、TypeScript 继承路径、构建脚本、OpenAPI 生成器、依赖边界、CI 与 Docker context 均使用新路径。两个开发启动器作为跨 workspace 编排入口保留在根目录；直接启动命令分别是 `bun run-desktop.ts` 和 `bun run-platform.ts`。日常命令名 `bun run dev`、`desktop:test`、`cloud:dev`、`cloud:test`、`worker:sync` 保持不变。

Compose 配置显式固定 `name: cloud`，避免由于配置目录从 `deploy/cloud` 变为 `platform/deploy` 而更换项目名和数据卷前缀。

## 数据与生成文件

`.git`、`.github` 和根 `node_modules` 保持工具约定位置。`.data` 保存本地数据，`.artifacts` 保存验收证据、构建辅助产物与本次迁移前的可恢复生成环境；它们不会混入产品源码目录。

迁移后已按新 workspace 路径重建 Bun 链接。Python 虚拟环境含绝对 shebang，不能原地搬运；旧环境保留在 `.artifacts/root-layout/`，`desktop/analytics-worker/.venv` 由 `uv sync --frozen` 在新路径重建。
