# 开发与测试工具

这里只保存 Desktop 和 Platform 共用的根工程工具，不承载产品业务路由。

| 文件                                  | 职责                                     |
| ------------------------------------- | ---------------------------------------- |
| `scripts/development.ts`              | 两个开发启动器共用的端口与进程树管理     |
| `scripts/build-package.ts`            | workspace 包的 esbuild 打包入口          |
| `scripts/lint.ts`                     | 按 TypeScript 项目分组的 ESLint 执行器   |
| `scripts/audit-dependency-patches.ts` | 本地依赖补丁的上游审计与回归验证         |
| `scripts/generate-node-licenses.ts`   | 扫描根 workspace 依赖并生成许可证清单    |
| `python/development.py`               | 根启动器的环境加载、端口检查与进程树清理 |
| `python/test_environment.py`          | 根启动器的隔离测试环境与数据库校验       |

TypeScript 脚本由 `tsx` 执行，`node:*` 依赖与 esbuild 是唯一的运行时要求；仓库不再使用 Bun 工具链。根目录的 Python 启动器只依赖标准库（Python 3.9+），由 `python3` 直接执行。

优先从仓库根目录调用 `pnpm run dev`、`pnpm run test`、`pnpm run desktop:test`、`pnpm run cloud:dev` 等命令。Desktop 专用的 fixtures、E2E、隔离测试和依赖说明在 `desktop/tooling/`；平台契约、测试种子和备份恢复脚本在 `platform/tooling/scripts/`。

开发启动入口为根目录 `run_desktop.py` 和 `run_platform.py`（Python，仅标准库），两者复用 `python/development.py` 的环境加载、端口检查、就绪等待和进程树清理。仓库其余脚本保持 Node.js/pnpm：`scripts/development.ts` 是同一套逻辑的 TypeScript 副本，仍供测试基础设施使用，两份实现需要保持同步；`platform/tooling/scripts/dev.ts` 与 Playwright 配置都通过 `pnpm run platform:dev` 转到标准平台入口。

测试日志、截图、Playwright 报告和许可证清单放在 `.artifacts/`；业务数据和需要保留的旧运行存储放在 `.data/`。不要把它们放回一级源码目录。
