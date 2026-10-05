# ZhiYun 无需外部凭据的优化实施计划

本计划把当前项目分析、同类产品调研和 GitHub 项目调研转化为可持续执行的工程任务。主目标是补齐本地采集、清洗、分析和监控工作台的体验与可靠性，全部使用本地夹具、Mock Provider 和隔离测试环境验收，不要求用户填写 API Token、支付密钥或签名证书。

编制日期：2026-10-03。本文是实施规格，任务状态与执行证据统一记录在 [优化执行记录](../verification/zhiyun-no-credentials-optimization.md)。创建本文不表示优化已实施，也不表示目标模式已经启动。

## 当前项目与优化方向

当前项目由 `desktop/` 本地桌面产品与 `platform/` 商业平台构成。桌面产品采用 Electron、React、TypeScript Runtime、SQLite 和本地 Python Analytics Worker；商业平台负责账户、订阅、积分与托管 AI。继续保持这个边界，优化工作围绕“网页采集 → 数据清洗 → 分析 → 持续监控”的用户路径展开。

### 已有能力与需要补齐的能力

| 领域       | 已有实现                                                                 | 本计划补齐的能力                                              |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 采集配置   | 草稿、页面点选、预览、字段规则、模板、分页                               | 多样本校验、字段质量反馈、列表与详情关系的明确呈现            |
| 数据与执行 | 不可变 Snapshot、版本化规则、SQLite 持久任务队列、Artifact、部分流式快照 | 采集端分批写入、URL 级 checkpoint、进程中断后的准确恢复       |
| AI 助手    | Mock/BYOK/托管入口、Stagehand 适配、修复验证后激活                       | 本地规则缓存、语义动作验证、固定夹具评测、成本信息的来源说明  |
| 清洗与分析 | 类型化分析方法、Analysis Recipe、分析问题入口、本地 Python 计算          | 可复用清洗操作、字段问题定位、分析过程溯源与分支比较          |
| 监控       | 空结果、数量下降、字段缺失、空值突增、类型和内容变化检测                 | 可配置过滤条件、阈值、冷却与聚合、本地通知、睡眠唤醒策略验证  |
| 管理后台   | 云端列表、客户端过滤、模拟商业流程                                       | 服务端过滤与游标分页，查询完整历史                            |
| 工程质量   | 类型、Lint、契约、架构、测试、构建与打包脚本                             | 修复当前依赖审计问题、缩小大文件职责、补齐隔离 E2E 与打包验收 |

需要特别区分：任务队列可恢复，不等于每个已采集 URL 和已写入记录都能准确恢复；已有 Snapshot 使用 spool/Parquet，也不等于采集器已经避免全量数组驻留内存。OPT04 只补齐这些缺口。

### 本次会话的观测基线

以下是 2026-10-03 前序分析中对本机工作区的观测，后续执行须在 OPT00 重新确认，不可当作未来改动的验收结果。

- `typecheck`、`lint`、`format:check`、架构约束、客户端生成检查、云端契约检查通过。
- TypeScript 测试 87 个文件、432 项通过；Python Worker 测试 39 项通过，有一项 statsmodels 时间频率推断警告。
- Desktop 与 Cloud 构建通过；Desktop 构建存在约 574 KB 图表 chunk 提示，Runtime utility bundle 约 21.55 MB。需要测量加载成本后再决定拆分方式。
- 依赖审计报告 27 项问题，其中 1 项 critical、26 项 high；涉及 Next.js、Fastify 和若干传递依赖。执行时以最新审计结果为准。
- 本次分析未重跑 Cloud 数据库测试、桌面和云端 E2E、安装包冒烟、远程 CI 或真实外部服务验证。仓库已有历史验收记录，但不能替代本轮验收。
- 工作区包含大量目录迁移和未提交改动。必须先识别现有改动，再开展优化，不能把删除列表直接当作功能缺失。

## 调研依据与采用方式

下表的优化方案是结合本项目代码作出的设计建议；链接支持借鉴对象的能力，不代表其方案可以原样移植或已经在本项目验证。资料整理日期为 2026-10-03，依赖版本和许可在实施时复核。

| 参考对象                                                                                             | 借鉴点                                             | 对应任务     |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------ |
| [Octoparse 操作基础](https://helpcenter.octoparse.com/en/articles/6470919-lesson-0-octoparse-basics) | 页面、操作流程、数据预览放在同一条可确认路径上     | OPT02        |
| [ParseHub 相对选择](https://help.parsehub.com/hc/en-us/articles/218226157-Relative-Select)           | 通过父子容器关系表达列表记录与关联字段             | OPT02        |
| [Apify 输入 Schema](https://docs.apify.com/actors/development/actor-definition/input-schema)         | 用统一 Schema 驱动表单、校验和参数说明             | OPT02        |
| [Crawlee](https://github.com/apify/crawlee)                                                          | 持久请求队列、会话管理与资源调度；项目已使用此依赖 | OPT04        |
| [Stagehand](https://github.com/browserbase/stagehand)                                                | 语义动作与结构化提取；项目已接入适配器             | OPT05、OPT06 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai)                                                    | 提取规则复用、正文过滤和资源控制的设计             | OPT04、EXT01 |
| [changedetection.io](https://github.com/dgtlmoon/changedetection.io)                                 | 变化过滤、条件触发和通知的组织方式                 | OPT09        |
| [OpenRefine](https://github.com/OpenRefine/OpenRefine)                                               | Facet、操作历史与可复用清洗步骤                    | OPT07        |
| [Data Formulator](https://github.com/microsoft/data-formulator)                                      | 分析过程分支与上下文溯源                           | OPT08        |
| [MarkItDown](https://github.com/microsoft/markitdown)                                                | 文档到文本的格式适配                               | EXT01        |
| [update-electron-app](https://github.com/electron/update-electron-app)                               | Electron 更新源和更新流程的封装                    | EXT02        |

Crawlee、Crawl4AI、changedetection.io 的仓库采用 Apache-2.0；Stagehand、Data Formulator、MarkItDown、update-electron-app 采用 MIT；OpenRefine 采用 BSD-3-Clause。真正引入代码或新依赖时重新检查对应版本的 LICENSE、NOTICE、传递依赖与分发要求。Skyvern 的 AGPL-3.0 方案只作为交互研究参考，本计划不默认引入其代码。

Stagehand v4 的内建缓存依赖远程 Browserbase 浏览器环境，不能把本地浏览器上的 `cache: true` 当作已经获得持久缓存。OPT05 在现有规则与版本模型上实现本地缓存，依据见 [Stagehand 缓存说明](https://docs.stagehand.dev/v4/best-practices/caching)。

本计划借鉴 Data Formulator 的过程表达，不开放任意 Python/SQL 执行；借鉴 Crawl4AI 的机制，不另建一套 Python 浏览器采集服务。架构边界继续遵循 [当前架构](../architecture.md)、[仓库布局](../architecture/REPOSITORY_LAYOUT.md) 和 [Level 2 方案](../architecture/ZHIYUN_LEVEL2_TS_PYTHON_REFACTOR.md)。

## 执行范围与外部边界

### 主目标包含的工作

OPT00 至 OPT11 全部属于主目标。允许编辑代码、契约、测试和文档，安装项目所需的公开依赖，创建临时本地数据与测试服务，运行本机支持的平台构建及未签名安装包测试。AI 相关功能使用显式 Mock Provider；商业流程使用模拟支付与本地测试账户。

本地测试数据库的地址和一次性测试凭据由执行者自动生成或采用夹具值，用户无需填写。不得覆盖用户已有 `.env`、读取或输出真实密钥、自动调用真实 AI Provider。网络调研与公开依赖下载不需要业务 Token。

### 不作为主目标完成条件的工作

| 外部事项           | 本计划可以交付                                | 留待外部条件具备后验证                     |
| ------------------ | --------------------------------------------- | ------------------------------------------ |
| 真实模型           | 缓存、修复流程、Mock 测试、评测夹具与指标脚本 | 模型准确率、真实 Token 与费用、线上稳定性  |
| 真实支付与短信邮件 | 本地契约、模拟购买与退款、错误处理            | 商户接入、到账、真实消息送达               |
| 应用签名与公网更新 | 未签名本机包；EXT02 的更新状态机与模拟源      | macOS 签名公证、Windows 签名、真实更新发布 |
| 招聘平台同步       | 现有导入与 deeplink 路径的回归                | 获得平台授权后的实时同步                   |
| 生产与远程 CI      | 本地构建、运行手册、可审查的 workflow 改动    | 公网部署、GitHub 上传、远程 CI 结果        |
| 真实用户研究       | 可运行的样例与现有测试脚本维护                | 招募参与者、真实成功率与访谈反馈           |
| 跨操作系统验证     | 当前宿主平台的运行证据与测试代码              | 其他系统的真实安装与运行结果               |

这些事项在执行记录中标为“范围外待验证”，不混入已完成结果。新的本地阻碍不能据此自动排除：主目标中的依赖审计、隔离数据库测试、E2E 或本机包验收若未通过，主目标仍未完成。

EXT01 和 EXT02 是可单独启动的扩展目标，记录在同一份文档中，但默认不进入主目标。1.0 继续不建设第三方插件市场、Extension Host、独立 Analytics 微服务、向量数据库或 RAG。

## 目标模式启动指令

在当前项目聊天中发送下面的指令即可作为主目标输入。目标模式若需要预算，由用户自行指定；本文不预设 Token 预算。

```text
请进入目标模式，完成 ZhiYun 无需外部凭据的优化主目标。

先阅读 docs/product/zhiyun-no-credentials-optimization-plan.md 和
docs/verification/zhiyun-no-credentials-optimization.md，以这两份文档为实施规格和进度依据。
目标是完成 OPT00 至 OPT11，并满足计划中的全部验收条件。
EXT01、EXT02 和明确列出的外部事项不属于本次主目标。

从 OPT00 开始，按依赖顺序执行。先保护和记录工作区已有改动；不要重置、清理、
覆盖、批量暂存或提交已有改动，不要提交或推送代码，不要发布或部署。
沿用现有架构和已有功能，只实现文档描述的增量。

不要求我填写 Token、API Key、支付密钥或签名证书；显式使用 Mock AI、模拟支付、
本地夹具和隔离测试数据库。不读取或输出真实凭据，不调用真实模型或外部通知渠道。
本地数据库和测试进程由你管理，不修改开发数据库、不清理共享卷、不终止其他进程。

每完成一个任务，更新执行记录中的状态、文件、测试命令、退出码和验收证据。
对声称已实现的能力，必须先确认代码和有意义的测试，再登记为已完成。
遇到可修复问题继续处理；局部受阻时记录原因并继续无依赖任务。
必做任务或验收未完成时不能宣布目标完成；需要外部条件的范围外事项单独记录。

完成后给出改动摘要、验证结果、实测指标、文档链接和范围外待验证事项。
```

中断后可发送：“继续执行 ZhiYun 无需外部凭据的优化主目标，先读取计划和执行记录，从未完成任务继续，不重做已有且仍有效的验收。”执行者仍须检查中断期间的代码与环境变化；变化使证据失效时只重跑受影响部分。

## 执行顺序与记录规则

| 批次 | 任务                | 前置条件                | 批次交付                               |
| ---- | ------------------- | ----------------------- | -------------------------------------- |
| 0    | OPT00               | 无                      | 工作区基线、隔离环境、可执行的测试入口 |
| 1    | OPT01               | OPT00                   | 安全依赖与可复现锁文件                 |
| 2    | OPT02、OPT03        | OPT01                   | 预览反馈、失败诊断、用户路径回归       |
| 3    | OPT04               | OPT02、OPT03            | 分批采集与 URL 级恢复、资源测量        |
| 4    | OPT05、OPT06        | OPT04；OPT06 依赖 OPT05 | 本地缓存、经过验证的修复、Mock 评测    |
| 5    | OPT07、OPT08、OPT09 | OPT04；OPT08 依赖 OPT07 | 清洗配方、分析过程、本地条件告警       |
| 6    | OPT10               | OPT01 至 OPT09          | 服务端分页、可维护性和性能改进         |
| 7    | OPT11               | OPT00 至 OPT10          | 全量检查、E2E、本机打包证据与最终报告  |

每个任务遵循“确认已有实现 → 描述差量 → 实现 → 针对性验证 → 登记证据”的顺序。已经满足要求的能力可以只补证据，不制造重复实现。任务编号固定；状态仅在执行记录维护，本文不重复维护勾选框。

新功能与接口变更必须保持契约、生成客户端、持久化和 UI 同步。变更应按可回归的最小范围推进；不默认启动其他聊天或子代理。每轮执行结束前记录下一步、中间失败和未提交改动，便于跨上下文恢复。

## 主目标任务与验收

### OPT00 工作区基线与测试隔离

**实施内容**：记录 HEAD、分支、工作区改动摘要与目录迁移情况；检查 Bun、Node、uv、Python、浏览器及本地容器运行能力。生成本轮运行编号与 Artifact 目录，区分原有改动和本轮增量。只记录必要元数据，不把凭据文件复制到证据目录。

Desktop 测试沿用 `desktop/tooling/scripts/test-isolated.ts` 的临时数据目录。Cloud 测试建立本轮专属 PostgreSQL 数据库，数据库名必须以 `_test` 结尾，Redis 使用隔离实例或明确的命名空间。使用独立 Compose 项目、独立卷和空闲端口，禁止截断开发库或执行共享环境的 `down -v`。

**主要入口**：`package.json`、`desktop/tooling/scripts/`、`platform/tooling/scripts/`、`platform/portal/playwright.config.ts`、`tooling/scripts/development.ts`。

**验收条件**：执行记录列明前置工具、原始改动摘要、测试隔离方法和命令入口；数据库脚本在非 `_test` 库、非测试路径或错误目标上拒绝破坏性操作；测试退出时仅清理本次创建的进程与资源。

现有平台启动器会终止目标端口的占用进程。测试启动前必须确认端口空闲；如被占用，改用测试专属端口并同步 Origin 与代理，或为测试启动路径实现安全模式。不能直接借用开发端口并杀掉已有服务。工具不足时先完成不依赖该工具的任务，明确记录受阻验收。

### OPT01 依赖安全与锁文件

**实施内容**：重新执行依赖审计，区分直接依赖、传递依赖、运行时与构建时影响；采用最小兼容升级，复核锁文件与许可证清单。前序发现的 Next.js 16.3.4 和 Fastify 5.12.1 问题需优先处理，但执行时复核当前公告和修复版本。

**依据**：[Next.js 安全公告](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j)、[Fastify 安全公告](https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7)。未发现 `next/og` 或 `ImageResponse` 的使用，只能说明尚未观察到该触发路径，不能替代升级。

**主要入口**：根与各工作区 `package.json`、`bun.lock`、Worker `pyproject.toml` 与 `uv.lock`、`tooling/scripts/generate-node-licenses.ts`。

**验收条件**：原有审计命令通过，且没有新增 ignore、降低审计级别或隐藏公告；现有三项 ignore 的理由与适用范围逐项登记，能够移除时移除。类型、受影响测试和 Desktop/Cloud 构建通过；许可证清单与锁定依赖一致。网络审计不可用只记为未验证，不以离线推断代替通过。

### OPT02 采集预览与字段确认

**实施内容**：围绕已有草稿和点选流程，呈现页面样本、记录容器、字段规则和预览对应关系。展示每个字段的缺失数量、空值比例、类型异常和样本值；对空预览、仅匹配单条、疑似导航/广告容器给出可操作的提示。统一复用已有 Schema 表单校验。

建立至少三组本地夹具：静态列表与详情、动态分页、含噪声及部分缺失字段的页面。允许用户在至少三个样本中确认规则，并在详情关系无法唯一确定时指出原因。

**主要入口**：`desktop/packages/ui/src/pages/CollectionFlowPage.tsx`、`TaskEditorPage.tsx`、`components/DraftTools.tsx`、`components/SchemaForm.tsx`、`plugins/collection/src/`、`desktop/tooling/fixtures/`。

**验收条件**：无需模型完成“选页面 → 确认字段 → 预览 → 保存 → 运行 → 查看 Dataset”；三类夹具都能给出一致的字段反馈；非法规则不能静默保存为可执行规则；草稿版本冲突、幂等提交和现有模板行为保持正确。至少一条桌面 E2E 验证完整路径。

### OPT03 可解释的采集失败诊断

**实施内容**：运行详情按步骤显示导航、动作、选择器匹配、提取和写入结果；将网络失败、选择器失效、预览为空、资源上限、取消等原因映射为明确的重试或修改入口。支持导出经过清理的诊断包，包含时间、规则版本、Trace ID 与必要的步骤元数据。

原始 DOM、请求头、Cookie、填表值与页面截图不默认进入诊断包。截图或 Trace 如有必要，采用显式开关、敏感区域处理、大小与保留期限限制。参考 [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) 的步骤表达，默认诊断数据仍由本项目控制。

**主要入口**：`desktop/packages/browser-runtime/src/index.ts`、`crawler-runtime/src/index.ts`、`plugins/collection/src/`、`ui/src/pages/RunDetailPage.tsx`、Artifact Store。

**验收条件**：导航失败、字段失效、超时、取消四类夹具均能定位到步骤并提供下一步操作；诊断序列化测试证明敏感标记不会出现在输出中；诊断不可用不改变原运行结果；导出与清理只作用于所选运行。

### OPT04 分批采集与 URL 级恢复

**实施内容**：把生产采集路径从全量 `records[]` 改为可等待的批次写入或异步迭代，保持背压、取消和错误传播。预览可以保留有严格上限的小数组。持久化请求状态、分页进度和提交位置，使用稳定的运行及请求标识，停止在每次执行结束后无条件丢弃可恢复队列。

为批次建立幂等键或提交序号，明确 Artifact 写入与数据库 checkpoint 的一致性协议。中断恢复采用至少一次处理与幂等提交，不能在“数据已写入、checkpoint 未提交”时重复产生最终记录；规则版本变化不得继续使用旧 checkpoint。

复用现有 Crawlee 与队列能力，参考 [会话管理](https://crawlee.dev/js/docs/guides/session-management)、[并发调度](https://crawlee.dev/js/docs/guides/scaling-crawlers) 和 [Crawl4AI 资源控制](https://docs.crawl4ai.com/advanced/multi-url-crawling/)。不另建采集服务。

**主要入口**：`desktop/packages/crawler-runtime/src/index.ts`、`plugins/collection/src/application/`、`plugins/datasets/src/`、`capabilities/queue-local/`、`capabilities/artifact-store/`。

**验收条件**：

1. HTTP 与浏览器夹具均分批产出；下游变慢时不会无限缓存待写记录。
2. 在请求执行中、Artifact 写入后、checkpoint 提交前后注入中断，重新启动得到与不中断运行相同的记录及统计，无丢失和重复最终记录。
3. 取消、重试、分页、已有去重策略和不可变 Snapshot 语义正确；临时文件有明确回收规则。
4. 使用相同硬件上的 1 万与 10 万条、每条约 1 KiB 的 HTTP 夹具测量 Runtime 峰值 RSS、耗时、记录数量与浏览器请求数。建议资源验收目标为：10 万条的增量峰值 RSS 不超过 1 万条的三倍，且吞吐不低于原实现的 80%。这是待验证的工程目标；记录采样方法、三次运行中位数及原实现基线，测试内存中不预先生成完整数据数组。

资源目标未达成时必须定位并修复，或保留任务未完成并说明原因，不能在执行记录里悄悄放宽指标。浏览器与 Python 的进程内存另行记录，不能混入上述 HTTP Runtime 比较。

### OPT05 本地规则缓存与失效控制

**实施内容**：缓存经过验证的结构化提取规则与浏览器动作，默认先确定性执行，失败后才进入受控修复流程。缓存键至少包含任务/规则版本、页面结构指纹、动作语义与关键配置；涉及模型时包含 Provider、模型及 Prompt/工具 Schema 版本，不保存密钥或认证材料。

区分命中、验证失败、过期、规则变化和手动清理。页面结构变化时先验证，再决定重用或修复。缓存不跨越认证会话复用敏感页面内容，不保存整页原始 DOM。

**主要入口**：`desktop/packages/browser-runtime/src/index.ts`、`plugins/ai-assistance/src/application/`、`plugins/collection/src/`、对应 SQLite Repository 与 migrations。

**验收条件**：同一夹具的首次调用创建规则，后续执行 Mock Provider 调用数为零；结构变化、规则升级和模型/Prompt 版本变化均按预期失效；损坏缓存自动降级并显示原因；填表值、Cookie、Token 和整页内容不落入缓存。报告实际命中数与 Mock 调用数，不宣称真实 AI 费用下降比例。

### OPT06 语义动作修复与离线评测

**实施内容**：在现有修复流程上增加结构化 `semanticGoal` 与 `expectedState`，对候选动作验证页面状态、记录 Schema 和数据质量，验证失败不激活新规则。沿用显式版本激活，禁止把等待与填表中的敏感值发送给模型。

建立不少于 12 个固定、无外网依赖的评测用例，覆盖布局变化、分页按钮移动、字段缺失、无效动作、提示注入和敏感信息。记录修复流程通过率、验证拒绝率、缓存命中率、调用数和耗时。指标标题明确标记 Mock/规则夹具，结果不得称为真实模型准确率。

助手成本面板区分“估算”“Mock 值”“实际结算”；无真实 Token 使用信息时显示未知或未结算，不能默认填零成本。预估上限可用 Mock 验证停止行为。

**主要入口**：`desktop/packages/plugins/ai-assistance/src/application/assistant.ts`、`pi-adapter.ts`、`browser-runtime/src/index.ts`、助手 UI 与本地评测脚本。

**验收条件**：12 个用例的期望行为全部通过；错误规则、越权工具调用和恶意页面指令无法激活；验证失败保留当前有效规则；成本上限用例停止后无后续调用；评测脚本可重复运行并输出带夹具版本的机器可读报告。真实模型验证列为范围外事项。

### OPT07 清洗操作与可复用配方

**实施内容**：在现有 Dataset 与 Worker 的类型化接口上增加受限清洗步骤，首轮限定为去首尾空白、空值归一、数字/日期类型转换、字段拆分或合并、按字段去重六类。提供字段 Facet/质量摘要、转换预览和错误行计数。

保存操作顺序、参数、输入 Snapshot、输出 Snapshot 和配方版本；复用配方前校验字段存在性与类型。通过重新指向或派生 Snapshot 撤销步骤，保留源数据不可变。参考 [OpenRefine Facet](https://openrefine.org/docs/manual/facets) 与 [操作历史](https://openrefine.org/docs/manual/running)。

**主要入口**：`desktop/packages/plugins/datasets/src/`、`plugins/analytics/src/`、`ui/src/pages/DatasetPage.tsx`、`desktop/analytics-worker/src/zhiyun_analytics_worker/normalization.py` 与 `models.py`。

**验收条件**：六类操作都有确定的输入/输出夹具；撤销/重做、配方在第二个兼容 Snapshot 复用、类型错误提示均通过；原 Snapshot 内容不变；TS/Python 契约与生成客户端一致；不存在任意公式、Python 或 SQL 执行入口。

### OPT08 分析问题入口与过程溯源

**实施内容**：扩展已有分析入口，首轮覆盖分组比较、时间趋势、分布及异常点四类问题。由字段 Schema 推荐可用问题和参数，生成已有类型化 Analysis Recipe，缺少时间或数值字段时说明原因。

每个分析结果保存输入 Snapshot、清洗配方版本、分析参数、执行状态和 Artifact 引用。用户可从已有结果修改参数产生分支，并比较两个兼容结果。图表选择采用确定性映射；图表失败仍能展示表格与解释。

**主要入口**：`desktop/packages/ui/src/pages/AnalyticsPage.tsx`、`AnalysisJobPage.tsx`、`components/AnalysisChart.tsx`、`plugins/analytics/src/`、Worker `analytics.py`。

**验收条件**：四类问题均可用固定数据从选择问题完成到可查看结果；结果能准确回到输入与配方版本；分支不会覆盖原结果；兼容性不足时拒绝比较并提示原因；大结果分页读取，不下载全量 Artifact 才能显示首屏。

### OPT09 条件监控与本地通知

**实施内容**：复用已有变化检测，增加包含/排除字段、绝对或百分比阈值、连续异常次数、冷却时间与相同事件聚合。规则首轮限定为字段值变化、记录数量下降、空值比例上升三类；有明确稳定默认值和预览说明。

在桌面主进程接入本地通知；通知被系统拒绝或不可用时，应用内事件仍可查阅。验证系统睡眠、恢复与离线错过调度的 `skip`/`run-once` 行为，沿用现有调度选项，不增加重复调度体系。

**主要入口**：`desktop/packages/plugins/monitoring/src/`、`plugins/outputs/src/`、`ui/src/components/ScheduleBuilder.tsx`、`desktop/src/main.ts` 和 Host Capability 边界。

**验收条件**：三类规则分别覆盖触发、不触发、冷却与聚合；新增/更新/删除事件与 Run 可追溯；模拟睡眠唤醒不会重复调度；本地通知拒绝不导致任务失败；通知内容不包含凭据或完整敏感字段。无 Webhook、邮件、短信或其他外部通知发送。

### OPT10 列表分页与代码性能

**实施内容**：将 Cloud Portal/Admin 中固定取最近 200 条再在前端过滤的相关列表，改为服务端参数校验、过滤与稳定游标分页。采用明确排序和唯一键作为同值排序的后续条件，参数化 SQL，不拼接用户提供的列名或 SQL。

围绕本计划已修改的 `TaskEditorPage.tsx`、`assistant.ts`、`level2.ts` 等大文件按职责提取模块，不改变 Plugin/Profile 边界。复测首屏和图表加载，检查已有懒加载是否有效；Runtime 大 bundle 先分析依赖组成，再做有实测收益的调整。

**主要入口**：`platform/server/src/app.ts`、`platform/packages/cloud-contracts/`、`platform/packages/cloud-client/`、`platform/portal/src/portal.tsx`、`platform/admin/src/main.tsx`、受影响 Desktop 页面与 Runtime。

**验收条件**：每个被改造列表使用超过 200 条测试记录证明完整历史可查询；过滤、同时间戳排序、跨页无重复/遗漏、非法 cursor 和权限隔离测试通过；前后端契约一致。记录改动前后构建产物大小、首屏与图表加载测量；拆分保持行为测试通过。仅换目录或拆行数不算性能优化，测量无收益时记录结论并避免多余拆分。

### OPT11 本地回归与交付验收

**实施内容**：按下一节运行全量静态检查、业务测试、构建、隔离 Cloud 回归、Desktop/Cloud E2E 和当前宿主平台未签名包冒烟。为新路径提供可运行的本地样例，更新产品说明与运行手册；核对执行记录和最终差量。

**主要入口**：根 `package.json`、`desktop/e2e/`、`desktop/e2e-packaged/`、`platform/server/tests/`、`platform/portal/e2e/`、`docs/product/` 与 `docs/verification/`。

**验收条件**：OPT00 至 OPT10 的每个验收条件都有有效证据；本轮全部必做检查通过；未签名包可启动，执行至少一条本地采集并读取 Dataset，Worker ready 与分析结果均可验证；本轮进程退出后无残留。最终报告明确本机系统、实际验证范围、性能测量、Mock 限制与范围外事项。

## 验证命令与数据保护

### 每个任务的验证

先运行受影响包与对应夹具的检查。契约变更时先更新生成产物，再运行对应 `*:check`；Python 变更同时运行 Ruff 与相关 pytest。新增测试须验证业务行为、边界或失败恢复，不写只复制实现的断言。文档单独改动只需格式、链接和差量检查。

Desktop 的业务测试优先使用隔离入口，例如：

```bash
bun desktop/tooling/scripts/test-isolated.ts desktop/packages/crawler-runtime/test
bun desktop/tooling/scripts/test-isolated.ts desktop/packages/runtime/test
```

性能测试必须确认实际收集到对应用例；存在 `test:performance` 脚本不表示已有本计划所需的 10 万条压力夹具。

### 最终静态检查与构建

以下命令从仓库根目录执行。已有 `release:verify` 可以汇总其中大部分检查，但它不包含 Cloud 数据库测试、E2E 与安装包冒烟，不能单独作为全部验收。

```bash
bun run lint
bun run worker:lint
bun run format:check
bun run architecture:deps
bun run architecture:check
bun run client:check
bun run worker:client:check
bun run cloud:contract:check
bun run typecheck
bun run cloud:check
bun run test
bun run worker:test
bun run build
bun run dependency:audit
bun run compliance:licenses
git diff --check
```

依赖审计访问公开 registry；如遇网络失败，保留错误并稍后重试。不要把网络错误解释为不存在漏洞。已通过的检查只在后续变更使其失效时重跑；收尾采用一次覆盖最终工作区的完整检查。

### 本地服务与安装包验收

先由 OPT00 建立专属测试 PostgreSQL/Redis、空闲端口、临时桌面数据目录和显式 Mock 配置，再执行：

```bash
bun run cloud:test
bun run test:e2e:cloud
bun run test:e2e:desktop
bun run worker:build
bun run worker:smoke
bun run test:smoke:desktop-package
```

这些命令不是可以对默认开发环境直接复制的无条件操作。执行者须把 Cloud 测试与 E2E 的连接变量都指向本轮专属 `_test` 数据库；核对 `CLOUD_E2E_DATABASE_URL`、测试文件读取的数据库变量、Redis 与启动器的实际地址。Mock 配置必须明确，不能从真实 `.env` 继承 Provider 或消息通道。

桌面测试与打包进程不得读取用户正常桌面数据；其配置与退出清理必须可验证。本机无需签名即可完成开发包冒烟，但不能把成功打包描述为签名公证或跨平台发布完成。保存命令、退出码、运行编号和报告路径，不提交构建输出或敏感日志。

## 可单独启动的扩展目标

### EXT01 文档导入与正文整理

按需引入 MarkItDown 的最小格式转换能力，首轮限定本地 PDF、DOCX、HTML 到文本/Markdown。文件由主进程确认并复制到工作目录，通过 Worker 的受限 Artifact 引用调用；设置大小、页数、转换时间和输出限额。超限、损坏与不支持格式返回明确错误，不自动下载远程 URL，不默认启用 OCR、音频、云端模型或整套插件。

前置条件为 OPT07、OPT08、OPT11。验收包含三类正常文件、损坏文件、超限文件、无文本扫描 PDF 与路径越界；产物来源与权限可追溯，并测量新增依赖对包体积及启动的影响。主目标不依赖该转换能力。

启动指令：“进入目标模式，依据无需外部凭据优化计划实施 EXT01，使用本地文件夹具完成受限文档转换及本机打包验证，不调用外部服务；更新同一份执行记录。”

### EXT02 自动更新流程与模拟更新源

依据 [Electron Forge 更新说明](https://www.electronforge.io/advanced/auto-update) 与 update-electron-app，先评估当前 Forge Maker 和操作系统兼容性，再实现更新检查、状态展示、失败重试与安装前退出协调。生产模式保持签名与完整性要求；本地模拟源只用于测试状态机，不允许未验证更新进入实际生产安装流程。

前置条件为 OPT01、OPT11。验收覆盖无更新、新版本、下载失败、文件损坏、安装前正在运行任务和重启恢复；不能仅凭 Mock 事件声称真实更新成功。真实签名、公证、公开更新源与另一操作系统的验证另列待办。

启动指令：“进入目标模式，依据无需外部凭据优化计划实施 EXT02，完成自动更新状态机、localhost 模拟源测试和兼容性记录，不签名、不发布、不替换当前安装；更新同一份执行记录。”

## 主目标完成定义

主目标完成需要同时满足：OPT00 至 OPT11 均为已完成；最终检查覆盖当前工作区并通过；关键用户路径、恢复、隔离与数据保护有实测证据；新功能文档与契约一致；范围外事项明确标记。任务不存在对应源码时不能只修改文档勾选，已有功能也不能只凭名称推断通过。

遇到局部阻碍先继续不依赖它的任务，并记录重现、原因、已尝试措施和下一步。必做验收未完成时不宣称完成，也不因为预算接近用尽而改成完成。目标模式的暂停、受阻和预算状态遵循其运行规则，本文不会把等待外部服务当作自动排除任务的理由。

最终交付包括代码差量、更新后的产品文档、执行记录、检查结果、性能与资源数据及本机未签名包的验收记录。代码提交、推送、发布与生产部署均不属于本次主目标。
