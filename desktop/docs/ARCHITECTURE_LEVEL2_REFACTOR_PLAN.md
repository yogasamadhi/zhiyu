# 桌面端 Level 2 架构重构执行计划

> 文档类型：Execution Plan
>
> 规范依据：[Level 2 大型封闭项目](../../docs/architecture/desktop/DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md)、[基于 DSH 的应用架构（基线）](../../docs/architecture/desktop/DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 适用范围：`desktop/` 下的 Electron 壳、Host、全部第一方插件与浏览器侧；`dsh-plugin/` 只在 P11 处理
>
> 状态：待执行。本文记录“从现状到规范”的步骤与退出条件；规范本身以上述两份文档为准，本文与规范冲突时以规范为准。

文中“基线 §x”指基线文档章节，“L2 §x”指 Level 2 文档章节；`<app>` 在本项目中为 `zhiyun`，`<APP>` 为 `ZHIYUN`，`@<scope>` 为 `@zhiyun`。

---

# 0. 目的、范围与决策

## 0.1 目的

把桌面端改造成规范定义的 Level 2 大型封闭项目：多个第一方业务插件各自拥有服务、存储领域、Remote namespace 与 UI 贡献；由组合包与 Profile 组装产品形态；由应用自有的启动器、Desktop Host 和基础设施组件承载；不开放安装。

## 0.2 决策

| #   | 决策                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **严格按规范，不兼容旧实现。** 不写桥接、facade、旧包名别名或旧 Profile 名别名；每个阶段直接落到目标形态，被替代的旧代码在同一阶段删除。                                                                      |
| D2  | 现有 `/api/v2` REST 路由全部改为 Remote（`@Remote` / `@RemoteScope`、typert descriptor、`ctx.remote`）。Fastify、`runtime-gateway`、生成的 OpenAPI 客户端 `@zhiyun/client` 与 `runtime/src/openapi.ts` 删除。 |
| D3  | 对外 Data API（API Token 调用，现为 `/api/v2/data/tasks/{taskId}/records`）按基线 §6.1 改为所属插件经 `ctx.webServer` 注册的自有路由；路径与响应格式重新定义，不承诺与旧接口一致。                            |
| D4  | **旧数据不迁移。** 新版本在 `$ZHIYUN_HOME` 下以全新的存储领域起步；旧 Electron userData 中的数据库不读取、不移动、不删除（基线 MUST NOT 12）。发布说明写明这一点。                                            |
| D5  | 浏览器侧完全按基线 §6.6：CSS Modules + `clsx`、主题 token 归主题组件、按插件的类型化语言字典、Client model 取代 TanStack Query 的业务状态、包由 tsdown 打包。                                                 |
| D6  | `dsh-plugin/` 是另一产品（依赖 `dsh-*` 包），重构期间不保证可用，在 P11 改用新包；`desktop/` 的依赖门禁不覆盖它。                                                                                             |
| D7  | 选择 Level 2：12 个稳定业务域、多种产品形态（完整版、受限版、测试与端到端组合、DSH 内嵌），全部代码由同一官方信任域构建（L2 §2）。没有第三方插件需求，不升级 Level 3。                                        |

## 0.3 非目标

- Level 3 能力：插件管理组件、`zhiyun plugin` 命令、公开扩展点（L2 §9、§14）。
- `platform/`（商业云端）代码；它只作为 Desktop 的外部服务存在。
- 产品功能与界面改版；界面只随架构迁移改动，用户路径保持。

---

# 1. 现状盘点

以下为执行前的仓库事实，作为差距判定与工作量估计的依据。

## 1.1 进程与启动

| 项              | 现状                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron 主进程 | [`desktop/src/main.ts`](../src/main.ts)（566 行）。`app://zhiyun/` 协议加载渲染页；单实例锁；凭据录入窗口与登录窗口。                                                                                                                                                                                                                                                                                                              |
| Host 启动       | [`runtime-supervisor.ts`](../src/runtime-supervisor.ts) 用 `utilityProcess.fork` 启动 [`runtime/src/utility-entry.ts`](../packages/runtime/src/utility-entry.ts)，以 `bootstrap` 消息传入 `dataDirectory`、`hostToken`、`sessionNonce`、AI 配置等；另有 `scheduling-environment-changed`、`cloud-mode-changed`、`analytics-worker-changed`、`issue-session-nonce` 消息。没有 CLI 启动器、没有 Profile runner、没有 `ZHIYUN_HOME`。 |
| 主进程能力服务  | [`host-capability-server.ts`](../src/host-capability-server.ts) 在主进程内开 HTTP 服务供 Host 回调：`/cloud/state`、`/credentials/{put,resolve,delete,prompt,login}`（`safeStorage` 加解密）、`/outputs/select-directory`、`/artifacts/save`、`/database/select-restore`、`/runtime/restart`、`/external/open`、`/notifications/show`、`/window/status`、`/runtime/diagnostics`。                                                  |
| 其他主进程职责  | `AnalyticsWorkerSupervisor`（Python Worker 由主进程监管）；[`cloud-account.ts`](../src/cloud-account.ts)（云账户会话，`safeStorage` 加密存储）。                                                                                                                                                                                                                                                                                   |
| Preload         | [`preload.ts`](../src/preload.ts) 暴露 `zhiyunRuntime`（bootstrap）与 `zhiyunCloud`（`summary/login/logout/select/portal`，其中 `select` 是业务选择）。                                                                                                                                                                                                                                                                            |

## 1.2 Host 组合

- [`runtime/src/level2.ts`](../packages/runtime/src/level2.ts) 以 `bootPlugins`（[`plugin-runtime/src/boot.ts`](../packages/plugin-runtime/src/boot.ts)）挂载 12 个插件与 timer、logger；在 `prepare` 中由 Host 集中创建全部仓储、任务队列、凭据、爬虫、AI 与 Worker 客户端，并以 `runtimeHost` 服务下发（类型 `Level2RuntimeDependencies`，见 [`runtime-contracts/src/index.ts`](../packages/runtime-contracts/src/index.ts)）。
- [`plugins/platform/src/plugin.ts`](../packages/plugins/platform/src/plugin.ts) 把这些集中依赖再 provide 为 `jobs`、`jobHandlers`、`artifacts`、`credentials`、`hostCapabilities`、`crawlerProvider`、`aiProvider`。
- [`runtime-gateway/src/index.ts`](../packages/runtime-gateway/src/index.ts)（1242 行）基于 Fastify：安装各插件经 `RuntimeRoutes.register()` 登记的路由，安装后拒绝再注册；统一做工作区授权与 Data API 令牌认证；`RealtimeEventHub` 推送领域事件。
- [`runtime/src/openapi.ts`](../packages/runtime/src/openapi.ts)（2916 行）手写 OpenAPI 文档，`@zhiyun/client` 由它生成。
- `runtime-contracts` 依赖全部 12 个插件包，插件又依赖 `runtime-contracts`。

## 1.3 插件

| 插件          | 源码行数 | 路由数 | 主要表（manifest 声明）                                                             |
| ------------- | -------: | -----: | ----------------------------------------------------------------------------------- |
| collection    |   12,612 |     41 | `collection_drafts`、`collection_crawl_sessions`、`collection_crawl_batches` 等     |
| ai-assistance |   10,979 |     42 | `ai_validated_cache*`、`ai_assistant_records`                                       |
| recruitment   |    5,556 |     21 | —                                                                                   |
| datasets      |    4,906 |     21 | `records`、`datasets`、`dataset_records`、`record_changes`、`dataset_snapshots`     |
| outputs       |    3,578 |     12 | `output_destinations`、`task_output_bindings`、`delivery_attempts`、`api_tokens`    |
| analytics     |    3,536 |     16 | `analysis_recipes`、`analysis_jobs`、`analysis_results`、`analysis_artifacts`       |
| corpus        |    3,107 |     18 | `corpora`、`corpus_recipes`、`corpus_builds`、`corpus_versions`、`corpus_artifacts` |
| identity      |    3,069 |     14 | 独立仓储                                                                            |
| monitoring    |    2,183 |      8 | `quality_policies`、`quality_evaluations`、`quality_task_state` 等                  |
| preferences   |    1,791 |     12 | `trend_sources`、`preference_signals`                                               |
| platform      |      942 |     22 | `experience_events`                                                                 |
| templates     |      835 |      3 | —                                                                                   |

合计约 230 条路由声明，其中 14 条 `requiredPermission: null`（健康检查、会话、认证、邀请接受等）。

插件以 `manifest.ts` 声明 routes、events、migrations、uiContributions、backgroundHandlers；`plugin-runtime/src/catalog.ts` 的 `resolveGraph` 与 `pnpm run architecture:check` 校验 ID 唯一与所有权。

## 1.4 数据访问

所有仓储由 Host 打开同一个 SQLite（[`capabilities/storage-sqlite`](../packages/capabilities/storage-sqlite/src/index.ts)，单一 `PRODUCT_SCHEMA_VERSION`），插件经 `ctx.runtimeHost.dependencies.repositories.<domain>` 访问任意领域。跨领域**写入**（必须消除）：

| 调用方        | 写入的他域方法                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ai-assistance | `collection.createDraft`、`updateDraft`、`createTaskWithInitialRule`、`createRuleVersion`、`createRuleRepairProposal`、`updateRuleRepairProposal`、`markRuleRepairProposalTested` |
| preferences   | `collection.createTask`、`createRule`、`createRun`                                                                                                                                |
| collection    | `monitoring.deleteTask`、`outputs.createDeliveryAttempt`、`platform.appendEvent`                                                                                                  |
| recruitment   | `platform.createArtifact`                                                                                                                                                         |

跨领域**读取**热点：ai-assistance→collection、datasets→collection、analytics/corpus→datasets、monitoring→collection/outputs、各插件→platform。

同级实现导入：`plugin-platform` 依赖 `plugin-analytics`、`plugin-corpus`、`plugin-datasets`；`plugin-templates` 依赖 `plugin-collection`；`plugin-ai-assistance` 依赖 `plugin-identity/policy`。

## 1.5 Profile 与组合包

[`profiles/catalog/config`](../packages/profiles/catalog/config) 打包 6 个 Profile 与 4 个组合包：

| Profile          | 组合包                                             | 规范判定                   |
| ---------------- | -------------------------------------------------- | -------------------------- |
| `desktop-studio` | core-data + intelligence                           | 应为 `desktop`             |
| `dsh-studio`     | core-data + intelligence（patch 去掉招聘）         | DSH 内嵌产品的组合，见 P11 |
| `safe`           | safe-core                                          | 受限组合，应为 overlay     |
| `test`           | core-data + intelligence，`deterministic`          | 测试组合，应为 overlay     |
| `e2e`            | core-data + intelligence，`deterministic+fixtures` | 测试组合，应为 overlay     |
| `identity-test`  | core-data + intelligence + identity-fixture        | 测试组合，应为 overlay     |

Profile 不在 home 目录下，没有用户 `cordis.patch.yml`、home 级 patch、`--patch` overlay 与 `--dump-config`。

## 1.6 浏览器侧

- [`ui/src/shell/client-runtime.tsx`](../packages/ui/src/shell/client-runtime.tsx) 静态导入 10 个插件的 `./client`，按 [`generated/client-profiles.json`](../packages/ui/src/generated/client-profiles.json) 的名册由 `bootClientPlugins` 激活。
- Slots 在 [`ui-sdk/src/slots.ts`](../packages/ui-sdk/src/slots.ts)；`ui-sdk` 同时承载基座控件与业务组件（`CollectionPreview`、`DatasetCleaningPanel`、`DatasetVersionPicker`、assistant、analysis、monitoring 组件）。
- 单一 i18next 字典（`ui-sdk/src/i18n.ts`）；全局 CSS（`ui-sdk/src/styles/*.css`，已有 token）；react-router 与 TanStack Query；数据经 `runtimeClient`（OpenAPI REST）获取。
- 包构建使用 `tooling/scripts/build-package.ts`（esbuild）。

## 1.7 已对齐的部分

- Cordis 框架包取自锁定 DSH 快照（`vendor/deepseek-harness`，`vendor.lock.json`），`pnpm run vendor:prepare` 校验 revision 与源码哈希，不修改原包。
- 插件以 `inject` 声明依赖、以 `ctx.effect()` 注册贡献；组合使用 Loader、Include 与 `applyEntryPatches`。
- 浏览器侧已是一棵 Cordis 树，UI 经 Slots 注册。
- 未挂载插件管理组件，没有 `plugin` 命令。
- `dependency-cruiser.config.cjs` 已有“插件不导入同级实现”“渲染器不导入服务端”“runtime 不导入 electron”规则。

---

# 2. 差距矩阵

| #   | 规范条款                                         | 现状证据                                                                | 差距                                                                                                                    | 阶段    |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- |
| G1  | L2 §3.1；基线 §1.2、§1.3、§11                    | `@zhiyun/plugin-*` 平铺；无 `apps/`；无 `infra-*`；包无 `zhiyun.*` 字段 | 目录、包名、`zhiyun.profile / bundle.patch / client` 声明                                                               | P1      |
| G2  | 基线 §4、MUST 5、19                              | `utilityProcess.fork` + bootstrap 消息                                  | 缺启动器、Profile runner、`ZHIYUN_HOME`、`--dump-config`、`--patch`、`profileContext`                                   | P3、P5  |
| G3  | L2 §3.2、§3.3、MUST 4、MUST NOT 3                | 6 个 Profile、4 个非规范组合包                                          | Profile 收敛为 `web/desktop/headless`；测试与受限组合改 overlay；组合包按 base/web/headless/域/Engine                   | P3      |
| G4  | 基线 §2、MUST 1；L2 MUST NOT 4                   | `runtimeHost`、`Level2RuntimeDependencies`、platform 插件转发集中依赖   | 特权内核与集中编排；依赖应由各所有插件或基础设施组件 provide                                                            | P6      |
| G5  | L2 §7、MUST 2、3、MUST NOT 2；基线 §8.1、MUST 14 | §1.4 跨域写入与读取；同级实现导入；单一 schema 版本                     | `ctx.storage` + `defineDomain`；跨域只经服务、事件、只读投影                                                            | P6      |
| G6  | 基线 §6.1–§6.3、MUST 8、9                        | 集中 Fastify 网关；`hostToken/sessionNonce` 认证                        | `ctx.webServer` 由路由所有者注册；令牌换签名 cookie；Host/Origin 信任                                                   | P4      |
| G7  | 基线 §6.4、§6.5、MUST 10、11；L2 §6              | OpenAPI REST + `runtimeClient`；`RealtimeEventHub`                      | Remote namespace、配对的 controller Host/Client face、`$events` allowlist                                               | P7      |
| G8  | 基线 §5、MUST 6、7、MUST NOT 4                   | 主进程能力 HTTP 服务、Worker 监管、云账户业务 IPC；`app://zhiyun`       | 壳只做窗口、协议、转发、原生能力；Host 经 Electron Node 模式 spawn；协议改为 `zhiyun-app://app` 与 `zhiyun-app://shell` | P5      |
| G9  | 基线 §6.6、MUST 12；L2 §6、MUST 5                | 静态客户端名册；`ui-sdk` 混入业务组件；单字典；全局 CSS                 | 客户端模块组件下发、两阶段启动、基座只含跨插件控件、按插件字典、CSS Modules                                             | P9      |
| G10 | 基线 §9、MUST 16、17；L2 §8、MUST 6              | `aiProvider`、`crawlerProvider` 固定服务；`mutableAi` 运行时覆盖        | `ctx.engines` seam；Engine 作为 Provider 插件经组合包选择；Session 日志                                                 | P8      |
| G11 | 基线 §8.2、MUST 15                               | 凭据经主进程 HTTP 端点解析；`apiKeyRef` 来自环境变量                    | `ctx.credentials` + `CredentialRef`；Desktop 提供方经壳专用 IPC 加解密                                                  | P2、P5  |
| G12 | L2 §10、MUST 7                                   | 部分 depcruise 规则；`architecture:check` 只校验生成物                  | 所有权、同级导入、跨域写、裸插件名、启动入口分类门禁，各带反例用例                                                      | P0、P10 |
| G13 | L2 §11；基线 §13                                 | 无插件生命周期测试、dump-config 快照、Engine 测试、controller 配对测试  | 补齐                                                                                                                    | 各阶段  |

---

# 3. 目标架构

## 3.1 目录

```text
desktop/
├── apps/
│   ├── cli/              # @zhiyun/app-cli：zhiyun 启动器与 Profile runner（Desktop Host 共用）
│   ├── desktop/          # @zhiyun/app-desktop：Electron 壳（主进程、preload、zhiyun-app 协议）
│   ├── desktop-host/     # @zhiyun/app-desktop-host：Electron Node 模式的私有 Host
│   └── web/              # @zhiyun/app-web：Vite Web 壳（入口 HTML、品牌资源）
├── packages/
│   ├── infra/<name>/     # @zhiyun/infra-<name>：基础设施组件
│   ├── <domain>/plugin/  # @zhiyun/<domain>-plugin：Host face 服务、存储领域、任务
│   ├── <domain>/controller/ # @zhiyun/<domain>-controller：Remote 服务（Host face）与 Client model（Client face）
│   ├── <domain>/ui/      # @zhiyun/<domain>-ui：客户端插件（Slots 贡献、视图、语言字典）
│   ├── <domain>/core/    # @zhiyun/<domain>-core：可选，无 Cordis 依赖的领域模型与纯函数
│   ├── engine/<id>/      # @zhiyun/engine-<id>：Engine Provider 插件
│   └── bundle/<name>/    # @zhiyun/bundle-<name>：组合包（cordis.patch.yml）
├── analytics-worker/     # Python Worker 源码（保持）
├── e2e/ · e2e-packaged/  # 端到端测试
└── docs/
```

`vendor/deepseek-harness` 保持在仓库根目录，只读。

## 3.2 包映射

| 现有包                                                              | 目标                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `desktop/src`（main、preload、协议、窗口）                          | `apps/desktop`                                                                                                    |
| `desktop/src/renderer`、`packages/ui` 的入口与壳                    | `apps/web`（入口）；React 根移入 `infra/ui-renderer`                                                              |
| `packages/runtime`、`runtime/src/utility-entry.ts`                  | `apps/desktop-host` + `apps/cli`；`level2.ts` 的集中组装删除                                                      |
| `packages/plugin-runtime`                                           | `infra/app-boot`（Profile runner、Loader、Include）；`catalog.ts` 的所有权检查移入门禁脚本                        |
| `packages/profiles/catalog`                                         | `bundle/*` + `apps/cli/profiles/*`（模板）+ `apps/cli/overlays/*`                                                 |
| `packages/runtime-gateway`                                          | 删除；职责分给 `infra/webserver`、`infra/connection`、`infra/api-gateway`、`infra/remote-access` 与各路由所有插件 |
| `packages/runtime-contracts`                                        | 删除；类型归各所有插件的 `./types` 或 controller                                                                  |
| `packages/client`、`runtime/src/openapi.ts`                         | 删除；由 typert 生成的 descriptor 与 `ctx.remote` 取代                                                            |
| `packages/capabilities/storage-sqlite`                              | `infra/storage-sqlite`（关系型后端，见 P2）                                                                       |
| `packages/capabilities/queue-local`、`platform-core` 的队列         | `jobs/plugin`（`ctx.jobs` Service Definition + 本地 Provider）                                                    |
| `packages/capabilities/artifact-store`                              | `artifacts/plugin`（`ctx.artifacts`）                                                                             |
| `packages/capabilities/analytics-worker-client`                     | `analytics/worker`（Provider 插件，经 `ctx.subprocess` 启动 Worker）                                              |
| `packages/ai-runtime`                                               | `engine/pi`                                                                                                       |
| `packages/crawler-runtime`、`browser-runtime`、`extraction`         | `engine/crawlee`（Provider）；`extraction` 作为 `collection/core`                                                 |
| `packages/plugins/<domain>`                                         | `<domain>/{plugin,controller,ui}`；`ai-assistance` 改名 `assistant`                                               |
| `packages/ui-sdk`                                                   | `infra/ui-{slots,renderer,theme,primitives,layout,locale}`；业务组件回到所属 `<domain>/ui`                        |
| `packages/contracts`、`shared`                                      | 拆分：跨域 wire 类型归 controller；纯工具留 `shared/core`（不含业务）                                             |
| `packages/outputs`、`exporters`、`rules`、`preferences`、`platform` | 分别并入 `outputs/core`、`datasets/core`、`collection/core`、`preferences/core`、`platform/core`                  |

域划分：`platform`、`jobs`、`artifacts`、`datasets`、`collection`、`outputs`、`monitoring`、`templates`、`preferences`、`analytics`、`corpus`、`assistant`、`recruitment`、`identity`。`templates`、`platform` 等小域可以把 plugin/controller/ui 合并为一个分面包（基线 §11：分面 tsconfig 叶子配置）。

## 3.3 基础设施组件

按基线 §1.2，组件沿用 DSH 的 `ctx` 键与服务契约：

| 组件                                                                              | 参照的 DSH 路径（`vendor/deepseek-harness/`）                                | `ctx` 键                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `infra-app-boot`、`infra-home-paths`、`infra-cmdline`、`infra-launch-environment` | `packages/boot/app-boot`、`packages/boot/cmdline`、`apps/cli`                | `profileContext`（启动器提供）                        |
| `infra-hmr`                                                                       | `packages/boot/hmr`                                                          | —                                                     |
| `infra-settings`、`infra-config-editor`                                           | `packages/settings`、`packages/boot/config-editor`                           | `ctx.configEditor`                                    |
| `infra-webserver`                                                                 | `packages/host`                                                              | `ctx.webServer`                                       |
| `infra-web-app`、`infra-frontend-static`                                          | `packages/web`、`packages/host`                                              | —                                                     |
| `infra-connection`                                                                | `packages/client/connection`                                                 | `ctx.connection`                                      |
| `infra-typert-*`                                                                  | `packages/typert`                                                            | `ctx.typert`                                          |
| `infra-api-gateway`、`infra-api-remotes`、`infra-remote-access`                   | `packages/api/gateway`、`packages/api/remotes`、`packages/api/remote-access` | `ctx.typertGateway`、`ctx.remote`、`ctx.remoteAccess` |
| `infra-client-modules`、`infra-client-hmr`、`infra-client-web`                    | `packages/client/modules`、`packages/client/hmr`、`packages/web`             | `ctx.clientModules`                                   |
| `infra-ui-slots`、`-renderer`、`-theme`、`-primitives`、`-layout`、`-locale`      | `packages/client/ui-*`、`packages/client/locale`                             | `ctx.slots` 等                                        |
| `infra-storage`、`-storage-domain`、`-storage-json`、`-storage-sqlite`            | `packages/storage`                                                           | `ctx.storage`                                         |
| `infra-credentials`、`infra-credentials-local`、`infra-credentials-desktop`       | `packages/credentials`                                                       | `ctx.credentials`                                     |
| `infra-subprocess`、`infra-subprocess-local`                                      | `packages/subprocess`                                                        | `ctx.subprocess`                                      |

执行时以 DSH 快照中实际的包目录为准逐一定位来源文件（各目录的 `README.zh.md` 与源码），记录来源路径与 DSH revision `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。

## 3.4 组合包与 Profile

| 组合包                  | 条目                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle-base`           | timer、logger、storage（+ sqlite、json）、credentials、settings、config-editor、subprocess、typert 注册表、api-gateway、remote-access、配置 HMR、`ctx.engines` seam、jobs、artifacts；核心域 platform、datasets、collection、outputs、monitoring、templates、preferences 的 plugin 与 controller Host face |
| `bundle-web`            | web-app、frontend-static、webserver、client-modules、client-hmr、connection、api-remotes 客户端桥接、UI 基座、核心域的 ui 与 controller Client face                                                                                                                                                        |
| `bundle-headless`       | 一次性运行入口（例如 `zhiyun headless run-task <id>`），不启动服务器                                                                                                                                                                                                                                       |
| `bundle-analytics`      | analytics plugin/controller/ui、analytics-worker Provider                                                                                                                                                                                                                                                  |
| `bundle-corpus`         | corpus                                                                                                                                                                                                                                                                                                     |
| `bundle-assistant`      | assistant                                                                                                                                                                                                                                                                                                  |
| `bundle-recruitment`    | recruitment                                                                                                                                                                                                                                                                                                |
| `bundle-identity`       | identity（团队模式）                                                                                                                                                                                                                                                                                       |
| `bundle-engine-crawlee` | engine-crawlee（Crawlee + Playwright）                                                                                                                                                                                                                                                                     |
| `bundle-engine-pi`      | engine-pi（Pi agent）                                                                                                                                                                                                                                                                                      |

| Profile    | 组合包栈                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| `web`      | base + web + analytics + corpus + assistant + recruitment + engine-crawlee + engine-pi |
| `desktop`  | 由 `web` 模板初始化，Desktop 独占                                                      |
| `headless` | base + headless + engine-crawlee                                                       |

| overlay（`--patch`）         | 取代            | 内容                                                         |
| ---------------------------- | --------------- | ------------------------------------------------------------ |
| `overlays/deterministic.yml` | `test`          | 固定时钟、固定 id、Engine 换为确定性 Provider                |
| `overlays/e2e.yml`           | `e2e`           | deterministic + 本地 fixtures 站点                           |
| `overlays/safe.yml`          | `safe`          | `disabled` 掉 analytics、corpus、assistant、recruitment 条目 |
| `overlays/identity.yml`      | `identity-test` | 插入 identity 条目与测试配置                                 |

`dsh-studio` 不再是本项目启动器的 Profile，P11 中由 dsh-plugin 自己声明组合包栈。

## 3.5 端到端数据流

```text
Host：<domain>-plugin（ctx.storage 领域、服务、任务）
      → <domain>-controller Host face（@Remote 方法、流生产、访问策略）
      → infra-api-gateway（/api 一元、/api/remote.mux 流）
浏览器：infra-api-remotes（ctx.remote.<namespace>）
      → <domain>-controller Client face（model：baseline + 增量）
      → <domain>-ui（UI adapter → 视图快照 → Slots）→ infra-ui-renderer（唯一 React 根）
```

---

# 4. 执行原则

## 4.1 规则

1. **不兼容旧实现（D1）**：替代物落地的阶段同时删除旧包、旧路由、旧 Profile 与相关测试；不写桥接与别名。唯一的例外在 §4.3 中逐项列出：在新实现尚未完成的阶段之间，旧实现继续作为**唯一**实现运行，不与新实现互相转发，并在列明的阶段删除。
2. **合并条件**：阶段内允许应用暂时不可运行，但每个 PR 合并到 `main` 时必须通过 §5.0 的通用验收；阶段完成时还必须通过该阶段的验收清单。
3. **搬移与逻辑分开提交**：纯 `git mv` 与包名替换单独成提交，便于评审与 `git log --follow`。
4. **旧数据（D4）**：新代码不读取、不删除旧 userData 数据库；新领域格式从版本 `1` 开始。
5. **契约优先**：先提交服务契约测试或门禁反例用例（此时可以失败并标记 `todo`），再迁移实现。
6. **所有权单一**：迁移任一路由、领域、Remote namespace 或 Slot 时，同一提交里确定唯一所有插件并进入门禁。
7. **DSH 复制规则**：复制的文件保留 MIT 版权与许可声明，来源路径与 DSH revision 记入第三方声明；去掉 DSH 产品内容（基线 §1.3）。
8. **dsh-plugin（D6）**：P11 之前允许其构建失败，CI 中把 `dsh-plugin:*` 暂时移出必过项，P11 恢复。

## 4.2 阶段依赖与 PR 粒度

```text
P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → P11
                        └──── 同一发布周期：P4 起至 P7 合并前不发布 Desktop 版本 ────┘
```

| 阶段 | 建议 PR 拆分                                                                  |
| ---- | ----------------------------------------------------------------------------- |
| P0   | 1 个                                                                          |
| P1   | 2 个：纯搬移；包名与配置更新                                                  |
| P2   | 9 个：按 §5 P2 步骤 1 的依赖闭包分组，每组一个                                |
| P3   | 2 个：启动器与组合包；删除旧 Profile 并改 overlay                             |
| P4   | 1 个                                                                          |
| P5   | 2 个：Host 与 IPC；壳的协议、preload 与生命周期                               |
| P6   | 每个域 1 个，共 14 个，按 P6 的顺序                                           |
| P7   | 每批 1 个，共 7 个；最后一批同时删除旧 API                                    |
| P8   | 3 个：`ctx.engines` 与 engine-crawlee；engine-pi 与 Session 日志；Worker 收尾 |
| P9   | 基座拆分 1 个；每个域的 UI 1 个；删除旧壳与全局样式 1 个                      |
| P10  | 1 个                                                                          |
| P11  | 1 个                                                                          |

## 4.3 过渡期并存登记

| 并存项                                                        | 原因                             | 起止    | 删除时的验收断言                                      |
| ------------------------------------------------------------- | -------------------------------- | ------- | ----------------------------------------------------- |
| Fastify 网关（`runtime-gateway`）继续提供 `/api/v2`，独立监听 | Remote 迁移按插件分批进行        | P4 → P7 | `rg -l "fastify" desktop` 无结果                      |
| `@zhiyun/client`（OpenAPI REST）                              | UI 逐页切换到 `ctx.remote`       | P4 → P7 | `rg -l "@zhiyun/client" desktop` 无结果               |
| 浏览器侧静态客户端名册                                        | 客户端模块组件要求各 UI 包已独立 | P1 → P9 | `client-runtime.tsx` 与 `client-profiles.json` 不存在 |
| `ui-sdk` 全局样式与字典                                       | 按插件迁移 CSS Modules 与字典    | P1 → P9 | `rg -l "@zhiyun/ui-sdk" desktop` 无结果               |

并存项不得被新代码新增调用；评审时以 `rg` 结果数只减不增为准，并在进度表登记当前计数。

## 4.4 不通过与回滚

- 任何验收项不通过即阻止阶段完成；不得以删除测试、跳过断言或降低门槛的方式通过。
- 需要偏离规范时，先在 §0.2 增加决策条目（D8 起编号），写明条款、理由与到期阶段，由项目负责人批准后再合并。
- 回滚：发布前，回滚单位是该阶段的 PR 集合（按合并逆序 `git revert`）；由于 D4，发布前没有用户数据迁移，回滚不涉及数据。发布后不提供降级（基线 §8.1：前驱不意味着回退或降级支持），问题以后继版本修复。

---

# 5. 阶段

## 5.0 通用验收（每个 PR 必过）

```bash
pnpm install --frozen-lockfile
pnpm run vendor:prepare
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run architecture:deps
pnpm run architecture:check
pnpm run test
pnpm run desktop:build
pnpm run desktop:test
```

- P0 新增的 `pnpm run architecture:gates` 在报告模式下输出的违规数只减不增；转为阻断后必须为 0。
- E2E 覆盖对照表（P0 产出）中每一行都能映射到现存测试；PR 改写 E2E 时同步更新对照表。
- 测试位置约定：包的单元与集成测试放在该包的 `test/`；跨包的生命周期与组合测试放在 `desktop/apps/cli/test/`；门禁反例用例放在 `tooling/scripts/test/architecture-gates/`。

每个阶段完成时，执行人在 `desktop/docs/acceptance/P<n>.md` 写验收记录（模板见 §9.2），并在 §9.3 进度表登记；项目负责人复核后标记完成。

## P0：基线冻结与门禁报告模式

**目标**：记录迁移前的行为与性能证据，让后续阶段可以比对。

步骤：

1. 在当前 `main` 上执行 §5.0 全部命令与 `pnpm run test:smoke:desktop-package`，记录结果。
2. 产出 `desktop/docs/acceptance/e2e-coverage-baseline.md`：`desktop/e2e/*.spec.ts` 当前共 22 个 `test()`，每个一行，列出文件、测试名、覆盖的用户路径；增加“迁移后对应测试”列，初始为空。
3. 性能基线：运行 `desktop/e2e/loading-performance.spec.ts`，记录冷启动到首页标题可见的时间、首屏加载的 JS 字节数；记录 `pnpm run desktop:make` 产物体积。
4. 新建 `tooling/scripts/architecture-gates.ts` 与根脚本 `architecture:gates`，以报告模式运行（只输出、不失败）：
   - 同级插件实现导入；
   - 跨领域仓储写入（初始违规集为 §1.4 的 14 处）；
   - `cordis.yml` 与组合包中的裸插件名是否出现在解析清单的 `dependencies`；
   - 每个包 bin 与根脚本的类别（启动器、构建、测试、工具），未归类即违规。
5. 每个门禁先写一个反例 fixture，证明脚本能识别违规（报告模式下断言“报告了该违规”）。

**验收**：

| #    | 检查               | 方法                                                           | 通过标准                     |
| ---- | ------------------ | -------------------------------------------------------------- | ---------------------------- |
| P0-1 | 基线检查结果已记录 | `acceptance/P0.md` 含 §5.0 全部命令的结果与提交哈希            | 全部记录；失败项注明原因     |
| P0-2 | E2E 覆盖对照表     | 对照表行数 = `rg -c "^\s*test\(" desktop/e2e` 合计             | 22 行，无遗漏                |
| P0-3 | 性能基线           | `acceptance/P0.md` 记录 3 个数值                               | 已记录                       |
| P0-4 | 门禁报告模式       | `pnpm run architecture:gates`                                  | 退出码 0；输出跨域写入 14 处 |
| P0-5 | 门禁反例           | `pnpm exec vitest run tooling/scripts/test/architecture-gates` | 每个门禁至少一个用例通过     |

## P1：包布局与命名（纯搬移）

**目标**：目录与包名符合基线 §11 与 L2 §3.1，不改逻辑。

步骤：

1. `git mv` 到 §3.1 结构：`desktop/src` → `apps/desktop/src`，`desktop/src/renderer` → `apps/web/src`，`packages/plugins/<d>` → `packages/<d>/plugin`（客户端代码暂留该包的 `src/client`，P9 拆出），`capabilities/*`、`ai-runtime`、`crawler-runtime` 等按 §3.2 进入目标目录。
2. 包名改为 `@zhiyun/<group>-<pkg>`；`ai-assistance` 改名 `assistant`（包名、目录、插件 id、路由前缀、i18n 键前缀一并改）。
3. 更新：`pnpm-workspace.yaml`、各 `tsconfig.json` paths、`tsconfig.base.json`、`dependency-cruiser.config.cjs`、`eslint.config.js`、`vitest*.config.ts`、`desktop/vite.config.ts`、`desktop/forge.config.ts`、`desktop/scripts/*`、`tooling/scripts/*`、`.github/workflows/*`、E2E 中的路径。
4. 删除 `packages/kernel` 残留（只有空的 `src`、`test` 与 `dist`）与空目录。

**验收**：

| #    | 检查                 | 方法                                                                                 | 通过标准                  |
| ---- | -------------------- | ------------------------------------------------------------------------------------ | ------------------------- |
| P1-1 | 通用验收             | §5.0                                                                                 | 全部通过                  |
| P1-2 | 搬移提交不含逻辑改动 | `git show --stat <搬移提交>` 与 `git diff -M <搬移提交>^ <搬移提交> --stat`          | 只有重命名（相似度 100%） |
| P1-3 | 旧包名清零           | `rg -l "@zhiyun/plugin-[a-z]" desktop tooling .github`                               | 无结果                    |
| P1-4 | 命名规则             | 门禁脚本检查 `desktop/packages/*/*/package.json` 的 `name` = `@zhiyun/<group>-<pkg>` | 0 违规                    |
| P1-5 | 历史可追溯           | 抽查 3 个文件 `git log --follow`                                                     | 能看到搬移前的提交        |
| P1-6 | 打包冒烟             | `pnpm run test:smoke:desktop-package`                                                | 通过                      |

## P2：基础设施组件

**目标**：按 §3.3 建立应用自有的基础设施组件，每个都有覆盖服务契约的测试。

步骤：

1. 按依赖闭包分组，从 DSH 快照复制改写：
   1. `infra-home-paths`、`infra-launch-environment`、`infra-cmdline`、`infra-app-boot`；
   2. `infra-storage`、`infra-storage-domain`、`infra-storage-json`、`infra-storage-sqlite`；
   3. `infra-credentials`、`infra-credentials-local`、`infra-credentials-desktop`；
   4. `infra-subprocess`、`infra-subprocess-local`；
   5. `infra-settings`、`infra-config-editor`、`infra-hmr`；
   6. `infra-webserver`、`infra-connection`、`infra-web-app`、`infra-frontend-static`；
   7. `infra-typert-registry`、`-loader`、`-protocol`、`-generator`，`infra-api-gateway`、`infra-api-remotes`、`infra-remote-access`；
   8. `infra-client-modules`、`infra-client-hmr`、`infra-client-web`；
   9. `infra-ui-slots`、`-renderer`、`-theme`、`-primitives`、`-layout`、`-locale`。
2. 替换产品内容：`dsh` 包字段 → `zhiyun`；`DSH_HOME` → `ZHIYUN_HOME`（默认 `~/.zhiyun`）；cookie 前缀、认证失败提示命令名、`window.__ZHIYUN_BOOT__`；Profile 模板与默认组合包由应用定义。
3. 存储决定：
   - 后端 `sqlite`：单文件 `$ZHIYUN_HOME/data/zhiyun.sqlite`；每个关系型领域声明自己的表（表名以领域名为前缀）与不可变前向迁移，写入经事务，查询以只读投影公开；**不允许跨领域事务与跨领域 join**；
   - 驱动与 DSH 一致用 `node:sqlite`，不再用 `better-sqlite3`：Host 在 Electron 的 Node 模式与系统 Node（`zhiyun` 启动器、测试）下运行同一份代码，不能依赖按某一种 ABI 编译的原生模块；同步删除 `forge.config.ts` 的 `rebuildConfig`、`scripts/prepare-maker-native.ts` 与各包的 `better-sqlite3` 依赖；
   - 后端 `json`：文档型领域（设置、单文档状态），目录 `$ZHIYUN_HOME/data/documents/`；
   - 每个领域有独立的格式版本与兼容列表；存储组件在运行时拒绝非所有插件的写入（为 P10 的跨域写门禁提供运行时断言）。
4. `infra-credentials-desktop`：加解密经壳的专用 IPC 通道交给主进程 `safeStorage`（基线 §8.2）；本阶段以 IPC 替身测试，P5 接入真实壳。
5. 复制或改写 DSH 对应测试；每个组件至少覆盖：服务契约、卸载撤销注册、配置错误显式失败。
6. 第三方声明：在 `tooling/scripts/generate-node-licenses.ts` 的流程中加入“复制来源”清单 `desktop/THIRD_PARTY_SOURCES.json`，逐文件记录来源路径与 DSH revision。
7. 依赖门禁：`desktop/` 内拒绝 Cordis 框架包以外的 `@deepseek-ai/*` 依赖，转为阻断。

**验收**：

| #    | 检查           | 方法                                                                                                                               | 通过标准                        |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| P2-1 | 通用验收       | §5.0                                                                                                                               | 全部通过                        |
| P2-2 | 组件契约测试   | `pnpm exec vitest run desktop/packages/infra`                                                                                      | 每个 `infra-*` 包都有测试且通过 |
| P2-3 | 卸载撤销       | 每个组件的测试中：`ctx.fiber.dispose()` 后 `webServer` 路由、Remote 方法、子进程、定时器全部撤销                                   | 有用例且通过                    |
| P2-4 | 产品内容清除   | `rg -n "DSH_HOME\|__DSH_\|dsh\.profile\|registry\.npmmirror" desktop/packages/infra`                                               | 无结果                          |
| P2-5 | 许可与来源     | 抽查 5 个复制文件含 MIT 声明；`THIRD_PARTY_SOURCES.json` 覆盖全部复制文件（脚本比对）                                              | 全部覆盖                        |
| P2-6 | 依赖门禁阻断   | 反例：在 fixture 包加入 `@deepseek-ai/dsh-storage` 依赖                                                                            | `architecture:deps` 失败        |
| P2-7 | 存储所有权断言 | `infra-storage` 测试：插件 A 写插件 B 的领域                                                                                       | 抛出所有权错误                  |
| P2-8 | 安全           | `infra-webserver` / `infra-connection` 测试：通配地址拒绝；Origin 不符 403；未认证 `/api` 401；令牌只在 `GET /` 与 `/connect` 生效 | 全部有用例且通过                |
| P2-9 | 无原生模块     | `rg -l "better-sqlite3" desktop`；`find desktop/packages -name "*.node" -not -path "*/node_modules/*"`                             | 均无结果                        |

## P3：启动器、组合包与 Profile

**目标**：受支持的 Node 应用只能经 `zhiyun --profile <name>` 启动（基线 §4、MUST 5、19）。

步骤：

1. `apps/cli`（包 `@zhiyun/app-cli`，bin `zhiyun`）：按 DSH `apps/cli/src/profile-boot.ts` 的 `runProfile` 编写共享 Profile runner：
   - 用应用模板初始化缺失 Profile（`$ZHIYUN_HOME/profiles/<name>`）；
   - 挂载前安装 HTTP 代理与 fail-loud 处理（SIGTERM→0，SIGINT→130）；
   - provide `profileContext` 与启动环境快照；挂载 Profile 内包加载器；提供命令行、受控退出与 `appReady`；
   - 实现 `--dump-config`、`--patch`、Profile 别名（`zhiyun web` 等价于 `zhiyun --profile web`）。
   - 开发期入口：根脚本 `"zhiyun": "node desktop/apps/cli/bin/zhiyun.js"`，消费 `pnpm run build` 的产物。
2. `packages/bundle/*`：按 §3.4 建组合包，每个包在 `package.json` 声明 `zhiyun.bundle.patch`；`apps/cli/profiles/{web,headless}` 模板声明 `zhiyun.profile`；overlay 放在 `apps/cli/overlays/`。
3. 删除 `profiles/catalog` 的 6 个 Profile、4 个组合包、`architecture:generate` 生成物与 `client-profiles.json` 生成脚本；E2E 与测试改用 overlay（`test-e2e-isolated.ts` 传 `--patch`）。
4. 叠加顺序：空根 → 组合包 patch（按 Profile 列出顺序）→ Profile `cordis.patch.yml` → home patch → `--patch` overlay，由 `applyEntryPatches` 完成。
5. `headless`：`zhiyun --profile headless run-task <taskId>` 运行一次指定任务后退出，退出码 0 表示运行成功，非 0 表示失败。
6. 本阶段 `web` Profile 只挂载 Host 侧条目并到达 `appReady`；页面与 API 由 P4 接入。

**验收**：

| #    | 检查             | 方法                                                                                                        | 通过标准                                                    |
| ---- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| P3-1 | 通用验收         | §5.0                                                                                                        | 全部通过                                                    |
| P3-2 | Profile 只有三个 | `zhiyun --profile test` 等旧名                                                                              | 报未知 Profile 并以非 0 退出                                |
| P3-3 | dump-config 快照 | `desktop/apps/cli/test/profiles.test.ts`：`web`、`headless` 及 `web` + 每个 overlay 的 `--dump-config` 快照 | 快照通过；改组合会使快照失败                                |
| P3-4 | 叠加顺序         | 测试：同一条目在组合包、Profile patch、home patch、overlay 各改一次 `config`                                | 最终值来自 overlay；每层可定位前一层插入的条目              |
| P3-5 | 启动冒烟         | `zhiyun --profile web`、`zhiyun --profile headless run-task <fixture 任务>`                                 | 前者到达 `appReady`；后者对 fixtures 站点运行成功并退出码 0 |
| P3-6 | 信号与退出码     | 测试：向 `zhiyun --profile web` 发送 SIGTERM、SIGINT                                                        | 退出码分别为 0、130；所有 effect 已释放                     |
| P3-7 | `ZHIYUN_HOME`    | 测试：设置临时 `ZHIYUN_HOME` 启动                                                                           | Profile 在该目录下初始化；不写入其他目录                    |
| P3-8 | 启动入口门禁     | `pnpm run architecture:gates`；反例：新增一个直接 `bootPlugins` 的根脚本                                    | 门禁阻断，反例失败                                          |
| P3-9 | 无插件管理       | `zhiyun plugin` 与 `rg -n "pluginManager" desktop`                                                          | 报未知 Profile `plugin`；无结果                             |

## P4：HTTP 载体与认证

**目标**：同一个 Host 进程在同一端口提供页面、插件脚本与 Remote API，每条路由由所有插件注册（基线 §6.1–§6.3、MUST 8、9）。

步骤：

1. `bundle-web` 挂载 `infra-webserver`、`infra-web-app`、`infra-frontend-static`、`infra-connection`、`infra-api-gateway`、`infra-client-modules`、`infra-client-hmr`；路径表按基线 §6.1：回退席位（静态页面）、`/api`、`/connect`、`/api/remote.mux`、`/plugins`、`/plugins/events`。
2. 认证：进程启动令牌 → `GET /` 或 `/connect` 验证 → 写入绑定 authority 的签名 cookie（密钥为 `ctx.credentials` 中连接组件拥有的 grant）→ 303 到干净地址；Host 与 Origin 信任检查。
3. `connection/request` waterfall：Desktop 用它在安装更新期间拒绝新 API 工作。
4. 健康检查（原 `/health`、`/ready`）由 platform 插件经 `ctx.webServer` 注册。
5. 过渡（§4.3）：Fastify 网关作为 `/api/v2` 的唯一实现，在同一 Host 进程内独立监听另一 loopback 端口，地址经启动注入交给页面；它不挂在 `ctx.webServer` 下，也不转发 Remote。

**验收**：

| #    | 检查         | 方法                                                                                                        | 通过标准                       |
| ---- | ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P4-1 | 通用验收     | §5.0                                                                                                        | 全部通过                       |
| P4-2 | Web 应用可用 | `zhiyun --profile web` 打开打印的地址；按 §6.2 人工验收 M1–M4                                               | 页面经新载体加载；M1–M4 通过   |
| P4-3 | 路由所有权   | `webServer` 测试：两个插件注册同一 exact 路径                                                               | 配置错误，激活失败             |
| P4-4 | 认证与信任   | 集成测试：无 cookie 访问 `/api` → 401；错误 Origin → 403；`Host: evil.example` → 拒绝；令牌在 `/api` 上无效 | 全部符合                       |
| P4-5 | 监听地址     | `zhiyun --profile web --host 0.0.0.0`；`--host 192.168.x.x` 无 TLS                                          | 前者启动失败；后者输出暴露警告 |
| P4-6 | 静态页面行为 | 测试：不存在路径 404（不回退首页）、越出 dist 403、非 GET 405、index 写入 `<base href="./">`                | 全部符合                       |
| P4-7 | 卸载撤销     | 测试：禁用 platform 条目后 `/health` 返回 404                                                               | 符合                           |

## P5：Desktop Host 与 Electron 壳

**目标**：Electron 主进程只是壳；Host 是运行完整 Web 应用的私有子进程（基线 §5、MUST 6、7、MUST NOT 4）。

步骤：

1. `apps/desktop-host`：主进程以 `spawn(process.execPath, [hostEntry, '--expose-internals', ...], { env: { ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })` 启动；Host 调用共享 runner，参数 `--profile desktop --no-open --host 127.0.0.1 --port 0`。
2. Node IPC 消息：

   | 消息                                         | 方向      | 所有方 |
   | -------------------------------------------- | --------- | ------ |
   | `ready`（URL 与启动注入）                    | Host → 壳 | Host   |
   | `fatal`                                      | Host → 壳 | Host   |
   | `shutdown` / `shutdown-complete`             | 壳 ↔ Host | 壳     |
   | `quit-inspection`                            | 壳 ↔ Host | 壳     |
   | `update-tasks`                               | 壳 ↔ Host | 壳     |
   | `credentials/encrypt`、`credentials/decrypt` | Host ↔ 壳 | 壳     |
   | `notification/show`                          | Host → 壳 | 壳     |
   | `scheduling-environment`                     | 壳 → Host | 壳     |

3. 删除 `runtime-supervisor.ts`、`utility-entry.ts`、`host-capability-server.ts`，逐项迁移其端点：

   | 原端点                                                       | 去向                                                                                    |
   | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
   | `/credentials/{put,resolve,delete}`                          | `infra-credentials-desktop` + 壳加解密 IPC                                              |
   | `/credentials/{prompt,login}`                                | 壳自有桥接：凭据录入窗口与登录窗口                                                      |
   | `/outputs/select-directory`、`/database/select-restore`      | 壳的原生目录选择桥接（preload 允许项）；数据库恢复按 D4 重新设计为 Profile 级备份与恢复 |
   | `/artifacts/save`                                            | artifacts 插件经 Remote 提供下载；另存为对话框经原生桥接                                |
   | `/notifications/show`                                        | `notification/show` IPC 消息，由 monitoring 等插件经 Host 服务发出                      |
   | `/runtime/restart`、`/runtime/diagnostics`、`/window/status` | 壳的恢复与诊断流程；诊断数据由 platform 插件经 Remote 提供                              |
   | `/external/open`                                             | 壳桥接，只允许 `http:` 与 `https:`                                                      |
   | `/cloud/state`                                               | 云账户会话保留在壳（OAuth 窗口与系统密钥）；byok/hosted 选择移入 Host 设置分节          |

4. 协议：`zhiyun-app://app/` 提供打包的 Web 入口与共享启动页；`zhiyun-app://shell/` 只提供壳自有的更新与恢复文档；应用 HTTP 请求转发给已认证 Host，丢弃 `transfer-encoding`、`connection`、`keep-alive`，插件 bundle 响应标记 `no-store`；WebSocket 只为所属窗口附加凭据。
5. Preload 只暴露：启动就绪、致命启动失败上报、原生目录选择、壳自有桥接（凭据录入、云账户登录）。删除 `zhiyunCloud.select` 等业务方法。
6. 生命周期：关闭主窗口只隐藏；普通退出前 `quit-inspection`，失败或超时按有运行中任务处理；致命失败在每个应用进程打开一次原生恢复对话框（退出、重启、备份 Profile patch 并重启）；首个致命弹窗前写崩溃报告；macOS/Linux 从图形界面启动时读取一次登录 shell 环境。
7. 状态归属：主进程在访问 Profile 前获取单实例锁，独占 `$ZHIYUN_HOME/profiles/desktop`；`app.asar` 携带运行时与完整生产依赖树；生成 `desktop-runtime.json` 并在打包时验证。
8. Analytics Worker：主进程的 `AnalyticsWorkerSupervisor` 删除，改为 analytics 域的 Worker Provider 插件（`ctx.analyticsWorker`），经 `ctx.subprocess` 启动和回收冻结的 Python Worker，归 `bundle-analytics`。

**验收**：

| #     | 检查           | 方法                                                                                               | 通过标准                                                                                            |
| ----- | -------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P5-1  | 通用验收       | §5.0                                                                                               | 全部通过                                                                                            |
| P5-2  | 壳不含业务     | `pnpm run architecture:deps`（规则：`apps/desktop` 不导入 `<domain>-*`、`infra-*` 以外的 Host 包） | 0 违规；反例 fixture 失败                                                                           |
| P5-3  | preload 暴露面 | 测试：快照 `window` 上由 preload 暴露的键与方法                                                    | 与本阶段步骤 5 的清单完全一致                                                                       |
| P5-4  | IPC 消息所有权 | 测试：发送未登记类型的 IPC 消息                                                                    | 被拒绝并记录                                                                                        |
| P5-5  | Host 进程形态  | E2E：检查 Host 子进程命令行含 `ELECTRON_RUN_AS_NODE=1`、`--profile desktop`、`--host 127.0.0.1`    | 符合                                                                                                |
| P5-6  | 关闭只隐藏     | E2E：运行中任务时关闭主窗口，重新激活                                                              | 任务继续，页面状态保留                                                                              |
| P5-7  | 退出查询       | E2E：有运行中任务时退出，确认对话框出现；模拟 Host 无响应                                          | 对话框出现；无响应按有任务处理                                                                      |
| P5-8  | 致命恢复       | E2E：注入 Host 启动失败；注入渲染进程崩溃                                                          | 各弹一次恢复对话框；崩溃报告写入日志目录；“备份 patch 并重启”生效                                   |
| P5-9  | 凭据           | E2E：保存带登录凭据的任务后，检查 `$ZHIYUN_HOME` 文件与 Remote 响应                                | 文件中无明文；响应只有不含值的信息视图                                                              |
| P5-10 | Worker         | E2E `analysis-questions.spec.ts` 通过；禁用 analytics 条目后 Worker 进程退出                       | 符合                                                                                                |
| P5-11 | 打包           | `pnpm run desktop:make` 后 `pnpm run test:smoke:desktop-package`；校验 `desktop-runtime.json`      | 通过；首次启动不运行 pnpm、不复制核心包；在未安装 Node、pnpm、Python 的干净机器上完成 §6.2 的 M1–M3 |
| P5-12 | 旧数据不动     | 在存在旧 userData 数据库的机器上首次启动                                                           | 旧文件的大小与修改时间不变；应用从空数据开始                                                        |

## P6：去掉特权内核，确立数据所有权

**目标**：每个存储领域、服务由唯一插件拥有，插件之间只经服务、类型化事件与只读投影协作（L2 §3.1、§7、MUST 2、3、MUST NOT 2、4）。

迁移顺序（被依赖者在前）：`jobs` → `artifacts` → `platform` → `datasets` → `collection` → `outputs` → `monitoring` → `templates` → `preferences` → `analytics` → `corpus` → `recruitment` → `assistant` → `identity`。

每个域的步骤：

1. 用 `defineDomain` 在模块加载时声明领域（名称、格式版本 `1`、兼容列表、表、前向迁移），删除该域在 `storage-sqlite` 与 `migrations/sqlite` 中的旧 schema。
2. 插件 `inject` 改为基础设施或所有插件的服务键；不再读取 `runtimeHost`。
3. 对外公开：只读投影服务（如 `ctx.collection.read`、`ctx.datasets.read`），返回不可变视图；写操作只在本域服务上；状态变化在提交后发出 `DomainChanged` 或本插件的类型化事件（JSDoc 标注 `@mode` 与 `@param`）。
4. 消除 §1.4 的跨域写入：

   | 现有调用                                                                                                                  | 改为                                                                                     |
   | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
   | assistant → `collection.createDraft / updateDraft / createTaskWithInitialRule / createRuleVersion / *RuleRepairProposal*` | collection 服务命令（`ctx.collection.drafts`、`ctx.collection.rules`），assistant 只调用 |
   | preferences → `collection.createTask / createRule / createRun`                                                            | collection 服务命令；趋势源安装由 collection 暴露的命令完成                              |
   | collection → `monitoring.deleteTask`                                                                                      | collection 发出 `collection/task-deleted`，monitoring 监听并清理本域状态                 |
   | collection → `outputs.createDeliveryAttempt`                                                                              | collection 发出 `collection/run-completed`，outputs 监听并创建投递                       |
   | collection → `platform.appendEvent`                                                                                       | platform 的 `ctx.events.append` 服务                                                     |
   | recruitment → `platform.createArtifact`                                                                                   | `ctx.artifacts.create`                                                                   |

5. 消除同级实现导入：platform 不再依赖 analytics、corpus、datasets（Worker 适配器归 analytics；诊断改为订阅各域只读投影）；templates 经 `ctx.collection` 服务；assistant 经 `ctx.identity` 的授权服务而非 `plugin-identity/policy` 实现。
6. 最后一个域完成后删除 `runtime-contracts`、`runtimeHost`、`Level2RuntimeDependencies`、`level2.ts` 的集中创建；platform 插件不再转发集中依赖。
7. 每个插件新增 `test/lifecycle.test.ts`（L2 §11）：激活、卸载撤销全部贡献、依赖服务缺失时等待、激活失败只让自身 Fiber 进入 `FAILED` 并可见报告、依赖方保持等待。

**验收**（每个域的 PR 都检查 P6-2 至 P6-5；阶段完成时检查全部）：

| #    | 检查         | 方法                                                                           | 通过标准                                                         |
| ---- | ------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| P6-1 | 通用验收     | §5.0                                                                           | 全部通过                                                         |
| P6-2 | 生命周期测试 | `pnpm exec vitest run desktop/packages/<domain>/plugin/test/lifecycle.test.ts` | 4 类用例齐全且通过                                               |
| P6-3 | 领域声明     | 测试：模块加载时 `defineDomain` 校验；格式版本不在兼容列表的记录               | 权威数据整次 open 拒绝                                           |
| P6-4 | 跨域写入     | `pnpm run architecture:gates` 的跨域写入计数                                   | 比上一个 PR 少；阶段结束为 0，并转为阻断                         |
| P6-5 | 事件协作     | 集成测试：删除任务后 monitoring 状态被清理；运行完成后 outputs 创建投递        | 通过                                                             |
| P6-6 | 内核清除     | `rg -n "runtimeHost\|Level2RuntimeDependencies\|runtime-contracts" desktop`    | 无结果                                                           |
| P6-7 | 同级导入     | 门禁转为阻断；反例 fixture                                                     | 0 违规；反例失败                                                 |
| P6-8 | 激活失败可见 | 测试：注入 collection 激活失败                                                 | collection `FAILED`、依赖它的 outputs 等待；错误出现在日志与诊断 |

## P7：Remote 与 controller

**目标**：Client 可调用的方法全部经 `@Remote` / `@RemoteScope` 声明，Client 类型来自生成的 descriptor 与 codec；每个 controller 有配对的 Host face 与 Client face（基线 §6.4、§6.5、MUST 10、11；L2 §6）。

步骤：

1. 每个域建 `<domain>/controller`：
   - Host face：`@Remote` 服务，委托本域 plugin 服务；权威 mutation 顺序与访问策略在此；
   - 复杂 Host 对象经 `TypertLookupMap` 与 `ctx.typert.lookups` 解析，不跨 wire；
   - 返回流的方法（运行进度、领域事件、助手输出）走 `/api/remote.mux`，每代流先 baseline 再增量；
   - Client face：与 React 无关的 model，公开 observable snapshot 与 command，重连时用新 baseline 替换。
2. 访问策略：原 `requiredPermission` 映射为 `ctx.remoteAccess` 的方法级策略；`identity` 未挂载时为单用户 owner。
3. `$events` allowlist：只转发 UI 需要的事件（运行完成与失败、数据集变化、监控告警）。
4. 迁移批次（每批一个 PR，含 UI 调用点改写与 E2E）：
   1. platform、jobs、artifacts；
   2. datasets（含清洗）；
   3. collection（草稿、任务、运行、浏览器会话）；
   4. outputs、monitoring、templates、preferences；
   5. analytics、corpus；
   6. assistant；
   7. recruitment、identity。
5. Data API（D3）：datasets 插件经 `ctx.webServer` 注册 `GET /data/v1/tasks/{taskId}/records`；令牌校验调用 outputs 拥有的 `ctx.outputs.dataTokens.verify`；`api_tokens` 仍归 outputs。
6. 最后一批合并时删除：`runtime-gateway`、Fastify 依赖、`@zhiyun/client`、`runtime/src/openapi.ts`、`client:generate` / `client:check` 脚本（同步从 `release:verify` 移除）、`/api/v2/openapi.json`、`RealtimeEventHub`、`RuntimeRoutes`、各插件 `src/http/*` 与 manifest 中的 `routes`。
7. 每个 controller 新增 `test/pairing.test.ts`（L2 §11）：Host face 与 Client face 在内存传输上配对，覆盖 baseline、增量、断线重连后 baseline 替换、未授权方法被拒绝。

**验收**：

| #    | 检查             | 方法                                                                      | 通过标准                           |
| ---- | ---------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| P7-1 | 通用验收         | §5.0                                                                      | 全部通过                           |
| P7-2 | 配对测试         | `pnpm exec vitest run desktop/packages/*/controller/test/pairing.test.ts` | 每个 controller 都有且通过         |
| P7-3 | 旧 API 清零      | `rg -l "fastify\|/api/v2\|@zhiyun/client\|RealtimeEventHub" desktop`      | 无结果                             |
| P7-4 | 未标记方法不可调 | 测试：调用 controller 上未加 `@Remote` 的方法                             | 生成类型中不存在；运行时调用被拒绝 |
| P7-5 | 访问策略         | 集成测试（`overlays/identity.yml`）：viewer 角色调用写方法                | 被拒绝；owner 允许                 |
| P7-6 | 重连             | E2E：运行任务时断开再恢复网络（`context.setOffline`）                     | 页面恢复后显示最新进度，无重复记录 |
| P7-7 | 事件 allowlist   | 测试：Host 发出 allowlist 外事件                                          | 客户端收不到                       |
| P7-8 | Data API         | 集成测试：有效令牌 200；无效令牌 401；旧路径 `/api/v2/data/...` 404       | 全部符合                           |
| P7-9 | E2E 覆盖         | E2E 对照表无空映射                                                        | 22 行全部映射                      |

## P8：Engine seam

**目标**：每个 Engine 是第一方 Provider 插件，以 `bundle-engine-<id>` 分发、按 Profile 选择（基线 §9、MUST 16、17；L2 §8、MUST 6）。

步骤：

1. `bundle-base` 提供 `ctx.engines`：Engine 注册表与统一的 Session/Run 接口；`register(id, provider)` 返回 disposer，卸载时停止并排空该 Engine 创建的运行。
2. `engine-crawlee`：封装现 `crawler-runtime`、`browser-runtime`；浏览器进程登记在 effect 中；声明支持的能力（静态抓取、浏览器渲染、登录会话）。
3. `engine-pi`：封装现 `ai-runtime`（Pi agent）；模型、端点、`CredentialRef` 为 Schemastery `Config` 字段。byok / hosted 由配置与凭据引用表达，删除 `mutableAi`、`aiOverride`。
4. 消费方（collection 运行、assistant 会话、AI 规则修复）按 Engine id 选择；引用未注册 Engine 或不支持的操作返回类型化结构错误，绝不 fallback。
5. Engine 发起的审批与提问经应用的人机交互 seam 交给用户；assistant 的“先预览再保存”沿用这一 seam。
6. Session 日志：assistant 会话改为仅追加的 Session 日志领域；交给 Engine 的输入与 Engine 报告的结果全部写入，可从日志重建。
7. `overlays/deterministic.yml` 中以确定性 Engine 替身替换 engine-crawlee 与 engine-pi。
8. 每个 Engine 新增 `test/engine.test.ts`：注册、卸载排空、不支持操作、进程失败（L2 §11）。

**验收**：

| #    | 检查         | 方法                                                                 | 通过标准                                      |
| ---- | ------------ | -------------------------------------------------------------------- | --------------------------------------------- |
| P8-1 | 通用验收     | §5.0                                                                 | 全部通过                                      |
| P8-2 | Engine 测试  | `pnpm exec vitest run desktop/packages/engine`                       | 每个 Engine 4 类用例齐全且通过                |
| P8-3 | 旧服务清零   | `rg -n "aiProvider\|crawlerProvider\|mutableAi\|aiOverride" desktop` | 无结果                                        |
| P8-4 | 缺失 Engine  | 测试：Profile 去掉 `bundle-engine-pi` 后发起助手会话                 | 返回类型化错误，UI 显示可操作提示，无静默降级 |
| P8-5 | 卸载排空     | 测试：运行中禁用 engine-crawlee                                      | 运行停止并记录为取消；无残留浏览器进程        |
| P8-6 | Session 重建 | 测试：从 Session 日志重建一次助手会话                                | 与原会话的输入和结果一致                      |
| P8-7 | headless     | `zhiyun --profile headless run-task <fixture 任务>`                  | 经 engine-crawlee 运行成功                    |

## P9：浏览器侧

**目标**：浏览器 UI 由客户端插件组成，经客户端模块组件下发、Slots 组合，只由渲染器挂载 React 根（基线 §6.6、MUST 12；L2 §6、MUST 5）。

步骤：

1. 每个 `<domain>/ui` 在 `package.json` 声明 `zhiyun.client`；`infra-client-modules` 扫描 Host Loader 中的声明，组合启动图写入 `window.__ZHIYUN_BOOT__`，bundle 在 `/plugins` 下以带 revision 的资源或 combo 脚本提供（`Cache-Control: public, max-age=31536000, immutable`）。
2. `infra-client-web` 两阶段启动：模块阶段建立懒加载模块表并预取 `immediately` 条目；插件阶段激活全部条目后交给渲染器。删除 `ui/src/shell/client-runtime.tsx`、`generated/client-profiles.json` 与静态导入。
3. 拆分 `ui-sdk`：
   - 跨插件复用的控件（按钮、表单、对话框、表格、状态提示、图表容器）→ `infra-ui-primitives` / `infra-ui-layout`；
   - Slots → `infra-ui-slots`；React 根与 `useSyncExternalStore` 绑定 → `infra-ui-renderer`（唯一调用 `renderSlot('root')`）；
   - 主题 token（现 `styles/tokens.css`，含深色模式）→ `infra-ui-theme`；
   - 业务组件回到所属域：`CollectionPreview`、`DraftTools`、`BrowserActionEditor` → collection/ui；`DatasetCleaningPanel`、`DatasetVersionPicker` → datasets/ui；assistant、analysis、monitoring 组件同理。被其他域使用的业务组件由所属域注册为具名 Slot（如 `datasets.version-picker`），使用方渲染 Slot，不导入实现。
4. 品牌、首页布局、导航与命令面板以客户端插件注册到 Slots，不写进 UI 基座。
5. 文案：每个插件拥有类型化语言字典与 `t`；新增 lint 规则拒绝 JSX 中的硬编码文案。删除全局 `ui-sdk/src/i18n.ts`。
6. 样式：按插件改为 CSS Modules + `clsx`；新增 lint 规则拒绝功能组件中的颜色字面量与主题选择器；删除 `ui-sdk/src/styles/{foundation,workspace,features}.css`。
7. 数据：页面只读 controller Client model 的快照，用户操作经 command 或 `ctx.remote`；删除 TanStack Query。路由由 Slots 的路由贡献驱动，路由实现归渲染器。
8. 构建：各包由 tsdown 打包（替换 `tooling/scripts/build-package.ts`），Vite 只构建 `apps/web`；开发期客户端热更新经 `/plugins/events`。
9. 浏览器边界输入用 zod 校验。

**验收**：

| #    | 检查           | 方法                                                                                          | 通过标准                                             |
| ---- | -------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P9-1 | 通用验收       | §5.0                                                                                          | 全部通过                                             |
| P9-2 | 动态加载       | 测试：在 overlay 中加入一个仅用于测试的 `zhiyun.client` 插件条目                              | 浏览器下次启动出现其 Slot 贡献，壳与渲染器未改       |
| P9-3 | 唯一 React 根  | `rg -n "createRoot\|renderSlot\('root'\)" desktop/packages desktop/apps`                      | 只出现在 `infra-ui-renderer`                         |
| P9-4 | 旧依赖清零     | `rg -l "@tanstack/react-query\|react-i18next\|@zhiyun/ui-sdk" desktop`                        | 无结果                                               |
| P9-5 | 样式与文案规则 | `pnpm run lint`；反例 fixture 含 `#fff` 与中文硬编码文案                                      | 主代码 0 违规；反例失败                              |
| P9-6 | 插件缓存头     | 集成测试：请求 `/plugins/<revision>/...`                                                      | `Cache-Control: public, max-age=31536000, immutable` |
| P9-7 | 可访问性       | E2E 中 axe 检查浅色与深色主题，覆盖首页、任务列表、新建采集、数据集、分析、语料、自动化、设置 | 无违规                                               |
| P9-8 | 布局           | E2E 在 360、768、1024、1440 宽度检查无横向溢出                                                | 通过                                                 |
| P9-9 | 性能           | `loading-performance.spec.ts`；首屏 JS 字节数                                                 | 均不超过 P0 基线的 120%                              |

## P10：门禁与收尾

**目标**：所有权与启动入口规则接入顶层检查，每个门禁至少有一个证明它会拒绝违规输入的用例（L2 §10、MUST 7）。

步骤：

1. 门禁全部转为阻断，接入 `pnpm run release:verify` 与 CI：

   | 门禁                                                                    | 反例用例                        |
   | ----------------------------------------------------------------------- | ------------------------------- |
   | 每条路由、Remote namespace、存储领域、Slot 贡献、服务键有唯一所有插件   | 两个插件注册同一 namespace      |
   | 插件不导入同级插件实现（只允许 `./types` 与 controller 的 Client face） | fixture 导入同级 `src`          |
   | 插件不写其他插件拥有的领域（静态检查 + P2 的运行时断言）                | 跨域 `put`                      |
   | `cordis.yml` 与组合包中的裸插件名出现在解析清单的 `dependencies`        | 未声明依赖的条目                |
   | 每个包 bin 与根脚本归入显式类别；拒绝绕过启动器的 Node 应用路径         | 新增未归类 bin                  |
   | `desktop/` 只依赖 Cordis 框架包这一类 `@deepseek-ai/*`                  | 引入 `@deepseek-ai/dsh-storage` |
   | 壳不导入业务包；preload 暴露面与清单一致                                | fixture 导入 `<domain>-plugin`  |
   | 功能 UI 不含颜色字面量、主题选择器与硬编码文案                          | fixture 含 `#fff`               |
   | 不存在插件管理组件与 `plugin` 命令                                      | 注册 `plugin` 子命令            |

2. 更新根 `README.md`、`desktop/` 下的开发说明、`vendor/README.md` 与 CI 工作流中的路径和命令；删除本文 §4.3 中已结束的并存项。
3. 执行 §6 总体验收。

**验收**：

| #     | 检查       | 方法                                                           | 通过标准                          |
| ----- | ---------- | -------------------------------------------------------------- | --------------------------------- |
| P10-1 | 通用验收   | §5.0                                                           | 全部通过                          |
| P10-2 | 门禁反例   | `pnpm exec vitest run tooling/scripts/test/architecture-gates` | 上表 9 个门禁各至少一个反例且通过 |
| P10-3 | 并存项清零 | §4.3 每行的删除断言                                            | 全部满足                          |
| P10-4 | 合规清单   | §7 每行都有证据链接                                            | 全部勾选                          |
| P10-5 | 总体验收   | §6                                                             | 全部通过                          |

## P11：dsh-plugin 改用新包

**目标**：DSH 内嵌产品改用新的组合包与 controller。

步骤：

1. 盘点 `dsh-plugin/src` 对旧包的导入（当前为 `@zhiyun/runtime`、`@zhiyun/client`、`@zhiyun/ui-sdk`、`@zhiyun/ai-runtime`、`@zhiyun/crawler-runtime`、`@zhiyun/analytics-worker-client`、`@zhiyun/shared`）。
2. 改为挂载 `bundle-base` 的业务域条目与所需 controller；原 `dsh-studio` 的组合（不含招聘）在 dsh-plugin 内声明。
3. Remote 元数据改用本项目 `infra-typert-generator` 生成的 descriptor；工具分组沿用。
4. 恢复 `dsh-plugin:build`、`dsh-plugin:test`、`dsh-plugin:package` 为 CI 必过项。

**验收**：

| #     | 检查       | 方法                                                                | 通过标准                       |
| ----- | ---------- | ------------------------------------------------------------------- | ------------------------------ |
| P11-1 | 构建与测试 | `pnpm run dsh-plugin:build && pnpm run dsh-plugin:test`             | 通过                           |
| P11-2 | 旧包清零   | `rg -l "@zhiyun/(runtime                                            | client                         | ui-sdk)['/]" dsh-plugin/src` | 无结果 |
| P11-3 | 宿主验收   | 按 `dsh-plugin/ACCEPTANCE.md` 的“实际宿主验收”表复跑 Web 与 Desktop | 全部通过，结果写入新的验收记录 |

---

# 6. 总体验收

P10 完成时执行一次，结果写入 `desktop/docs/acceptance/final.md`。

## 6.1 自动化

```bash
pnpm run release:verify
pnpm run desktop:make
pnpm run test:smoke:desktop-package
pnpm run architecture:gates
```

全部通过；`architecture:gates` 违规数为 0。

## 6.2 人工验收脚本

在全新的 `ZHIYUN_HOME` 上用打包后的 Desktop 执行；每步记录“通过 / 不通过 / 备注”。

| #   | 场景         | 操作与预期                                                                                       |
| --- | ------------ | ------------------------------------------------------------------------------------------------ |
| M1  | 首次启动     | 显示首页与入门清单；`$ZHIYUN_HOME/profiles/desktop` 已创建；旧 userData 数据库未被读取或改动     |
| M2  | 样例体验     | 用内置样例运行一次，看到记录与“最近运行”                                                         |
| M3  | 新建采集     | 输入网址 → 在网页上点选字段 → 预览三个页签 → 保存并运行；运行完成后窗口在后台时收到系统通知      |
| M4  | 数据集       | 打开数据集，切换数据、清洗与版本、变更比较三个页签；导出 CSV 并另存到选择的目录                  |
| M5  | 清洗         | 添加清洗步骤、预览、执行，生成新版本                                                             |
| M6  | 分析         | 选择问题卡，自动生成数据版本，得到图表结果；切换深色主题后图表配色跟随                           |
| M7  | 语料         | 从数据集构建语料并导出                                                                           |
| M8  | 自动化       | 设置定时任务，在定时列表中看到；配置一个本地文件输出并完成一次投递                               |
| M9  | 助手         | 让助手生成规则，预览后保存；未配置模型时得到明确提示而非静默失败                                 |
| M10 | 凭据         | 为需要登录的任务录入凭据；重启后任务仍可运行；数据目录中找不到明文                               |
| M11 | 快捷键与导航 | ⌘/Ctrl+K 搜索并跳转；⌘/Ctrl+N 新建；窄窗口下汉堡菜单可用                                         |
| M12 | 生命周期     | 运行中关闭窗口后任务继续；退出时出现中断确认；强制结束 Host 进程后出现恢复对话框，重启后数据完整 |
| M13 | Web 形态     | `zhiyun --profile web` 用浏览器完成 M3、M4                                                       |
| M14 | 受限形态     | `zhiyun --profile web --patch overlays/safe.yml`：分析、语料、助手、招聘入口不存在，其余功能正常 |
| M15 | Data API     | 创建 API Token，用 `curl` 访问 `/data/v1/tasks/{taskId}/records` 得到记录；撤销后 401            |

## 6.3 发布矩阵

| 平台        | 安装 | 首次启动 | 升级（本次版本 → 下一个补丁版本） | 签名 / 公证 | 卸载 | 离线启动 |
| ----------- | ---- | -------- | --------------------------------- | ----------- | ---- | -------- |
| macOS arm64 |      |          |                                   |             |      |          |
| macOS x64   |      |          |                                   |             |      |          |
| Windows x64 |      |          |                                   |             |      |          |
| Linux x64   |      |          |                                   |             |      |          |

升级一栏验证：升级后数据保留、Profile patch 保留、`desktop-runtime.json` 与壳版本一致。

## 6.4 非功能

| 项       | 标准                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 性能     | 冷启动到首页可见、首屏 JS 字节数不超过 P0 基线的 120%；安装包体积不超过 P0 基线的 110% |
| 安全     | P2-8、P4-4、P4-5、P5-3、P5-9、P7-4、P7-5、P7-8 全部通过                                |
| 可访问性 | P9-7、P9-8 通过                                                                        |
| 许可     | `pnpm run compliance:licenses` 通过；`THIRD_PARTY_SOURCES.json` 覆盖全部复制文件       |
| 发布说明 | 写明 D3（Data API 新路径）与 D4（旧数据不迁移，旧文件位置）                            |

---

# 7. 合规清单

## 7.1 Level 2

| 条款       | 内容摘要                                    | 落实阶段 | 证据             |
| ---------- | ------------------------------------------- | -------- | ---------------- |
| MUST 1     | 遵守基线全部 MUST                           | 全部     | §7.2             |
| MUST 2     | 按业务域拆插件，唯一所有者                  | P1、P6   | P1-4、P10-2      |
| MUST 3     | 只经服务、类型化事件、只读投影协作          | P6       | P6-4、P6-5、P6-7 |
| MUST 4     | 组合包与 Profile 表达形态，overlay 表达测试 | P3       | P3-2、P3-3       |
| MUST 5     | Client face 经客户端模块组件与 Slots 接入   | P9       | P9-2             |
| MUST 6     | Engine 为第一方 Provider，按组合包选择      | P8       | P8-2、P8-4       |
| MUST 7     | 所有权与启动入口规则接入门禁                | P0、P10  | P0-5、P10-2      |
| MUST NOT 1 | 不挂载插件管理、不提供 `plugin` 命令        | P3、P10  | P3-9             |
| MUST NOT 2 | 不导入同级实现、不写他域                    | P6       | P6-4、P6-7、P2-7 |
| MUST NOT 3 | 不为测试或受限组合另设 Profile              | P3       | P3-2             |
| MUST NOT 4 | 不建集中编排的业务服务                      | P6       | P6-6             |
| MUST NOT 5 | 不为基础设施已提供的能力另建平行 seam       | P2、P6   | P2-2；评审       |

## 7.2 基线（与本次重构相关的条款）

| 条款        | 落实阶段        | 证据        |
| ----------- | --------------- | ----------- |
| MUST 1      | P6              | P6-6        |
| MUST 2、3   | 已满足；P2 门禁 | P2-6        |
| MUST 4      | P3              | P3-3、P3-4  |
| MUST 5      | P3              | P3-5、P3-8  |
| MUST 6、7   | P5              | P5-5、P5-11 |
| MUST 8      | P4              | P4-2、P4-3  |
| MUST 9      | P4              | P4-4、P4-5  |
| MUST 10、11 | P7              | P7-2、P7-4  |
| MUST 12     | P9              | P9-2、P9-3  |
| MUST 13     | P6、P7、P10     | P10-2       |
| MUST 14     | P6              | P6-3        |
| MUST 15     | P2、P5          | P5-9        |
| MUST 16、17 | P8              | P8-2、P8-6  |
| MUST 18     | D7              | 本文 §0.2   |
| MUST 19     | P3              | P3-7        |
| MUST 20、21 | P2              | P2-2、P2-5  |

MUST NOT 1–14：2、3、7、8 由 P2 落实（P2-4、P2-6）；4 由 P5（P5-2、P5-3）；5 由 P3（P3-8）；6、12、13 由 P6（P6-4、P5-12）；10 由 P8（P8-4）；11 由 P9（P9-5）；9（waterfall 短路）与 14（兼容性检查不称为沙箱）在 P10 评审中逐项确认。

---

# 8. 风险

| 风险                        | 影响                                     | 处理                                                                          |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| 一次性删除旧 API（D1、D2）  | P4–P7 期间 `main` 无可发布版本           | P4–P7 在同一发布周期内完成；期间不发 Desktop 版本；每个 PR 仍要求 §5.0 通过   |
| 旧数据不迁移（D4）          | 现有用户升级后看不到旧任务与数据集       | 发布说明明示；旧数据库保留在原位置，不删除（P5-12）                           |
| E2E 依赖中文文案与角色名    | UI 迁移时大量断言需改写                  | 以 P0 覆盖对照表逐条映射；只改定位方式，不删断言                              |
| 跨域写入改为事件后的一致性  | 运行完成→投递、任务删除→监控清理可能延迟 | 事件在领域写入提交后发出；需要同步结果的场景改为所有者服务命令；P6-5 集成测试 |
| 基础设施组件规模大          | P2 工作量高                              | 以 DSH 源码复制改写为主，测试随代码复制；按依赖闭包分 9 个 PR                 |
| 启动时间与 bundle 体积      | 两阶段启动与按插件 bundle 可能拖慢首屏   | P9-9 与 §6.4 的阈值；`immediately` 只给首屏所需插件                           |
| dsh-plugin 长期不可用（D6） | DSH 内嵌产品停更                         | P11 紧随 P10；CI 临时移出必过项需在 PR 中注明                                 |

---

# 9. 附录

## 9.1 常用命令

```bash
pnpm install
pnpm run vendor:prepare
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run architecture:deps
pnpm run architecture:check
pnpm run architecture:gates
pnpm run test
pnpm run desktop:build
pnpm run desktop:test
pnpm run test:smoke:desktop-package
pnpm run release:verify
```

P3 之后：

```bash
pnpm run zhiyun -- --profile web --dump-config
pnpm run zhiyun -- --profile web --patch desktop/apps/cli/overlays/e2e.yml
pnpm run zhiyun -- --profile headless run-task <taskId>
```

## 9.2 验收记录模板

`desktop/docs/acceptance/P<n>.md`：

```markdown
# P<n> 验收记录

- 日期：
- 执行人：
- 提交：<git 哈希>
- 环境：<操作系统、架构、Node 版本>

## 通用验收

| 命令 | 结果 | 备注 |
| ---- | ---- | ---- |

## 阶段验收

| #   | 结果 | 证据（命令输出摘要、测试名、截图路径） |
| --- | ---- | -------------------------------------- |

## 偏离与遗留

- 无 / <对应 §0.2 的 D 编号>

## 复核

- 复核人：
- 结论：通过 / 不通过
```

## 9.3 进度

| 阶段 | 状态   | PR / 提交 | 验收记录 | 并存项计数（§4.3） |
| ---- | ------ | --------- | -------- | ------------------ |
| P0   | 未开始 |           |          |                    |
| P1   | 未开始 |           |          |                    |
| P2   | 未开始 |           |          |                    |
| P3   | 未开始 |           |          |                    |
| P4   | 未开始 |           |          |                    |
| P5   | 未开始 |           |          |                    |
| P6   | 未开始 |           |          |                    |
| P7   | 未开始 |           |          |                    |
| P8   | 未开始 |           |          |                    |
| P9   | 未开始 |           |          |                    |
| P10  | 未开始 |           |          |                    |
| P11  | 未开始 |           |          |                    |
