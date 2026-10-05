# ZhiYun Level 2 TS/Python 大重构架构方案

> 2026-09-10 更新：本文中的浏览器工作台、Headless 启动和独立发行内容属于历史方案，已由 [应用入口收敛决策](../adr/0011-desktop-cloud-apps.md) 替代；本地 Runtime、SQLite、插件与 Worker 的边界继续保留。

> 后续调整（2026-09-10）：数据库与队列现已统一 SQLite；本文保留历史决策，当前部署以 [SQLite 统一存储记录](../adr/0010-unified-sqlite.md) 为准。

> 目录调整（2026-09-12）：本文中的 `apps/`、`packages/`、`services/` 是方案当时的历史路径。当前本地产品实现位于 `desktop/`，商业平台位于 `platform/`，详见 [仓库布局](./REPOSITORY_LAYOUT.md)。

> 文档类型：Project Architecture Proposal
>
> 文档状态：Accepted
>
> 版本：1.0
>
> 更新时间：2026-08-28
>
> 适用范围：ZhiYun Desktop、Web、Headless、数据分析与语料库能力

## 1. 结论

ZhiYun 下一阶段大重构采用：

```text
Level 2 大型封闭项目架构
+ Local-first 模块化单体
+ 第一方 Internal Plugin Runtime
+ TypeScript 控制面
+ Python 分析计算侧车
```

不继续扩张当前 Level 1 的单体 Runtime，不升级 Level 3 第三方开放插件平台，也不把每个业务域拆成独立 localhost 微服务。

本方案保留当前已经建立的 Client / Runtime / Host 宏观边界，只重构 Runtime 内部的组合方式、领域边界、数据所有权和分析计算能力。

相关规范：

- [通用桌面架构基线](./desktop/DESKTOP_ARCHITECTURE_BASELINE.md)
- [Level 1 小型项目版](./desktop/DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md)
- [Level 2 大型封闭项目版](./desktop/DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md)
- [Level 3 大型开放项目版](./desktop/DESKTOP_ARCHITECTURE_LEVEL3_LARGE_OPEN_FINAL.md)
- [ZhiYun 桌面化改造分析](./desktop/ZHIYUN_DESKTOP_MIGRATION_ANALYSIS.md)
- [当前 Level 1 实现架构](../architecture.md)

## 2. 为什么从 Level 1 升级到 Level 2

现有 Level 1 的宏观架构是正确的，以下边界必须继续保留：

- Electron Renderer 只负责 UI、交互和 Client cache；
- Core Runtime 是持久业务状态和工作流的事实源；
- Renderer 通过 HTTP / SSE 调用 Runtime，不使用业务 IPC；
- Electron Main 只负责宿主能力、应用生命周期和进程监督；
- Desktop 默认使用 SQLite，Headless 使用 PostgreSQL；
- Runtime 可由 Electron `utilityProcess` 或 Bun Headless 独立启动；
- Runtime 不依赖 Electron 才能运行；
- Python、Playwright Browser 等外部进程不拥有产品业务状态。

当前实现已经出现多个 Level 2 触发信号：

- `packages/runtime/src/index.ts` 已约 3186 行，同时包含路由、调度、采集编排、数据集、输出、偏好、趋势、检查和导出等职责；
- `Repository` Contract 同时覆盖任务、规则、运行、数据集、偏好、趋势和输出等多个业务域；
- SQLite 与 PostgreSQL 分别维护大型 Repository 实现，新增领域通常需要同时修改 Contract、两个 Repository、Runtime、OpenAPI、Client 和 UI；
- 数据分析将引入分析任务、方法注册、结果、制品和 Python Worker 生命周期；
- 语料库将引入清洗、去重、分块、语料版本和导出等独立业务状态；
- Runtime、Python、Playwright、调度器和输出任务具有不同的资源与故障生命周期；
- 路由、事件、表、迁移、后台工作和 UI 页面已经需要明确所有者。

这些信号符合 Level 1 文档定义的升级条件：业务域快速增长、模块需要独立生命周期、注册关系难以追踪、需要产品 Profile，以及跨模块数据所有权开始模糊。

原桌面化迁移方案中“第一阶段不实现 Level 2”仍是正确的阶段性决策。当前桌面基线已经形成，且产品范围新增分析和语料库，因此应通过新的 ADR 将项目从 Level 1 升级为 Level 2，同时保留 ADR 0006 中的 Electron、HTTP、Host Capability、SQLite 和 Headless conformance 决策。

## 3. 目标架构

```text
Electron Host / Headless Launcher
├── Renderer
│   └── React UI Shell + Built-in UI Contributions
│            │
│            │ HTTP / SSE / OpenAPI Client
│            ▼
├── Core Runtime
│   ├── Runtime Gateway
│   │   └── Auth / Session / HTTP / SSE / OpenAPI
│   ├── Minimal Kernel
│   │   └── Graph / Lifecycle / Effect / Migration / Diagnostics
│   └── Effective Core Graph
│       ├── Collection Plugin
│       ├── Dataset Plugin
│       ├── Output Plugin
│       ├── Analytics Plugin
│       ├── Corpus Plugin
│       ├── Preferences Plugin
│       └── AI Assistance Plugin
│
├── Python Analytics Worker
│   └── Polars / DuckDB / SciPy / statsmodels / scikit-learn
│
└── Browser Engine
    └── Crawlee / Playwright / Chromium
```

### 3.1 Level 2 Plugin 的含义

本方案中的 Plugin 是第一方、有稳定边界的业务模块或可替换平台能力，不是用户可安装的第三方插件。

要求：

- 所有 Plugin 代码随产品一起构建、签名和发布；
- 用户不能安装任意代码；
- 不提供第三方 Public Plugin SDK；
- 不加载未签名远程代码或动态 UI bundle；
- 不建设 Permission、Trust、Extension Marketplace；
- Production Graph 启动后保持 immutable；
- Profile 或 Bundle 改变时重启 Runtime，不承诺运行期热加载；
- 大多数 Plugin 仍在同一个 Core Runtime 进程内运行。

因此，Level 2 描述的是逻辑模块化和生命周期治理，不等于微服务化。

### 3.2 Minimal Kernel

Kernel 只负责平台机制：

```text
graph resolution and validation
lifecycle
effect tracking
typed services and capabilities
event infrastructure
migration coordination
contribution staging
diagnostics
```

Kernel 不包含任务、数据集、分析、语料库等领域业务，也不提供可以任意取得全局对象的万能 Service Locator。

正式组合层级为：

```text
Plugin
  ↓
Bundle
  ↓
Product Profile
  ↓
Effective Core Graph Revision
```

每次有效组合拥有明确的 Profile、Bundle 版本、Plugin 版本、Contract 版本和配置 fingerprint。

## 4. 领域划分与数据所有权

只建立稳定的 Bounded Context Plugin，不把普通 Entity、React Component、Utility 或单个分析按钮做成 Plugin。

| Plugin          | 主要职责                                     | 数据所有权                                          |
| --------------- | -------------------------------------------- | --------------------------------------------------- |
| `collection`    | 任务、规则、运行、采集编排、运行日志         | tasks、rules、runs、run_logs、run_requests          |
| `datasets`      | 原始记录、数据集投影、快照、变化记录         | records、dataset_records、dataset_changes           |
| `outputs`       | Webhook、PostgreSQL、Data API、导出交付      | output_bindings、deliveries                         |
| `analytics`     | 分析任务、方法注册、结果、图表数据、分析制品 | analysis_jobs、analysis_results、analysis_artifacts |
| `corpus`        | 清洗、去重、分块、语料版本、语料导出         | corpora、documents、chunks、corpus_versions         |
| `preferences`   | 用户偏好信号、趋势源绑定                     | preference_signals、trend_bindings                  |
| `ai-assistance` | 规则生成、结构建议、AI Provider 编排         | AI 调用记录和领域配置                               |

以下属于 Replaceable Platform Capability，不属于业务 Plugin：

```text
storage
queue
scheduler
crawler.engine
analytics.worker
credential.store
artifact.store
event.bus
telemetry
```

### 4.1 跨 Plugin 协作

跨 Plugin 只允许使用：

- versioned stable contract；
- typed service；
- capability；
- public domain event；
- owner 提供的只读 projection。

禁止：

- 导入另一个 Plugin 的实现；
- 直接查询另一个 Plugin 拥有的表；
- 获取另一个 Plugin 的 Repository；
- 将 Raw SQLite、Drizzle DB 或全局 Runtime Context 暴露给 Plugin；
- 形成循环依赖。

Plugin 依赖图必须是 DAG，并在 Runtime 启动前完成 unknown dependency、missing capability、cycle、version conflict 和 duplicate contribution 校验。

### 4.2 Repository 拆分

当前全局 `Repository` 应拆分为领域 Contract：

```text
CollectionRepository
DatasetRepository
OutputRepository
AnalyticsRepository
CorpusRepository
PreferencesRepository
```

SQLite 和 PostgreSQL 分别实现这些 Contract，并共享 conformance tests。每张表、索引、迁移、事件和 operationId 必须有唯一 owner。

## 5. TypeScript 与 Python 分工

### 5.1 TypeScript：产品控制面

TypeScript 继续负责：

- Electron、Web 和共享 React UI；
- HTTP API、SSE、认证、幂等、ETag 和 OpenAPI；
- 任务、规则、运行、数据集、语料库和分析任务的业务状态；
- 队列、调度、取消、重试和故障恢复；
- SQLite/PostgreSQL 业务持久化；
- Python Worker 监督、限流和任务分发；
- 凭据、文件授权、Artifact 和 Desktop Capability；
- 分析结果校验、持久化和展示；
- AI Provider。

现有 AI Provider 继续保留在 TypeScript，不因引入分析 Worker 而重新迁移到 Python。

### 5.2 Python：分析计算面

Python 只负责：

- 数据清洗和类型推断；
- 描述性统计和数据质量；
- 分布、相关性、异常值和时间趋势；
- 分组聚合和统计检验；
- 回归和时间序列；
- 聚类、降维和异常检测；
- 文本特征、语料清洗、去重和分块。

Python Worker 不得：

- 直接写 SQLite/PostgreSQL 业务数据库；
- 持有产品凭据；
- 直接控制 Electron；
- 自行决定业务 Job 状态；
- 监听可被外部访问的地址；
- 接受任意 Python 代码执行；
- 成为第二套业务 Backend；
- 拥有任务、数据集、分析结果或语料库的权威状态。

## 6. 数据分析技术栈

采用 Polars-first，而不是 pandas-first。

| 技术               | 决策            | 主要用途                                               |
| ------------------ | --------------- | ------------------------------------------------------ |
| Polars             | 核心采用        | 清洗、聚合、缺失值、分组、窗口、时间预处理和大数据扫描 |
| DuckDB             | 核心采用        | 针对 Parquet/Arrow 的 SQL、Join、复杂聚合和临时分析    |
| NumPy              | 基础依赖        | 数值数组和科学计算兼容层                               |
| SciPy              | 核心采用        | 统计检验、概率分布、优化、插值和距离计算               |
| pandas             | 兼容边界        | 仅在 statsmodels 或第三方算法要求 DataFrame 时转换     |
| statsmodels        | 第二阶段采用    | OLS/GLM、显著性、置信区间、ARIMA 和统计诊断            |
| scikit-learn       | 第二阶段采用    | 聚类、PCA、Isolation Forest、分类、回归和 TF-IDF       |
| PyArrow/Parquet    | 数据交换采用    | TS/Python 之间的大数据快照和结果制品                   |
| FastAPI + Pydantic | Worker 控制协议 | 方法发现、任务、进度、取消、健康检查和 OpenAPI         |
| ECharts            | UI 图表         | 在 React 内渲染结构化分析结果                          |

Polars 是主要 DataFrame 引擎。pandas 被限制在算法兼容 Adapter 中：

```text
Polars
  → NumPy / pandas compatibility adapter
  → statsmodels or legacy algorithm
  → structured result
```

DuckDB 是分析引擎，不替代 SQLite/PostgreSQL 成为业务数据库。它只读取受控的不可变分析快照和临时文件。

## 7. 分析任务模型

### 7.1 数据流

```text
用户选择数据集版本
    ↓
Runtime 创建 AnalysisJob
    ↓
冻结 sourceRunId / datasetVersion / fingerprint
    ↓
生成不可变 Arrow/Parquet 输入制品
    ↓
Python Worker 执行内置 Method
    ↓
返回 metrics / tables / series / warnings / artifacts
    ↓
Runtime 校验并持久化结果
    ↓
SSE 通知 UI
    ↓
React + ECharts 展示
```

### 7.2 Job 状态

建议状态：

```text
queued
→ preparing
→ running
→ persisting
→ succeeded

queued/running
→ canceling
→ canceled

any active state
→ failed
```

Runtime 是 Job 状态权威。Worker 崩溃、超时或被强制终止时，Runtime 根据 retry policy 将 Job 标记为 failed 或重新排队。

### 7.3 结果溯源

每个结果至少记录：

```text
analysisJobId
methodId
methodVersion
parameters
datasetId
sourceRunId
datasetFingerprint
schemaFingerprint
workerVersion
startedAt
completedAt
warnings
result artifacts
```

相同 Dataset fingerprint、Method version 和参数可以安全复用缓存结果。

### 7.4 Method Registry

分析方法通过 Registry 注册：

```text
id
version
category
display metadata
supported field types
parameter JSON Schema
resource limits
output schema
recommended chart types
```

UI 根据注册信息生成按钮和参数表单，但只加载构建期登记、随应用签名的结果组件。Python 不能动态注入前端代码。

第一批内置分析方法：

- 数据概况；
- 缺失值和重复值；
- 描述性统计；
- 分类字段分布；
- 分组聚合；
- 相关性分析；
- 异常值检测；
- 时间趋势；
- 文本长度、词频和关键词；
- 数据质量报告。

第二批方法：

- 回归与置信区间；
- 假设检验；
- 聚类；
- PCA；
- 时间序列分析与预测；
- 机器学习异常检测；
- TF-IDF 和文本分类。

## 8. Python Worker 边界

### 8.1 监督与通信

Desktop 中由 Electron Host/Engine Supervisor 启动和监督 Worker；Headless 中由 API Launcher 或受控容器监督。

控制协议采用私有 loopback HTTP/JSON：

- 监听 `127.0.0.1:0`；
- 每次启动生成随机 token 和 generation；
- ready handshake 返回实际端口、版本和 capability；
- Runtime 与 Worker 的 Contract 通过 OpenAPI 生成 TypeScript Client；
- 大数据不放入 JSON body，通过受控 Artifact/Job Workspace 传递 Arrow/Parquet；
- 日志、诊断和命令行不得包含 token、数据内容、凭据或不必要的绝对路径。

Worker 必须支持：

```text
health
capabilities
methods
execute
progress
cancel
shutdown
```

### 8.2 资源治理

每个 Job 必须拥有：

- 独立临时工作目录；
- CPU、内存、输入大小和执行时间限制；
- Abort/cancel channel；
- 最大并发限制；
- 结构化日志和 Trace ID；
- 完成或失败后的确定性清理；
- Runtime 可执行的 hard kill 兜底。

Python Worker 默认不拥有外部网络能力。未来确实需要下载模型或资源时，应通过单独的、受限的平台 Capability 实现。

## 9. 语料库领域

语料库不是简单保存分析结果，而是独立、有版本的生产流水线：

```text
Dataset Snapshot
→ 字段选择
→ 文本规范化
→ 空值和噪声清理
→ 精确/近似去重
→ 语言识别
→ 分块
→ 元数据附加
→ Corpus Version
→ JSONL / Parquet / Markdown Export
```

每个 Corpus Version 必须记录：

- 来源 Dataset、Run 和 fingerprint；
- 字段映射；
- 清洗规则版本；
- 去重算法和参数；
- 分块策略和参数；
- 文档数、分块数、字符数和错误统计；
- 构建工具版本；
- 输出 Artifact。

第一阶段不引入向量数据库。先形成稳定、可重建的语料版本；当产品明确需要语义检索或 RAG 时，再将 Embedding Provider 和 Vector Index 建模为可替换 Capability，并按实际部署需求选择 LanceDB、Qdrant 或其他实现。

## 10. 完整技术栈

### 10.1 TypeScript 侧

- Bun Workspaces：安装、开发、构建、测试和 Headless Runtime；
- TypeScript strict mode；
- Electron + `utilityProcess`：Desktop Host 和独立 Runtime；
- Fastify：Runtime Gateway；
- Zod + OpenAPI + 生成式 Client：产品 HTTP Contract；
- React 19 + Vite + React Router：共享 UI；
- TanStack Query：HTTP Server State；
- 现有 Connection Manager：generation、重连和 SSE；
- ECharts：分析图表；
- Drizzle ORM：Schema 与存储 Adapter；
- Desktop：SQLite + `better-sqlite3`；
- Headless：PostgreSQL + `postgres.js`；
- Desktop Queue：SQLite Durable Queue；
- Headless Queue：Redis + BullMQ；
- Pino + OpenTelemetry：跨 Runtime、Worker 和 Browser 的日志与 Trace。

TanStack Query 不替代 Server Connection Manager。连接协商、generation 变化、SSE replay 和旧请求中止仍由专用 Client 层负责。

### 10.2 Python 侧

- CPython 3.12 作为构建基线；
- `uv` 只用于开发、锁依赖和构建；
- FastAPI + Pydantic v2；
- Polars + DuckDB；
- NumPy + SciPy；
- pandas compatibility adapter；
- statsmodels；
- scikit-learn；
- pytest + Hypothesis；
- PyInstaller `onedir` 生成各平台 Worker。

Desktop 安装包自带签名 Worker，最终用户不需要安装 Python、uv 或任何分析库。

### 10.3 Contract 真相源

产品 HTTP API：

```text
Zod schema
→ Product OpenAPI
→ generated @zhiyun/client
```

Python Worker API：

```text
Pydantic model
→ Worker OpenAPI
→ generated TypeScript Worker Client
```

不得在 TypeScript 和 Python 中手写两份同名 Transport Contract。CI 必须检查 OpenAPI 和生成 Client 漂移。

## 11. Product Profile 与 Bundle

推荐 Bundle：

```text
core-data
  = collection + datasets + outputs

intelligence-core
  = analytics-core + corpus + ai-assistance

intelligence-advanced
  = statsmodels methods + scikit-learn methods
```

推荐 Product Profile：

| Profile           | 说明                                       |
| ----------------- | ------------------------------------------ |
| `desktop-studio`  | 完整桌面功能和本地 Python Worker           |
| `headless-server` | PostgreSQL/Redis 和受监督分析 Worker       |
| `safe`            | 禁用外部输出、可选禁用 Browser/AI/高级分析 |
| `test`            | 内存或临时存储、Mock Capability            |
| `e2e`             | 固定 Fixture、确定性 Worker 方法           |

Profile 是官方构建形态，不是用户随意安装插件的集合。

## 12. 推荐仓库结构

```text
apps/
  desktop/
  web/
  api/

packages/
  kernel/
  runtime-gateway/
  contracts/
  client/
  ui-shell/
  platform-core/

packages/plugins/
  collection/
  datasets/
  outputs/
  analytics/
  corpus/
  preferences/
  ai-assistance/

packages/capabilities/
  storage-sqlite/
  storage-postgres/
  queue-local/
  queue-redis/
  crawler-engine/
  analytics-worker-client/
  credential-store/
  artifact-store/

services/
  analytics-worker/
    pyproject.toml
    src/
    tests/
    packaging/

packages/profiles/
  desktop-studio/
  headless-server/
  safe/
  test/
  e2e/
```

目录不应一次性机械拆完。先建立依赖方向、Contract、Kernel 和所有权，再按领域逐步移动文件。

## 13. 分阶段重构计划

### 13.1 阶段 0：建立可回退基线

当前仓库尚无正式 Git commit。在开始结构调整前必须：

1. 创建完整基线 commit 和 tag；
2. 固定可重复通过的 CI；
3. 保存 SQLite/PostgreSQL Schema 和关键测试快照；
4. 建立数据备份、恢复和迁移回滚预案；
5. 记录 Desktop 安装包和 Chromium 资源体积基线；
6. 完成依赖审计和发布链检查；
7. 冻结现有 HTTP、OpenAPI 和行为 conformance baseline。

### 13.2 阶段 1：引入 Minimal Kernel

在不改变现有业务行为的前提下：

- 创建 Plugin Descriptor；
- 创建 Typed Service Contract；
- 实现 Graph resolve/validate；
- 实现 Effect Registry 和逆序 cleanup；
- 实现 Plugin → Bundle → Profile → Graph Revision；
- 生成路由、表、事件、服务和 UI Contribution 所有权清单；
- 使用 immutable production graph；
- 暂时把当前业务包装为 Legacy/Core Plugin。

### 13.3 阶段 2：拆分业务域

推荐顺序：

```text
preferences
→ outputs
→ datasets
→ collection
```

每次只迁移一个领域的：

- Contract；
- domain/application implementation；
- Repository；
- SQLite/PostgreSQL adapter；
- migrations；
- routes；
- services/events；
- UI Contribution；
- conformance tests。

目标是让 `buildRuntime()` 只负责组合，不再包含具体业务路由和工作流实现。

### 13.4 阶段 3：Analytics Plugin 与 Python Worker

- 建立 AnalysisJob 和 AnalysisResult；
- 建立 Method Registry；
- 实现 Worker Supervisor；
- 实现随机端口、token、generation 和 ready handshake；
- 建立 Arrow/Parquet 数据交换；
- 实现进度、取消、超时、hard kill 和故障恢复；
- 完成第一批 Polars/DuckDB/SciPy 分析按钮；
- 确保 Python 崩溃不会导致 Core Runtime 崩溃。

### 13.5 阶段 4：Corpus Plugin

- 语料项目和语料版本；
- 字段映射；
- 文本清洗、去重和分块；
- JSONL/Parquet/Markdown 导出；
- 版本 provenance 和统计；
- 与 Dataset Snapshot 复用数据制品，但保持独立数据所有权。

### 13.6 阶段 5：高级分析与发布

- statsmodels 回归、显著性和时间序列；
- scikit-learn 聚类、PCA、异常检测和文本特征；
- Worker 跨平台构建、签名和公证；
- 清洁机器安装、升级和回滚测试；
- Python/Chromium/Desktop 安装包体积预算；
- 根据体积和使用率决定高级分析是否作为官方可选 Bundle。

### 13.7 阶段 6：删除 Legacy Runtime

只有当所有领域完成迁移并通过 conformance 后：

- 删除旧全局 Repository；
- 删除旧 Runtime 中的领域路由；
- 删除临时兼容 Adapter；
- 固化 Architecture Catalog；
- 更新 ADR 0006 状态和目标架构文档。

## 14. 测试与架构门禁

除现有测试外，增加：

```text
plugin unit / integration
dependency graph
profile / bundle
activation rollback
effect leak
migration ownership
domain event replay
effective OpenAPI
UI contribution resolution
Python Worker contract
analysis method golden test
analysis property test
job cancel / timeout / crash / restart
dataset fingerprint reproducibility
corpus version reproducibility
desktop packaged Worker smoke
```

CI 应拒绝：

- cross-plugin implementation import；
- unowned table、migration、route、event 或 operationId；
- Plugin 获得 Raw DB 或其他 Plugin Repository；
- 未登记的 timer、listener、worker、watcher、stream 或 child process；
- Renderer 直接调用 Python Worker；
- Renderer business IPC 或直接导入 Runtime 实现；
- Python Worker 直接写业务数据库；
- Product OpenAPI、Worker OpenAPI 和生成 Client 漂移；
- migration checksum 漂移；
- 日志包含 token、credential、敏感数据或不必要绝对路径；
- Profile/Bundle/Graph 无法确定性解析；
- Worker 崩溃后 Job 永久停留在 running。

## 15. 发布与体积策略

Desktop 当前已经包含 Electron 和 Playwright Chromium，Python 科学计算栈会进一步增加制品体积。必须把体积作为架构指标，而不是发布末期问题。

建议：

- Worker 使用 PyInstaller `onedir`，避免 `onefile` 的解压和启动开销；
- Core Analytics 首先只打包 Polars、DuckDB、NumPy 和 SciPy；
- statsmodels/scikit-learn 作为 Advanced Analytics Bundle 评估；
- 删除 Python package 中的 tests、cache、开发元数据和未使用资源；
- 各平台单独构建和签名，不发布通用跨平台 Worker；
- Worker version、Python version 和 dependency lock 写入诊断信息；
- 安装包在没有 Bun、Node、Python、uv、Docker、PostgreSQL 和 Redis 的干净机器上验收。

## 16. 明确不采用

本次重构不采用：

- Level 3 第三方插件架构；
- Marketplace、公共 Plugin SDK 或动态远程 UI；
- 每个业务 Plugin 一个微服务；
- Python 进入 Electron Renderer；
- Python Worker 直接写业务数据库；
- DuckDB 替代 SQLite/PostgreSQL；
- Celery、Kafka、NATS 等额外分布式基础设施；
- pandas-first 的主数据处理架构；
- 运行期 Plugin 热加载；
- 一次性推倒重写；
- 在第一阶段引入向量数据库；
- 因引入分析 Worker 而将现有 AI Provider 改回 Python。

## 17. 验收标准

架构重构完成至少满足：

1. `buildRuntime()` 只负责组合，领域路由和工作流位于各自 Plugin；
2. 所有业务表、迁移、路由、事件和 UI Contribution 都有唯一 owner；
3. Plugin 之间不存在 implementation import 或直接跨域数据库访问；
4. Desktop、Headless、Safe、Test 和 E2E Profile 可确定性启动；
5. Runtime、Python Worker 和 Browser 的长期资源均有 supervisor 和 cleanup owner；
6. Python Worker 崩溃、超时、取消和重启行为有故障测试；
7. AnalysisResult 可通过 Dataset fingerprint、Method version 和参数复现；
8. Corpus Version 可追溯到来源 Dataset/Run 和处理规则版本；
9. Desktop 安装包不依赖系统 Python 或 uv；
10. Product API 和 Worker API 都通过生成 Client 使用；
11. SQLite/PostgreSQL 对各领域 Repository 通过相同 conformance tests；
12. 所有架构门禁进入 CI；
13. 清洁机器上的安装、升级、回滚和分析 Worker smoke test 通过。

## 18. 最终原则

```text
目标架构要大，迁移步子要小。

逻辑上升级到 Level 2，
部署上保持模块化单体。

TypeScript 掌握业务状态和控制权，
Python 专注可替换、可监督、无状态的分析计算。
```

这套架构允许 ZhiYun 将常见分析方法和语料生产能力直接集成到软件中，同时不破坏已经建立的 Electron 安全边界、Client/Runtime/Host 分层、Local-first 数据模型和 Headless 兼容能力。
