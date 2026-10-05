# ZhiYun 织云

> Practical Intelligent Web Data Extraction and Local Analytics Studio

ZhiYun 1.0 是一个 Local-first 的 Web 数据采集、数据分析与语料构建平台。产品采用 Level 2 封闭式 Internal Plugin Runtime：TypeScript 负责产品控制面、采集和 AI Provider，受监督的 Python 3.12 Worker 负责 Polars/DuckDB 数据平面、统计分析、机器学习和中英语料处理。

正式产品协议是 `/api/v2`，Python Worker 使用独立的 `/worker/v1`。1.0 不兼容 `/api/v1`，也不导入或备份 0.x 业务数据。

## 主要能力

- Cheerio、JSON API、Sitemap 与 Playwright 动态页面采集
- 可编辑 CrawlPlan、不可变 Rule Version、测试、Diff、回滚、页面点选与 AI 修复建议
- 手动运行和五段 Cron、统一 Platform Job、资源类别、租约、取消、重试和崩溃恢复
- 独立 Dataset 资源、不可变 Snapshot、NDJSON spool、Parquet、变更历史和流式导出
- 完整首发分析目录：质量、描述统计、分组、相关、异常、时间序列、文本、假设检验、回归、ARIMA、聚类、PCA、Isolation Forest、TF-IDF 和分类
- 保存 Analysis Recipe，手动创建 Job，查看实时进度、结构化结果、ECharts 图表与 Artifact
- 可复用清洗配方、类型化分析问题、冻结输入与结果分支比较
- 字段变化、记录减少与空值上升的条件监控，包含冷却、聚合和可追溯的本地事件历史
- 中英优先 Corpus Pipeline：清洗、精确/MinHash 去重、语言统计、分词、句子分块及 Parquet/JSONL/Markdown/Manifest
- Webhook、本地文件、Google Sheets、S3 和带 Task Scope/限流的只读 Data API
- RFC 7807、Trace ID、ETag/If-Match、Idempotency-Key、cursor 和持久/实时双 SSE
- Desktop safeStorage 凭据存储与主进程云账户凭证管理
- Desktop 使用 React UI、生成式 Client、TanStack Query 和静态签名 UI Contribution Registry

## 架构概要

```text
Electron Renderer
  → @zhiyun/client
  → Fastify Product API /api/v2
  → Minimal Kernel + immutable ProductProfile graph
  → first-party Plugins
  → typed Repository / Job / Artifact capabilities

Analytics / Corpus Plugin
  → supervised local Python Worker /worker/v1
  → Polars + DuckDB + PyArrow
  → NumPy/SciPy/pandas/statsmodels/scikit-learn
  → Parquet / JSONL / Markdown / Manifest artifacts
```

Python Worker 不访问产品数据库、不持有产品凭据、不接受任意 SQL/Python/公式或绝对路径。Worker 不可用时采集和 Dataset 继续工作，Analytics/Corpus 显示 degraded 并返回 503。

详细边界见 [当前架构](docs/architecture.md)，完整重构决策见 [Level 2 TS/Python 方案](docs/architecture/ZHIYUN_LEVEL2_TS_PYTHON_REFACTOR.md)。

## 桌面开发

开发环境需要 Bun 1.4、Node.js 24、Python 3.12 与 uv；最终 Desktop 安装包不要求用户安装 Bun、Node、Python、uv、Docker、PostgreSQL 或 Redis。

```bash
bun install
bun run desktop:browser
bun run-desktop.ts
```

`run-desktop.ts`（也可用 `bun run dev` / `bun run desktop:dev`）检查 Bun 依赖、同步 Python 环境并构建桌面应用，随后启动 Electron、Renderer 和本地测试站点。使用 `--skip-install` 可跳过依赖同步。`FIXTURE_PORT`、`DESKTOP_RENDERER_PORT` 可指定端口；退出启动器会停止该次启动的整个进程树。

常用命令：

```bash
bun run desktop:build
bun run desktop:test
bun run worker:build
bun run worker:smoke
bun run desktop:package
bun run test:smoke:desktop-package
bun run desktop:make
```

Desktop 启动顺序是 Host Capability Server → Analytics Worker Supervisor → Core Runtime Supervisor → Renderer。Worker onedir 位于安装资源的 `analytics-worker/{platform}-{arch}`，Chromium 位于 ASAR 外的 Playwright 资源目录。

支持 macOS arm64、macOS x64 和 Windows x64 Desktop。签名凭据只从 CI 环境读取：

- macOS：`MAC_CODESIGN_IDENTITY`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- Windows：`WINDOWS_CERTIFICATE_FILE`、`WINDOWS_CERTIFICATE_PASSWORD`

## 官网、管理后台与云端开发

产品代码按运行边界分为两组：`desktop/` 是 Electron 桌面软件及其本地运行时，`platform/portal` 是 Next.js 官网与账户中心，`platform/admin` 是 React 管理后台，`platform/server` 是 Bun/Hono 商业服务及 Worker。

```bash
bun run-platform.ts --infra
```

`--infra` 先通过 Docker Compose 启动本地 PostgreSQL 和 Redis。基础设施已就绪时直接执行 `bun run-platform.ts`（也可用 `bun run platform:dev` / `bun run cloud:dev`）。启动器检查 Bun 依赖、应用数据库迁移，按顺序启动 Server API、云端后台任务、Portal 和 Admin；`--skip-install`、`--skip-migrate` 分别跳过依赖检查和迁移。

两个入口均支持 `--help`，从脚本位置定位仓库，并读取根目录的环境文件；终端环境变量优先。平台启动前会停止占用 Server、Portal、Admin 目标端口的进程，然后使用配置的固定端口，并同步默认代理地址和登录 Origin。Ctrl+C 会停止本次启动的 Server、Worker、Portal、Admin 及其子进程；Docker 数据库保持运行。桌面入口仍会在默认端口占用时选择邻近可用端口。

默认 Portal 为 `http://localhost:3100`，Admin 为 `http://localhost:3101`，云端 API 为 `http://localhost:3200/api/cloud/v1`。云端使用独立 PostgreSQL 和 Redis；Electron 本地功能不依赖它们。云端管理账户、模拟支付、订阅、积分和托管 AI，采集、分析、语料处理与助手工具始终在桌面执行。

商品默认未发布，需通过部署命令创建首位管理员，再配置模型、费率、价格和每月积分。支付、签约、续费与退款全部模拟。非 AI 本地功能以及自带 API Key 的 AI 使用免费。

旧浏览器工作台和 Headless 自托管应用已移除，原有业务实现继续由 `desktop/packages/runtime`、`desktop/packages/ui`、`desktop/packages/plugins/` 和本地 Python Worker 提供。详见 [应用入口收敛决策](docs/adr/0011-desktop-cloud-apps.md)、[商业架构](docs/architecture/ZHIYUN_CLOUD_COMMERCIAL_ARCHITECTURE.md) 和 [云端运行手册](platform/deploy/README.md)。

## 数据与 1.0 Reset

- 空数据库直接创建 1.0 Schema。
- 检测到明确 0.x signature 时，只清空 Catalog 中列出的 ZhiYun 数据。
- 未知 Schema 拒绝启动，不猜测性删除。
- Reset marker 使中途崩溃后的继续操作幂等。
- 大型分析结果和 Corpus 内容只保存为 Artifact；业务数据库保存元数据、统计和引用。
- 1.0 不提供旧数据备份、恢复、转换或导入入口。

## AI 与凭据

AI Provider 继续由 TypeScript Runtime 管理。无密钥时使用 Mock Provider；OpenAI-compatible 配置示例：

```env
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=your-model
AI_API_KEY=your-key
```

Desktop Renderer 不具备长期凭据、数据库、Python Client 或业务 IPC 权限。云账户长期凭证由主进程保存；托管 AI 与 BYOK 由用户显式切换。

## 验证

```bash
bun run lint
bun run format:check
bun run architecture:deps
bun run architecture:check
bun run client:check
bun run worker:client:check
bun run typecheck
bun run test
bun run worker:test
bun run build
bun run dependency:audit
bun run compliance:licenses
bun run test:e2e:cloud
bun run test:e2e:desktop
bun run test:smoke:desktop-package
bun run release:verify
```

## 工作区

桌面与商业平台代码按运行位置聚合，根目录只保留两个产品域、文档与通用工程文件：

```text
desktop/                 Electron 应用根目录
  analytics-worker/      本地 Python 分析与语料计算进程
  packages/              本地 Runtime、UI、插件、Capabilities 和 Profiles
  tooling/               Desktop fixtures、E2E 辅助代码与依赖说明
platform/
  portal/                 Next.js 官网与账户中心
  admin/                  React 管理后台
  server/                 Bun/Hono 商业 API、后台任务与数据库迁移
  packages/               cloud-contracts、cloud-client、cloud-ui
  deploy/                 容器、HTTPS 路由和环境示例
  tooling/                契约、E2E 种子、备份恢复脚本
docs/                     架构、产品、技术决策和验收记录
tooling/                  两端共用的开发进程管理与许可证脚本
run-desktop.ts            Desktop 开发启动器
run-platform.ts           Platform 开发启动器
```

`node_modules/` 是安装依赖；`.data/` 保存开发数据及迁出的旧数据，`.artifacts/` 保存日志、截图、测试报告和许可证清单。各应用自己的 `dist/`、`.next/`、`out/` 继续位于应用内部。目录说明见 [仓库布局](docs/architecture/REPOSITORY_LAYOUT.md)。

1.0 不建设 Level 3 Extension Host、第三方插件/SDK/Marketplace、热加载、独立 Analytics 微服务、Celery/Kafka/NATS、向量数据库、Embedding 或 RAG。

## License

Apache-2.0

## 产品工作台与用户路径

当前体验以“选择页面 → 确认字段与预览 → 保存运行”为主流程，Desktop 使用统一草稿、数据工作台、分析、语料和场景入口。内置商品样例无需模型或外网。

- [产品说明与用户路径](docs/product/user-journeys.md)
- [接口增量与兼容性](docs/product/api-experience.md)
- [实施与验收记录](docs/product/experience-implementation.md)
- [真实用户测试脚本](docs/product/usability-test-script.md)
- [无需外部凭据的优化计划与目标模式指令](docs/product/zhiyun-no-credentials-optimization-plan.md)
- [优化执行记录](docs/verification/zhiyun-no-credentials-optimization.md)
- [无需外部凭据的本地样例与验证指南](docs/examples/no-credentials-workflows.md)
