# 织云助手实施与验收记录

更新：2026-09-10。代码验收、真实模型评估和真实用户验收分别记录。

## 实现

- 首页四个入口、`/assistant?conversation={id}`、全局侧栏共用会话控制器、消息、卡片和实时订阅。旧助手地址仍可打开。
- 无资源会话、三种帮助方式、归档恢复、历史分页、取消与重试。普通问答不创建 CollectionDraft；第一次写配置时才关联唯一业务草稿。
- 保留 pi 和现有 Provider；按权限生成工具目录，加入帮助、上下文、教程、导航、诊断、修复和操作准备。
- 对话使用 io；页面检查、规则生成、预览和修复使用 browser-heavy。Provider 嵌套调用传递取消信号。保留 8 轮、12 次工具、120 秒限制。
- 预览在执行端限制 10 行、2 个列表页或加载批次、12 次文档请求、30 秒；历史样本和失效卡片明确标识。字段修改使用用户已观察到的版本。
- 保存、保存运行、再运行、计划、应用修复、仅重试输出和导出使用持久化操作卡。任务、运行、修复版本和导出文件使用稳定标识恢复。运行完成或失败返回原会话。
- 保存时再次校验草稿版本并使用 CAS；排队运行记录任务与规则版本，实际启动前发现变化则失败并要求重新确认；导出在一致性快照内重新校验数据版本，避免检查与执行之间的变化被忽略。Provider 限流退避也响应取消信号。
- 草稿安全登录复用 Desktop Host；Web 无受控登录时提供受保护的手动配置入口。取消不写入草稿，冲突清理未关联的新凭据引用。
- 四个版本化教程。点选面板和服务端提取共享打包商品内容；字段、预览、运行、导出和分页加载均有服务端证据。跳过不会伪装为业务成功。
- 新会话及所有者在同一事务创建。旧共享会话保持共享；动作重验权限和资源版本；实时连接重新验证会话，退出后停止订阅。
- SQLite/PostgreSQL 新增 AI 002、Platform 003 迁移，保留原迁移文本。采集从明确意图开始记录；教学与样例单列，沿用本地指标开关、清除和 90 天保留期。

## 六条关键路径

| 路径       | 界面与工具                                               | 验收证据                                                                                          |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 无任务问答 | 首页/独立页 → search_help/read_context                   | pi 脚本验证帮助工具、无草稿、io 作业和用户隔离事件                                                |
| 已有网址   | 写草稿 → 检查页面 → 字段 → 预览 → 操作卡                 | 采集助手、统一草稿、执行预算回归；真实模型端到端待凭据                                            |
| 只有想法   | 搜索候选 → 用户选源 → 页面检查；失败提供样例与现有导入页 | 来源确认约束及 pi 工具回归；真实搜索质量待模型评估                                                |
| 独立学习   | 四课 → 点选/加载/预览/运行/导出证据                      | Runtime 样例闭环；当前 Desktop 复用 `desktop/tooling/e2e/assistant.ts`（历史 Web 亦复用同一场景） |
| 运行失败   | 就地求助 → diagnose/prepare_repair → 预览 → 应用卡       | 运行及修复回归；权限、版本冲突、恢复测试                                                          |
| 创建后追问 | 保存并运行 → 后台结果 → 原会话继续问答                   | 真实 SQLite Runtime 完成样例、任务、运行、Dataset、导出及追问                                     |

## 接口补充

新接口属于 `/api/v2/assistant`，OpenAPI 和生成客户端同步。会话元数据与教学事件使用 `conversation.revision`；`PUT /conversations/{id}/context` 使用独立的 `conversation.context.revision`。操作卡使用 action revision，草稿继续使用 CollectionDraft revision。写入携带 Idempotency-Key。

增加 `POST /conversations/{id}/actions`，供预览界面准备具体操作卡，不会直接执行。教程增加 `load_more` 事件，服务端记录打包样例的加载范围。导航消息仅允许产品内链接，不渲染模型 HTML。

## 可复现检查

```sh
bun desktop/tooling/scripts/test-isolated.ts desktop/packages/plugins/ai-assistance/test desktop/packages/plugins/collection/test/drafts.integration.test.ts desktop/packages/runtime/test/assistant.integration.test.ts desktop/packages/runtime-gateway/test/authorization.test.ts
bun run --filter @zhiyun/desktop build
bun x playwright test -c desktop/playwright.config.ts -g assistant
bun run release:verify
```

`test-isolated.ts` 创建并清理临时 SQLite 数据目录。Desktop E2E 使用临时 user-data-dir。界面测试保存 360、768、1024、1440px 截图，执行 Axe、Escape 与焦点恢复检查；Electron 使用 Axe 的 legacy mode。

2026-09-10 已通过 Web 全部 9 个端到端用例与 Desktop 全部 8 个端到端用例，覆盖助手及既有工作台。相关 SQLite/PostgreSQL、草稿登录、排队时版本变化与 Provider 取消测试已运行；完整发布门禁结果见本文件后续记录。

Web 测试文件共用同一独立数据库及一次性管理员初始化，因此配置为一个 worker，避免两个文件同时初始化产生 409。测试服务器使用 Node 启动 Vite；修复前 Bun 启动方式曾在首个 HTML 请求上等待超时。没有延长断言超时或跳过业务用例。

当前环境真实 Provider 配置检查结果为 **未配置**，检查只输出是否配置的布尔值，没有输出密钥。脚本 Provider 结果不计为真实模型验证。

## 最终本机验证结果

2026-09-10，在包含排队运行版本保护的最终代码上执行 `bun run release:verify`，**退出码 0**。

| 检查                                                                                 | 结果                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------ |
| TypeScript 单元、集成及 SQLite/PostgreSQL 一致性测试                                 | 90 个文件，497 项通过                |
| Python 分析 Worker                                                                   | 39 项通过                            |
| Web 端到端                                                                           | 9 项通过                             |
| Desktop 端到端                                                                       | 8 项通过                             |
| macOS arm64 实际打包应用                                                             | 1 项通过：动态采集与分析             |
| ESLint、Ruff、格式、架构依赖与目录、OpenAPI/客户端生成一致性、全工作区类型检查与构建 | 通过                                 |
| 高危依赖审计与许可证清单                                                             | 通过；沿用已有审计忽略项，未新增忽略 |

证据保存在工作区忽略目录 `.artifacts/assistant/`：

- [完整发布检查日志](../../.artifacts/assistant/release-verify.log)、[验证摘要](../../.artifacts/assistant/verification.txt)。
- [Web 1440px](../../.artifacts/assistant/web-assistant-1440.png)、[Web 360px](../../.artifacts/assistant/web-assistant-360.png)。
- [Desktop 中文](../../.artifacts/assistant/desktop-assistant-1440.png)、[Desktop 英文](../../.artifacts/assistant/desktop-assistant-en-1440.png)。目录中保留两端、中英文、四种宽度共 16 张截图。

这里只记录已执行的本机验证，不将其视为 P6 的真实模型、小白用户及其他操作系统验收完成。

## 发布与待验收事项

`ZHIYUN_ASSISTANT_ENABLED=false` 关闭新助手入口和写操作，保留历史读取及旧采集数据。恢复开关无需迁移回退。旧二进制能否运行新 schema 须针对实际发布版本验证，不能承诺直接降级。

真实 Provider 六路径评估、5–8 名代表性用户测试（至少 3 名没有采集经验）和其他操作系统 CI 尚须执行。没有发送招募消息，没有虚构首次完成率或耗时基线。用户观察脚本见 `usability-test-script.md`。

正式发布仍以必需用例通过、真实验证留有记录和无阻断问题为准。

## 发布门禁发现的依赖问题

`release:verify` 的依赖审计发现 js-yaml 4.3.1 与旧 extract-zip 2.0.1 的高危公告。js-yaml 固定到同一主版本修复版 4.3.2；仅在 Electron 打包依赖使用 extract-zip 的位置，覆盖为 Electron 已在使用的 `@electron-internal/extract-zip@1.0.5`，保留 `extract(zip, { dir })` 调用方式。没有新增安全忽略项。随后执行审计和实际打包冒烟检查。

依据：[js-yaml 公告](https://github.com/advisories/GHSA-2883-xcg3-v3hh)、[extract-zip 公告](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3)、[Electron 提取器 API 与适用范围](https://github.com/electron/extract-zip)。旧 extract-zip 的公告未列修复版本，因此使用 Electron 自有提取器，而不是将原版本标记为已修复。

## SQLite 统一后的验收补充（2026-09-10）

本文上方的 PostgreSQL 相关结果是切换前的历史记录。当前所有端统一 SQLite，`test-isolated.ts` 使用临时 SQLite 数据目录；Redis/PostgreSQL 的驱动、测试分支和服务依赖均已移除。当前验证及既有数据迁移证据见 [SQLite 统一存储记录](../adr/0010-unified-sqlite.md)。

SQLite 切换后完整 `bun run release:verify` 已通过：433 项 TypeScript、39 项 Python、9 项 Web、8 项 Desktop 和 1 项 macOS arm64 安装包测试。已停止旧 Redis/PostgreSQL 服务，迁移数据通过 54 张业务表、2697 条记录逐字段核验；Linux 与其他支持平台仍由对应 CI 验证。

## 本轮用量、预估额度与离线修复评测（2026-10-04）

助手回复下方的“本轮 AI 用量与费用”展示调用数、Token 来源与费用来源。Mock 数值明确标为“Mock 值”；Provider 报告的 Token 与 Mock 混合时标明混合来源。估算、实际结算分别展示，并保留币种，不自动换算。旧回复、离线固定引导或未收到用量信息的调用显示“未知 / 未结算”，不把旧的零占位值当作真实免费账单。结算信息仅在 Provider 明确提供时展示；当前 OpenAI-compatible 适配器不会从 Token 数量推算结算金额。

发送消息前，可展开“本轮预估上限（可选）”，填写上限、每次 AI 调用估价与 CNY/USD 币种。HTTP 接口 `POST /api/v2/assistant/conversations/{id}/messages` 支持可选 `costBudget`：

```json
{
  "content": "请检查当前采集规则",
  "costBudget": {
    "maximum": 0.5,
    "perCallEstimate": 0.25,
    "currency": "CNY"
  }
}
```

该额度按本轮实际 Provider 方法调用计数，聊天和工具中的 Schema/规则生成、提取、解释、修复共用一个额度；独立浏览器队列继续使用父轮额度。估价不足以覆盖下一次调用时，停止追加模型和工具调用。设定上限但没有可用估价时，真实 Provider 在首次请求前停止。Mock 在未显式提供估价时使用已知的 Mock 零估价；设定零上限仍会阻止调用。预算停止不能被普通错误回退吞掉，不能保存中断生成后的回退草稿。

预算与核算结果保存到该轮回复，刷新与历史读取保留。失败调用仍计入调用次数；重试保留预算设置，为新的一轮单独核算。额度用于控制给定估价下的追加调用，不保证真实账单不会超过上限，单次调用的内部请求重试也不单独估价。没有测量真实模型 Token、费用或准确率。

固定的 `repair-quality-v3` 评测覆盖布局、分页移动、字段质量、无效动作、提示注入、敏感配置、工具授权、缓存与预算停止。修复候选先检查输出 Schema 和用户配置，再用本地当前页面验证字段及数据质量；成功复验后才允许显式激活新版本，失败复验会清除旧测试资格。报告中的通过率是 Mock/规则夹具的预期行为通过率。

```sh
bun --no-env-file run ai:evaluate
bun --no-env-file run desktop:test e2e/assistant-cost.spec.ts
```

评测输出带夹具版本、逐例状态、调用数、耗时、修复验证/拒绝率、缓存命中率和源文件哈希的 JSON。桌面专项验证预算填写与请求载荷、历史恢复、未知费用、中英文与窄屏显示；预算的实际停止另由 Runtime 队列与 Mock Provider 集成用例验证。本轮命令、退出码和报告以 [无需外部凭据优化执行记录](../verification/zhiyun-no-credentials-optimization.md) 为准。
