# Server 与 Analytics Worker 一级目录迁移验收

日期：2026-09-10。本文记录当时的中间布局：将 `services/analytics-worker/` 移到当时的根 `analytics-worker/`，将 `apps/server/` 移到当时的根 `server/`，并删除空 `services/`。2026-09-12 两者分别继续迁入 `desktop/analytics-worker/` 和 `platform/server/`；当前完整结构见 [仓库布局](../architecture/REPOSITORY_LAYOUT.md)。

## 迁移内容

- 当时 `apps/` 保留 `desktop/`、`portal/`、`admin/`；当时的根 `server/` 是 Bun/Hono 云端商业服务，根 `analytics-worker/` 是随 Electron 交付的本地 Python 计算进程。
- Bun 工作区显式登记 `server`，包名仍为 `@zhiyun/cloud-server`。更新锁文件、TypeScript 继承路径、云端开发/迁移/测试脚本和测试种子的导入路径。
- Electron 开发态 Python 路径、Forge 装配来源、Worker 契约生成器、共享运行时和插件集成测试均使用新目录。Python 虚拟环境重新创建，避免旧绝对路径残留。
- 依赖检查同时扫描 `packages`、`apps`、`server`，继续约束浏览器与服务端依赖、禁止云端执行桌面工具。
- Docker 构建从根目录 `server` 复制服务代码和迁移；排除 Python 构建与测试缓存。许可证生成命令仍将产物写入根目录 `.artifacts/compliance/`。
- 更新 README、商业架构、实施计划与目录说明。现有 CI 使用根脚本，随脚本切换至新路径。

目录调整保留原源码、数据库迁移和测试；原 `services/analytics-worker` 的 25 个受版本控制文件在新目录均存在。没有删除本地数据库、云端数据库、账户凭据和用户配置。日常 `bun run dev`、`cloud:dev`、`cloud:test`、`worker:sync` 等命令名称不变。

## 本机验证

环境为 macOS arm64、Bun 1.4.0、Node 24、Python 3.12，使用真实 SQLite/PostgreSQL 和本地 Python Worker。支付和托管模型沿用测试模拟配置。

| 检查                                                   | 结果                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| `bun install --frozen-lockfile`、`bun run worker:sync` | 通过；工作区依赖及 Python 环境均从新位置解析                      |
| `bun run typecheck`、`bun run cloud:check`             | 通过，包含根目录 Server                                           |
| `bun run lint`、`bun run worker:lint`                  | 通过                                                              |
| 本地/Worker/云端契约和 Architecture Catalog            | 通过，无契约漂移                                                  |
| `bun run architecture:deps`                            | 通过：376 个模块、1074 条依赖，无违规                             |
| `bun run test`                                         | 87 个文件、432 项通过                                             |
| `bun run worker:test`                                  | 39 项通过；4 条第三方库警告                                       |
| `bun run cloud:test`                                   | 25 项通过、93 个断言，含真实 PostgreSQL 和 Redis 故障回退         |
| `bun run cloud:build`                                  | Server、Portal、Admin 全部构建成功                                |
| `bun run cloud:e2e`                                    | 2 项网页测试通过；默认跳过打包桌面专项                            |
| Docker Server 镜像构建                                 | 通过，验证新路径的依赖安装、三个云端应用构建及服务/迁移装配       |
| `bun run worker:build`、`bun run worker:smoke`         | 新目录生成 macOS arm64 可执行文件，完成快照、分析、语料与关闭验证 |

桌面 E2E 首轮为 9 项通过、2 项失败：样例任务页面在 30 秒内未显示完成状态；测试进程重启后，空分析页出现 `link-in-text-block` 无障碍问题。保留该轮日志与现场。在其他构建任务结束后，使用同一桌面构建完整复跑，11 项全部通过；未修改业务代码、断言或超时。首轮问题没有稳定复现，不能据复跑结果认定已修复。

重新执行 `bun run desktop:package`，当时成功生成 `apps/desktop/out/ZhiYun-darwin-arm64/ZhiYun.app`（当前对应 `desktop/out/`）。随后使用该产物完成：

- `bun run --filter @zhiyun/desktop test:packaged`：1 项通过，完成动态采集与本地分析。
- `CLOUD_DESKTOP_E2E=true bun run cloud:e2e desktop-commercial.spec.ts`：1 项通过，完成 PKCE 登录、模拟购买、托管助手、BYOK 切换、设备解绑与退出登录；单独运行默认跳过的专项。

当时 `format:check` 与 `git diff --check` 通过。`services/`、`apps/server/` 没有被重新生成；本文中的旧路径仅作为该轮迁移的历史验收证据。

日志与首次失败现场保存在忽略提交的 `.artifacts/service-layout/`。本轮只在本机执行验证，没有触发远程发布或公网部署；Windows/macOS x64 安装包由已有 CI 矩阵验证。
