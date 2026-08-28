# ZhiYun 织云桌面化改造分析

> 文档类型：Project Architecture Analysis
>
> 状态：Implemented
>
> 更新时间：2026-08-27
>
> 适用范围：ZhiYun 第一阶段 MVP 向 Local-first 桌面软件演进
>
> 架构级别：Level 1

## 实施结果（2026-08-27）

本分析中的 Level 1 目标已经落地。实际实现采用 `packages/runtime` 依赖注入、`/api/v1`、生成式 `packages/client`、共享 `packages/ui`、Desktop SQLite/Local Queue、Headless PostgreSQL/Redis、Electron `utilityProcess` Supervisor 和 Host Capability API。Python AI sidecar 方案未采用，`services/ai` 已删除并由 `packages/ai-runtime` TypeScript Provider 替代。

macOS arm64 的 Electron E2E、应用目录启动 smoke、DMG/ZIP 生成及完整性检查已通过；macOS x64 和 Windows x64 由目标平台 CI matrix 构建。本文后续的“当前差距”“推荐结构”和阶段章节保留为决策过程记录，实施后的权威架构说明以 [`docs/architecture.md`](../../architecture.md) 与 ADR 0006 为准。

## 1. 结论

ZhiYun 可以改造为桌面软件，但不应只是给现有 Web 页面套一层 Electron。项目应采用桌面架构文档定义的 Level 1：保留独立 Core Runtime，以 Electron 作为 Desktop Host，不引入 Plugin Kernel、Bundle、Profile、Marketplace 或第三方扩展平台。

选择 Level 1 的原因：

- 当前是单一产品目标；
- 业务能力全部由官方维护；
- 当前团队和业务域规模不需要动态组合；
- 没有用户安装第三方代码的需求；
- 现有 Fastify HTTP API 已经具备 Client / Runtime 边界的基础；
- 未来若达到多业务域、多团队和多产品形态的规模，仍可在不改变 HTTP C/S 宏观边界的情况下升级到 Level 2。

参考：

- [通用桌面软件架构基线](./DESKTOP_ARCHITECTURE_BASELINE.md)
- [Level 1 小型项目版](./DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md)
- [Level 2 大型封闭项目版](./DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md)
- [Level 3 大型开放项目版](./DESKTOP_ARCHITECTURE_LEVEL3_LARGE_OPEN_FINAL.md)

## 2. 目标架构

```text
Electron Desktop Host
├── Window / Menu / Tray
├── Runtime Supervisor
├── File / Credential / Notification Capability
└── Preload：只提供一次性 bootstrap metadata
          │
          ▼
React Renderer
└── Server Connection Manager
          │ REST / JSON / SSE
          │ per-start token
          ▼
Core Runtime（Electron utilityProcess）
├── Fastify HTTP API
├── Task / Rule / Run Application Services
├── SQLite
├── Local Scheduler / Worker
├── Crawlee / Playwright
└── TypeScript AI Provider
```

宏观职责保持为：

```text
Desktop / Web / CLI Client
        │
        │ Server Connection Manager
        │ REST / JSON / SSE / OpenAPI
        ▼
Independent Core Runtime
        │
        │ Versioned Host Capability API
        ▼
Desktop Host / Native Capability Providers
```

关键原则：

1. Renderer 只负责 UI、交互和 Client cache。
2. Electron Main 不承载任务、规则、采集或数据存储等业务逻辑。
3. Renderer 不使用 Electron IPC 调用业务能力。
4. Core Runtime 不导入 Electron，并继续支持 Bun Headless 启动。
5. Runtime 是任务、规则、运行记录和采集数据的唯一业务事实源。
6. Desktop Host 只负责应用生命周期、进程监督和原生能力。
7. Python、Playwright Browser 等外部进程不能拥有产品业务状态。

## 3. 技术选择

### 3.1 Desktop Host 使用 Electron

Electron 是当前项目成本最低、风险最可控的选择：

- Crawlee、Playwright、Fastify 和当前 TypeScript 代码均建立在 Node-compatible 生态之上；
- Electron `utilityProcess` 可以承载使用 Electron 内嵌 Node 的独立 Runtime；
- 现有 React/Vite UI 可以复用；
- Host 与 Runtime 可以保持清晰进程边界；
- 不需要额外依赖用户机器上的系统 Node。

不建议当前改用 Tauri。Tauri 会使现有 TypeScript Runtime 成为额外 sidecar，并增加 Node/Bun 可执行文件分发、进程监督和跨平台打包复杂度。

Electron Renderer 必须使用：

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
strict Content-Security-Policy
deny arbitrary navigation
deny unvalidated new windows
deny unvalidated external URLs
```

生产 Renderer 应使用受控自定义协议，例如 `app://zhiyun`，避免直接使用 `file://`。开发模式可以加载固定的 Vite Origin。

参考：

- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

### 3.2 Bun 与 Electron Runtime 的关系

```text
安装、开发、构建、测试、生成、打包 = Bun 1.4+
Headless / Server Runtime           = Bun
Desktop Runtime                     = Electron embedded Node
系统 Node                            = 不允许成为运行依赖
```

当前 Runtime 依赖的 Bun-specific API 必须限制在 Adapter 中。`run.ts` 等开发脚本不进入桌面安装包。

Electron `utilityProcess` 只能执行构建后的 JavaScript，不能依赖 Bun 在用户机器上实时执行 TypeScript。因此当前仅运行 `tsc --noEmit`、并从 workspace 导出 TypeScript 源码的方式需要改为生成真实的 ESM JavaScript 产物。

## 4. 当前实现与目标状态的差距

| 当前实现                                 | 桌面目标                                           |
| ---------------------------------------- | -------------------------------------------------- |
| Headless API 固定监听 `0.0.0.0:45300`    | Desktop 模式监听 `127.0.0.1:0`，由系统分配端口     |
| 开发环境允许任意 CORS                    | 只允许 `app://zhiyun` 和明确的开发 Origin          |
| API 没有认证                             | 每次启动生成 token、runtime ID 和 generation       |
| React 使用相对路径直接 `fetch`           | 使用统一 Server Connection Manager 和生成式 Client |
| PostgreSQL + Redis + Docker              | 桌面默认 SQLite + 进程内持久队列                   |
| BullMQ/Redis 负责队列、Cron 和锁         | SQLite job/lease + 单 Runtime scheduler            |
| Cookie、代理密码、storage state 明文入库 | 数据库只保存 `credentialRef`                       |
| 导出接口直接返回浏览器下载               | Runtime 生成 `artifactRef`，Host 完成保存授权      |
| Python 服务依赖系统 `uv`                 | 迁移为 TS Provider 或打包为签名 sidecar            |
| Playwright 使用开发机浏览器缓存          | Chromium 作为应用资源或受控下载                    |
| Run 状态由 Renderer 轮询                 | SSE 进度流、heartbeat、cursor 和断线恢复           |
| TypeScript 包只检查类型                  | 生成 Electron Node 可执行的 JavaScript 产物        |

主要代码耦合点：

- `apps/api/src/server.ts` 固定监听地址和端口；
- `apps/api/src/app.ts` 直接创建数据库、队列、Worker 和 Crawler；
- `packages/storage` 导出全局 PostgreSQL 连接与 Drizzle 实例；
- `packages/scheduler` 直接依赖 BullMQ 和 Redis；
- `apps/web/src/api.ts` 直接调用相对 URL，缺少认证、协商和重连；
- 导出按钮直接使用 API 下载 URL，无法注入桌面认证和文件授权。

## 5. 推荐仓库结构

```text
apps/
  desktop/
    src/main/              Electron Main
    src/preload/           只提供 bootstrap metadata
    src/renderer/          Desktop Renderer 入口
    forge.config.ts
  web/                     保留浏览器版入口
  api/                     Bun Headless 启动器

packages/
  runtime/                 Core Runtime 与组合根
  contracts/               Zod、OpenAPI、Problem Details、事件
  client/                  HTTP Client、认证、重连、SSE
  ui/                      Web/Desktop 共用 React UI
  desktop-host/            Supervisor 与原生 Capability
  storage/
    core/                  Repository 接口和迁移模型
    sqlite/                Desktop Local-first adapter
    postgres/              可选 Headless adapter
  scheduler/
    core/                  Queue/Scheduler contract
    local/                 SQLite durable queue
    redis/                 可选 Headless adapter

services/ai/               可选 Python AI sidecar
tests/desktop/             Electron E2E 与故障测试
```

目录不必一次性机械拆完。优先建立依赖方向和进程边界，再逐步移动文件。

## 6. Core Runtime 改造

### 6.1 从 API 应用提取 Runtime

当前 `buildApp()` 同时负责 HTTP、数据库、队列、Worker、调度恢复和采集对象创建，需要改为显式依赖注入：

```ts
interface RuntimeDependencies {
  repositories: RuntimeRepositories;
  scheduler: Scheduler;
  runQueue: RunQueue;
  crawler: Crawler;
  aiProvider: AiProvider;
  hostCapabilities: HostCapabilities;
  authentication: RuntimeAuthentication;
}

const runtime = await buildRuntime(dependencies);
```

建议内部结构：

```text
packages/runtime/src/
  bootstrap/
  http/
  application/
  domain/
  repositories/
  tasks/
  adapters/
```

`apps/api` 最终只负责 Bun Headless 的配置和启动；`apps/desktop` 使用另一组合根，将相同 Runtime 放入 Electron `utilityProcess`。

### 6.2 生命周期

所有长期资源都必须有成对接口：

```text
start / stop
open / close
subscribe / unsubscribe
acquire / release
```

统一管理：

- Fastify listener；
- SQLite handle；
- scheduler timer；
- crawl worker；
- SSE connection；
- Playwright browser/process；
- Python AI sidecar；
- file watcher；
- Host Capability connection。

Runtime shutdown 顺序：

```text
停止接收 mutation
→ 停止新任务调度
→ 等待或取消正在执行的采集
→ 关闭 browser / AI sidecar
→ 关闭 HTTP / SSE
→ checkpoint / 关闭 SQLite
→ 向 Host 报告 stopped
```

## 7. Server Connection Manager 与本地认证

### 7.1 启动握手

Desktop Host 启动 Runtime 时：

1. 生成 `runtimeId`、`generation`、随机 token 和一次性 nonce；
2. 使用 `utilityProcess.fork()` 启动构建后的 Runtime；
3. 通过私有父子消息通道发送数据库位置、Host Capability 地址和启动密钥，不能放进命令行；
4. Runtime 监听 `127.0.0.1:0`；
5. Runtime 返回实际端口、runtime ID、generation 和 API version；
6. Preload 只向 Renderer 暴露冻结的 bootstrap metadata；
7. Renderer 使用 nonce 换取 Runtime session；
8. 后续业务调用全部使用 HTTP token。

Runtime 重启后必须更换 token 和 generation。Client 发现 generation 变化时必须：

- 中止旧 pending request；
- 丢弃旧 cache；
- 关闭旧 SSE；
- 重新协商版本与 capability；
- 只自动重试安全 GET、可重放事件和显式幂等 mutation。

### 7.2 最低 API

```text
GET /health
GET /api/v1/version
GET /api/v1/capabilities
GET /api/v1/runtime
GET /api/v1/events
```

业务 API 统一放入 `/api/v1`，并补充：

- OpenAPI 和稳定 `operationId`；
- RFC 7807 Problem Details；
- `Idempotency-Key`；
- `ETag` / `If-Match`；
- Cursor Pagination；
- Trace ID；
- AbortSignal 和 timeout；
- SSE heartbeat、replay cursor 和最终错误事件。

## 8. Local-first 数据与调度

### 8.1 SQLite

桌面安装包不应要求用户安装 Docker、PostgreSQL 或 Redis。默认持久层应迁移到 SQLite：

- PostgreSQL UUID default 改为 Runtime 生成 UUID；
- JSONB 改为 SQLite JSON/TEXT；
- PostgreSQL enum 改为受约束 text；
- timestamp 统一为 UTC epoch 或 ISO 8601；
- migrations 使用 forward-only、checksum 和 migration ledger；
- 数据库保存在 Host 提供的私有应用数据目录；
- Runtime 是唯一写入者；
- 启动时执行 integrity check；
- 升级前创建备份，并定义恢复策略。

SQLite driver 必须进行 Bun Headless 与 Electron Node 双运行时 conformance spike。优先使用一个可同时支持两个环境的 driver；若无法做到，则通过 Storage Adapter 分别实现，但共享 Repository contract、SQL 语义和迁移测试。

如果已有 PostgreSQL 用户数据需要保留，应提供一次性导出/导入工具；MVP 尚无正式数据时可以选择 clean migration。

### 8.2 本地持久队列

移除桌面版 BullMQ/Redis，新增：

```text
jobs
schedules
runtime_events
idempotency_keys
```

队列要求：

- Run 与 job 在同一事务创建；
- 原子 claim queued job；
- 使用 lease/heartbeat 识别崩溃；
- 同一 task 只允许一个 queued/running Run；
- Runtime 重启后恢复 queued job；
- 遗留 running job 按策略标记 interrupted、failed 或重新排队；
- 增加 `canceled` 状态和取消 API；
- Cron 仍使用五段表达式和时区。

桌面 MVP 建议定义为“应用窗口关闭后可驻留托盘继续调度，用户完全退出后停止”。如果要求应用完全退出后仍执行 Cron，需要额外建设 launchd/systemd/Windows Service，不应隐式混入第一阶段。

## 9. Desktop Host Capability

Runtime 通过独立、版本化且认证的 Host Capability API 使用原生能力。Host API 与 Runtime API 使用不同 token。

### 9.1 File / Directory / Export Grant

Renderer 和业务数据库不保存任意绝对路径，只使用：

```text
grantId
artifactRef
credentialRef
```

建议导出流程：

1. Renderer 请求 Runtime 生成导出；
2. Runtime 在受控 artifact 目录生成文件；
3. Runtime 返回 `artifactRef`；
4. Renderer 请求保存该 artifact；
5. Runtime 调用 Host Export Capability；
6. Host 显示保存对话框并完成复制；
7. Runtime 返回 saved/canceled 结构化结果。

### 9.2 Credential Reference

以下内容不得继续明文保存在任务 JSON 中：

- Cookie；
- Authorization 等敏感 header；
- proxy username/password；
- Playwright storage state；
- AI API key。

Host 负责凭据捕获和 OS-backed 安全存储，Runtime 只保存并使用 `credentialRef`。采集时 Runtime 按 scope 临时解析凭据，使用后从内存释放，日志中必须脱敏。

推荐 Electron `safeStorage` 异步 API。Linux 必须检查实际 storage backend；当只能使用不安全后端时，应警告用户或禁用长期敏感凭据。

参考：[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

### 9.3 其他 Capability

- 系统通知；
- Window 状态；
- 经过验证的外部 URL；
- Updater 状态；
- Playwright Engine 监督；
- 文件和目录授权。

Renderer 不直接获得 Electron business IPC、数据库连接、凭据明文或任意文件系统能力。

## 10. React UI 改造

现有 React 页面可以继续复用，但应抽离为共享 UI：

```text
packages/ui
├── app shell
├── task pages
├── rule pages
├── run pages
└── shared components
```

`apps/web` 和 `apps/desktop` 分别提供入口和连接配置。

需要修改：

- 将 `apps/web/src/api.ts` 替换为 `@zhiyun/client`；
- 删除散落的直接 `fetch`；
- 所有响应经过生成类型或 Zod 校验；
- 增加 Runtime 连接状态页面；
- 增加 restarting/degraded/disconnected/incompatible 状态；
- Run 进度从轮询迁移到 SSE；
- 下载链接迁移为 Artifact/Export Grant 流程；
- 外部链接通过 Host 验证后打开；
- language/theme 等纯 UI 偏好仍可存入 localStorage。

## 11. AI 服务策略

当前 FastAPI 服务在开发环境通过 `uv` 启动，不能作为最终桌面运行时前置条件。

### 方案 A：迁移到 TypeScript Runtime（推荐）

- 将 Mock Provider 和 OpenAI-compatible HTTP 调用迁移到 Runtime；
- 继续使用 Zod 验证输入输出；
- 减少一个进程和一套 Python 打包链；
- 降低安装包、升级和故障监督复杂度。

### 方案 B：保留 Python Sidecar

- 每个平台构建独立可执行文件；
- 作为签名资源随应用发布；
- 不依赖系统 Python 或 `uv`；
- 由 Host Supervisor 管理启动、健康、重启、日志和退出；
- 协议继续使用 HTTP 或改为 stdio/JSON-RPC；
- Sidecar 不拥有业务状态。

如果 PydanticAI 的能力是产品核心并且短期无法迁移，可采用方案 B；否则桌面 MVP 优先采用方案 A。

## 12. Playwright 与 Crawlee

采集仍运行在 Core Runtime/Engine 中，不能进入 Renderer。

桌面发布必须解决：

- Chromium 二进制随包分发或首次启动受控下载；
- 固定并验证 Browser revision；
- 从 Electron ASAR 中解包可执行文件；
- macOS/Windows 签名和公证；
- 明确 `PLAYWRIGHT_BROWSERS_PATH` 或 executable path；
- 浏览器进程有独立生命周期和崩溃恢复；
- Crawlee local storage 指向 Host 提供的私有 Runtime 目录；
- 清理 session、request queue 和临时 artifact；
- Browser 崩溃不能导致任务永久停留在 running。

初期可以继续由 Runtime 内部管理 Playwright；当浏览器资源、崩溃和更新需要独立治理时，再提取 Engine Supervisor，但不需要为此升级到 Level 2 Plugin Runtime。

## 13. 构建、打包与更新

建议使用 Electron Forge：

- `package`：生成应用包；
- `make`：生成平台安装包；
- `publish`：发布更新制品；
- 原生依赖 rebuild；
- ASAR 与资源解包；
- macOS code signing/notarization；
- Windows signing；
- Linux 包格式。

参考：

- [Electron Application Packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution/)
- [Electron Forge](https://www.electronjs.org/docs/latest/tutorial/forge-overview)

建议命令：

```text
bun run dev                 # 默认启动桌面应用
bun run dev:headless        # 显式启动 Headless/Web
bun run desktop:dev
bun run desktop:build
bun run desktop:package
bun run desktop:make
bun run desktop:test
```

安装包必须包含：

- Electron Main/Preload/Renderer；
- 构建后的 Core Runtime JavaScript；
- SQLite driver/native resources；
- Playwright Chromium 或受控 downloader；
- 可选 Python AI sidecar；
- migration、license、icons 和 update metadata。

最终安装包不能依赖系统 Bun、Node、Python、uv、PostgreSQL、Redis 或 Docker。

## 14. 分阶段实施计划

### 阶段一：解耦 Runtime

目标是在不改变现有行为的前提下建立正确边界。

- 创建 `packages/runtime`；
- 引入 Repository、Scheduler、Queue、AI 和 Host Capability 接口；
- 将数据库、Redis、Crawler、Exporter 从 `buildApp()` 中注入；
- 保留现有 PostgreSQL/Redis adapter；
- 建立 `/api/v1/version`、`capabilities`、`runtime`；
- 引入 Problem Details、OpenAPI 和类型化 Client；
- 补齐 Runtime start/stop 和资源 leak tests。

### 阶段二：Electron 骨架

- 创建 `apps/desktop`；
- 实现 Main、Preload 和 Renderer；
- 使用 `utilityProcess` 监督 Runtime；
- 实现随机端口、token、generation 和 ready handshake；
- 加入 Origin allowlist、CSP、sandbox 和 navigation policy；
- 复用现有 React UI；
- 增加连接、断线、重启和不兼容 UI；
- 保持 Bun Headless API 可独立运行。

### 阶段三：Local-first

- 实现 SQLite Storage Adapter；
- 实现 SQLite migration 和备份恢复；
- 实现 Local Durable Scheduler/Queue；
- 移除桌面版 Docker、Redis 和 PostgreSQL 依赖；
- 增加 canceled/interrupted/recovery 行为；
- 明确托盘和完全退出的调度语义。

### 阶段四：桌面能力

- Credential Reference；
- File/Directory/Export Grant；
- 系统通知；
- 安全外部 URL；
- Runtime/Engine diagnostics；
- AI TypeScript 化或 Python sidecar 打包；
- Chromium 分发和监督。

### 阶段五：发布

- Electron Forge；
- 平台图标和应用元数据；
- macOS/Windows 签名；
- macOS notarization；
- 更新、回滚和升级迁移；
- 安装包 smoke test；
- 清洁机器无外部运行时验证。

## 15. 测试与验收

保留现有单元、API、Web E2E 和 Python 测试，并增加：

```text
Bun Headless Runtime conformance
Electron Node Runtime conformance
HTTP contract tests
Runtime startup failure / crash / restart
generation and stale response rejection
invalid token / Origin
SSE disconnect / heartbeat / replay
mutation timeout after commit
duplicate Idempotency-Key
If-Match conflict
SQLite migration / checksum / backup / recovery
queued/running job crash recovery
Host unavailable
Credential backend unavailable or degraded
Artifact and Export Grant
Playwright browser missing / crash / recovery
resource leak
Electron E2E
package / install / upgrade smoke
```

桌面发布验收必须在未安装 Bun、Node、Python、uv、Docker、PostgreSQL 和 Redis 的干净系统上完成。

## 16. 架构门禁

CI 应拒绝：

- Electron Main 导入 domain/repository/route 实现；
- Renderer 导入 Electron、SQLite、Provider SDK 或 Runtime 内部实现；
- Renderer 散落直接 `fetch`；
- Renderer 通过 IPC 调用业务方法；
- Runtime 导入 Electron；
- Runtime 直接使用未被 Adapter 包装的 runtime-specific API；
- 未登记或无法关闭的 listener、timer、worker、watcher、stream 和 child process；
- API/OpenAPI/生成 Client 漂移；
- migration checksum 漂移；
- 日志包含 token、credential、绝对路径或未脱敏采集内容。

## 17. 明确不做

第一阶段桌面化不实现：

- Level 2 Internal Plugin Kernel；
- Level 3 第三方插件系统；
- Marketplace；
- Renderer business IPC；
- Electron Main 业务 Backend；
- 多 Runtime 共享数据库；
- 远程 Host Capability；
- 应用完全退出后的 OS 级 Cron 服务；
- 自动加载个人 Chrome Profile；
- 未签名的远程代码或动态 UI bundle。

## 18. 建议的第一步

第一步不是创建 Electron 窗口，而是完成：

```text
apps/api
   ↓
packages/runtime + apps/api headless launcher
```

具体完成标准：

1. `packages/runtime` 不依赖 Electron；
2. Runtime 的数据库、队列、AI、Crawler 和 Host Capability 全部可注入；
3. `apps/api` 只负责 Bun Headless 启动；
4. 当前 API 集成测试迁移为 Runtime conformance test；
5. 所有资源在 test teardown 后归零；
6. Runtime 可以构建为 Electron `utilityProcess` 可执行的 JavaScript；
7. 现有 Web UI 和采集闭环保持通过。

完成这一阶段后，再加入 Electron Host，可以避免把现有基础设施耦合复制进 Desktop Main。
