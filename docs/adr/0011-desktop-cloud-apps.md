# 0011 — 应用入口收敛为桌面与商业平台

日期：2026-09-10。状态：已实施。

## 决策

用户确定所有采集、分析、语料、定时任务、导出和助手工具在 Electron 执行，网页提供官网、账户中心和运营后台，云端提供账户、模拟支付、订阅、积分与托管 AI。因此移除原 `apps/web`、`apps/api`，当前应用入口为 `desktop`、`platform/portal`、`platform/admin`、`platform/server`。

桌面入口直接装配 `desktop/packages/ui`、`desktop/packages/client`、`desktop/packages/runtime`、`desktop/packages/runtime-gateway`、业务插件和本地 Python Worker。本地 `/api/v2`、SQLite 和持久任务队列继续存在；移除独立 API 应用不改变桌面的本地 API 协议。

## 工程调整

- 删除旧浏览器工作台、独立 API 和其专用 `packages/config`；该配置包原来只有 API 应用使用。
- 移除 Headless/Web 启动命令、静态网站托管、Linux tar/image、专用 Compose/反向代理示例和冒烟脚本。
- CI/Release 删除 Headless 作业；通用质量检查保留运行时测试，桌面矩阵执行桌面 E2E 与真实打包回归，商业平台工作流继续验证 Portal/Admin/Server。
- `bun run dev` / `desktop:dev` 只启动 Electron 和本地夹具；`cloud:dev` 启动商业平台。`test:e2e` 指向桌面，`test:e2e:cloud` 指向商业网站。
- 本地客户端按 `desktop-studio` OpenAPI 生成；旧 Headless Profile 替换为明确的 `identity-test` 内部授权测试配置，不提供启动或发布入口。通用宿主兼容类型和权限插件保留，以避免无关的协议/身份重构。
- 历史 ADR 和验收记录保留当时事实，并标记已被本决策替代；当前 README、架构和部署手册按四个应用更新。

## 测试迁移

原 API 的 9 项生命周期集成测试迁到 `desktop/packages/runtime/test/product-api.integration.test.ts`，直接装配真实 SQLite、本地队列、采集器和 Python Worker，使用临时目录与独立会话，不依赖独立 HTTP 服务或用户开发数据。

原 Web 的静态采集、Load More、助手、离线体验和响应式场景已有 Electron 覆盖；将招聘导入/工作流、官方模板和无限滚动的 3 项场景迁到 Electron E2E。CSV/XLSX/JSON 导出继续由运行时和桌面保存流程覆盖。

旧 Web 登录页面及静态 SPA 托管的专用测试随入口移除；云账户/后台身份隔离由商业平台测试负责，共享权限和 Identity 插件测试继续保留。

## 数据与运行范围

删除应用前将其内部忽略提交的 `.data` 和 `storage` 目录迁出，保存在工作区 `.data/retired-apps/web-api-*` 下。根目录原有数据、桌面用户目录、云数据库、模型 Key 和凭据不清空。迁出的数据不会自动导入其他应用。

真实支付仍不在范围内，云端没有接管本地业务工具。本次不执行公网生产部署。

## 验证

执行结果见 [应用移除验收记录](../verification/app-entry-removal.md)。
