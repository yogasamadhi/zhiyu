# 一级目录整理验收

日期：2026-09-10。以下记录第一轮代码与工具目录整理，其中路径是当时的中间布局。2026-09-12 源码已进一步收敛为 `desktop/` 和 `platform/`；当前结构见 [仓库布局](../architecture/REPOSITORY_LAYOUT.md)，中间验证见 [服务目录迁移验收](service-layout.md)。

## 完成内容

- 一级源码目录收敛为 `apps`、`packages`、`services`、`tooling`、`deploy`、`docs`。
- 业务插件、底层能力、运行配置分别迁入 `packages/plugins`、`packages/capabilities`、`packages/profiles`，保留原工作区包名和模块边界。
- 脚本、测试夹具与 E2E 辅助代码集中在 `tooling`；四个应用入口保持原路径。
- 第三方源码/补丁说明迁入 `tooling/dependencies`；无源码的旧存储包和 legacy-runtime 构建残留清除。
- 根目录许可证产物与 Playwright 报告迁入 `.artifacts`。旧 Crawlee 存储迁至 `.data/legacy-crawlee-*`，原业务数据和凭据保留。
- Bun 工作区、相对路径、TypeScript、测试选择器、依赖边界、生成器、许可证装配、备份恢复、CI 与文档同步更新。

迁移过程中修正了一项云端并发测试的观察方式：原测试在持锁事务内重复读取 PostgreSQL 活动视图，可能一直读到同一统计快照。现在使用独立自动提交查询观察等待状态，并限定当前数据库；保留原并发和账本断言，未改变支付或积分领域逻辑。

## 本机验证结果

环境：macOS arm64、Bun 1.4.0、Node 24，真实 SQLite/PostgreSQL、受监督的本地 Python Worker；外部支付和模型继续使用模拟。

| 检查                                                       | 结果                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `bun run test`                                             | **87 个测试文件、432 项通过**，迁移前后的用例总数一致               |
| `bun run desktop:test`                                     | **11 项通过**，覆盖新夹具路径、助手、采集、招聘、模板、响应式       |
| `bun run cloud:test`                                       | **25 项通过、93 个断言**                                            |
| `bun run cloud:e2e`                                        | **2 项网页测试通过**，默认跳过打包桌面专项                          |
| `bun run typecheck`、`bun run lint`、`bun run worker:lint` | 通过                                                                |
| 本地、Worker、云端契约检查                                 | 通过，生成器均从新路径运行                                          |
| `bun run architecture:deps`                                | 无违规，376 个模块、1074 条依赖，与整理前一致                       |
| `bun run cloud:build`                                      | Server、Portal、Admin 构建通过                                      |
| Docker Server 目标构建                                     | 从新工作区结构安装依赖并构建成功，构建阶段覆盖三个云端应用          |
| `bun run desktop:package`                                  | macOS arm64 `.app` 生成成功，包含新路径生成的许可证清单             |
| 新路径备份脚本                                             | 从 `/tmp` 调用，成功备份隔离测试库，验证自行定位仓库与 Compose 路径 |

打包后分别执行了以下验证，均使用本次新目录结构构建的 macOS arm64 `.app`：

- `bun run --filter @zhiyun/desktop test:packaged`：**1 项通过**，完成动态采集与分析。
- `CLOUD_DESKTOP_E2E=true bun run cloud:e2e desktop-commercial.spec.ts`：**1 项通过**，完成 PKCE 登录、模拟购买、托管助手、BYOK 切换、设备解绑与退出；此项单独运行，没有把默认跳过当作通过。

`bun install --frozen-lockfile`、`format:check`、`git diff --check`、备份/恢复脚本 `bash -n` 均通过。

运行完成后核对，原一级业务/工具目录和根目录 `storage`、`dist`、`playwright-report-cloud` 均未重新生成。`.data`、`.artifacts`、`node_modules` 和 Git 相关目录保留各自的数据或工具职责。

测试日志和路径迁移清单保存在忽略提交的 `.artifacts/root-layout/`。本轮不推送远程 CI、不执行公网部署；其他操作系统的安装包由已有 CI 矩阵后续验证。
