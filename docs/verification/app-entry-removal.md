# 桌面与商业平台应用入口收敛验收

日期：2026-09-10。对应 [ADR 0011](../adr/0011-desktop-cloud-apps.md)。本记录验证删除旧浏览器工作台和独立 API 后，桌面及商业平台继续正常运行。

## 应用结构（路径按后续整理更新）

```text
desktop/          Electron 与本地业务运行时入口
platform/
  portal/         官网、购买和账户中心
  admin/          商业运营后台
  server/         商业 API 与 Worker
```

Electron 测试辅助文件现位于 `desktop/tooling/e2e/assistant.ts`、`desktop/tooling/e2e/experience.ts`。原有 `apps/web`、`apps/api` 及其专用 `packages/config` 已删除；依赖锁文件、开发命令、Headless Linux 发布、Compose/代理配置和 CI 引用已清理。

Server 在后续整理中迁入 `platform/server/`，本地 Python 进程迁入 `desktop/analytics-worker/`。完整目录与中间迁移记录见 [仓库布局](../architecture/REPOSITORY_LAYOUT.md) 和 [服务目录迁移验收](service-layout.md)。

本地 `/api/v2`、SQLite、持久队列、共享 UI/Client/Runtime、业务插件和 Python Worker 保留。商业 API 继续使用 `/api/cloud/v1`，支付仍只模拟。

## 数据保留

删除目录前将原 `apps/api/.data` 与 `apps/api/storage` 移至根目录 `.data/retired-apps/web-api-*`。未清空根数据目录、桌面用户配置、云数据库或凭据；迁出的旧数据未自动导入其他运行环境。

## 测试覆盖迁移

| 原有覆盖                                                | 当前位置或处理方式                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| API 生命周期的 9 项测试                                 | `desktop/packages/runtime/test/product-api.integration.test.ts`，直接组合本地运行时与真实 SQLite/Python Worker |
| 明文凭据写入                                            | 按桌面规则更新：拒绝 Renderer 明文输入，由测试 Host 保存凭据后传递引用                                         |
| 招聘 CSV 导入与状态、官方模板、无限滚动                 | 迁入 Electron，桌面 E2E 从 8 项增加至 11 项                                                                    |
| 静态采集、Load More、助手、离线体验、响应式             | 由已有 Electron E2E 保留覆盖                                                                                   |
| CSV/JSON/XLSX 导出、规则版本、修复、调度、Data API 权限 | 保留在运行时集成测试和桌面文件保存测试                                                                         |
| 独立网页登录、静态 SPA 托管                             | 功能入口已删除，对应专用测试删除；云账户与管理员身份测试继续由商业平台承担                                     |
| Headless 权限图                                         | 转为 `identity-test` 内部配置，保留授权回归，不提供应用或发布入口                                              |

## 本机执行结果

环境：macOS 26.6.2 arm64、Bun 1.4.0、Node 24，使用本地隔离数据库与临时桌面配置。

| 命令                                                      | 结果                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `bun install --frozen-lockfile`                           | 通过；旧应用和专用配置包已从工作区锁文件移除               |
| `bun run test`                                            | **87 个文件、432 项通过**                                  |
| `bun run test:integration`                                | **5 个文件、24 项通过**；属于上行的子集                    |
| `bun run desktop:test`                                    | **11 项通过**，包含迁入的 3 项场景                         |
| `bun run cloud:test`                                      | **25 项通过，93 个断言**，真实 PostgreSQL                  |
| `bun run cloud:build`                                     | Server、Portal、Admin 构建通过                             |
| `bun run cloud:e2e`                                       | **2 项浏览器测试通过**；默认跳过打包桌面专项，专项另行执行 |
| `bun run desktop:package`                                 | macOS arm64 `.app` 构建通过                                |
| `bun run typecheck`、`bun run lint`                       | 全仓库通过                                                 |
| `bun run client:check`、`bun run cloud:check`             | 本地与云端契约一致，云端类型检查通过                       |
| `bun run architecture:deps`、`bun run architecture:check` | 无依赖违规，Catalog 一致；376 个模块、1074 条依赖          |
| `bun run format:check`、`git diff --check`                | 通过                                                       |

打包后另行执行两项验证，均使用本次重新生成的 `.app`：

- `bun run --filter @zhiyun/desktop test:packaged`：**1 项通过**，安装目录内完成动态采集与分析。
- `CLOUD_DESKTOP_E2E=true bun run cloud:e2e desktop-commercial.spec.ts`：**1 项通过**，完成 PKCE 登录、模拟购买、托管助手、BYOK 切换、设备解绑与退出；此项单独执行，未将默认跳过算作通过。

测试日志保留在忽略提交的 `.artifacts/app-entry-removal/`，不将历史运行结果当作本次通过的证据。GitHub 工作流仅完成本地配置检查，本轮未推送触发远程 CI；Windows/macOS x64 打包不在本机验证范围。未执行公网部署或真实外部支付/消息/模型联调。
