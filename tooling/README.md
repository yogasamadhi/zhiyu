# 开发与测试工具

这里只保存 Desktop 和 Platform 共用的根工程工具，不承载产品业务路由。

| 文件                                | 职责                                  |
| ----------------------------------- | ------------------------------------- |
| `scripts/development.ts`            | 两个开发启动器共用的端口与进程树管理  |
| `scripts/generate-node-licenses.ts` | 扫描根 workspace 依赖并生成许可证清单 |

优先从仓库根目录调用 `bun run dev`、`bun run test`、`bun run desktop:test`、`bun run cloud:dev` 等命令。Desktop 专用的 fixtures、E2E、隔离测试和依赖说明在 `desktop/tooling/`；平台契约、测试种子和备份恢复脚本在 `platform/tooling/scripts/`。

开发启动入口为根目录 `run-desktop.ts` 和 `run-platform.ts`，两者复用 `scripts/development.ts` 的环境加载、端口检查、就绪等待和进程树清理。`platform/tooling/scripts/dev.ts` 仅转到标准平台入口。

测试日志、截图、Playwright 报告和许可证清单放在 `.artifacts/`；业务数据和需要保留的旧运行存储放在 `.data/`。不要把它们放回一级源码目录。
