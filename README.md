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
- 中英优先 Corpus Pipeline：清洗、精确/MinHash 去重、语言统计、分词、句子分块及 Parquet/JSONL/Markdown/Manifest
- Webhook、外部 PostgreSQL 和带 Task Scope/限流的只读 Data API
- RFC 7807、Trace ID、ETag/If-Match、Idempotency-Key、cursor 和持久/实时双 SSE
- Desktop safeStorage 与 Headless AES-256-GCM 凭据存储
- Web/Desktop 共用 React UI、生成式 Client、TanStack Query 和静态签名 UI Contribution Registry

## 架构概要

```text
Web / Electron Renderer
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

开发环境需要 Bun 1.4、Python 3.12 与 uv；最终 Desktop 安装包不要求用户安装 Bun、Node、Python、uv、Docker、PostgreSQL 或 Redis。

```bash
bun install
bun run worker:sync
bun run desktop:browser
bun run dev
```

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

## Headless/Web 开发与发布

```bash
cp .env.example .env
bun install
bun run worker:sync
bun run browser:install
bun run dev:headless
```

Headless 使用 PostgreSQL 与 Redis，但与 Desktop 运行同一 Product API、Plugin graph 和 Client conformance。数据库由 Plugin migrations 在 Runtime 启动时初始化，不再使用旧 Drizzle migration chain。

Linux x64 发布任务会生成：

```text
apps/api/dist/headless/
  linux-x64/
    zhiyun-api
    analytics-worker/linux-x64/analytics-worker/
    node_modules/
    SHA256SUMS
  zhiyun-headless-1.0.0-linux-x64.tar.gz
```

在 Linux x64 构建机执行：

```bash
bun run worker:build
bun run --filter @zhiyun/api package:linux
bun run --filter @zhiyun/api test:packaged
docker build -f apps/api/Dockerfile -t zhiyun-headless:1.0.0 .
```

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

Headless production 必须提供 base64 编码的 32-byte `ZHIYUN_CREDENTIAL_KEY` 和至少 32 字符的 `ZHIYUN_ADMIN_TOKEN`。Desktop Renderer 不具备凭据、文件、数据库、Python Client或业务 IPC 权限。

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
bun run test:e2e:web
bun run test:e2e:desktop
bun run test:smoke:desktop-package
bun run release:verify
```

## 工作区

```text
apps/          Desktop、Web、Headless API 与 Linux Image
packages/      Kernel、Runtime、Gateway、Client、UI、平台公共组件
plugins/       Collection、Datasets、Outputs、Preferences、Analytics、Corpus、AI Assistance
capabilities/  SQLite/PostgreSQL、Local/Redis Queue、Artifact、Worker Client
services/      Python Analytics Worker
profiles/      desktop-studio、headless-server、safe、test、e2e
fixtures/      E2E 测试站点
docs/          ADR、架构、Catalog 与验收基线
```

1.0 不建设 Level 3 Extension Host、第三方插件/SDK/Marketplace、热加载、独立 Analytics 微服务、Celery/Kafka/NATS、向量数据库、Embedding 或 RAG。

## License

Apache-2.0
