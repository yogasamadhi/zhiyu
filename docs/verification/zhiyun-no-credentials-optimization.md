# ZhiYun 无需外部凭据的优化执行记录

本文件是 [优化实施计划](../product/zhiyun-no-credentials-optimization-plan.md) 的任务状态与证据入口。计划编制日期为 2026-10-03；主目标 OPT00 至 OPT11 已于 2026-10-04 完成。最终业务、静态、构建、隔离 Cloud、完整 Desktop E2E、当前宿主应用包与资源清理均有实际证据，详见本文件末尾的最终验收核对。EXT01、EXT02 未启动，明确列出的真实外部事项仍为范围外待验证。

前序分析的测试结果在计划中作为观测基线保留，不在本文件登记为优化任务完成证据。实施者在开始、任务状态变化和结束时更新本文件。

## 当前执行上下文

| 项目                    | 当前值                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| 目标范围                | 主目标 OPT00 至 OPT11；EXT01、EXT02 默认不执行                                                             |
| 当前状态                | 已完成                                                                                                     |
| 当前任务                | OPT11 已完成；全部必做检查、当前宿主应用包、24 项桌面 E2E 与资源清理通过                                   |
| 本轮运行编号            | `20261003T054244Z`                                                                                         |
| HEAD 与分支             | `34215e527342ed118ca8a6824ff8ea77edcfcdc6`，`main`；未提交或切换分支                                       |
| 宿主系统与工具版本      | macOS 27 arm64；Bun 1.4.0；Node 24.18.0；uv 0.11.14；Worker Python 3.12.13；Docker Server 29.6.2           |
| 原有工作区改动摘要      | 26 个修改、456 个删除、13 个未跟踪聚合条目；记录 573 个非忽略文件的哈希，不复制凭据或源码内容              |
| 本轮改动清单            | 最终记录 730 个源码/文档文件；相对 573 个基线文件修改 150 个、新增记录 157 个，基线缺失 0                  |
| 测试数据库与 Redis 隔离 | 每次执行独立 `zhiyun-test-<uuid>` 项目与临时数据卷；本机动态端口；数据库名分别以 `_test`、`_e2e_test` 结尾 |
| Artifact 根目录         | `.artifacts/no-credentials-optimization/20261003T054244Z/`                                                 |
| 下一步                  | 主目标无剩余必做任务；EXT01/EXT02 保持独立未启动，外部事项按下表另行验证                                   |

## 主目标任务状态

状态限定为：未开始、进行中、已完成、受阻。只有实施内容与全部验收满足时才能登记为已完成；受阻任务写明原因并保持未完成。范围外待验证不属于此表的状态。

| 任务  | 内容                   | 前置任务       | 状态   | 证据位置或阻碍                                                                                                                                      |
| ----- | ---------------------- | -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPT00 | 工作区基线与测试隔离   | 无             | 已完成 | 下文 OPT00 证据                                                                                                                                     |
| OPT01 | 依赖安全与锁文件       | OPT00          | 已完成 | 下文 OPT01；保留一项原有构建期例外                                                                                                                  |
| OPT02 | 采集预览与字段确认     | OPT01          | 已完成 | 下文 OPT02；三样本 Desktop 完整路径通过                                                                                                             |
| OPT03 | 可解释的采集失败诊断   | OPT01          | 已完成 | 下文 OPT03；实际步骤、恢复、导出与清理通过                                                                                                          |
| OPT04 | 分批采集与 URL 级恢复  | OPT02、OPT03   | 已完成 | 37 个采集进程及 2 个 Chromium 终止窗口；真实 Electron 三类恢复；15 条完整 E2E 加启动清理专项；HTTP 资源门槛与独立浏览器/Python 记录；见下文逐条验收 |
| OPT05 | 本地规则缓存与失效控制 | OPT04          | 已完成 | 规则/动作、组合采集、会话与隐私、失效/清理和 UI 均有证据；原生 CSS 悬停误判已修正；下文逐条验收及 opt05-completion-audit.json                       |
| OPT06 | 语义动作修复与离线评测 | OPT05          | 已完成 | 44 项固定夹具连续两次通过、预算与独立队列停止、费用来源/历史与桌面；12 项核对见 opt06-completion-audit.json                                         |
| OPT07 | 清洗操作与可复用配方   | OPT04          | 已完成 | 实际 Worker/Artifact/SQLite、8 个 HTTP/客户端接口、桌面七步操作、配方复用、撤销/重做、源文件哈希与类型拒绝；见 opt07-completion-audit.json          |
| OPT08 | 分析问题入口与过程溯源 | OPT07          | 已完成 | 四类问题、冻结输入/历史版本、分支比较、逐行分页、图表双类失败回退均通过实际桌面验收；见 opt08-completion-audit.json                                 |
| OPT09 | 条件监控与本地通知     | OPT04          | 已完成 | 下文 OPT09 完成证据：三类条件、205 条接口分页、52 次成功桌面运行、通知拒绝/不可用、Run 溯源和真实调度 IPC                                           |
| OPT10 | 列表分页与代码性能     | OPT01 至 OPT09 | 已完成 | 下文 OPT10 完成证据：21 个列表完整历史、桌面职责模块、321 项业务回归、真实规则历史与修复、前后构建/加载测量和资源清理                               |
| OPT11 | 本地回归与交付验收     | OPT00 至 OPT10 | 已完成 | 下文最终核对：21 个必做脚本与 diff、24 项完整 Desktop E2E、当前宿主包、24 组资源复测及自有进程/Profile/Compose 清理均通过                           |

## 扩展目标状态

| 任务  | 内容                     | 状态   | 范围说明                       |
| ----- | ------------------------ | ------ | ------------------------------ |
| EXT01 | 文档导入与正文整理       | 未启动 | 独立目标，不计入主目标完成条件 |
| EXT02 | 自动更新流程与模拟更新源 | 未启动 | 独立目标，不包含真实签名或发布 |

## 任务证据写法

每个任务开始后，在本节追加对应记录。记录结构如下；不要把示例占位符当作已经发生的结果。

```text
任务：OPTxx
状态与时间：进行中 / 已完成 / 受阻，实际时间
运行编号与代码范围：HEAD、相关文件；本轮增量与原有改动的关系
已有能力确认：代码入口、已有测试；无需重复实现的部分
实际改动：新增行为、契约/持久化/客户端/UI 的同步情况
逐条验收：计划中的条件 → 夹具/报告/源码位置 → 实际结果
验证命令：工作目录、命令、非敏感配置、退出码、日志或报告路径
实测指标：输入规模、环境、采样方法、基线、结果；没有测量则写未测量
失败与处置：重现步骤、原因、尝试、遗留影响
清理与隔离：本轮进程/数据库/临时文件的去向，确认未触碰开发数据
后续任务：下一步及依赖条件
```

必要的报告保存在本轮 Artifact 目录，可在本文件给出仓库相对路径。报告不得包含真实 Token、Cookie、认证头、密码或未经清理的页面内容。忽略提交的 Artifact 可以作为本地证据，但关键结论、命令、退出码和指标必须写入本文件，以免清理后无法审查。

### OPT00 工作区基线与测试隔离

2026-10-03 完成。基线元数据保存在本轮 `baseline.json`：记录 HEAD、分支、495 条 Git 状态和 573 个文件哈希；排除环境文件、私钥、证书和忽略的产物。现有迁移与未提交改动保持原样，没有 reset、stash、提交或推送。

原有 Desktop 单元测试已有临时数据目录，Electron E2E 已有临时用户 Profile；本轮沿用并补齐环境过滤。`tooling/scripts/test-environment.ts` 仅复制必要的操作系统变量，显式使用测试模式与模拟渠道，不继承任意命名的模型密钥、消息配置或签名信息。Bun 测试子进程使用 `--no-env-file`；测试平台启动器绕过项目环境文件。

新增 `platform/deploy/compose.test.yml` 和 `platform/tooling/scripts/test-isolated.ts`：每次新建独立 Compose 项目、PostgreSQL 卷和 Redis 实例，只绑定 localhost 动态端口，使用自动生成的测试库名称。结束时只对本轮项目执行清理，并查询标签确认没有剩余容器或卷。Docker 后端最初未运行，已启动本机 Docker 应用；未改变其他容器或开发数据库。

`run-platform.ts --isolated-test` 调用安全端口预检，遇到占用即拒绝启动，不终止监听进程。Cloud E2E 使用动态端口并同步代理、Origin 和测试 URL，退出时向启动器发送 SIGTERM。Desktop Playwright 不复用已有测试站点。数据库测试与 E2E seed 在建立连接前要求本机 PostgreSQL、合法数据库名和对应 `_test` 后缀，拒绝查询参数、远程地址及开发库。

可复现入口：

```bash
bun --no-env-file run cloud:test:isolation
bun --no-env-file run cloud:test
bun --no-env-file run cloud:e2e
bun --no-env-file run test
bun --no-env-file run desktop:test
bun --no-env-file run test:smoke:desktop-package
```

最后两个入口的环境过滤已经落地，完整桌面 E2E 和未签名包运行验收仍由 OPT11 完成，本节没有宣称已运行它们。

| 验证                 | 实际结果                                                                                                  | 退出码与证据                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 隔离策略测试         | 4 项通过，28 个断言；包括凭据剔除、危险 DB URL 拒绝、占用端口监听仍存活、真实 seed 拒绝开发库且未尝试连接 | 0；`cloud:test:isolation`                  |
| Cloud 单元与集成     | 原有 25 项业务测试通过，覆盖模拟商业流程、权限、计费和恢复；本轮专属库与 Redis                            | 0；`cloud-isolated-unit.txt`               |
| Cloud 网页 E2E       | 2 项通过；打包桌面商业专项 1 项按原配置跳过，未计为通过                                                   | 0；`cloud-isolated-e2e.txt`；约 39.3 秒    |
| Desktop 隔离业务测试 | 87 个文件、432 项通过；临时 SQLite/Crawlee 数据目录                                                       | 0；`opt00-desktop-test.txt`；约 74.3 秒    |
| TypeScript           | 根工程与全部工作区通过                                                                                    | 0；`opt00-typecheck.txt`                   |
| 变更文件 ESLint      | 通过；中间发现的 finally 语法检查问题已修复                                                               | 0                                          |
| 依赖边界             | 388 个模块、1110 条依赖，无违规                                                                           | 0；`architecture:deps`                     |
| 中断清理             | 在运行建立后向测试入口发送 SIGTERM；入口返回预期 130；按本轮 Compose 标签查询容器、卷、网络均为零         | 验证脚本 0；`cloud-isolated-interrupt.txt` |

两次正常运行与一次中断运行均仅清理本轮资源。此前出现的 Playwright 环境类型不匹配已通过返回无 `undefined` 值的环境对象修复，全工作区类型检查通过。性能采集夹具与本机安装包尚未测量，不在 OPT00 计作完成。

### OPT01 依赖安全与锁文件

2026-10-03 完成。初始 `dependency:audit` 返回 1，复现 27 项漏洞（1 critical、26 high），见 `audit-before.txt`。修复后原 high 阈值审计及补充安全检查均返回 0。当前仍有 8 项低于 high 阈值的公告，以及一项原有构建期 ICNS 例外；不宣称全部漏洞归零。

直接依赖采用最小安全版本下限：Portal Next.js 16.3.6、Fastify ^5.12.2（锁定 5.12.5）、Nodemailer ^10.0.6（锁定 10.0.13）。同时锁定 adm-zip、brace-expansion、fast-uri、undici 的安全版本，保留原 Electron 等兼容覆盖。`bun.lock` 使用 Bun 1.4 支持的 version-scoped overrides 和 lockfileVersion 3。

braces 3.0.3 与 http-cache-semantics 4.2.0 的公告尚无上游发布修复，采用 `tooling/dependency-patches/` 中有来源、原始 tarball SHA-512 与许可证的本地源码修复。前者限制解析深度并拒绝递归 AST；后者在存储/重验证限制下拒绝 max-stale 或 stale-while-revalidate 绕过。私有包重命名并非验收依据：补充审计继续查询原始上游版本、打印公告、拒绝未登记的新 high/critical，并从实际 Forge、Electron 下载器及 Crawlee 依赖图执行安全回归。没有新增 ignore 或降低级别。

原三项 ignore 逐项复核：extract-zip 已由现有 `@electron-internal/extract-zip` 覆盖，移除该 ignore；image-size JXL/HEIF 公告不影响锁定 0.7.5，移除该 ignore；仅保留 appdmg 构建期 image-size ICNS 例外，输入限定仓库图标，移除条件记录于 [依赖审计例外](../security/dependency-audit-exceptions.md)。Nodemailer 默认禁用文件与 URL 附件读取，使用内存流测试，未发送真实邮件。

| 验证             | 实际结果                                                                                                                              | 退出码与本轮 Artifact                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 锁文件           | `bun --no-env-file install --frozen-lockfile --ignore-scripts` 通过；不变更锁文件                                                     | 0；`opt01-security-gates.txt` 的安装阶段            |
| 原审计与补充审计 | 1037 个包；8 项低于阈值，1 项原有 ignore；本地补丁 14 项/42 断言通过，Node 语法通过                                                   | 0；`opt01-security-recheck.txt`                     |
| 许可证           | 1087 个当前锁图 npm 包、51 个 Python 包；两个补丁的上游来源、MIT/BSD-2-Clause 原文与 SHA-256 存在                                     | 0；`opt01-licenses.txt`、`opt01-node-licenses.json` |
| Desktop 隔离测试 | 87 文件、432 项通过；约 63.2 秒                                                                                                       | 0；`opt01-desktop-test-serial.txt`                  |
| Cloud 隔离测试   | 环境与补丁测试 18 项；服务器与离线邮件测试 27 项通过                                                                                  | 0；`opt01-cloud-test-recheck.txt`                   |
| Cloud E2E        | 2 项通过、原有专项 1 项跳过；约 16.2 秒；3 个应用端口、专属容器/卷已释放                                                              | 0；`opt01-cloud-e2e.txt`                            |
| 静态/架构        | 根 lint、format:check、architecture:deps、architecture:check、typecheck、git diff --check 通过；最后解析调整额外 ESLint/Prettier 通过 | 0；`opt01-static.txt`                               |
| 构建             | Desktop 与 Cloud 全部构建通过；Portal 显示 Next.js 16.3.6；已有图表 chunk 提示仍在                                                    | 0；`opt01-builds.txt`                               |

中间失败与处理：`bun audit fix --dry-run` 在 install 和 frozen install 通过后仍报告元数据不匹配，改为显式升级并复核锁文件；新增补丁测试的 require 解析无法访问 import-only 的 got-scraping，改用 Bun 的 ESM 解析，14 项通过；与多个构建/静态检查并行时采集测试 4 项超时，停止并行负载后单独 9 项与全套 432 项均通过，未放宽超时或改变业务断言。失败日志保留在 `opt01-security-gates.txt`、`opt01-cloud-test.txt`、`opt01-desktop-test.txt`。

### OPT02 采集预览与字段确认

2026-10-03 完成。沿用 `CollectionFlowPage` 的草稿版本、自动保存、点选、模板、10 条预览和提交指纹校验，以及 `TaskEditorPage` 的专业规则编辑，没有新增另一套创建流程。

提取器在预览模式输出结构化字段状态：未匹配、空白、类型转换失败、正常匹配；不把原始输入放入诊断状态。修复非法数字文本被转换为 0 的情况，空字符串转数值/日期/URL 时保留空值。HTTP、浏览器、JSON 与内置商品预览保留相同结构；草稿的既有 JSON 持久化保存诊断，OpenAPI 和生成客户端已同步。

共用 `CollectionPreview` 显示声明字段的缺失数量、空值比例、类型异常、前三条样本值、列表/详情来源及选择器。用户可切换最多十个样本、逐条确认，看到来源页面、容器与字段状态；本地“已检查”标记在重新预览时清空。旧预览没有诊断时不虚构缺失或转换失败次数，显示未测量；专业编辑规则变化时保留上次预览的规则上下文，并提示重新预览。模板参数表单改为复用已有 `SchemaForm` 和必填校验。

空预览、仅单条记录、疑似导航/广告容器均有调整规则的提示；详情状态区分链接缺失、多链接、多详情容器、无详情记录、访问失败和请求上限。草稿提交拒绝多链接/多详情容器歧义；可编辑草稿仍可保存未完成配置。可执行规则的创建、版本保存和提交先验证 CSS、XPath、JSONPath、字段存在性及详情 URL 字段类型，失败不产生可执行任务或运行。

新夹具在 `desktop/tooling/fixtures/src/preview-pages.ts`：静态三条列表及对应详情、按钮加载的动态分页、导航/广告/缺失/空白/非法数值混合页面，另有两组详情歧义页面。噪声夹具的价格字段精确得到缺失 1、转换失败 1、空值比例 60%；CSS、XPath、JSON 都有同一结果。完整产品路径使用本地夹具与手动配置，不调用模型。

| 验收条件                         | 实际证据与结果                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 页面→字段→预览→保存→运行→Dataset | 新 Desktop E2E 在 UI 输入本地页面、配置字段和唯一详情关系，确认 3/3 样本，保存并运行，Dataset 中核对第三条及其详情；最终定向执行约 12.1 秒 |
| 三类夹具、字段反馈与歧义原因     | 新提取质量 5 项、新采集预览 5 项、草稿新增 2 项通过；静态和动态都有三条有效样本，噪声精确计数，两个歧义原因分别验证                        |
| 非法规则不能执行                 | 选择器/路径语法、空字段与不存在的详情 URL 字段测试；无效提交和歧义提交不入队，草稿保持 editing                                             |
| 版本、幂等与模板回归             | 原有冲突、幂等提交、草稿恢复与模板测试仍通过；草稿新增测试确认诊断持久化与相同请求回放                                                     |
| Desktop E2E 与全套业务           | 全套 12 项通过；最后滚动边界调整后，对三样本和无限滚动两个受影响用例再验证通过；最终单元测试 90 文件、448 项通过                           |

| 命令/检查                                                                                   | 退出码与本轮 Artifact                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 初始领域回归 76 项                                                                          | 0；`opt02-regression.txt`，约 19 秒                              |
| `bun --no-env-file run test` 最终 448 项                                                    | 0；`opt02-desktop-unit-final.txt`，约 37.1 秒                    |
| `bun --no-env-file run desktop:test` 全套 12 项                                             | 0；`opt02-desktop-e2e-final.txt`，约 1.3 分钟                    |
| 安全环境中 Desktop 的 `test --grep 'reviews three\|stops Infinite'`，最终 2 项              | 0；`opt02-desktop-e2e-targeted-final.txt`，约 52.7 秒含构建/启动 |
| 最终采集集成 10 项                                                                          | 0；`opt02-infinite-regression-final.txt`，约 3.6 秒              |
| 根 typecheck、lint、format:check、client:check、architecture:deps、architecture:check、diff | 0；`opt02-static.txt`，397 模块、1139 条依赖，无违规             |
| 最后增量类型/Lint/格式/diff                                                                 | 0；`opt02-followup-static.txt`、`opt02-final-checks.txt`         |

中间失败与处理：动态测试夹具未声明 UTF-8 导致乱码，补充测试响应的 charset；第一次 E2E 准备目录缺少 Electron 二进制，确认另一个本地依赖目录已有 44.0.0 arm64 后，仅停止本轮安装进程，复用相同版本并删除自己的下载临时目录；初次全套 E2E 的无限滚动只获得 10/30 条，定位为指纹产生的高视口使首批完全可见、哨兵无法重新进入，及边界贴合仍算相交。针对无滚动空间的自有页面按最后记录位置调整视口，并上移多一个像素，短页面与长页面回归均通过，全套 E2E 恢复 12 项通过。失败/观测日志保留，不放宽断言或超时。

每次 Electron 测试使用新临时 profile，关闭应用与本轮夹具服务后删除 profile；未复用用户工作区数据库。最终只读检查确认夹具端口 45100 已释放、本轮 Electron 安装进程及中断下载目录均不存在，见 `opt02-cleanup.txt`。OPT02 结束时与 OPT00 基线比较，57 个原有文件发生变更、新增 32 个文件，原有 573 个采样文件没有新增缺失；清单见 `delta-current.json`，后续更新会改变这些计数。未做采集内存/吞吐测量，此项留在 OPT04。

### OPT03 可解释的采集失败诊断

2026-10-03 完成。实际 JSON/HTTP/Crawlee 浏览器/详情/Sitemap 路径记录导航结果，浏览器操作记录动作类型，提取器记录容器与字段匹配数量以及记录数，任务持久化记录 Dataset 写入结果。字段以规则版本和字段序号关联，UI 从对应历史版本显示字段名；不把字段原值、选择器、网页内容或访问设置写入步骤。Crawlee 最终请求失败现在传回任务层，不把耗尽重试后的空结果登记为成功。

复用 Collection 的 SQLite 运行日志，诊断 phase 不更新运行进度、阶段、警告数或结果。每次运行保留最近 256 个诊断步骤并记录累计数量；报告按所选运行构造，超过 64 KiB 继续移除最早步骤并标明 truncated。步骤白名单只允许固定类型、错误码、计数、时间；原始 DOM、请求头、Cookie、填表值、选择器、URL、截图和任意异常文本均不导出。规则版本来自实际执行时记录的版本，Trace ID 默认使用该次运行标识。

诊断回调拒绝或超过 200 ms 时降级，并停止使用该不可用回调；保持原操作的返回值或原始异常。浏览器容器等待超时归为字段未匹配，页面访问超时归为 TIMEOUT；运行时长上限与用户取消分别报告 RESOURCE_LIMIT 和 CANCELED。

新增 `GET /api/v2/runs/{runId}/diagnostics`（workspace.read，no-store）与 `DELETE`（task.write、幂等请求头、仅终态运行）。删除只匹配该 runId 的 diagnostic 日志；不会清除普通日志、Dataset、Snapshot 或其他运行。运行详情按步骤显示原因和下一步操作，失败/取消可创建重试运行，字段问题可编辑规则，超时/资源上限可调整控制，访问策略问题可编辑访问策略。只读用户不获得清理或执行入口。

诊断包按需返回 JSON，UI 创建临时 Blob 下载并立即释放地址，不增加服务端持久化导出文件。没有新增截图或 Trace 捕获，因此没有额外的媒体保存开关或媒体保留目录；已有记录查看不依赖诊断可用性。

| 验收条件                                             | 当前证据                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 导航失败、字段失效、超时、取消均定位步骤并提供下一步 | 实际本地服务器/浏览器夹具 7 项通过；HTTP 503、缺失字段、挂起响应、进行中的取消、浏览器填写及消失容器分别验证；UI 5 项验证四类原因、编辑/重试入口与只读权限         |
| 敏感标记不进入输出，尺寸有上限                       | Shared 4 项涵盖嵌套凭据/DOM/截图/填表/选择器标记、任意错误文本、损坏元数据、跨运行数据、超长时间字符串与 64 KiB 上限；浏览器真实填写的值也不进入步骤               |
| 诊断不可用不改变采集与持久化结果                     | 回调拒绝和挂起保留原值/原异常；真实 CollectionService + SQLite 在诊断写入失败时仍完成 Dataset 写入；普通运行状态未因诊断日志变化                                   |
| 导出和清理仅作用于所选运行                           | Collection 集成 4 项验证 300 步只保留 256、累计计数、运行中清理拒绝、未知运行、选定运行清理、另一运行与普通日志保留；真实 Snapshot/记录清理前后相等                |
| 完整桌面入口与已有流程                               | Desktop E2E 12 项通过；三样本用例进入运行记录、查看写入步骤、点击导出并捕获生成的 JSON/文件名（测试拦截下载以不写用户下载目录）、点击清理，再返回 Dataset 核对数据 |

| 命令/检查                                           | 结果及 Artifact                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 领域回归（新增消失容器测试之前）                    | 84 项 / 10 文件通过；`opt03-domain-regression.txt`，约 13.1 秒                                            |
| 诊断存储集成 / UI 恢复入口                          | 4 项 / 5 项通过；`opt03-storage-integration-final.txt`、`opt03-ui-recovery.txt`                           |
| 最终 `bun --no-env-file run test`                   | 465 项 / 93 文件通过，含最新消失容器测试；`opt03-desktop-unit-final.txt`，约 60.2 秒                      |
| 最终 `bun --no-env-file run desktop:test`           | 12 项通过；`opt03-desktop-e2e-final.txt`，约 1.5 分钟；其中新增诊断 UI 验收约 11.2 秒                     |
| 根 typecheck、Lint、格式、client:check、架构与 diff | 均返回 0；`opt03-typecheck-final.txt`、`opt03-static-gates.txt`；403 模块、1159 条依赖，无违规            |
| 清理核对                                            | 夹具端口 45100 已释放，诊断 SQLite 夹具、Electron profile 和单元测试临时目录均不存在；`opt03-cleanup.txt` |

中间失败保留证据：HTTP 失败响应在 postNavigation hook 后才被 Crawlee 拒绝，改为按非成功状态记录失败；超时根因位于既有 ZhiYunError.details，补充有限深度分类。新夹具遵守数据库文件名、同一任务单活跃运行、generatedBy 枚举和 428 缺少幂等头的既有约束。新 E2E 最初在任务概览寻找运行链接，改为先进入运行记录页。新增 API 后生成架构目录并重新检查。见 `opt03-diagnostic-integration-initial.txt`、`opt03-diagnostic-integration-recheck.txt`、`opt03-diagnostic-integration-final.txt`、`opt03-desktop-e2e.txt`；失败不计作通过。

### OPT04 分批采集与 URL 级恢复

2026-10-03 已开始，尚未完成。将 OPT03 完成后的原全量 records[] 实现及其 Shared、Extraction、Browser Runtime 源码保存到本轮 Artifact 的 `opt04-baseline/`，16 个源码/manifest 文件记录 SHA-256，另记录锁文件 SHA-256。公开依赖链接到本轮锁定安装，四个工作区包互相解析到保存的源码；不复制凭据、环境文件、数据库或用户文件。`opt04-baseline-check.txt` 验证该独立入口可导入并导出 CrawlerRuntime。

**原实现资源基线**：新增 `desktop/tooling/benchmarks/collection-resource.ts` 与 `collection-resource-worker.ts`。父进程在 localhost 动态端口提供 JSON 分页夹具，每页 1000 条；每次只生成一条序列化后恰好 1024 字节的记录，并等待 HTTP response 的 drain，不预先创建完整记录数组。每轮启动独立 Node Runtime 进程；四个保存包编译为 Node ESM 后互相解析到保存入口。保存源码的 16 个哈希在测量启动时重新核验。

Apple M4、macOS arm64、10 个逻辑 CPU、16 GiB 内存，Node 24.18.0。在模块初始化与一次初始 GC 后记录空闲 RSS，采集中不主动 GC。父进程每 25 ms 采样 ps RSS，Runtime 每 20 ms 及 progress/batch 边界采样 RSS，并读取 Node maxRSS；峰值取三种观测最大值。耗时从采集启动至返回，排除模块加载、夹具启动；RSS 排除父进程、Chromium 和 Python。每种规模运行三次，下表各项分别取中位数：

| 原实现输入 | 采集耗时   | 吞吐（条/秒） | 增量峰值 RSS | HTTP 请求数 | 浏览器请求 / Python 进程 |
| ---------- | ---------- | ------------- | ------------ | ----------- | ------------------------ |
| 10000 条   | 71.608 ms  | 139649        | 48.484 MiB   | 10          | 0 / 0                    |
| 100000 条  | 637.399 ms | 156888        | 180.016 MiB  | 100         | 0 / 0                    |

原实现增量 RSS 比例为 3.713。上述仅为 **HTTP JSON 分页采集器** 基线：没有 Dataset writer、桌面 UI、浏览器或 Worker，不代表完整应用的采集写入耗时或内存。优化后的采集器使用相同输入、进程与采样协议比较，同时提供真实下游写入及背压集成证据。计划要求保持不变：10 万条增量峰值 RSS 不超过 1 万条的三倍，吞吐不低于原实现的 80%。六轮原始数据、采样方法与硬件见 `opt04-performance/baseline.json`，中位数与范围说明见 `baseline-summary.json`，入口日志为 `opt04-baseline-performance-final.txt`；优化后数据与适用范围见下面的生产批次阶段。

可复现入口（工作目录为仓库根目录，使用本轮已保存的原实现）：

```bash
bun --no-env-file desktop/tooling/benchmarks/collection-resource.ts .artifacts/no-credentials-optimization/20261003T054244Z baseline
```

**已实施的 Dataset 存储基础**：追加 `003-batch-ingestion` 前向 migration，未改动既有 migration 校验内容。`beginIngestion` 固定 run、task、规则/配置指纹、Dataset 设置和去重设置；`stageBatch` 将不超过 500 条的批次、校验和、Artifact key、去重键、记录和提交序号放入同一 SQLite 事务。同批次重放返回原接受数，不重新追加记录；规则/配置或重放内容变化拒绝复用。去重键保存在数据库，保留 hash、fields、none 行为；append 使用已提交接受数生成稳定记录序号，snapshot/upsert 保留同键最后值。

`commitIngestion` 在一个事务中投影 Dataset、统计和不可变 Snapshot，再标记已提交并回收暂存记录/去重键；批次台账保留用于重放。投影暂存记录和判定被移除记录都使用最多 500 条的 keyset 分页；最终指纹逐条读取有序记录，不再为指纹创建全量数组。原 `commitRunRecords` 接口保留并复用同一投影逻辑。`discardIngestion` 仅清理指定 run 的台账与暂存，不删除 Dataset、最终记录或已有 Snapshot。

新增 `batch-ingestion.test.ts` 的 8 项真实 SQLite 测试：关闭连接再打开后的批次重放及最终提交复用、三种跨批次去重、1001 条记录跨投影读取分页、规则/配置/校验和/批次上限拒绝、取消暂存的跨 run 隔离、1201 条旧记录的多分页移除判定。与数组路径比较最终指纹、统计与记录；已有 Snapshot 元数据保持一致，重复提交不创建第二个 Snapshot。这组存储基础测试中的 Artifact key 为受控字符串，不涵盖真实 Artifact 或进程中断；后续真实持久化测试另列，不能将基础测试视作 URL checkpoint 的验收。

| 本阶段检查                                               | 实际结果 / 证据                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新分批台账 + Dataset / Collection Repository conformance | 24 项通过；`opt04-staging-regression-final.txt`                                                                                                                     |
| 根目录隔离单元测试                                       | 473 项 / 94 文件通过，约 61.2 秒；`opt04-foundation-unit.txt`                                                                                                       |
| TypeScript                                               | 根 `tsc --noEmit` 返回 0；`opt04-foundation-typecheck-final.txt`                                                                                                    |
| 架构目录 / 依赖边界 / Client                             | 返回 0；新增 migration 已生成 Catalog；406 模块、1175 条依赖无违规；`opt04-foundation-architecture.txt`、`opt04-foundation-deps.txt`、`opt04-foundation-client.txt` |
| Lint / 格式 / diff                                       | 最终均返回 0；`opt04-foundation-lint-final.txt`、`opt04-foundation-format.txt`、`opt04-foundation-diff.txt`                                                         |
| 清理与原工作区保护                                       | 本轮分批存储及资源测量临时目录均不存在；69 个基线文件变化，39 个新增文件，573 个基线文件无新增缺失；`opt04-foundation-cleanup.txt`、`delta-current.json`            |

**中间失败与修复**：初始 benchmark 协议解析硬编码截断位置，改为前缀长度；每页 500 条使 10 万条分页数超过现有 100 页上限，改为每页 1000 条后完成六轮，未放宽业务上限。未完成的测量保留在 `opt04-performance-initial/` 和初始失败日志中，没有混入最终中位数。SQLite 投影迭代器会阻止同连接事务及写入，首次新测试失败；改为读完受限分页后再投影写入，并补充跨分页测试。初始测试日志为 `opt04-staging-regression-initial.txt`。清理器现会继续释放所有本轮资源后汇总异常，避免单个 close 失败中断后续清理；失败测试遗留的 7 个已知专属目录在核对文件名后删除，见 `opt04-foundation-cleanup.txt`。Lint 发现 benchmark 的 async callback 与 stdin Promise 未处理，已修正并重新验证。

**生产批次与真实持久化**：`shared/src/crawl-batch.ts` 定义可等待的批次、提交确认、磁盘列表 spool 与详情缓存接口；Contracts、Crawler Runtime 和 Collection Job 同步。HTTP JSON、HTTP HTML 与 Crawlee 浏览器的页面提取结果按最多 250 条、目标 1 MiB 的批次等待下游，生产运行返回空 `records[]`，最终数量来自 Dataset 接受数。单条大记录仍受既有响应资源上限控制，不声称每个批次都有严格 1 MiB 上限。预览保持最多十条的小数组，内置少量示例保留数组后按批次写入。

生产 Collection 使用真实 LocalArtifactStore：原列表批次先提交到 `collection-batches/<runId>/list/`，再写入 `004-crawl-batches` Collection 台账；列表导航完成后逐批读取、补详情，再把最终批次 Artifact 提交后交给 Dataset `stageBatch`。完整列表和详情后的记录不聚合到运行结果数组。批次身份由配置指纹、请求 URL/执行引擎和批次序号的 SHA-256 构造；URL 相同的 HTTP 探测与浏览器回退使用不同请求身份，避免空 HTTP 结果占用浏览器回退的记录容量。`collection-batches-v2` 指纹固定任务 revision、规则版本与定义、分页、访问策略、Dataset 设置及已解析的请求/浏览器设置；凭据只参与哈希，不保存为指纹明文。

列表先落盘，再补详情，保留原先列表和详情共用请求预算的语义。详情内存缓存最多 500 个 URL，其余已提取结果保存在所选运行的受控 Artifact 中；跨缓存淘汰后仍可复用，缓存不保存原始 DOM、截图或请求头。原列表上限在补详情和去重前应用；Dataset 保留跨批次去重与不可变 Snapshot。Artifact 内容冲突、配置变化、无效批次确认等不能作为可重试成功处理；错误根因经有限深度分类。

成功、取消和最终失败清理指定运行的 Artifact、workspace、Collection 台账与 Dataset 暂存；可恢复失败保留这些数据。任务删除级联删除运行后，下一次重试也清理其暂存；错误 taskId 不得清除另一个存在的运行。Artifact Store 的受控两级目录删除验证范围和真实路径，拒绝路径穿越及 symlink。现有 Dataset、Snapshot 和无关 Artifact 保留。运行诊断与生成客户端增加固定 `writePhase`，UI 将“采集暂存”和“结果更新”分开，暂存成功不表示 Dataset 已经更新。

新增 `streaming.integration.test.ts` 使用真实 localhost 服务器、SQLite、Artifact Store 与 Crawler Runtime：HTTP JSON 与浏览器 CSS 均在第一批写入被阻塞时不获取下一页，原 Snapshot 在最终投影前保持可见；780 条原列表跨批次去重为 778 条，统计为新增 778、移除 1、当前 778，产生一个新 Snapshot；778 个唯一详情 URL 跨超过 500 个缓存条目只各请求一次，列表与详情共 781 个请求；原列表上限 520 条最终去重为 519 条。Dataset 已提交但确认丢失时，关闭重开 Repository 后重放不重复追加，最终数据与统计一致。取消阻塞的最终 Artifact 写入后保留原数据并清理孤立文件。另验证删除任务后的清理、错误任务 ID 的隔离，以及规则/请求设置改变后不再请求页面且拒绝旧批次。上述关闭重开连接不是实际进程中断验收。

新增 `crawler-runtime/test/streaming.test.ts` 覆盖同 URL 空 HTTP 后的真实浏览器回退、无效消费确认必须失败，以及大 Unicode 字段按 UTF-8 序列化字节拆分后保持顺序。Artifact Store 增加所选目录清理、幂等、无关数据与 symlink 隔离测试。桌面 E2E 已通过真实批次路径，三样本运行分别显示暂存和结果更新。

**采集器资源复测，未达成全部目标**：计数消费者用于确认生产者不返回聚合数组，最多接受 250 条一批，不执行真实 Artifact/SQLite 写入。第一次六轮初测在 `opt04-performance-preliminary/`；后续六轮复测的 1 万条吞吐仅为最初原实现的 74.48%，数据保存在 `opt04-performance-before-public-size/`，日志为 `opt04-stream-performance-final.txt`。随后试验对 250 条小批次统一计算 JSON 大小并减少重复映射，1 万条和 10 万条吞吐分别为最初原实现的 65.10% 和 90.21%，未证明收益；已撤回该实现，保留新增大记录边界测试。试验源文件哈希及数据在 `opt04-performance-public-size-experiment/`，日志为 `opt04-stream-public-sizing-performance.txt`。没有采用更有利的初测数据作为最终达标证据。

为检查时段差异，使用同一份保存的原源码，先运行原实现六轮，再运行当前实现六轮；两次测量期间不启动项目测试或构建。初始原实现六轮与源码哈希没有覆盖，复测数据另存 `opt04-matched-comparison/opt04-performance/`。每项仍取三次中位数，当前实现采用原有逐条计量与批次映射、`collection-batches-v2`：

| 输入      | 相邻时段原实现耗时 / 吞吐  | 当前实现耗时 / 吞吐        | 原实现 / 当前增量 RSS | 当前吞吐 / 相邻基线 | 当前吞吐 / 最初基线 |
| --------- | -------------------------- | -------------------------- | --------------------- | ------------------- | ------------------- |
| 10000 条  | 83.992 ms / 119059 条每秒  | 127.016 ms / 78730 条每秒  | 45.859 / 58.672 MiB   | 66.13%              | 56.38%              |
| 100000 条 | 701.994 ms / 142451 条每秒 | 862.256 ms / 115975 条每秒 | 184.719 / 67.859 MiB  | 81.41%              | 73.92%              |

当前增量 RSS 比例为 1.157，满足不超过三倍；1 万条增量 RSS 高于原实现，10 万条低于原实现。HTTP 请求数分别为 10 与 100，批次行数最多 250，浏览器请求和 Python 进程均为零。1 万条吞吐对两份原实现基线都低于 80%，10 万条对最初基线也低于 80%，故资源验收仍未通过。不同轮次存在耗时变化，不能在没有分析证据时把回归归因于机器负载或只改用相邻基线登记完成。机器可读 `comparison.json` 保留两种比较、各组三次的范围、当前源码 SHA-256 和 `targetPassed: false`。此次测量仍未覆盖真实下游写入成本，完整链路、浏览器及 Python 的资源验证另待执行。

本轮可复现命令（隔离环境由入口构造，工作目录为仓库根目录）：

```bash
bun --no-env-file run test
bun --no-env-file run desktop:test
bun --no-env-file run typecheck
bun --no-env-file run lint
bun --no-env-file run architecture:deps
bun --no-env-file run architecture:check
bun --no-env-file run client:check
bun --no-env-file desktop/tooling/benchmarks/collection-resource.ts .artifacts/no-credentials-optimization/20261003T054244Z/opt04-matched-comparison baseline
bun --no-env-file desktop/tooling/benchmarks/collection-resource.ts .artifacts/no-credentials-optimization/20261003T054244Z/opt04-matched-comparison stream
```

`opt04-matched-comparison/opt04-baseline` 指向本轮原源码捕获目录；上述两个测量入口分别更新该比较目录下的报告，不能拿根目录最初基线报告当成它们本次生成的数据。重新运行前保留已有结果，测量时避免同时运行项目测试和构建。

生产接入的中间问题与处理：新增测试所需的工作区依赖先通过 lockfile-only 登记，随后 frozen install 才建立包链接；未新增公开依赖或修改安全覆盖。首次集成测试无法导入 Artifact Store，补齐安装后通过；确认丢失的异常被 Crawlee 包装，断言改为实际外层错误，并检查提交发生、重放数据和统计，而不是改业务行为来配合异常文案。全工作区类型检查发现错误码枚举、可空 cursor、示例 metadata 联合类型、ES2022 不支持的 Promise 工厂和测试包依赖，均已修正；Lint 的类型导入与异步处理也已修正。失败日志保留在 `opt04-stream-persistence-initial.txt`、`opt04-stream-persistence-recheck.txt` 和对应类型/Lint 初始日志，未放宽断言、超时、审计或资源目标。

| 生产批次阶段的最终检查     | 实际结果 / 退出码 / 证据                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 隔离单元测试       | 96 个文件、487 项通过，约 60.7 秒；0；`opt04-stream-unit-verification.txt`                                                                                                             |
| 真实采集、Artifact、SQLite | 新集成 10 项全部包含于最终单元测试；新生产者 3 项包含大 Unicode 边界，Artifact Store 5 项全部通过                                                                                      |
| Desktop E2E                | 12 项通过，约 1.4 分钟；0；`opt04-stream-desktop-e2e-complete.txt`；暂存/结果更新、认证、动态与无限滚动路径通过，之后试验实现已撤回                                                    |
| TypeScript                 | 根与全部工作区通过；0；`opt04-stream-typecheck-verification.txt`                                                                                                                       |
| Lint / 格式 / diff         | 全部通过；0；`opt04-stream-lint-verification.txt`、`opt04-stream-format-verification.txt`、`opt04-stream-diff-verification.txt`                                                        |
| 架构 / Client              | Catalog 一致、410 模块/1197 条依赖无违规、生成客户端一致；0；`opt04-stream-architecture-final.txt`、`opt04-stream-deps-final.txt`、`opt04-stream-client-final.txt`                     |
| 资源比较入口               | 相邻原实现与当前实现各六轮均完成，入口返回 0；`opt04-matched-baseline-performance.txt`、`opt04-matched-stream-performance.txt`；**运行成功不等于指标通过，报告 `targetPassed: false`** |
| 清理与工作区保护           | 本轮采集、暂存、资源测量、单元测试及 Electron profile 目录均无剩余，45100 已释放；`opt04-stream-cleanup.json`；未提交、推送、改开发库或终止其他进程                                    |
| 相对初始采样的差量         | 76 个文件变化、41 个新增代码/文档路径，573 个基线文件无新增缺失；`delta-current.json`；环境文件未读取或哈希                                                                            |

此前差量清单把两个未参与哈希基线的 `.env.example` 路径列在未采样文件列表中，不能据此判断它们为本轮新增；当前已从新增计数中剔除，记录为 `excludedUnhashed`，没有读取其内容。基础阶段记录的“39 个新增”是当时清单的历史计数，包含这两个未采样路径；当前新增计数为排除它们后的 41 个。原有目录迁移及未提交改动保持原样。

**URL checkpoint 与实际进程恢复阶段**：Collection 追加 `005-url-checkpoints` 前向 migration，保留已登记的 004。SQLite 保存请求 URL、执行引擎、稳定身份、固定序号、pending/completed、原列表记录容量预留、分页后继，以及运行级请求数和原列表记录数。请求身份仍由 requested URL 与 stage 的规范化 SHA-256 生成；同 URL 的 API、HTTP、browser 与 detail 分别计数。请求槽位首次建立时计入共享预算，重试复用原槽位；记录容量只首次预留，重放不再次扣减。读取请求与原批次使用最多 100 条的 keyset 分页，按请求固定序号重放列表，避免并行完成顺序改变去重结果。

原列表的 Artifact 提交、原批次台账写入完成后，才允许请求 checkpoint 完成；Repository 验证该请求已登记的原批次行数等于预留容量。父请求完成与预算允许的下一页登记在同一 SQLite 事务内。确认丢失后，重启可从 completed 父请求及 pending 子请求继续；未完成请求采用至少一次处理，稳定批次身份与内容校验防止重复最终记录。真实详情 Artifact 先保存，再完成详情请求 checkpoint；可容忍的详情失败只缓存固定错误码和空结果，不保存任意异常文本，重启不会再次请求同一失败 URL。

SQLite 是持久 URL 队列，Crawlee 继续负责调度与导航。生产 HTTP/浏览器队列以 run/配置哈希构造稳定名称，从 SQLite 恢复待处理项；显式使用独立 `Configuration`、`persistStorage: false` 和 `writeMetadata: false`，Native 调度器只在内存保存会话及请求数据。成功/取消/最终失败通过既有选定运行清理协议回收 SQLite 和 Artifact；可恢复失败保留 SQLite checkpoint，结束时不无条件删除它。HTTP 与浏览器在导航时注入本次解析的认证头。此设计没有将 Cookie、认证头、会话或错误对象交给 Native 磁盘存储；无需新采集服务。认证头夹具扫描所选运行的 SQLite、Artifact 和 workspace 文件，证明指定假凭据未进入这些文件；该证据不泛化为任意采集字段或 URL 查询参数自动脱敏。

生产指纹升级为 `collection-batches-v3`，固定任务 revision、规则版本/定义及已解析配置；凭据材料参与哈希，变化即拒绝复用旧状态并清理该运行暂存。采集最终统计及清理过的 warnings/URL 列表在 Dataset 投影前保存为不可变完成摘要。若 Dataset 已提交但 Collection 尚未完成，重启复用完成摘要和已提交 ingestion，不再导航或重新投影，不新增 Snapshot。前面的 `v2` 资源测量为历史阶段结果，不能作为新增 checkpoint 代码的资源验收。

`streaming.integration.test.ts` 已扩展到 22 项。其中五项在独立 Node 24.18.0 子进程运行实际 Collection Job Handler、Crawler Runtime、LocalArtifactStore 和 SQLite，分别在请求进行中、Artifact 提交后、checkpoint 提交前、提交后、Dataset 投影后，由父进程确认窗口并仅对自己创建的子进程发送 `SIGKILL`，随后创建新进程恢复。每项另运行不中断的对照进程，逐条比较 778 条最终记录和来源 URL、运行记录数/逻辑请求数/browserUsed/Dataset 统计、Snapshot 数量及旧 Snapshot。前三个窗口允许重取第 2 页，物理页序列为 `[1,2,2,3]`；checkpoint 后与投影后为 `[1,2,3]`，已完成页面不重新请求。这些测试涵盖生产 handler 的实际进程重启，未启动完整 Electron/LocalQueue 宿主，不能直接声明完整应用异常退出验收已完成。

另新增 HTTP HTML 与真实浏览器 next-link 分页的 checkpoint 确认丢失恢复；带认证的两种导航恢复与假认证头文件扫描；凭据材料变化后的拒绝与旧数据保留；详情失败缓存及 Dataset 批次确认丢失后重开连接的逻辑统计恢复；三个列表页和详情共用四个请求槽位的预算夹具。详情失败恢复中，778 个唯一详情 URL 只各物理访问一次，最终逻辑请求数 781；允许保留的失败记录没有虚构详情，其他记录保留真实详情。

本阶段失败记录：最初使用 Bun 子进程启动对照运行时发生 NAPI 原生模块 `SIGABRT`，未登记为中断恢复通过。改用测试宿主的 Node executable，通过仅限测试进程的 `.js`→`.ts` resolver 和 `--experimental-transform-types --conditions=development` 读取当前工作区源码，第三方原生模块仍由 Node 正常解析；五个真实中断用例通过。新增认证测试最初遗漏 Repository 更新要求的 expected revision，后补上非空更新断言；随后发现 page 模式预登记三页，Crawlee 在一个页面失败后仍处理另两页，改为本来要验证的 next-link 模式，保留“失败前只访问第一页、恢复访问后两页”的断言。失败日志保留在 `opt04-url-recovery-targeted-initial.txt`、`opt04-url-recovery-complete.txt`、`opt04-url-auth-recheck.txt`，最终定向认证三项通过，见 `opt04-url-auth-final.txt`；未放宽业务预算、恢复断言或超时。

| URL checkpoint 阶段检查 | 实际结果 / 退出码 / 证据                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 隔离单元测试    | 96 个文件、499 项全部通过，约 80.1 秒；0；`opt04-url-unit-final.txt`；包含最新 22 项真实采集持久化测试及五个 SIGKILL 窗口                                   |
| TypeScript              | 根与全部工作区通过；0；`opt04-url-typecheck-final.txt`                                                                                                      |
| Lint / 格式 / diff      | 全部通过；0；`opt04-url-lint-final.txt`、`opt04-url-format-final.txt`、`opt04-url-diff-final.txt`                                                           |
| 架构 / Client           | Catalog 一致、412 模块 / 1209 条依赖无违规、生成客户端一致；0；`opt04-url-architecture-final.txt`、`opt04-url-deps-final.txt`、`opt04-url-client-final.txt` |
| Desktop E2E             | 当前代码全套 12 项通过，约 1.4 分钟；0；`opt04-url-desktop-e2e-final.txt`；含手动草稿到 Dataset、动态、登录态与无限滚动路径                                 |
| 资源指标                | 本阶段未重新测量；前阶段吞吐验收失败保留，不能以本轮功能测试替代资源验收                                                                                    |

本阶段测试句柄均已退出。只读核对本轮采集、暂存、单元测试、资源夹具及 Electron profile 前缀没有剩余目录，夹具端口 45100 已释放，见 `opt04-url-cleanup.json`。相对初始采样为 76 个文件变化、43 个新增代码/文档路径，573 个基线文件无新增缺失；见 `delta-current.json`。环境文件未读取或哈希，HEAD 与 main 保持初始值；未提交、推送、部署或清理其他进程。

**Sitemap 分批、全局排序与恢复阶段**：追加 `006-sitemap-spool` 前向 migration，未修改已应用的 004/005。为所选运行建立嵌套 Sitemap 队列、唯一发现 URL 索引和不可变原批次台账；三个表均随 crawl session 回收。嵌套队列最多保留计划允许的 100 个地图节点，重复及回环只登记一次，深度与同源过滤沿用已有规则；仅在实际开始访问地图时向既有 API-stage URL checkpoint 申请请求槽位，尚未访问的节点不占列表/详情共享预算。记录 URL 按首次发现去重并保留首个修改时间，受原 `maxUrls`（最多 10000）限制。

生产 Sitemap 解析每最多 250 个候选 URL/子地图、目标 1 MiB 就等待 Artifact 提交，随后在同一 SQLite 事务登记批次、URL 和子地图。原请求正文仍受 `maxResponseBytes` 限制；单个大 URL 不承诺小于 1 MiB。确认丢失或进程中断后按相同序号重放，Artifact 校验和及台账防止重新追加。地图完成 checkpoint 额外验证 `discoveryBatchCount` 的批次数和连续序号，防止未完成地图重放为更短内容时直接发布旧前缀。中断时即使 URL 上限已被持久前缀占满，仍先完成该 pending 地图，再停止新地图访问。

采集结束后先逐页验证每份原 Artifact，再通过 SQLite keyset 分页按修改时间降序/首次发现序号升序读取（未配置修改时间时按发现顺序）；每页最多 250 条，产出再按 UTF-8 序列化大小拆批，然后交给既有详情缓存和 Dataset `stageBatch`。记录上限在全局排序之后、详情请求之前应用。生产 Sitemap 返回空 `records[]`，不再聚合整个发现结果或排序数组。Sitemap 使用 `collection-sitemap-v1` 指纹以拒绝复用旧协议；HTTP/浏览器保留 `collection-batches-v3`。普通预览/非流式兼容入口使用受结果上限控制的候选数组，修改时间排序通过二分插入保留前 K 条；预览夹具从 519 个唯一 URL 中得到最新的 3 条，并仅请求这 3 个详情。

真实持久化测试扩展到 37 项，本阶段新增 15 项。Sitemap 夹具有两个子地图、重复节点、根节点回环、520 个候选/519 个唯一 URL、相同修改时间及缺失修改时间。全局排序后限定 300 条，并发补详情后的记录内容和实际提交顺序与数组兼容入口一致，逻辑请求数为 303；首次 Artifact 被阻塞时只请求根地图、不访问子地图或详情，旧 Snapshot 仍可见。另验证深度/地图数限制及停机原因、URL 上限处确认丢失恢复、未访问地图不占预算、截短重放拒绝和完成地图的 Artifact 损坏拒绝，拒绝后旧数据及旧 Snapshot 保留。

独立 Node 子进程新增六个 Sitemap SIGKILL 用例：请求中、Artifact 提交后、checkpoint 前、checkpoint 后、Dataset 投影后，以及发现批次 SQLite 事务已提交但确认未返回。每项均运行不中断对照进程，并逐条比较 519 条最终记录/来源 URL、逻辑计数、Dataset 统计与 Snapshot。请求中的中断允许重取第二个子地图；Artifact/发现台账/checkpoint 前的中断允许重取第一个子地图；已完成根地图均不重取。checkpoint 后及 Dataset 投影后不重新请求已完成地图。连同前阶段 HTTP 五个窗口，目前共 11 个生产 handler 实际进程中断用例；仍未等同于完整 Electron/LocalQueue 宿主异常退出验收。

本阶段中间失败：首次类型检查发现诊断元数据工厂不能返回 Promise，改为被观测操作返回实际计数，再同步构造元数据。排序测试最初把并发详情请求到达顺序作为记录排序依据，改为直接检查实际提交的 URL 序列和完整内容，并分别核对详情请求集合及数量；记录排序与数量断言没有放宽。空地图（深度上限为零）不会创建采集 Artifact 目录，清理断言现仅接受所选目录为空或 ENOENT，其他文件系统错误仍失败。失败日志保留在 `opt04-sitemap-typecheck-initial.txt`、`opt04-sitemap-regression-initial.txt`、`opt04-sitemap-domain-final.txt`；后者首次执行有 14 项通过、清理断言 1 项失败，不作为最终通过证据。修正后全套单元测试包含全部最新用例。

| Sitemap 阶段检查     | 实际结果 / 退出码 / 证据                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 隔离单元测试 | 96 个文件、514 项全部通过，约 102.7 秒；0；`opt04-sitemap-unit-final.txt`，含 37 项实际采集持久化与 11 个 SIGKILL 窗口                                                                                          |
| TypeScript           | 根与全部工作区通过；0；`opt04-sitemap-typecheck-final.txt`                                                                                                                                                      |
| Lint / 格式 / diff   | 全部通过；0；`opt04-sitemap-lint-final.txt`、`opt04-sitemap-format-final.txt`、`opt04-sitemap-diff-final.txt`                                                                                                   |
| 架构 / Client        | Catalog 一致、412 模块 / 1209 条依赖无违规、生成客户端一致；0；`opt04-sitemap-catalog-generation.txt`、`opt04-sitemap-architecture-final.txt`、`opt04-sitemap-deps-final.txt`、`opt04-sitemap-client-final.txt` |
| Desktop E2E          | 当前代码全套 12 项通过，约 1.4 分钟；0；`opt04-sitemap-desktop-e2e-final.txt`；含手动草稿到 Dataset、动态、认证与无限滚动路径                                                                                   |
| 资源指标             | 本阶段未重新测量；此前 HTTP 吞吐目标仍未通过，Sitemap 功能测试不替代资源验收                                                                                                                                    |

本阶段已确认全部测试句柄退出；本轮采集/暂存/资源夹具/单元测试/Electron profile 临时目录均无剩余，45100 已释放，见 `opt04-sitemap-cleanup.json`。基线差量为 76 个文件变化、43 个新增代码/文档路径，573 个采样文件无新增缺失；环境文件未读取或哈希，见 `delta-current.json`。HEAD 与 main 保持原值，未提交、推送、部署或终止其他进程。

本阶段复现命令（仓库根目录，测试入口自动构造隔离环境）：

```bash
bun --no-env-file run test
bun --no-env-file run desktop:test
bun --no-env-file run typecheck
bun --no-env-file run lint
bun --no-env-file run format:check
bun --no-env-file run architecture:check
bun --no-env-file run architecture:deps
bun --no-env-file run client:check
```

迁移变更时先执行 `bun --no-env-file run architecture:generate`，本阶段入口返回 0；无需更改已应用的 migration。前阶段审查发现 Collection DELETE route 仅执行既有 `cleanup.clearTask` 与 Repository 删除，cancel route 仅登记取消并调用队列取消，保留的采集暂存依赖 handler 再次执行才能回收。下述阶段补齐这部分行为。

**取消、删除与持久清理阶段（2026-10-03）**：追加 `007-crawl-cleanup` 前向 migration，保留已应用的 004/005/006。清理请求保存 run/task 身份、原因、执行时间、重试次数和固定错误码；不依赖 Run 外键，因此删除 Task/Run/session 后仍然存在。取消请求与 Run 状态变更在同一 SQLite 事务登记，任务删除在同一事务检查 expected revision、为全部历史 Run 登记清理请求并执行 cascade。成功、取消与最终失败的既有 handler 清理入口也先登记请求，文件操作失败后不丢失回收依据。

新增 `desktop/packages/plugins/collection/src/application/batch-cleanup.ts`，由 Level 2 Runtime 的 effect 管理，启动时检查、运行中每秒检查，并在关闭 Repository 前停止定时器和等待已开始的检查。清理请求和 session owner 以最多 100 条的 keyset 分页读取，串行处理避免同一进程重复清理；删除和取消 HTTP 接口直接请求处理所选任务/运行。排队或已领取的任务可取消后立即回收；运行中/结果写入中/取消中的任务保留暂存，等待它结束。

回收前同时核对 Platform job 的 owner、type、job/run/task 身份、终止状态、空 lease，以及 LocalQueue dispatcher 中是否仍有该运行的 handler。Platform Queue 的可选 `diagnostics()` 接口暴露既有在途 job 身份；真实 LocalQueue 已提供实现。即使租约恢复已把 job 标为 canceled，旧 handler 仍在本进程执行时也不能删除文件。HTTP cancel 的兼容路径也核对 job 身份，避免取消同 ID 的其他插件任务。清理只删除所选运行的采集 Artifact、workspace、Dataset ingestion 和 Collection session，全部成功后才确认请求；Dataset、已提交 Snapshot 和其他运行不属于回收对象。

文件操作失败时保存固定 `COLLECTION_CLEANUP_FAILED`，不保存任意 IO 异常文本，按 1 秒起、最高 60 秒的退避等待后续检查或重启重试。可恢复的 queued Platform job 无清理请求时保持 checkpoint。耗尽重试且没有完成摘要的 job 可将未完成 Run 标为最终失败后回收；**job 已终止但 Run 尚未完成、且已有持久完成摘要时，当前保留摘要和 ingestion，不自动回收**。完整 LocalQueue/应用恢复阶段仍需处理这个完成窗口，不能以本阶段清理通过宣称恢复或全部临时回收已完成。

修复自动重试的 Run 状态：实际仍会重试时保留 `status: queued`、`phase: retrying`、`finishedAt: null` 和已有进度；最终失败仍为 failed。既有页面因此继续轮询，不能误把排队重试当作终止运行再次创建手动重试；新增中英文阶段文案“等待自动重试”/“Waiting to retry”。领域失败事件继续保留 `finalFailure`，监控及通知的原有最终失败条件不变。

新增 `desktop/packages/runtime/test/collection-cleanup.integration.test.ts` 共 10 项，使用真实 LocalQueue、SQLite、Artifact 与 Dataset：自动重试后无再次 dispatch 的取消及重复取消；删除选定任务的历史/排队 Run、拒绝旧 revision、保留其他任务；取消和删除正在写入的 handler（两项），包括租约过期后仍有延迟文件写入，定时检查只在写入完成后回收；删除事务已提交后重新打开 SQLite/LocalQueue 的启动恢复；IO 失败退避和重开后重试；耗尽重试的回收与已提交 Dataset/未完成 Run 摘要的保留；不同 job owner/payload 的隔离（两项）；105 个已删除运行跨 keyset 页的 workspace 回收。断言包含旧 Snapshot 内容与无关 Artifact 保留，以及所选 ingestion 无残留已接受记录。

既有 `level2.integration.test.ts` 还增加完整 Runtime 组合下的两项行为断言：启动 effect 回收删除后尚未执行的 job；带会话授权的取消 route 回收尚未执行的批次，保留当前 Dataset。此文件仍是 1 项组合测试，不能把新增断言重复计为独立测试。新 10 项和既有组合测试定向共 11 项通过；现有生产 streaming 37 项保留，通过新的 queued/retrying 状态核对恢复。关闭/重开夹具与 Runtime 组合启动属于其实际范围，**本阶段没有新增 SIGKILL 或 Electron 异常退出恢复证据**。

本阶段中间失败：初次定向测试没有执行用例，因为 Runtime 包不能直接解析未声明的 Shared 依赖；改用已经声明且转导出 Shared 的 Contracts，没有新增依赖。类型检查同时修正夹具的初始化断言、CollectionTask 类型来源、dedupe fields 与 ingestion 输入。首次可运行的 10 项中 8 项失败、2 项通过：夹具错误地把最终批次 Artifact 当作原列表目录，或违反同任务只允许一个活跃 Run 的现有唯一约束。改为核对实际最终 JSON Artifact，并用历史终止 Run 构造多 Run 清理场景，没有修改生产约束或放宽回收/隔离断言。失败日志保留在 `opt04-cleanup-targeted-initial.txt`、`opt04-cleanup-targeted-recheck.txt`、`opt04-cleanup-typecheck-initial.txt`；最终定向结果见 `opt04-cleanup-runtime-targeted.txt`。随后增加定时器回收断言，包含在以下完整单元测试中。

| 持久清理阶段检查     | 实际结果 / 退出码 / 证据                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 隔离单元测试 | 97 个文件、524 项全部通过，约 140.3 秒；0；`opt04-cleanup-unit-final.txt`，含新 10 项 LocalQueue 清理和原 37 项采集持久化测试                                                                                   |
| TypeScript           | 根与全部工作区通过；0；`opt04-cleanup-typecheck-final.txt`                                                                                                                                                      |
| Lint / 格式 / diff   | 全部通过；0；`opt04-cleanup-lint-initial.txt`（首次即通过）、`opt04-cleanup-format-final.txt`、`opt04-cleanup-diff-final.txt`                                                                                   |
| 架构 / Client        | Catalog 一致、414 模块 / 1223 条依赖无违规、生成客户端一致；0；`opt04-cleanup-catalog-generation.txt`、`opt04-cleanup-architecture-final.txt`、`opt04-cleanup-deps-final.txt`、`opt04-cleanup-client-final.txt` |
| Desktop E2E          | 最新代码全套 12 项通过，约 1.5 分钟；0；`opt04-cleanup-desktop-e2e-final.txt`，含 Runtime 启动、三样本手动草稿、静态/动态/登录态与无限滚动                                                                      |
| 资源指标             | 本阶段未重新测量；此前 HTTP 吞吐目标仍未通过，功能与清理检查不替代资源验收                                                                                                                                      |

本阶段已确认全部测试句柄退出；本轮清理/采集/暂存/资源夹具/单元测试/Electron profile 前缀均无剩余目录，45100 已释放，见 `opt04-cleanup-cleanup.json`。相对初始采样为 77 个文件变化、45 个新增代码/文档路径，573 个基线文件无新增缺失；仅复核已采样及明确新增代码路径，环境文件未读取或哈希，见 `delta-current.json`。HEAD 与 main 保持原值，未提交、推送、部署或终止其他进程。

复现完整检查沿用前一阶段列出的命令；定向入口为 `bun --no-env-file run test desktop/packages/runtime/test/collection-cleanup.integration.test.ts desktop/packages/runtime/test/level2.integration.test.ts`。本阶段文档更新后重新运行格式和 diff，见 `opt04-cleanup-record-format-final.txt`、`opt04-cleanup-record-diff-final.txt`；两项退出码 0。

**LocalQueue 与完整 TypeScript Runtime 进程恢复阶段（2026-10-03）**：补齐上一阶段保留的完成摘要窗口。Platform Core 增加 `JobCompletionRecoveryInput` 与 Repository 的 `retryJobCompletion`，LocalQueue 暴露 `retryCompletion`。该内部入口由 Collection 确认已有持久完成摘要或成功 Run 后调用；SQLite 事务核对原 job 的 owner、type、payload、attempt、failed 状态、空 lease、无取消请求及已耗尽的次数。通过后仅为同一个 job 增加一次完成机会，保留原 run/job 身份，并按 1 秒起、最高 60 秒的退避等待。重复或过期调用返回 null；LocalQueue 仍有该 job 的 handler 在途时拒绝重排。没有新增服务、依赖或 migration，也没有修改既有 migration。

Collection 的可恢复写入失败若已有固定指纹的完成摘要，保留 queued/retrying Run 和 ingestion，不再仅因采集尝试耗尽而清理它。启动及定时检查在真实租约恢复把 job 标为 failed 后重排该 job；原 handler 复用完成摘要及 Dataset 幂等提交，继续执行任务/规则/配置指纹检查。没有完成摘要的采集失败仍遵循原有有限重试和最终回收；验证/规则/资源/网络策略错误不获得该完成恢复机会。取消和删除沿用同一 job 的持久清理协议；直接取消的终止 job 优先取消未完成 Run，不恢复其摘要。

成功 Run 的清理请求现在保留至 handler 回调与 Platform job 确认之后：handler 可以先回收批次、workspace 和 ingestion，但不提前删除该请求；检查确认 job succeeded 后才完成请求。如果进程在 Run 已完成、job 尚未确认的窗口退出，原 job 可再次执行成功 Run 的已有完成分支，不再次采集或投影。完成摘要读取在所选 session 不存在时返回 null，指纹不一致仍拒绝。该协议保证本轮验证范围内的最终记录与 Snapshot 幂等；**回调和平台事件仍采用既有至少一次行为，本阶段没有新增其严格一次语义的验收**。

新增完成恢复验证：既有 `collection-cleanup.integration.test.ts` 从 10 项扩至 16 项，其中新增 4 项模拟最后一次尝试在投影前、投影后、Run 完成后、Platform job 确认前失败，恢复后仅调用采集器一次、记录/统计正确、仅有旧和新两个 Snapshot；另 2 项证明恢复期间仍可取消，以及任务版本变化会拒绝恢复且不重新采集、不替换旧数据。SQLite Repository 新增一项作用域/attempt CAS 验证，拒绝活跃、身份不一致、过期与带取消请求的任务，不修改无关任务。

新增 `desktop/packages/runtime/test/queue-recovery.integration.test.ts` 和 `test/fixtures/queue-recovery-worker.ts`。独立 Node 24 子进程以两种模式执行同一实际采集 handler：真实 LocalQueue/Artifact/SQLite；完整 `buildLevel2Runtime` 组合（全部插件 Repository、Mock AI、真实 LocalQueue、Runtime 启动迁移与 effects）。两种模式各有请求中、原 Artifact 提交后、checkpoint 前、checkpoint 后、Dataset 投影后、Run 完成后六个 SIGKILL 用例，共 12 项。最后两个窗口把原任务 maxAttempts 设为 1，明确验证已耗尽尝试的完成恢复；其他窗口允许原队列进行第二次采集尝试。

每项先运行同模式不中断的独立对照，再确认本次 child 的 PID/窗口并只对该 child 发送 SIGKILL，随后以全新 child 打开同一临时 SQLite 和 Artifact。没有手动改 job 状态、增大次数、指定假 attempt 或用父进程代替租约恢复；新 LocalQueue 按真实时间回收过期 lease。HTTP JSON 夹具三页共 780 条、778 条唯一记录，逐条核对内容和来源 URL、记录数、逻辑请求数 3、browserUsed/aiUsed、Dataset 增改/移除统计、两个 Snapshot 及旧 Snapshot 内容。已完成页面不重取：checkpoint 后、投影后、Run 完成后物理页序列为 `[1,2,3]`，其余窗口允许未完成第二页重取，为 `[1,2,2,3]`。最终同一个 job succeeded、attempt 2/maxAttempts 2，所选 session、清理请求及采集临时目录没有剩余。

本阶段 12 项 HTTP Queue/Runtime 进程中断，加上前阶段 HTTP handler 5 项和 Sitemap handler 6 项，共 **23 项真实进程中断用例**，全部包含在最新单元测试中。这里的完整 Runtime 是独立进程中的真实 TypeScript Runtime 组合；**没有启动 Electron 主进程或 Renderer，也没有在这些新用例中启动浏览器/Python Worker**，不能宣称 Electron 宿主、真实浏览器和 Python 的中断/内存验收已经完成。

中间检查：首次筛选的模式字符串与 Vitest 带引号的参数名称不匹配，12 项全部跳过；该退出码 0 不作为通过证据，见 `opt04-queue-process-initial.txt`。改为筛选 after_projection 后两种模式均实际通过，见 `opt04-queue-process-projection.txt`。类型检查首次发现可变指纹在异步回调内失去收窄，改为保留局部不可变指纹与独立恢复指纹；Lint 首次发现测试内联 import type，改为既有 Contracts 类型导入。首次完整回归有 542 项通过、1 项旧写入诊断断言失败（期望终止 failed，实际为可恢复 queued）；更新 queued/retrying/finishedAt 断言，补充持久摘要存在性，保留失败写入步骤与错误消息不进入导出的断言，然后重新运行完整测试。失败/跳过证据保留在 `opt04-queue-recovery-typecheck-initial.txt`、`opt04-queue-recovery-lint-initial.txt`、`opt04-queue-recovery-unit-regression-initial.txt`，未放宽恢复、数据、Snapshot、超时或资源目标。

| Queue/Runtime 恢复阶段检查 | 实际结果 / 退出码 / 证据                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 隔离单元测试       | 98 个文件、543 项全部通过，约 158.7 秒；0；`opt04-queue-recovery-unit-final.txt`，含 12 项新 SIGKILL（约 55.6 秒）、16 项清理/完成恢复及原 37 项采集持久化                                   |
| TypeScript                 | 根与全部工作区通过；0；`opt04-queue-recovery-typecheck-current.txt`                                                                                                                          |
| Lint / 格式 / diff         | 全部通过；0；`opt04-queue-recovery-lint-current.txt`、`opt04-queue-recovery-format-final.txt`、`opt04-queue-recovery-diff-final.txt`；文档更新后的检查见下面                                 |
| 架构 / Client              | Catalog 一致、416 模块 / 1253 条依赖无违规、生成客户端一致；0；`opt04-queue-recovery-architecture-final.txt`、`opt04-queue-recovery-deps-final.txt`、`opt04-queue-recovery-client-final.txt` |
| Desktop E2E                | 最新代码全套 12 项通过，约 1.4 分钟；0；`opt04-queue-recovery-desktop-e2e-final.txt`，含启动、三样本、Dataset、静态/动态/登录态与无限滚动                                                    |
| 资源指标                   | 本阶段没有重新测量；此前 HTTP 吞吐目标仍未通过，真实进程恢复通过不替代资源验收                                                                                                               |

本阶段所有测试句柄已退出。只读检查确认本轮 Queue/完成恢复、清理/采集/暂存/资源/单元测试/Electron profile 前缀均无剩余目录，45100 已释放，见 `opt04-queue-recovery-cleanup.json`。相对初始采样为 80 个文件变化、47 个明确新增代码/文档路径，573 个基线文件无新增缺失；环境文件未读取或哈希，HEAD/main 保持原值，见 `delta-current.json`。未提交、推送、部署或终止其他进程。

复现命令沿用前一阶段的完整检查；定向恢复为 `bun --no-env-file run test desktop/packages/runtime/test/queue-recovery.integration.test.ts desktop/packages/runtime/test/collection-cleanup.integration.test.ts desktop/packages/capabilities/storage-sqlite/test/platform-repository.test.ts`。文档更新后重新运行格式与 diff，退出码均为 0，见 `opt04-queue-recovery-record-format-final.txt`、`opt04-queue-recovery-record-diff-final.txt`。

上述恢复阶段结束时，浏览器单 URL 动作进度、真实浏览器/Electron 宿主异常退出、警告保留与资源指标仍待补齐；以下记录本轮资源工作的进展。

**HTTP 与实际 Artifact/SQLite 资源阶段（2026-10-03）**：扩展 `desktop/tooling/benchmarks/collection-resource.ts` 和 `collection-resource-worker.ts`，增加独立 CPU profile 诊断模式；新建 `collection-pipeline-worker.ts`，直接执行当前生产 Collection handler、真实 Artifact、SQLite 原列表 spool、Dataset 暂存、投影与不可变 Snapshot 元数据提交。三个模式都使用 1 万或 10 万条、每条 JSON 数据精确 1024 字节、每页 1000 条的 localhost 夹具；父进程逐条生成响应并等待背压，不预建完整数据数组。每个规模三次测量，各自启动独立 Node 24 进程与专属临时数据目录。

RSS 方法沿用原基线：导入后只做一次初始 GC；父进程每 25 ms 用 `ps` 采样，Runtime 每 20 ms 与进度/批次边界采样，取这些采样与 Node `maxRSS` 的最大值，再减初始 RSS。采集中不强制 GC。实际写入模式的基线在初始化测试数据库及规则后记录，计时涵盖完整 handler 和临时 Artifact 清理；handler 结束后向父进程发送测量结束消息，再以最多 500 行的查询批次逐行核对持久化结果，校验用的小型标记数组不存储记录内容，校验耗时与 RSS 不计入采集测量。每条最终记录验证 ID、来源分页 URL、字段内容和 1024 字节数据大小，验证无重复/丢失、所有 Snapshot 统计、最多 250 行/1 MiB 的批次以及无剩余临时 Artifact/workspace。每次 1 万条为 40 个最终批次、80 个原/最终 Artifact；10 万条为 400 个最终批次、800 个 Artifact。

首次实际写入测量虽然数据校验通过，资源目标失败：增量峰值 RSS 中位数从 328.72 MiB 增至 2379.30 MiB，比例 7.238。Dataset `commitNormalized` 在每行上创建查询、插入、更新与变化记录的原生 SQLite 语句，语句包装对象被回收前保留大量原生分配。本轮把这些语句移到投影循环外、每次事务内复用，覆盖 added、updated、unchanged、removed 四类路径；不改变事务、去重、Record Key、变化事件或 Snapshot 指纹语义，没有新增 migration、依赖，也没有依靠中途 GC 或放宽资源指标解决问题。已有跨 500 行投影、1199 行移除、重开、重放及旧 Snapshot 不变测试均保留。

实际写入前后中位数如下，均来自每个规模三次完整运行；该“修复前”是本轮 OPT04 写入实现，**不是最初采集器或整个原产品的吞吐基线**。

| 实际 Collection 写入链路 | 1 万条耗时 / 吞吐 / 增量峰值 RSS  | 10 万条耗时 / 吞吐 / 增量峰值 RSS  | RSS 规模比例 |
| ------------------------ | --------------------------------- | ---------------------------------- | ------------ |
| 复用语句前               | 1.048 s / 9542 条/s / 328.72 MiB  | 13.237 s / 7555 条/s / 2379.30 MiB | 7.238，失败  |
| 复用语句后               | 0.828 s / 12084 条/s / 112.72 MiB | 10.859 s / 9209 条/s / 162.80 MiB  | 1.444，通过  |

前后各六次的逐次报告与源文件哈希分别保留在 `opt04-pipeline-performance/`、`opt04-pipeline-reuse/`，汇总为 `opt04-pipeline-resource-comparison.json`。修复后 10 万条峰值增量减少约 93.2%，吞吐约为修复前的 121.9%，只适用于这个固定本地夹具。报告还记录 Artifact 写入字节、SQLite/ WAL 大小、投影耗时和投影前后 RSS/JS heap；10 万条每次最终 Artifact 批次最大 272001 字节。本次没有保存最初产品完整写入链路的源码基线，因此不能宣称完整写入吞吐达到原产品的某个百分比。

计数消费者另行按最终脚本重新测量原始已保存采集器与当前分批采集器，全部 16 个保存源码哈希通过校验，先原始后当前，每个规模各三次，不与其他验证并行。初次本轮测量保留在 `opt04-current-performance/`，最终结果及哈希保留在 `opt04-resource-final/`。原始首次捕获报告与此前失败报告未覆盖；仍对首次原始基线以及相邻复测基线分别比较，门槛保持 80% 和 RSS 比例三倍。

| HTTP 计数消费者中位数 | 最初原始吞吐 | 相邻原始吞吐 | 当前吞吐 / 耗时          | 当前增量峰值 RSS | 当前 / 最初原始 | 当前 / 相邻原始 |
| --------------------- | ------------ | ------------ | ------------------------ | ---------------- | --------------- | --------------- |
| 1 万条                | 139649 条/s  | 137957 条/s  | 130777 条/s / 76.466 ms  | 59.22 MiB        | 93.65%          | 94.80%          |
| 10 万条               | 156888 条/s  | 155604 条/s  | 157813 条/s / 633.661 ms | 79.95 MiB        | 100.59%         | 101.42%         |

该范围 RSS 规模比例为 1.350，原始与当前的请求数分别精确为 10/100，浏览器与 Python 启动数为 0；`opt04-resource-final/opt04-performance/comparison.json` 的 `targetPassed` 为 true。本轮没有改动 HTTP 采集热路径，因此不能把此前吞吐失败与本次通过的差异归因于 SQLite 语句修复，也没有证明此前时间波动的具体原因。CPU profile 另存为 `opt04-current-performance/opt04-performance/stream-profile-100000-1.cpuprofile` 与 `profile-summary.json`，只用于诊断、包含 inspector 开销，不参与吞吐/内存门槛统计。实际 Artifact/SQLite 模式验证的是 Collection handler 完成，不包含队列调度、Electron 宿主、浏览器、Python 或 Parquet materialization；Snapshot 为 projected 元数据状态。

本阶段初始类型检查与首个实际链路启动失败，因为根 tooling 不能解析其他工作区私有包入口；改为引用明确的仓库源码入口，沿用已有 Node 开发条件与 `.js` → `.ts` loader，没有新增依赖。失败保留在 `opt04-current-performance/typecheck-initial.txt`、`pipeline-command-initial.txt` 及首个 worker 日志。随后根类型检查、Dataset 定向 3 文件/17 项通过，再运行以下完整回归；资源首轮失败也完整保留，不能把“脚本退出 0、数据正确”计作内存门槛通过。

| 本资源阶段检查            | 实际结果 / 退出码 / 证据                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop 隔离单元测试      | 98 文件、543 项全部通过，171.18 秒；0；`opt04-resource-unit-final.txt`                                                                                                                     |
| TypeScript                | 根与全部工作区通过；0；`opt04-resource-typecheck-final.txt`                                                                                                                                |
| Lint / 格式 / diff        | 全部通过；0；`opt04-resource-lint-initial.txt`（首次即通过）、`opt04-resource-format-final.txt`、`opt04-resource-diff-final.txt`；文档更新后另行检查                                       |
| 架构 / Client             | Catalog 一致、418 模块 / 1265 条依赖无违规、生成客户端一致；0；`opt04-resource-architecture-final.txt`、`opt04-resource-deps-initial.txt`（首次即通过）、`opt04-resource-client-final.txt` |
| Desktop E2E               | 12 项通过，约 1.4 分钟；0；`opt04-resource-desktop-e2e-final.txt`                                                                                                                          |
| HTTP Runtime 测量         | 原始与当前各六次正常运行；0；最终 `comparison.json` 证明两个规模对两份原始基线均通过 80% 门槛，增量峰值 RSS 比例 1.350                                                                     |
| 实际 Artifact/SQLite 测量 | 修复前后各六次正常运行且所有记录校验通过；0；修复后内存比例 1.444；完整原产品吞吐基线未测量，不冒充通过                                                                                    |

复现测量使用 `bun --no-env-file desktop/tooling/benchmarks/collection-resource.ts <本轮测量目录> baseline`、`stream` 或 `pipeline`；目录内 `opt04-baseline` 指向不可变的本轮原始采集源码目录。诊断模式为 `stream profile`，仅运行 10 万条一次且使用独立文件名。完整回归命令沿用前述隔离入口；新增源码入口直接运行 Node，测试子进程使用环境允许列表，不加载用户环境文件或真实凭据。

本阶段全部资源、单元测试与桌面 E2E 句柄已退出；只读检查确认九类本轮临时目录前缀无剩余目录，45100 可用，见 `opt04-resource-cleanup.json`。相对初始采样为 80 个文件变化、48 个明确新增代码/文档路径、573 个基线文件无新增缺失；环境文件未读取或哈希，HEAD/main 保持原值，见 `delta-current.json`。文档更新后格式与 diff 退出码均为 0，见 `opt04-resource-record-format-final.txt`、`opt04-resource-record-diff-final.txt`。没有暂存、提交、推送、部署、清理共享卷或终止其他进程。

以上是资源阶段结束时的范围。其后的浏览器动作恢复与警告限制见下一节；资源结果必须随受影响代码复测。各类夹具只支持其实际范围，OPT04 与全部主目标继续保持未完成，OPT05 至 OPT11 未开始。

### OPT04 浏览器动作逐轮恢复与警告资源限制

2026-10-03 至 10-04。本阶段继续实现 OPT04，没有改变主目标或启动 OPT05。先复核已有测试句柄的终态：警告与浏览器轮次定向三文件 21 项通过，根与全部工作区类型检查通过；此前初始失败日志仍保留。

生产 Collection 现在向 Crawler 注入 `CrawlBrowserPagination`。loadMore/无限滚动在初始页面及每次动作后提取当前页面，等待最多 250 条/目标 1 MiB 的批次持久化，再提交这一轮的状态并执行下一动作。单条较大记录仍受原响应大小限制，未降低既有上限。预览及无批次回调的兼容入口继续沿用原行为；生产流式动态分页缺少持久端口时明确拒绝执行。

新增迁移 `008_collection_crawl_browser_rounds`，001 至 007 的迁移内容不变。新表只保存轮次、来源 URL、哈希、数量、选择位置及受控游标；待提交轮次的选择位置以 250 项游标分页读取，已提交后清除临时选择与观察表。相同内容在同一累积页面出现多次时保留其数量；跨轮见过的数量在 SQLite 中维护。不同内容的虚拟滚动窗口被完整保留，不能据此声称能够识别两个完全相同内容的虚拟窗口中的物理记录身份。

恢复时从新浏览器重新执行必要的动作，校验各轮提取数据的顺序及校验和；已提交轮次不再输出或占用记录预算，未完成轮次重放稳定批次序号。确认每轮的原始批次行数、批次数及连续序号之后才提交轮次，最后一轮终止之前不能完成 URL。重放数据或分页控件变化会产生明确的验证错误并保留旧 Snapshot。游标状态规范化为五个允许字段，额外 DOM/认证字段不落库；字段顺序变化仍识别为相同提交。动态分页 fingerprint 使用 `collection-browser-rounds-v1`；静态 HTTP/浏览器与 Sitemap 保持各自既有版本。契约、Batch Writer、Repository、迁移 descriptor 与 Catalog 同步，HTTP 公共 API 未增加新操作。

共享 `warnings.ts` 为提取器与 Crawler 提供普通数组兼容的有界缓冲：保留最早 127 条消息和一条省略数量，单条 JSON 字符串最多 512 字节，整个警告数组 JSON 不超过 64 KiB。合并及脱敏后继续受此限制，不把省略标记再次算作一条警告；`warningTotal` 单独保存本次执行实际观察到的警告总数。HTTP JSON 采集原来没有合并字段提取警告，本阶段补齐。这个总数包含累计页面再次提取时观察到的警告，属于当前尝试的观察数量，不代表唯一字段问题数或所有恢复尝试的历史数量；Run 的原日志 `warningCount` 语义不变。

有意义的定向证据包括：每种分页初轮 Artifact 写入暂停时不加载下一页、取消时不再执行动作且只保留旧 Dataset/Snapshot、累积页面的 786 条记录及 6 条等值重复、两种虚拟窗口的 780 条唯一记录、原始记录上限和既有字段去重、六个普通异常后重开 Repository 的恢复窗口、重放数据变化在尚有五次尝试额度时仍不可重试、追加游标字段不进入 SQLite/WAL。警告测试包含 10 万次追加、Unicode/控制字符 JSON 字节限制与省略总数合并，真实 HTTP 3000 条无效数字产生 3000 个观察计数但仅 128 项警告；实际 Collection 浏览器运行观察总数 1572、保留 128 项，最终 786 条记录的该字段均为 null。

真实进程夹具直接运行 Node + Crawlee Chromium + Collection handler + Artifact/SQLite，并与另一不中断进程比较完整记录集合、逻辑请求数、Dataset 统计和 Snapshot。两个模式各覆盖请求中、第三个 Artifact 写入后、第二轮提交前后、终止轮次提交后、URL 提交前后，以及只终止 Chromium 的窗口。使用测试拥有的 PID/父子关系及启动时间/可执行文件标识校验，终止或清理仅作用于登记的进程；重启使用相同 Run ID。列表查询以随机记录 ID 排序，因此比较按记录内容排序的完整多重集合，保留重复记录；未将物理浏览器 AJAX 请求次数冒充逻辑 URL 请求数。

首轮 30 项中普通用例 14 项通过，16 个新增进程用例失败：一项请求窗口越过了夹具 100 ms 动作等待、13 项完整数据一致但查询顺序不同，另两项 Chromium 终止后工作进程未退出。调整仅针对中断夹具的动作等待为 2000 ms，以便在未完成请求窗口内登记并终止进程；增加进程退出与请求等待的联动，记录比较保留所有内容与重复次数，未减少预期记录或统计。其后的聚焦运行仍证明浏览器已失败并关闭 Repository 后存在连接，不能归为通过。

实际原因在 `proxy-chain@2.7.1` 的 HTTP 转发：下游在上游发送响应头之前关闭，尚未建立响应 pipeline，上游请求没有随之销毁。本阶段增加一个 8 行 Bun 补丁，只在响应未正常完成且下游已关闭时销毁上游请求并结束转发。保留原包名称、版本、Apache-2.0 许可及上游完整性；原 registry 审计仍能看到原包，没有新增 ignore。补丁声明位于根 `package.json` 与 `bun.lock`，说明见 `tooling/dependency-patches/README.md`。已验证冻结安装退出 0；移除唯一新增补丁声明后的锁文件 SHA-256 与上一资源阶段完全一致，证明没有顺带升级包版本，见 `opt04-proxy-patch-lock-comparison.json`。

`bun patch` 的准备阶段在本机 isolated linker 下两次报 ENOENT，并临时移除了一个忽略的依赖安装目录。通过冻结安装恢复该目录，随后采用声明式补丁正常安装，不编辑 Bun 全局缓存或其他项目。原失败日志分别保留在 `opt04-proxy-patch-prepare.txt`、`opt04-proxy-patch-prepare-path.txt`，恢复、安装及冻结验证日志保留在同前缀文件。修复后的两个 Chromium 终止定向用例均自然退出、恢复为完整控制数据，退出 0，见 `opt04-browser-kill-patched-current.txt`。临时 async_hooks/资源栈诊断已移除，原诊断日志保留，不用强制退出掩盖连接问题。

以下针对清理诊断代码、声明补丁且冻结安装后的代码运行，24 个明确非凭据源码路径的哈希保存在 `opt04-browser-round-source-hashes.json`。完整测试内新增浏览器套件 31 项全部通过，包含 14 个真正的采集进程 SIGKILL 窗口及两个 Chromium 终止窗口；累计已有 HTTP/Sitemap/Queue/Runtime 的 23 个窗口为 37 个采集进程 SIGKILL 窗口。

| 本浏览器阶段检查        | 实际结果 / 退出码 / 证据                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Desktop 隔离业务测试    | 100 文件、578 项通过，336.30 秒；0；`opt04-browser-final-unit.txt`                                      |
| TypeScript              | 根与全部工作区通过；0；`opt04-browser-final-typecheck.txt`                                              |
| Lint / 格式 / diff      | 全部通过；0；`opt04-browser-final-lint.txt`、`format.txt`、`diff.txt`（同前缀）；文档结束后另行检查     |
| 架构 / Client           | Catalog 一致、422 模块/1290 依赖无违规、生成客户端一致；0；`architecture.txt`、`deps.txt`、`client.txt` |
| Desktop E2E             | 12 项通过，约 1.3 分钟；0；`opt04-browser-final-desktop-e2e.txt`                                        |
| 公开依赖审计            | 原命令和补充上游审计通过；安全补丁 14 项回归通过；0；`opt04-browser-final-audit.txt`                    |
| 许可证                  | 1087 项 Node、51 项 Python 记录；0；`opt04-browser-final-licenses.txt`                                  |
| HTTP / 实际写入资源复测 | 原始、当前 HTTP 及实际写入各六次正常运行，三次中位数与全部记录验证通过；0；详见以下复测表格             |

上表的完整测试与 E2E 结束后，才依次复测资源，不与其他验证并行。使用相同 M4/Node 环境、逐条生成且精确 1024 字节的本机 JSON 夹具，沿用三种峰值取最大、初始化后 RSS 基点、不在执行中强制 GC、500 行分页和紧凑位图检查数据的方法。测量命令与上一节相同，目录换为本轮 `opt04-browser-round-resources/`；该目录中的 baseline 链接指向不可变原始源码，16 个保存源码哈希仍经过校验。每个规模的三次原始结果、较慢样本和 RSS 范围均保留，没有删样本或放宽目标。

| 当前 HTTP 计数消费者 | 1 万条      | 10 万条     |
| -------------------- | ----------- | ----------- |
| 耗时中位数           | 77.951 ms   | 645.028 ms  |
| 吞吐中位数           | 128286 条/s | 155032 条/s |
| 增量峰值 RSS 中位数  | 59.86 MiB   | 76.19 MiB   |
| 相对首次原始吞吐     | 91.86%      | 98.82%      |
| 相对相邻原始吞吐     | 92.39%      | 99.84%      |
| 精确逻辑/HTTP 请求数 | 10 / 10     | 100 / 100   |

RSS 规模比例为 1.273，两个规模相对首次与相邻原始基线均通过 80% 门槛，`opt04-browser-round-resources/opt04-performance/comparison.json` 的 `targetPassed` 为 true。这个范围仍是 HTTP Runtime 加计数消费者，不包含生产 Artifact/SQLite、Electron、浏览器或 Python。原始首次报告与先前失败报告没有覆盖。

| 当前实际 Artifact/SQLite 链路 | 1 万条               | 10 万条              |
| ----------------------------- | -------------------- | -------------------- |
| 耗时 / 吞吐中位数             | 0.940 s / 10638 条/s | 11.423 s / 8755 条/s |
| 增量峰值 RSS 中位数           | 126.14 MiB           | 163.25 MiB           |
| Dataset projection 中位数     | 484.429 ms           | 5406.329 ms          |
| 单批最多记录 / JSON 字节      | 250 / 271751         | 250 / 272001         |
| 校验完成记录数                | 每次全部 10000 条    | 每次全部 100000 条   |
| 相对上一 OPT04 资源阶段吞吐   | 88.04%               | 95.06%               |

实际链路 RSS 比例为 1.294，`pipeline-comparison.json` 的内存目标与数据验证均为 true；它包括 handler、Artifact、SQLite raw spool、staging、projection、不可变 Snapshot 元数据与清理，不包括队列调度、Electron/浏览器/Python 或 Parquet materialization。最后一行是与之前 OPT04 语句复用后的资源阶段比较，不是与最初完整产品链路比较；最初完整产品吞吐基线依然未测量，不能冒充其验收结果。两个资源报告包含硬件、采样、各次范围、原报告引用和明确源码哈希，命令日志保留在 `opt04-browser-resource-{baseline,stream,pipeline}.txt`。

清理审查又补齐测试子进程的 `TMPDIR/TMP/TEMP`：Playwright 临时 Profile/下载目录现在位于已登记的测试目录内，即使 Node 被 SIGKILL、无法执行 Playwright finally，也能在确认所有登记进程结束后随该目录回收。真正的 SIGKILL 用例在终止前还检查 Chromium Profile 确实位于专属目录，未按系统全局 Playwright 前缀批量删除目录。此处仅改变测试夹具环境与归属断言，生产源码、补丁和锁文件相对资源测量没有变化；以新的哈希记录区分，见 `opt04-browser-owned-temp-source-hashes.json`。隔离修改后浏览器 31 项再次全部通过，166.15 秒，0；`opt04-browser-owned-temp-final.txt`；根及全部工作区 typecheck、夹具 ESLint 再次退出 0，见同前缀对应日志。因此 578 项完整回归与 12 条 E2E 对应生产代码，31 项复测同时覆盖最新夹具隔离。

本阶段所有测试、E2E、审计、诊断及资源句柄已确认终态。只读检查十类明确测试目录前缀均为空，45100 可用，见 `opt04-browser-round-cleanup.json`；这里只证明已登记前缀与当前归属，不据此删除或宣称全局系统临时目录为空。相对初始 573 个非凭据采样文件，有 80 个文件变化、53 个明确新增源码/文档/补丁路径，新增缺失为 0，见 `delta-current.json`。两份 `.env.example` 仍明确未读取或哈希；HEAD/main 保持原值。没有暂存、提交、推送、部署、清理共享卷或终止无关进程。文档更新后的全库格式检查与 diff 均退出 0，见 `opt04-browser-record-format-final.txt`、`opt04-browser-record-diff-final.txt`；登记后再检查本文与 diff。

**本浏览器阶段结束时仍待验收**：当时尚未验证真实 Electron 主进程/utility/Renderer 宿主恢复和浏览器/Python 独立内存；下节补齐这些证据。浏览器依然会保留当前 DOM，提取器会产生受响应上限约束的当前页临时数组；这里证明移除了全运行 records[] 驻留和无限待写批次，不能把它说成没有 DOM/当前页数组，也不证明真实外部网站的数据不会变化。

### OPT04 完成：真实 Electron 恢复与独立进程内存

2026-10-04（Asia/Shanghai）完成本项验收。主目标仍包含 OPT05 至 OPT11，没有缩小范围。新增 `desktop/e2e/recovery.spec.ts` 使用实际 Electron Main、生产 utility-entry、Runtime API、队列、Artifact、SQLite 与本机 Chromium。每个用例有独立 `zhiyun-host-recovery-` Profile，本机动态端口分页夹具和过滤环境；Playwright 的临时目录也位于该 Profile。Runtime 本地鉴权由应用自动生成，nonce/token 只在 Renderer 闭包内使用，不进入报告，不需要外部凭据。

每个用例先运行一个不中断控制任务，再给待中断任务生成一条旧数据的 Snapshot。第二页请求被夹具暂停时，先检查真实 SQLite：同一个 job 为 running/attempt 1，第一页 260 条已写为两个批次，round 0 已提交，逻辑请求数 1，旧记录与 Snapshot 仍未改变。随后分别执行：

- **utility**：验证应用的 Runtime PID 与登记身份后 SIGKILL，等待现有 Supervisor 自动生成新 utility，沿用生产 30 秒 lease/5 秒恢复扫描，没有缩短 lease 来让测试更容易通过。
- **Main**：真正 SIGKILL 测试启动的 Electron 主进程；确认原 utility 已退出，按登记 PID、启动时间与可执行文件身份回收本用例的辅助子进程，再启动同一 Profile。这里没有用正常退出代替崩溃，也不据测试辅助进程回收声称操作系统会自动回收全部子进程。
- **Renderer**：实际 `forcefullyCrashRenderer()`。补齐此前只记日志的主进程处理：重建窗口，恢复当前内部页面及正常窗口尺寸、显示/隐藏、最大化状态；Runtime PID/创建时间保持不变，同一 Run 继续。额外连续崩溃验证十分钟内最多自动恢复三次，第四次只提示重新打开应用；测试拦截末次原生错误对话框，避免阻塞。隐藏与最大化经过实际断言；全屏状态保存逻辑本轮没有单独作原生全屏验收。

三种故障均得到完整的 778 条最终去重记录，逐条比较全部 data/sourceUrl 的多重集，统计与控制运行一致：added 778、removed 1、updated/unchanged 0、current 778。逻辑 requestCount 均为 1；旧 Snapshot 与旧 Run 内容不变，只增加一次新 Snapshot。Main/utility 同一 job 以 attempt 2 成功，Renderer 为 attempt 1；完成后 session、批次与清理意图均回收。最终三份报告为 `opt04-host-{utility,main,renderer}-final.json`，恢复上限报告为 `opt04-host-renderer-limit-final.json`。从故障到结果校验结束分别约 43.180、43.836、11.300 秒，包含真实 lease 等待及分页动作等待，不作为采集吞吐基线。

首次夹具把首页误当成任务页，三项在启动断言处失败；随后又修正 Electron ProcessMetric 名称识别与 utility 重启空档的等待。日志 `opt04-host-e2e-{initial,bootstrap-corrected,recovery-first,recovery-second}.txt` 均保留。修正后的定向三项先全部通过，再进行包含原 12 条用户路径的完整 E2E。完整运行最后通过 15 项，约 5.9 分钟，退出 0，见 `opt04-host-desktop-e2e-final.txt`。这是桌面产品运行证据，仍不代替未签名安装包验收。

首次错误启动用例退出后，三个具体 Profile 缓存目录被延迟重建。核对其时间、仅 Cache/Network Persistent State 内容、专属启动参数及 lsof 句柄后，确认没有关联测试主进程或占用句柄，仅回收这三个审计中的确切路径，没有按全局前缀删除目录或终止进程，见 `opt04-host-initial-cache-audit.json`。测试启动 helper 现在即使首屏断言失败也会登记、关闭并检查自身进程，Profile 在启动前写归属标记。新增真实启动后故意断言失败的专项，验证所有登记进程结束；1 项通过，33.4 秒，0，见 `opt04-host-launch-cleanup-final.txt`。该专项在最后一次完整 15 项之后加入，因此本阶段证据为“完整 15 项 + 定向 1 项”，没有声称已经跑过一次合并的 16 项套件。此处仅改变测试 helper/归属记录，生产 Main 与 Worker 相对完整 E2E 没有变化。

#### Chromium 内存观测

`desktop/tooling/e2e/process-memory.ts` 在三类实际宿主用例中，每约 100ms 加 ps 延迟采样，只识别本用例 Electron 的后代中采集 Chromium 主进程及 helpers；Main 重启后更新归属根，Electron Renderer、Runtime 和 Python 不计入。每个用例均是三个 260 条页面、每条 payload 约 1 KiB 的列表，包含实际 DOM、分页和恢复重放。

| 故障场景 | 采集 Chromium RSS 求和峰值 | 有浏览器采样数 | 最多同时进程 |
| -------- | -------------------------- | -------------- | ------------ |
| utility  | 474.00 MiB                 | 81             | 5            |
| Main     | 449.84 MiB                 | 81             | 5            |
| Renderer | 434.72 MiB                 | 78             | 5            |

这些是各自故障场景的独立观测，不是三次相同负载的性能对照。采样峰值是下界，RSS 求和可能重复计入共享页，也不表示独占物理内存；没有声称浏览器在 10 万条 DOM 上保持该内存水平。这些数值不混入 HTTP Runtime 的三倍 RSS/80% 吞吐验收。

#### Python Worker 内存与数据验证

新增 `desktop/analytics-worker/scripts/measure_resources.py`，用独立 Python 3.12.13 Worker 真实执行 `dataset.normalize_snapshot` 与 `stats.descriptive`。1 万/10 万条各三次，每次新建 Worker/专属 workspace，逐行生成精确 1024 字节 NDJSON，不预建全量数组。只采样该 Worker PID 的 ps RSS，约 25ms 加 ps 延迟，未强制 GC。归一化基点在 ready/health 后；分析基点在归一化后，明确保留前一阶段驻留内存。完整 Parquet 校验在测量后按 500 行检查每个 key/sourceUrl/value/payload，并用紧凑位图证明无遗漏/重复；描述统计的 count/mean/min/max 全部符合完整输入。

| Python 三次中位数  | 1 万条     | 10 万条    |
| ------------------ | ---------- | ---------- |
| 归一化耗时         | 217.008 ms | 836.604 ms |
| 归一化增量峰值 RSS | 77.31 MiB  | 104.81 MiB |
| 归一化绝对峰值 RSS | 186.42 MiB | 214.00 MiB |
| 描述统计耗时       | 71.157 ms  | 70.247 ms  |
| 分析增量峰值 RSS   | 39.75 MiB  | 48.77 MiB  |
| 分析绝对峰值 RSS   | 226.25 MiB | 262.98 MiB |

耗时包含 Worker 提交/状态轮询，采样峰值同样是下界，尤其短分析仅有 3–4 个采样点。六次结果和范围原样保留在 `opt04-python-native-resources-final/{samples.jsonl,report.json}`，日志同目录名 `.txt`，退出 0；六个明确 Python 源码哈希已与当前文件核对。它们是独立计算链路记录，不是原 HTTP Runtime 的性能对照，也不代替打包 Python 二进制验收。

首次测量准确拒绝了普通字符串列的假“类型冲突”警告，见 `opt04-python-native-resources.txt`。根因是 `ColumnProfile.finalize` 把非日期的单一字符串类型落入混合类型分支；修正为普通 string，ISO 日期仍归为 datetime，混合类型仍提示。新增真实 Parquet 回归；Worker 全部 40 项通过，3.84 秒，退出 0，保留原 ARIMA 时间频率推断 warning，见 `opt04-worker-tests-final.txt`。Ruff 全部通过，0，见 `opt04-worker-lint-final.txt`。一次错误相对路径启动没有执行 pytest，127 的日志单独保留为 `opt04-worker-tests-launch-error.txt`。

#### 最后检查与逐条验收

最后代码的根与全部工作区 typecheck、全库 ESLint/Prettier、Catalog、依赖边界、Desktop/Worker 生成客户端均退出 0。依赖边界 425 模块/1302 依赖无违规。日志为 `opt04-host-final-{typecheck,lint,format,architecture,client}.txt`，补充终态及 Catalog/Desktop Client 输出在 `opt04-host-final-process-status.json`；启动清理修正后的全工作区 typecheck 与相关 ESLint 再次退出 0，见 `opt04-host-launch-{typecheck,lint}-final.txt`。此前 578 项业务测试及 HTTP/实际写入资源阶段的 24 个登记 Node 文件与当前源码完全一致，见 `opt04-host-browser-source-comparison.json`；本阶段修改的 Main、Worker 和 E2E 用上述真实宿主与 40 项 Python 测试验证，没有用旧业务测试冒称已覆盖新的主进程行为。

| OPT04 计划要求                                  | 证明与当前结论                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/浏览器分批、背压、错误传播                 | 前述 streaming、31 项 browser-rounds 与实际 Artifact/SQLite 生产批次；每批有界且下游未返回不进入下一阶段；满足                                          |
| 请求及 Artifact/checkpoint 中断后准确恢复       | 37 个采集进程 SIGKILL、2 个 Chromium 终止及真实 Electron Main/utility/Renderer 三类故障；最终完整记录与统计一致；满足                                   |
| 取消/重试/分页/去重、不可变 Snapshot、临时回收  | 前述取消/删除/持久清理测试，最新同 Run attempt 恢复、旧 Snapshot 不变与启动失败清理；满足                                                               |
| 同硬件 1 万/10 万条 HTTP 三次中位数与原实现基线 | 上一阶段不可变原始 HTTP 基线和当前 comparison.json：增量 RSS 比例 1.273、吞吐 91.86%/98.82%；目标通过；实际 Artifact/SQLite RSS 比例 1.294 单独标明范围 |
| 浏览器/Python 内存另行记录                      | 上述 Chromium 三场景与 Python 六次实际运行，明确峰值采样限制，不混入 HTTP 比较；满足                                                                    |

最后只读核对本阶段登记的三类临时目录前缀均为空，所有工具句柄已终态，见 `opt04-host-cleanup.json`。相对初始 573 个非凭据采样文件，有 83 个变化文件、56 个明确新增路径，新增缺失 0；源码、脚本与文档在 `opt04-host-source-hashes.json`/`delta-current.json` 登记；两份 `.env.example` 继续明确不读取或哈希。HEAD/main 保持原值，没有暂存、提交、推送、部署或触碰开发数据。最后文档/相关源码格式与 diff 均退出 0，见 `opt04-host-record-{format,diff}-final.txt`；Worker 全部格式检查退出 0，见 `opt04-worker-format-final.txt`。登记本段后再次核对文档格式/diff，并刷新明确源码清单的哈希。

### OPT05 开始：确认已有实现与缓存差量

2026-10-04 开始确认时，尚未实现缓存。现有 Collection 已持久保存规则/版本，AI Assistance `extractTask` 可选取 active version；这只证明版本引用，不证明结构、Provider/模型或 Prompt 变化后的本地缓存命中/失效。`application/analyzer.ts` 的 `enrichWithAi` 在 useAi 时直接调用 generateSchema/generateRule；现有 AI Assistance migration 001/002 只有设置、会话、回合和工具记录，没有本地验证缓存。Browser Runtime 的 Stagehand 修复是选择器失败后调用 act，也没有本地动作缓存协议。

初始实施安排是以现有 Plugin/Repository 为边界实现持久的验证缓存与结构指纹，补齐稳定键、过期/规则与模型/Prompt/工具 Schema 变化失效、损坏降级原因及手动清理，验证命中时 Mock 调用数为零。只保存经过验证的规则/动作及必要哈希/元数据，不保存原始 DOM、填表值、Cookie、Token；认证会话必须隔离。OPT05 当前为进行中，OPT06 至 OPT11 保持未开始。

### OPT05 第一阶段：持久规则缓存与受控分析

2026-10-04 实施并验收本阶段，OPT05 仍为进行中。已实现当前页面列表提取规则的持久缓存；浏览器动作缓存、复杂详情/分页组合的缓存验证及真实 Electron 缓存界面 E2E 继续留在 OPT05。OPT06 至 OPT11 保持未完成，整个主目标没有缩小。

**实际实现**：

- 新增 `contracts/src/validated-cache.ts` 持久化端口及 AI Assistance migration `003-validated-cache`；001/002 的源文件和 checksum 输入保持原样。SQLite 只接收哈希、已验证规则和时间/命中元数据，单条上限 32 KiB、全局 256 条 LRU，默认 TTL 一天、最大七天；命中不延长原 TTL。
- `application/rule-cache.ts` 与 `analyzer.ts` 共用确定性验证；Runtime 注入到任务/草稿分析和爬虫助手 `generate_rule`。缓存键包含独立任务或草稿范围、实际 Task revision 与 active Rule version、完整页面结构指纹、动作语义哈希、分页/Dataset/网络/请求/浏览器配置，以及 Provider/模型和 Prompt/工具版本。Cookie、Header、Storage State、代理与 URL 的认证上下文只参与瞬时计算，持久边界接收摘要。
- HTML 指纹忽略文本、输入值及非结构属性值；JSON 指纹使用键和类型形状。最多遍历 20,000 个节点、64 层，超过范围时跳过缓存，不采用截断指纹。每次复用重新提取当前页面，校验规则语法、前十条样本的全部字段及类型/缺失状态；预览数据来自当前页面，不读取缓存中的旧数据。
- 结构变化后先验证旧规则；验证成功可更新结构摘要并复用，失败才在显式允许 AI 的分析中重新生成。损坏 payload、checksum、Schema、过期时间或元数据均降级并返回原因。关闭 AI 后，空的确定性预览只返回调整字段/显式启用 AI 的提示，Provider 调用为零；取消继续传播。
- Provider 身份读取不调用 API Key resolver；Hosted 身份使用当前实际选择的模型。OpenAI-compatible/Hosted 规则生成实际使用的 Schema、Rule 和 system 提示词共同形成 Prompt 指纹；工具 Schema 版本与分析版本另行入键。未知模型身份跳过缓存。
- HTTP 启发式找不到自定义容器时，先尝试已有缓存；未命中才进入浏览器分析。未找到启发式容器时不再等待一个不存在的猜测选择器。真实 Chromium 夹具首次在浏览器中生成，后续直接在 HTTP 页面验证并复用。
- 新增 `POST /api/v2/rules/cache/clear`，要求 `task.write`、独立任务/草稿 UUID 和 Idempotency-Key。清理增加 generation，阻止清理前开始的分析写回缓存。OpenAPI、生成客户端、SDK 与 TaskEditor 的缓存状态、原因、调用/命中数及清理按钮同步；API 重放只返回首次清理结果。
- 缓存规则采用结构表达式限制和敏感值检查，拒绝填表字面量、敏感 selector、Cookie/Token 回显及隐藏在 metadata 中的整页 DOM。分析中未执行的动作、详情或分页组合仍待对应验证，不登记为已验证缓存。

**实际证据与指标**：

| 验收点                               | 当前证据与结果                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次创建、重开后复用                 | `rule-cache.test.ts` 的 HTTP 夹具首次 Mock `generateSchema`/`generateRule` 共两次；关闭并重开 Repository 后的两次分析共零次 Mock 调用，实际命中计数为二，预览反映修改后的页面数据                   |
| 自定义容器与真实浏览器               | 真实本地 Chromium 首次分析 engine=browser、Mock 两次；后续 engine=http、Mock 零次、实际命中一次；对应私有浏览器生命周期正常结束                                                                     |
| 结构/规则/模型/Prompt/config/session | 结构变化后成功验证旧规则的夹具零次调用；容器失效后重新生成两次。Task revision、实际 Rule version、Provider/模型、Prompt/工具、分页/Dataset/请求/动作配置、Header/Storage State 会话变化各有失效断言 |
| 实际规则升级                         | Level2 集成在真实 SQLite Collection Repository 创建版本一并升级为版本二，经过任务 HTTP 分析入口均返回 `rule_changed`、两次调用；版本稳定后的再次请求命中、零次调用                                  |
| 损坏与清理                           | invalid JSON/checksum/Schema、无效 expiry、字段缺失降级；手动清理隔离范围、清理中途的模型回写被拒绝；未授权清理返回 401、混合两个范围返回 422；清理请求重放不删除后来生成的缓存                     |
| 隐私                                 | Header Token、Cookie、填表值、Storage State 和页面标记均未出现在实际隔离 SQLite 文件及其 WAL；另外验证短填表值、裸 Bearer、页面 Token selector、生成的 fill 和 metadata 内整页 DOM 被拒绝           |
| 容量和中断                           | 超过 256 条触发 LRU；TTL 不因命中延长；失败的生成不缓存备用规则；关闭 AI 的空结果及取消分别验证无调用和抛出取消原因                                                                                 |

机器可读实测在本轮 Artifact `opt05-rule-cache-metrics.json`，数据来自运行时 Mock usage 回调和实际命中结果；计数单位是 Provider 方法调用，不是传输重试次数或真实 Token/费用。未测量真实模型效果与费用，不报告真实费用下降比例。

**验证命令**：全部在仓库根目录，以 `bun --no-env-file` 执行；测试使用原有隔离环境过滤器。

| 检查                   | 命令/覆盖                                                                                                                                                                                                                                                                                                                                                | 实际退出码与记录                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 规则/助手/Runtime 回归 | `desktop/tooling/scripts/test-isolated.ts desktop/packages/plugins/ai-assistance/test desktop/packages/ai-runtime/test desktop/packages/runtime/test/level2.integration.test.ts desktop/packages/runtime/test/openapi.test.ts desktop/packages/runtime/test/product-api.integration.test.ts desktop/packages/runtime/test/assistant.integration.test.ts` | 0；13 个文件、100 条测试通过，其中缓存 36 条；`opt05-rule-cache-stage1-final.txt/.json`，24.25 秒           |
| 全工作区 TypeScript    | `bun --no-env-file run typecheck`                                                                                                                                                                                                                                                                                                                        | 0；`opt05-typecheck-stage1-final.txt`                                                                       |
| 全库 ESLint            | `bun --no-env-file run lint`                                                                                                                                                                                                                                                                                                                             | 0；`opt05-lint-stage1-final.txt`                                                                            |
| Catalog 与生成客户端   | `architecture:generate/check`、`client:generate/check`                                                                                                                                                                                                                                                                                                   | 均 0；`opt05-catalog-verified.txt`、`opt05-client-generate-after-clear.txt`、`opt05-client-check-final.txt` |
| 依赖边界               | `architecture:deps`                                                                                                                                                                                                                                                                                                                                      | 0；430 modules、1322 dependencies 无违例；`opt05-architecture-deps-current.txt`                             |
| 格式与 diff            | 本阶段末尾 `format:check`、`git diff --check`                                                                                                                                                                                                                                                                                                            | 以 `opt05-record-format-final.txt`、`opt05-record-diff-final.txt` 的最终结果为准                            |

**失败与处置**：保留 `opt05-rule-cache-regression.txt/.json` 的首次集成失败（清理重放再次删除新缓存，退出 1）；补接现有幂等机制后已通过最终回归。新增 API 最初遇到 Zod optional 与 TypeScript exactOptionalPropertyTypes 不一致（退出 2），已规范化范围对象并通过全工作区检查。后续复查补强了损坏 expiry、自定义容器、整页 DOM metadata、实际版本升级及关闭 AI 的空结果；对应最终测试均已通过。

**隔离与后续**：本阶段每条缓存测试都创建并关闭自己的 SQLite/Platform Repository、本地动态端口服务与 `zhiyun-rule-cache-*` 临时目录；Chromium 由 Adapter 自有生命周期管理。隔离启动器回收自身 `zhiyun-runtime-test-*` 数据目录。未读取开发数据库或环境文件、未调用真实模型、未提交/推送/部署。全目标仍为 OPT00 至 OPT11；下一阶段先补充普通 URL 查询参数、结构属性选择器和组合计划的缓存资格用例，修正会误跳过缓存的情况；继续实现经过执行与状态验证的浏览器动作缓存及桌面缓存交互 E2E，再进入 OPT06。

### OPT05 缓存资格补强与专业编辑器 E2E

2026-10-04 继续实施。上阶段 634 个登记文件的当前哈希与 `opt05-rule-cache-source-final.json` 全部一致；本阶段修改规则缓存、分析器和 Playwright Adapter，扩展缓存测试并新增 `desktop/e2e/rule-cache.spec.ts`。OPT05 仍为进行中，没有把单独列表规则的验收扩展为浏览器动作或组合计划已完成。

**实际改动**：

- 修正 `?page=1&limit=1000&q=name` 被当作敏感值、与固定字段名及数值版本碰撞而跳过缓存的问题。常用分页、搜索和排序参数采用明确白名单；其他参数保守保护，包括 `token`、`api_key`、`csrf`、`t` 和 `access_key`。整个 URL 仍只以摘要进入键，认证上下文变化不跨会话复用。敏感值反射检查遍历字符串与对象键，避免把数值版号等固定数值误判为凭据；反射进 selector 的短凭据仍被拒绝。
- CSS 与 XPath 允许经过当前数据验证的结构属性表达式，例如 `[data-testid="price"]` 和 `./span[@data-testid="price"]`。属性名限于 id/class/role/name/type 与四类测试标识，字面量长度和字符受限；页面文本、任意数据属性、表单值及敏感值不能借此持久化。结构指纹也包含这些属性值的摘要。属性变化后先验证旧规则，验证失败才生成并验证新规则；再次执行为零次调用。
- 顶层 JSON 数组使用 `$[*]` 按记录预览，字段路径使用带引号的属性段；当前简单 JSON 路径与字段名资格限制继续生效，没有宣称支持任意过滤表达式。
- 真实 Chromium 夹具复现列表在 400 毫秒后渲染、此前预览为空的问题；分析器现在对已有启发式容器做最多一秒、且不超过请求超时的可选就绪检查。没有匹配时正常继续预览；明确配置的动作仍按原有失败行为处理。第二次动态分析取得当前值并复用规则，Mock 调用为零。此用例证明限定时间内的夹具行为，不保证任意站点自动识别就绪状态。

**逐条验证与实测**：

| 条件               | 当前证据与结果                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公共查询参数       | 本地 HTTP 夹具首次两次实际 Mock 方法调用，后续零次、实际命中一次，预览使用修改后的值；`opt05-eligibility-metrics.json`                                                                                                                 |
| 查询参数隐私       | 五种参数名各自验证重复命中、值改变后 `session_changed`、反射进 selector 被拒绝；假 Token 标记不在实际 SQLite 与 WAL 中                                                                                                                 |
| 结构选择器         | CSS/XPath 首次缓存、重复零次调用；属性值变化导致旧规则验证失败，新候选验证后缓存，再次零次调用；含页面文本的三个有效提取规则仍被拒绝缓存                                                                                               |
| JSON 与动态 DOM    | 顶层数组逐行预览及当前值复用通过；真实 Chromium 延迟列表首次两次调用、后续零次；关闭 AI 的空结果回归继续为零次调用                                                                                                                     |
| 专业编辑器用户路径 | Electron 页面实际显示“缓存已保存”、生成调用 2；重复显示“缓存命中”、累计复用 1、调用 0；手动清理返回 deleted=1、移除提示并保留预览；再分析显示重新保存、调用 2。`opt05-rule-cache-ui-metrics.json` 从通过的原生 Playwright 报告附件提取 |

计数单位仍为 Provider 方法调用；不是传输重试、实际 Token、费用或真实模型准确率。专业编辑器 E2E 不替代默认创建流程、助手或动作缓存的验收。

**命令与退出码**：全部在仓库根目录以 `bun --no-env-file` 执行，测试继续使用现有环境过滤与专属临时数据。

| 检查                | 命令/覆盖                                                                                                                   | 最终结果与 Artifact                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 业务回归            | `desktop/tooling/scripts/test-isolated.ts`，AI 插件、AI Runtime、Browser Runtime、Level2/OpenAPI/Product API/Assistant 集成 | 0；14 个文件、119 条测试通过，其中缓存 50 条；`opt05-eligibility-qualified-final.txt/.json`，31.95 秒                                                               |
| 全工作区类型与 Lint | `run typecheck`、`run lint`                                                                                                 | 均 0；`opt05-eligibility-typecheck-current.txt`、`opt05-eligibility-lint-current.txt`                                                                               |
| E2E 文件静态检查    | Desktop workspace typecheck、针对新 spec 的 ESLint                                                                          | 均 0；`opt05-rule-cache-ui-typecheck-final.txt`、`opt05-rule-cache-ui-lint-final.txt`                                                                               |
| 架构与生成检查      | `architecture:deps`、`architecture:check`、`client:check`                                                                   | 均 0；431 modules、1327 dependencies 无违例；`opt05-eligibility-architecture-deps.txt`、`opt05-eligibility-catalog-check.txt`、`opt05-eligibility-client-check.txt` |
| Electron 缓存 E2E   | `desktop/tooling/scripts/test-e2e-isolated.ts development e2e/rule-cache.spec.ts`                                           | 0；一条真实 Electron 用户路径通过，34.0 秒；`opt05-rule-cache-ui-e2e-final.txt`，附带当前 Desktop 构建通过                                                          |
| 格式与 diff         | `format:check`、`git diff --check`                                                                                          | 均 0；`opt05-eligibility-format-final.txt`、`opt05-eligibility-diff-final.txt`                                                                                      |

**失败与处置**：保留动态页面修复前的真实空预览失败 `opt05-dynamic-preview-before.txt/.json`。第一次新增测试的 usage 回调误返回数字，类型检查退出 2，已改为 void。属性更新后的 Mock 夹具最初仍输出旧 selector，导致候选验证失败；修正夹具后覆盖实际生成新属性规则的行为。E2E 前两次超时的阶段信息不足，第三次定位为标签精确匹配未找到 textarea；取消精确匹配后通过。测试增加首页就绪等待、分阶段记录和定位超时，正常及失败路径均关闭自己的 Electron 并清理专属 Profile；前两次残留目录在确认相关进程不存在后，仅按准确路径清理，证据见对应 `*-cleanup.json`。

**隔离与后续**：未读取开发数据库、环境文件或真实凭据，未调用真实模型、提交、推送或部署。本阶段的最终源文件快照、差量和进程/临时目录检查写入 `opt05-eligibility-source-final.json`、`opt05-eligibility-cleanup.json`。接下来实现经过执行与状态验证的浏览器动作缓存，补齐 detail/pagination 组合计划资格及默认创建流程的缓存反馈，再继续 OPT06 至 OPT11。

### OPT05 浏览器动作缓存、实际采集与默认流程接入

2026-10-04 继续实施。先确认 635 个上阶段登记文件，保留随后动作缓存基础代码的 640 文件快照 `opt05-actions-source-before-runtime.json`；本阶段新增实际 Runtime 采集测试并接入生产采集与草稿。OPT05 仍为进行中，OPT06 至 OPT11 的全部要求继续保留。本节登记已经验证的动作缓存能力，不把列表/详情动作复用等同于完整组合提取规则已通过缓存资格。

**实际改动与边界**：

- 将缓存持久化端口和动作缓存上下文放在 Shared 的类型边界；新增 `004-cache-owners` 加性迁移，为规则与各列表/详情阶段保留父范围摘要。任务或草稿清理一次删除自己的所有阶段，仍使用 generation/CAS，清理期间不能重新写回缓存。原 AI 001、002、003 迁移保持不变；004 只修改既有表，Catalog 不重复声明该表所有权。
- 新增结构化 `semanticGoal`、`expectedState` 和 `ACTION_STATE_INVALID`。动作缓存只保存经过当前执行验证的 selector 数组；动作类型、填表值、目标说明和状态条件来自当前调用，不复制进 payload。键包含任务/规则版本、阶段与 URL、当前认证会话、动作语义、页面结构、采集配置以及 Provider/模型/Prompt/工具版本的摘要。
- 命中时仍执行动作并验证当前状态；页面结构变化时先验证旧动作再重用。缺失 click/press/hover 目标且动作尚未执行时，只有显式授权、已知 Provider 身份、状态条件和调用额度均具备才请求修复。等待、填写和选择不进入修复请求；已经点击但未达到状态时不重放该副作用。旧动作缺少证明条件时确定性执行并报告跳过，不给它伪造缓存资格。
- 修复输入只包含语义目标与有界结构候选，不包含页面正文、DOM、填表值或认证值；候选 selector 必须来自当前页面，`role` 只允许明确语义枚举。每次修复前重新读取 DOM 与当前 Cookie/localStorage，阻止前一步产生的新敏感值进入后续请求，超出指纹上限则停止修复。最终写入前再次检查选择器反射、会话及 Provider 变化。
- 正式 Collection Job 绑定实际执行的规则版本与任务修订；Crawler 的列表及详情阶段接入相同持久端口。配置动作会触发浏览器执行，先完成展开动作再等待记录容器，避免隐藏列表被提前等待阻塞。处理器总时限包含动作和状态验证的时间，并受整次采集时限约束；动作状态失败不进入 Job 自动重试。
- 运行结果保存并验证有界阶段计数、命中/保存/跳过数、修复调用数和枚举原因，恢复序列化也保留这些字段。默认采集草稿以内容指纹作为预览版本；预览记录自身修订递增不会使相同内容每次失效。草稿与正式任务各自拥有范围，清理其中一方不删除另一方的缓存。
- 专业编辑器增加动作缓存状态；默认创建流程增加本次预览的动作缓存摘要及清理入口，运行详情显示对应统计。清理保留已经得到的预览和 Dataset。统计是动作阶段与 Provider 方法调用，未转换成真实 Token、结算费用或真实模型准确率。默认正式采集没有自动模型修复授权；分析入口仍由显式 `useAi` 决定是否允许受控修复。

**逐条验证与实测**：

| 条件                   | 当前证据与结果                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 动作首次修复与重复复用 | 真实 Chromium、SQLite 及实际 Mock Provider 方法：缺失展开目标首次调用 1 次，完成状态验证后保存；关闭并重新打开 Repository 后重复调用 0 次、命中 1 次，取得当前内容。`opt05-actions-runtime-metrics.json`                                    |
| 失效、损坏与清理       | 动作测试覆盖结构变化后验证、规则/模型/Prompt/工具版本/会话/关键配置变化、过期与损坏原因；验证失败不覆盖旧有效缓存，清理 owner 隔离以及进行中的 CAS 均通过。动作 22 条、规则 50 条包含在本阶段回归中                                         |
| 实际任务与详情         | API 创建任务、实际持久队列派发、Chromium 列表与两个详情页、分批写入 Dataset：首次保存 3 个阶段，重复命中 3 个阶段，2 条记录包含更新后的名称和详情，生成独立 Snapshot；实际 Mock 调用均为 0；清理 deleted=3                                  |
| 草稿内容版本与范围     | 实际草稿 API 初次预览保存 3 个阶段；草稿修订递增后重复预览仍命中 3 个阶段；清理草稿 deleted=3，正式任务的 3 个阶段仍在；再预览重新保存并保留 2 条当前样本                                                                                   |
| 动作失败与副作用       | 错误点击产生的实际 HTTP 副作用计数恰为 1；动作诊断为 `ACTION_STATE_INVALID` 并提供修改入口，没有 Job 重试，没有模型调用，旧缓存与当前有效规则版本保留                                                                                       |
| 隐私                   | 实际 SQLite/WAL 扫描验证假填表值、Cookie、Authorization、页面 Token 和正文标记不进入动作缓存；修复输入也不包含它们。新增会话值、超过 1 MiB 的后续页面和伪造 role 三条真实浏览器用例全部通过                                                 |
| 默认流程界面           | 真实 Electron 默认创建流程手工配置 waitFor 动作：第一次保存 1 个阶段，重复命中 1 个阶段，清理 deleted=1 且预览保留，再预览重新保存；各次修复调用为 0。专业编辑器规则生成调用 2 → 0 的 E2E 同时通过；`opt05-actions-runtime-ui-metrics.json` |

`opt05-actions-runtime-metrics.json` 从通过的测试 stdout 提取方法调用与阶段指标，保留夹具版本 `expand-records-v1` 和 `list-detail-actions-v1`。Native Vitest JSON 的 Suite 数包括 describe 分组；实际文件数是 23，不把其 49 个分组写成文件数。

**命令与退出码**：命令均在仓库根目录以 `bun --no-env-file` 执行，测试使用现有过滤环境和专属临时数据；测试文件精确范围保存在执行日志与 JSON 报告。

| 检查                        | 最终结果与 Artifact                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 业务回归                    | `desktop/tooling/scripts/test-isolated.ts`：AI 插件、AI Runtime、Browser/Crawler Runtime、Collection 诊断、Runtime API/Assistant/OpenAPI 与 UI 诊断；0，23 个文件、187 条测试，62.59 秒；`opt05-actions-runtime-qualified-initial.txt/.json` |
| 草稿与恢复回归              | 同一隔离启动器运行 Collection drafts、streaming、browser-rounds；0，3 个文件、74 条通过，208.98 秒；包含真实 Node/Chromium 终止、背压、重复 multiplicity、分页和 Snapshot 保留；`opt05-actions-runtime-collection-regression.txt/.json`      |
| 全工作区类型与 Lint         | `run typecheck`、`run lint` 均 0；`opt05-actions-runtime-typecheck-final.txt`、`opt05-actions-runtime-lint-final.txt`                                                                                                                        |
| 架构与生成一致性            | `architecture:deps` 0，437 modules、1356 dependencies 无违例；`architecture:check` 与 `client:check` 均 0；对应 `opt05-actions-runtime-architecture-deps.txt`、`*-catalog-check.txt`、`*-client-check.txt`                                   |
| Electron spec 静态检查      | 针对最终 spec 的 Desktop workspace typecheck 与 ESLint 均 0；`opt05-actions-runtime-e2e-typecheck-current.txt`、`*-e2e-lint-current.txt`                                                                                                     |
| Desktop 构建与 Electron E2E | 0，2 条真实 Electron 用例通过，分别 33.7 秒与 38.0 秒；当前 Desktop 构建通过，仍有约 591 KB 的图表 chunk 提示；`opt05-actions-runtime-ui-e2e-fourth.txt`、原生 `opt05-actions-runtime-native-report.zip`、`*-ui-metrics.json`                |
| 格式与 diff                 | `format:check` 与 `git diff --check` 均 0，最终文档更新后再次检查；`opt05-actions-runtime-format-current.txt`、`*-diff-current.txt`                                                                                                          |

**失败与处置**：保留动作基础阶段的首次测试失败 `opt05-actions-tests-initial.txt/.json`（13 条失败，结构候选中的 CSS 子元素 `>` 被误拒绝），修正后 `opt05-actions-tests-second.txt/.json` 的 67 条通过；基础类型及 Lint 失败也保留并已修正。本阶段 Catalog/客户端首次生成暴露 004 对既有表的重复所有权声明，已按其他加性迁移使用空 tables 声明并通过检查。类型检查先后发现示例结果 union 缺少缓存字段和 Runtime 测试直接依赖 SQLite 类型，已使用 union 守卫与现有 Repository 端口修正。实际任务用例先后纠正“派发一次即执行指定任务”的错误假设及 Dataset 无序返回的顺序假设；读取具体 Job 状态后继续派发。随后确实复现总超时抢先、导致动作失败被误重试，补足处理时限并把状态失败列为不重试后，真实副作用只发生一次。E2E 初次使用不符合 Playwright 要求的首参数，第二次漏展开专业配置，第三次标签精确匹配未包含 textarea 的当前值；修正为正确展开和非精确标签匹配，第四次两条真实用例通过。对应失败日志全部保留。

**隔离与后续**：每条动作测试自有 `zhiyun-action-cache-*` SQLite/服务/Chromium；实际 Runtime 测试自有 `zhiyun-product-api-test-*` 与 Worker；Electron 用例自有 `zy-cache-e2e-*` Profile，并在成功/失败的 finally 中关闭应用和清理准确目录。最终登记 641 个文件，快照与差量见 `opt05-actions-runtime-source-final.json`、`delta-current.json`。`opt05-actions-runtime-cleanup.json` 记录 6 个自有 Electron Profile 已移除，登记的相关进程与八类临时目录检查为空，夹具端口 45100 空闲；检查没有终止其他进程或删除其他目录。未读取开发数据库或环境文件，未调用真实模型、提交、推送或部署。下一阶段仍须补齐 detail/pagination/discovery 组合提取计划的实际执行与字段质量验证后缓存资格、Stagehand 的状态验证接入，以及默认流程/助手的规则生成缓存反馈；再完整实施 OPT06 的固定评测与成本来源、OPT07 至 OPT11。

## 最终检查记录

以下记录 OPT11 最终实际结果。源码、阶段要求及清理证据已核对；后续相关代码变化需要更新受影响的验收，不继承本轮通过结论。

| 检查组     | 覆盖内容                                                     | 状态 | 证据                                                                                                               |
| ---------- | ------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------ |
| 静态与格式 | Lint、Ruff、Prettier、TypeScript、diff 检查                  | 通过 | `opt11-static-gates.log`、`opt11-post-e2e-types.log`、`opt11-packaged-fixture-checks.json`、最终文档格式/diff 日志 |
| 架构与契约 | 依赖边界、Catalog、Desktop Client、Worker Client、Cloud 契约 | 通过 | `opt11-static-gates.log`                                                                                           |
| 业务测试   | Desktop 隔离测试、Worker pytest、12 项以上 Mock 评测         | 通过 | `opt11-business-gates.log`；125 文件/843 项 TS 与 73 项 pytest；固定评测见 OPT06                                   |
| Cloud 回归 | 专属数据库与 Redis、账户权限、模拟支付积分、服务端分页       | 通过 | `opt11-cloud-tests.log`；18 项工具测试、73 项服务器测试                                                            |
| 构建与依赖 | Desktop/Cloud/Worker 构建、审计、许可证                      | 通过 | `opt11-build.log`、`opt11-worker-package.log`、`opt11-static-gates.log`                                            |
| E2E        | Desktop 本地采集路径、Cloud 模拟业务路径                     | 通过 | `opt11-desktop-e2e.log`：24 项通过、0 跳过；Cloud 3 项通过、1 条件专项跳过，未计作通过                             |
| 恢复与资源 | URL/批次中断恢复、背压、1 万与 10 万条采集测量               | 通过 | 本轮三类真实崩溃恢复、24 组资源采样、原始中断窗口证明、`opt11-final-cleanup.json`                                  |
| 本机安装包 | 未签名包启动、采集与 Dataset、Worker 与分析、退出清理        | 通过 | `opt11-desktop-package-second.log`、`opt11-packaged-smoke.json`；实际包和两个 Profile 清理均通过                   |
| 文档交付   | 产品文档、运行手册、最终差量与范围说明                       | 完成 | README、用户路径、本地验证指南、本执行记录；最终链接/格式/源码差量与逐项核对见末节                                 |

## 范围外待验证事项

这些事项不会因 Mock 或本地夹具通过而改为已验证，也不作为主目标未完成任务。

| 事项                   | 当前状态     | 所需条件                             |
| ---------------------- | ------------ | ------------------------------------ |
| 真实模型效果与实际费用 | 范围外待验证 | 明确选择模型并提供已授权的可用接入   |
| 真实支付、短信与邮件   | 范围外待验证 | 商户与消息服务接入及测试渠道         |
| 签名公证与真实自动更新 | 范围外待验证 | 证书、平台条件、更新源与明确发布授权 |
| 招聘平台实时同步       | 范围外待验证 | 对应平台授权与开放接口               |
| 公网部署与远程 CI      | 范围外待验证 | 对应环境与明确部署或推送授权         |
| 其他系统安装与运行     | 范围外待验证 | 对应操作系统上的真实验证环境         |
| 真实用户可用性结论     | 范围外待验证 | 参与者与实际研究记录                 |

## 最终交付结论

主目标 OPT00 至 OPT11 已完成。交付包括分批采集与准确恢复、本地规则/动作缓存及受控修复、清洗配方、四类分析与冻结溯源/分支、条件监控、Cloud 完整历史分页、职责模块、使用说明、实测报告和当前 macOS arm64 应用包。全部必做检查通过，原有迁移与用户工作区得到保留，自有测试资源已回收。HTTP 资源门槛通过；首屏/图表观测只证明懒加载有效，未证明职责提取带来因果提速或 bundle 缩小。真实模型效果/费用、真实支付消息、签名公证、真实更新、公网/远程 CI、其他系统与用户研究仍按范围外事项管理，EXT01/EXT02 未启动。

### 2026-10-04 OPT05：组合规则的实际采集资格验证

本阶段继续 OPT05，主目标范围仍为 OPT00 至 OPT11。组合规则的缓存资格现在通过实际 `CrawlerRuntime` 预览验证，不再用单页列表的成功推断详情、动作和分页的有效性。OPT05 仍为进行中。

**改动与行为**：

- 单页列表沿用现有提取校验；包含列表动作、详情或分页的计划进入真实 HTTP/Chromium 采集。沿用预览上限：最多 10 条返回记录、12 次请求、30 秒；页码/下一页最多两个页面，加载更多和滚动最多一轮。更低的任务上限仍生效。
- 每个实际提取阶段验证全部声明字段、类型、非空值及警告；最终列表与详情关系必须唯一解析。详情失败、字段缺失、类型错误或多容器匹配均拒绝缓存资格，即使既有错误策略允许保留列表或跳过详情。重名字段也先分别验证两个阶段。
- 分页需要实际执行与数据证据：下一页/页码采集至少两个不同页面且取得新记录，加载更多/滚动比较动作前后的记录样本。仅有按钮、请求成功或无关 DOM 样式变化不能证明分页有效。
- 新增内部瞬时页面验证回调，在实际来源上重新进行隐私检查和结构指纹计算；当前 Cookie/localStorage 只进入摘要及内存检查。回调输入不进入 Crawl metadata、API 或 SQLite。组合缓存键覆盖各列表、详情及分页阶段的结构、URL 摘要、实际浏览器会话、动作语义和分页配置；详情结构变化同样先验证再重用。
- 组合 payload 使用带版本的规则封装，只增加基础摘要；原有单页 payload 保持兼容。规则、基础哈希和 payload 仍受 32 KiB 上限约束，整个流程继续使用现有 generation/CAS。未新增依赖或迁移。
- 验证失败保留旧缓存，只有新候选验证和 CAS 都通过后才覆盖。缓存动作发生状态错误时停止本次生成与重放，返回空预览及验证失败状态，保留旧条目；实际点击副作用验证为一次、Mock 调用为零。验证期间手动清理后不能写回已清理条目，已经通过验证的缓存候选也不再为清理事件重新调用模型。
- 组合资格流程采用确定性动作，没有修复回调；Mock 调用只来自明确的规则生成。详情页面上才出现的敏感标记、填表值和浏览器会话同样参与反射检测。目标描述中嵌入原始 HTML 的候选被拒绝。

**实际夹具与结果**：

| 场景               | 已取得的证据                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两页列表与四个详情 | 首次实际 Mock 方法调用 2 次，得到 4 条完整记录；重新打开 SQLite 后重复调用 0 次，取得更新的名称、详情和数值；真实请求包含第二页及全部四个详情                         |
| 详情结构变化       | 实际详情包裹层变化后验证成功，原因 `structure_changed`、Mock 调用 0 次；再次重复命中；手动清理删除 1 个规则条目，再次生成调用 2 次                                    |
| 详情资格拒绝       | 缺失字段、无效数值、重复详情容器、HTTP 500 四类均拒绝新候选，旧条目完整保留；修复夹具后重新命中且调用 0 次                                                            |
| 分页与动作         | 下一页目标不存在时拒绝资格；实际加载更多产生新记录才保存；只改 DOM 样式时拒绝。列表与详情展开均验证当前状态，未调用动作修复方法                                       |
| 会话与隐私         | 详情 Cookie/localStorage 变化报告 `session_changed` 并重新生成；实际 SQLite/WAL 中不存在假会话和填表值；只出现在详情页的假 Token 反射被拒绝；原始 HTML 目标描述被拒绝 |
| 进行中的变更       | 初次和缓存复用的详情验证期间清理均不能复活条目；验证过程中切换 Provider 不覆盖旧条目；缓存点击产生真实 HTTP 副作用后状态失败只执行一次                                |

**验证记录**：

- 受影响业务回归：根目录执行 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts`，参数覆盖 AI 插件、AI Runtime、Browser/Crawler Runtime、Collection 运行诊断、Runtime 正式动作缓存、Level2、Product API、Assistant、OpenAPI 和 UI 诊断；退出 0，24 个文件、201 条通过，219.93 秒。原生报告 `opt05-composition-qualified-final.txt/.json`。此命令启动后补加 HTML 目标描述拒绝测试，因此其结果不包含这条新增测试。
- 当前缓存专项复验：`rule-cache.test.ts` 与 `rule-cache-composition.test.ts`，使用同一隔离入口及 default/json Reporter；报告 `opt05-composition-cache-current.txt/.json`；退出 0，65 条通过，169.79 秒，其中组合验证 15 条。两次成功测试的用例并集为 202 条，不能把重复复验相加成 266 条。
- 全工作区 `typecheck`、`lint`、`architecture:deps`、`architecture:check`、`client:check` 均退出 0；报告 `opt05-composition-typecheck-final.txt`、`opt05-composition-lint-final.txt`、`opt05-composition-architecture-deps.txt`、`opt05-composition-catalog-check.txt`、`opt05-composition-client-check.txt`。架构检查 438 modules、1368 dependencies，无违例；最后隐私检查与新增测试随后通过全工作区类型/Lint 复验，退出均为 0，报告 `opt05-composition-typecheck-current.txt`、`opt05-composition-lint-current.txt`。格式与 diff 最终结果见下文清理记录。
- 该阶段未修改 UI，未重新运行 Electron E2E 或安装包；上阶段两条 Electron 路径的报告保留，OPT11 仍要求最终完整回归。当前指标来自实际 Mock 方法和本地规则夹具，不作为真实模型准确率、Token 或结算费用。

**中间失败与处置**：首轮两个文件 60 条中 6 条失败，报告 `opt05-composition-tests-initial.txt/.json` 保留。失败涉及结构变化原因被覆盖、旧测试在缺少真实第二页时仍期待缓存、原有清除旧条目的断言，以及详情隐私测试的 5 秒测试时限。修正原因优先级、加入实际第二页及新数据、验证旧条目恢复后命中，并让包含完整采集的测试采用已有 30 秒上限。第二轮 59 条通过、1 条失败，报告 `opt05-composition-tests-second.txt/.json` 保留：当前配置开始分页时，旧单页 payload 被误认为损坏；已按存储计划自身判断封装要求，实际配置变化原因保持正确。新候选不能覆盖旧缓存的断言更严格，未降低采集或缓存验收条件。

**边界与下一步**：组合资格尚需补齐 sitemap 发现、有效单页终止的分页样本、不同分页/JSON 来源的固定证据以及已配置 fill/select 值的可重建缓存表达；生成的填表值继续不进入规则 payload。JSON/内嵌 JSON 分析入口的配置动作执行、Stagehand 的确定性状态与缓存适配、默认流程规则生成缓存反馈仍待处理。随后继续 OPT06 至 OPT11，包含修复提案质量门槛、固定离线评测和最终验收；本节不将这些任务登记为完成。

**改动清单、指标与清理**：本阶段相对 `opt05-composition-source-before.json` 修改 5 个已有文件、新增 `rule-cache-composition.test.ts` 1 个文件，无缺失；共注册 642 个源文件。清单为 `opt05-composition-delta.json`，最终哈希为 `opt05-composition-source-final.json`，实际 Mock 指标及测试去重计数为 `opt05-composition-metrics.json`。原 AI 001（`index.ts`）、002、003 迁移哈希保持不变，报告 `opt05-composition-migration-check.json`。首次清单脚本误用 `001` 文件名前缀定位迁移，断言拒绝继续；确认 001 定义在 `index.ts` 后改为精确路径比较，没有修改迁移。

全部测试命令已退出；两个失败尝试为退出 1，最后两次业务验证为退出 0。测试的 HTTP 服务和临时 SQLite/Crawlee 目录由各自隔离入口关闭、删除。`zhiyun-rule-composition-`、`zhiyun-rule-cache-`、`zhiyun-action-cache-`、`zhiyun-runtime-test-` 四个测试目录前缀盘点为 0，排除检查器祖先进程后的对应进程匹配为 0；仅检查，没有终止其他进程或删除未知资源。报告 `opt05-composition-cleanup.json` 包含已结束的命令句柄及退出码。最终全工作区格式检查和 `git diff --check` 均退出 0，报告 `opt05-composition-format-current.txt`、`opt05-composition-diff-current.txt`。HEAD 与分支仍保持原值，无提交、推送、部署或真实外部调用；范围内剩余工作继续保留。

### 2026-10-04 OPT05：Stagehand 原生动作与本地缓存适配

本阶段继续 OPT05，使用项目已安装的 Stagehand 4.0.2、真实本地 Chromium、Node HTTP 夹具、SQLite 和显式 Mock Provider。主目标仍是 OPT00 至 OPT11；OPT05 继续保持进行中。

**实现与兼容行为**：

- StagehandAdapter 不再要求模型 Key 才能启用。真实 Stagehand 本地浏览器执行 click、fill、select、press、hover、wait、waitFor 和 scroll；动作前置条件与执行后状态通过同一原生标签页上的共享验证器检查。浏览器驱动不被 Mock 替代。
- 利用 Stagehand 公开的本地 CDP 地址与短暂标签页标记绑定观察页，标记在导航前恢复。Playwright 连接用于观察状态、会话和网络策略；动作由 Stagehand 原生 API 执行。fill/select 验证当前值，press 先聚焦再按键，不再附带额外点击。真实输入框点击的 HTTP 副作用为 0，Enter 属性变化验证成功。
- 删除隐式 `stagehand.act` 修复兜底。SDK 的 selfHeal 和远程 cache 均关闭，SDK 模型回调明确拒绝隐式推断。只有调用方传入作用域、Provider 身份与结构化 repair 回调时，现有有界缓存流程才可修复缺失的合格目标；填表和等待目标不进入模型。`maxRepairCalls=0`、`selfHeal=false` 均阻止回调。配置中的 model/apiKey 字段保留为废弃兼容字段，不再转交 SDK；演示入口也不再读取 AI_MODEL/AI_API_KEY。
- 原生动作沿用本地经过验证的 SQLite 缓存、TTL、隐私检查和 generation/CAS。缓存配置摘要加入适配器版本与修复开关，Playwright 条目不能直接算作 Stagehand 命中。结构变化先实际执行和验证；失败不重复副作用，不覆盖已验证旧条目；手动清理竞争不能复活缓存。
- 请求策略按 origin 执行，包含同主机不同端口；敏感 Header 仅注入获准请求。对重定向额外在 CDP 响应阶段检查 Location 和 allowRequest，阻止目的地收到请求之前的跨 origin/策略拒绝跳转；浏览器错误页报告导航失败。新标签页请求也先建立响应检查。真实夹具分别验证跨端口子资源、被拒绝子资源、跨端口服务器跳转，以及同 origin 的获准/拒绝跳转。
- 每次加载创建并删除自己拥有的浏览器 profile。取消时只关闭本次 SDK 浏览器；超时和退出均收尾 CDP 连接及 profile，不操作其他进程。

**当前 SDK 悬停边界**：本机 Stagehand 4.0.2 启动的浏览器确实产生可信鼠标移动/进入事件，但默认 CSS `:hover` 状态未被观察到；同一页使用 Playwright 鼠标移动、激活标签页或设置 viewport 的探针也得到相同结果。没有强制伪造 CSS 状态，也没有放宽共享验证器。成功用例改为明确验证可信 mouseover 触发的属性变化；另一个用例证明发生一次真实 hover 副作用但记录仍不可见时必须拒绝。依赖 CSS 悬停的任务仍须实际达到 expectedState，否则失败且不保存无效结果。相关探针保留为 `opt05-stagehand-hover-probe.txt`、`opt05-stagehand-hover-focus-probe.txt`、`opt05-stagehand-hover-viewport-probe.txt`，三个命令均退出 0。

**实际结果**：

| 场景               | 证据                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生动作与模型边界 | 真实 SDK 探针确认 local Provider、唯一匹配标签页、模型回调次数 0、SDK 推断/Token 指标均为 0；`opt05-stagehand-probe-initial.txt`，退出 0。它是本地原生驱动探针，不是实际模型成本测量。            |
| 缓存复用           | 首次实际 Mock repairBrowserAction 调用 1 次；关闭并重开 SQLite 后再次采集更新内容，调用 0 次、验证命中 1 次；夹具版本 `native-expand-records-v1`。                                                |
| 失效与清理         | 结构变化验证后零调用重用；规则、模型、Prompt、工具 Schema、会话与配置变化按各自原因重新修复；损坏和过期有不同原因；按 owner 清理不影响其他任务，清理竞争不会写回。                                |
| 敏感内容           | 原生 fill/select 使用本次的假值；repair 输入以及实际 SQLite/WAL 均不存在假填表值、选项值、Cookie、认证 Header 和正文标记。缓存 payload 仅保存版本与选择器。                                       |
| 无效动作与取消     | 缓存点击和 hover 在产生一次真实 HTTP 副作用后状态失败，只执行一次；无模型回调重放。取消夹具先证明点击完成，再中断原生 wait，诊断中包含 wait/CANCELED。缺失 fill/select/waitFor 均不推断替换目标。 |

**命令、退出码与计数**：报告位于 `.artifacts/no-credentials-optimization/20261003T054244Z/`。

- 原生缓存测试的首个完整专项报告为 `opt05-stagehand-native-second.txt/.json`。其中 `stagehand-action-cache.test.ts` 的 15 条全部通过；同一命令的驱动文件默认悬停失败，故整个命令退出 1，不能记为整轮通过。
- 最后定向验证使用 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts desktop/packages/browser-runtime/test/stagehand.test.ts desktop/packages/plugins/ai-assistance/test/stagehand-action-cache.test.ts -t 'real local Stagehand adapter|qualifies its native adapter'`，附加 default/json Reporter 与 outputFile；退出 0，驱动 12 条及新增的适配器区别测试 1 条通过，缓存文件其余 15 条跳过，76.07 秒。报告 `opt05-stagehand-driver-final.txt/.json`。此前通过的 15 条缓存测试未修改既有行为；两份报告验证用例并集为 28 条，不把跳过项或重复通过项相加。
- 受影响业务回归使用同一隔离入口，覆盖 AI 插件、AI Runtime、Browser/Crawler Runtime、Collection 运行诊断、Runtime 正式动作缓存、Level2、Product API、Assistant、OpenAPI 和 UI 诊断；通过两个 exclude 参数排除上述原生 SDK 专项文件，避免重复计数；退出 0，24 个文件、202 条通过，221.15 秒。报告 `opt05-stagehand-regression-final.txt/.json`。本阶段已通过的不同用例合计 230 条；后续原生 hover 调整只影响 Stagehand 动作分支，该回归的 Playwright 分支未修改。
- 全工作区 `typecheck` 与 `lint` 退出 0；最后测试调整后再次执行并退出 0，报告 `opt05-stagehand-typecheck-current-final.txt`、`opt05-stagehand-lint-current-final.txt`。`architecture:deps`、`architecture:check`、`client:check` 退出均为 0，对应 `opt05-stagehand-deps-final.txt`、`opt05-stagehand-catalog-final.txt`、`opt05-stagehand-client-final.txt`；架构检查 441 modules、1386 dependencies，无违例。
- 未修改产品 UI、公共契约或迁移，本阶段未重跑 Electron E2E、打包或依赖审计；OPT11 仍要求最终验收。没有新依赖，没有真实模型、通知或公网发布。

**中间失败**：初轮驱动 7 条中 2 条失败，报告 `opt05-stagehand-driver-initial.txt/.json`，退出 1：悬停状态失败、服务器重定向绕过请求路由。增加响应阶段策略后，焦点复验仍退出 1，报告 `opt05-stagehand-driver-focus.txt/.json`：重定向已被阻止，但 SDK 返回的 Chromium 错误页还被当成成功；已增加原生 URL 与 origin 检查。随后完整原生专项为 25 条通过、1 条悬停失败，报告 `opt05-stagehand-native-second.txt/.json`，退出 1；保留这个结果，并用可信事件驱动的明确状态及失败副作用用例完成最终复验，没有将默认 CSS 悬停登记为已修复。

**清单与下一步**：本阶段源文件清单及哈希为 `opt05-stagehand-delta.json`、`opt05-stagehand-source-final.json`；测试去重计数与 Mock 指标为 `opt05-stagehand-metrics.json`，原迁移哈希为 `opt05-stagehand-migration-check.json`，资源盘点与命令退出码为 `opt05-stagehand-cleanup.json`。主目标入口始终为 `docs/product/zhiyun-no-credentials-optimization-plan.md`，本文件只记录执行进度。接下来仍需处理组合规则的 sitemap/单页终止/分页与 JSON 样本、配置动作执行与值表达、默认助手生成规则的缓存反馈，并继续 OPT06 至 OPT11；上述 SDK 默认 CSS 悬停差异仍待调查，不能作为完成证据。

本阶段修改 5 个已有文件：Browser Runtime 的 `index.ts`、`action-execution.ts`、`action-cache.ts`、`stagehand-demo.ts` 及本执行记录；新增 `stagehand-native.ts`、`browser-runtime/test/stagehand.test.ts`、`ai-assistance/test/stagehand-action-cache.test.ts` 3 个源文件。共注册 645 个文件，无缺失；原 AI 001、002、003 迁移保持不变。首次证据汇总脚本仅按文件与测试标题去重，把原规则缓存参数化测试中同名的不同输入合并了 8 项，断言拒绝写入指标。确认其输入确实不同后，以文件、标题和同名出现序号标识具体用例；未修改用例或补造通过结果。

所有本阶段命令均已结束。最终全工作区格式检查与 `git diff --check` 退出 0，报告 `opt05-stagehand-format-final.txt`、`opt05-stagehand-diff-final.txt`。临时 Stagehand profile/cache、规则/动作缓存及 Runtime 测试目录前缀均为 0，对应本阶段进程匹配为 0；这里只盘点，不终止其他进程或清理未知资源。HEAD/分支保持原值，无提交、推送或部署；各检查、失败尝试与资源盘点见上述 JSON 记录。

### 2026-10-04 OPT05：JSON 动作执行、配置值引用与模型样本脱敏

状态仍为进行中。本阶段完成 JSON 分析入口与配置动作缓存的一组增量，没有完成 OPT05 全部条件，也没有提前启动或跳过 OPT06 至 OPT11。主目标输入文件仍是 `docs/product/zhiyun-no-credentials-optimization-plan.md`；目标模式读取该文件执行 OPT00 至 OPT11，本执行记录提供状态与证据，不能替代实施规格。

**已有行为与缺口**：原始 JSON 和脚本内嵌 JSON 在浏览器加载之前返回，因此 forceBrowser、已启用浏览器和配置的填表/点击动作可能被跳过；浏览器响应也可能与先前 HTTP 样本不同。规则缓存此前直接拒绝规则内的 fill/select，不区分用户已提供的配置值与模型自行产生的值。AI 分析还需要在调用 generateSchema/generateRule 之前剔除当前配置和样本中可识别的私密值，并阻止第一轮输出将私密值带入第二轮模型输入。

**实际改动**：

- `analyzer.ts` 先执行 forceBrowser、已启用浏览器或非空的配置动作，再判断当前页面中的 JSON 与内嵌 JSON；保持动作失败和取消向上传播，不在动作失败后偷偷生成规则。原始 JSON 浏览器页面读取当前 `body > pre`，不继续使用早先的 HTTP JSON；内嵌 JSON 读取动作之后的脚本状态。动作缓存状态、实际会话、API Candidates 和 engine 均随结果保留；浏览器已加载时不再重复执行这组分析动作。
- `rule-action-values.ts` 仅为当前配置中类型、选择器和值都相符的 fill/select 建立 list/detail 位置引用。持久 payload 中的值为空，引用只含阶段、动作位置和配置位置；执行时从当前配置恢复真实值。新增 cacheVersion 3，版本 2 和普通规则格式继续用于没有值引用的规则；旧格式中的未投影 fill/select、重复/遗漏/无效引用、非空字面值均拒绝。未知配置值仍 privacy_rejected，不覆盖旧有效条目；配置更改先按 configuration_changed 失效，再重新生成和验证。
- `rule-cache.ts` 的模型样本私密值收集同时检查内嵌 JSON 的 HTML 输入和 JSON 结构，即使没有浏览器会话，也能识别 DOM 中的 data-token/data-secret 等值。`analyzer.ts` 在两个模型调用前清理已知原值及 URI、JSON、HTML 编码表达，再使用现有 HTML sanitizer；候选 Schema 的键和值也必须通过检查。若生成的 Schema 反映认证值，停止第二轮调用。规则缓存 Prompt 版本改为 `rule-analysis-v2-private-samples`，现有条目按提示词版本失效。
- 未修改公共 HTTP 契约、客户端、UI、迁移或依赖。新增测试使用真实本地 Node HTTP、Chromium/Crawlee、临时 SQLite/WAL，并包装实际 MockAiProvider 获取调用统计；没有真实 Provider、Token 或外部通知。

**逐条证据**：

| 场景                   | 实际结果                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内嵌 JSON 动作与双缓存 | 首次实际 Mock 调用 3 次：修复动作 1 次、Schema/Rule 2 次。关闭并重开 SQLite 后，第二次返回更新的记录，规则和动作缓存各命中 1 次，Mock 调用 0 次。两次分析各产生一次真实按钮 HTTP 效果，总计 2 次。                               |
| 原始 JSON 当前页       | 本地服务根据实际 Chromium User-Agent 返回与 HTTP 初样不同的数据；配置 wait 后的预览为浏览器响应，重复分析读取更新内容且 Mock 调用 0 次。forceBrowser 即使没有动作也生效；实际浏览器 Cookie 改变报告 session_changed 并重新生成。 |
| 动作失败与 AI 关闭     | 两类 JSON 的不存在填表目标均失败、模型调用 0、无规则条目；已发生一次按钮 HTTP 效果但 expectedState 失败时，不重放或生成。显式关闭 AI 后，已知动作仍执行并验证，规则能够确定性复用。                                              |
| 配置值引用             | fill/select 首次 Schema/Rule Mock 调用 2 次；重开 SQLite 后，恢复本次配置的 2 个动作，实际 DOM 预览和选项价格正确，命中 1 次且 Mock 调用 0 次。改变填表值按 configuration_changed 重新生成，实际结果使用新值。                   |
| 损坏与保留旧条目       | 人为构造校验和正确的越界配置引用、重复位置、非空缓存字面值和旧版本值 payload，全部报告 corrupt 并安全重新生成。新生成但未获配置提供的值被拒绝；错误 JSON/DOM 规则及反映认证值的 Schema 不替换旧有效条目。                        |
| 隐私边界               | 模型输入与真实 SQLite/WAL 均检查假填表值、选项值、Cookie、Authorization 和页面敏感标记；无浏览器的内嵌 JSON 单独验证 DOM 标记不进入两个模型输入。反映认证值的第一轮 Schema 只产生 1 次调用，第二轮没有执行。                     |

上述次数是实际 Mock 回调与 HTTP 夹具统计；没有测量真实模型准确率、Token 或费用。

**验证命令与退出码**：证据均位于 `.artifacts/no-credentials-optimization/20261003T054244Z/`。

- 专项最终命令为 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts desktop/packages/plugins/ai-assistance/test/json-action-cache.test.ts --reporter=default --reporter=json --outputFile=.artifacts/no-credentials-optimization/20261003T054244Z/opt05-json-tests-final.json`，退出 0，17 项全部通过，22.68 秒；对应 `opt05-json-tests-final.txt/.json`。
- 业务回归采用同一隔离入口，选择上一阶段回归 JSON 中列明的 24 个文件，再加入新专项文件；覆盖 AI 插件、AI/Browser/Crawler Runtime、Collection 运行诊断、正式动作缓存、Level2、Product API、Assistant、OpenAPI 和 UI 诊断。退出 0，25 个文件、219 项通过，241.25 秒；对应 `opt05-json-regression-current.txt/.json`。专项最终复验用于确认测试夹具类型修正后的同一组 17 项，不能再与 219 项相加。
- 全工作区 `bun --no-env-file run typecheck` 最终退出 0，报告 `opt05-json-typecheck-current-final.txt`。此前根 TypeScript 检查退出 0 不能替代各工作区的测试类型检查；完整检查发现的新夹具类型错误已修复，见下述失败记录。
- 全工作区 `bun --no-env-file run lint` 退出 0，报告 `opt05-json-lint-final.txt`；夹具修正后对本阶段 4 个源文件再次 ESLint，退出 0，报告 `opt05-json-lint-current-final.txt`。
- `architecture:deps`、`architecture:check`、`client:check` 全部退出 0，对应 `opt05-json-deps-final.txt`、`opt05-json-catalog-final.txt`、`opt05-json-client-final.txt`。依赖图为 443 modules、1399 dependencies，无违例。
- 本阶段没有产品 UI 或依赖变更，未重跑 Electron E2E、打包和依赖审计；最终交付验收仍须在 OPT11 完成。Stagehand 原生 SDK 分支和专项未修改，上一阶段证据继续保留，不把它们算作本阶段重跑结果。

**中间失败与处置**：首次专项 `opt05-json-tests-initial.txt/.json` 退出 1，16 项中 14 项通过、2 项失败。不存在 fill 目标触发 Playwright 操作超时，现有适配器映射为 NAVIGATION_ERROR，而新测试预期 ACTION_STATE_INVALID；改为检验现有错误码，同时保留模型零调用、无缓存断言及独立的预期状态失败测试，没有改动或放宽动作执行器。另补充无浏览器的 DOM 脱敏用例后，专项 `opt05-json-tests-current.txt/.json` 退出 0，17 项通过。首次完整类型检查 `opt05-json-typecheck-final.txt` 退出 2：Mock 的具体方法把字段名称推断为固定四项，新测试为模拟认证反映而扩大返回类型，不能作为子类重写；改成按 AiProvider 公共契约包装原 Mock，继续统计真实 Mock 回调。最终完整类型检查和专项复验退出均为 0。

**改动与后续**：本阶段修改 `analyzer.ts`、`rule-cache.ts` 和本执行记录，新增 `rule-action-values.ts`、`json-action-cache.test.ts`。源清单、对阶段前后及原始基线的哈希差量、Mock 指标、迁移哈希和资源盘点分别保存为 `opt05-json-source-final.json`、`opt05-json-delta.json`、`opt05-json-metrics.json`、`opt05-json-migration-check.json`、`opt05-json-cleanup.json`。原工作区迁移与未提交改动受到保留，没有重置、批量暂存、提交、推送或部署。

收尾全工作区格式检查与 `git diff --check` 退出均为 0，报告 `opt05-json-format-final.txt`、`opt05-json-diff-final.txt`。注册源文件共 647 个，本阶段修改 3 个已有文件、新增 2 个文件、缺失 0 个；相对原始基线共 96 个改动、74 个新增、缺失 0 个。AI SQLite 的 001 入口及 002、003、004 四份现有迁移哈希全部保持不变。证据盘点第一次错误地预期只有 3 份迁移，断言拒绝；确认已有 004 后修正枚举。第二次盘点把其他项目的 3 个 Vitest 进程误计入本阶段，断言再次拒绝；核实其 cwd 后改为按本项目归属盘点，没有终止其他进程。两个失败脚本退出均为 1，修正后的盘点退出 0，没有改造测试或补造通过结果。

所有本阶段命令均已结束；本项目匹配测试进程为 0，JSON/规则/动作缓存、Runtime 测试及 Stagehand 的临时目录前缀均为 0。其他项目的测试进程只核对归属并保留，详见 `opt05-json-cleanup.json`。

OPT05 下一步仍是 sitemap 资格、有效单页终止、其他分页边界及默认助手生成规则后的缓存反馈；Stagehand 默认 CSS 悬停差异继续按上一节记录调查。配置值引用已覆盖实际 list 动作，detail 位置的 helper 已实现但仍需完整详情链路的专门证据。随后依次执行 OPT06 至 OPT11；本阶段没有将这些未完成任务排除或登记为完成。

### 2026-10-04 OPT05：默认助手缓存反馈与手动设置保护

状态仍为进行中。目标模式继续以 `docs/product/zhiyun-no-credentials-optimization-plan.md` 为实施规格、以本文件为进度依据；本阶段只完成默认助手路径的增量，没有完成 OPT05 或整个主目标。

**实际改动**：

- 默认助手的 `generate_rule` 工具现在传递独立的规则缓存和动作缓存结果。`assistant.ts` 分别按严格 Schema 校验后写入 fields 消息；非法结果被忽略，独立有效的另一个结果仍可保留。消息持久化、HTTP 契约、生成客户端和 UI 同步，旧 fields 消息允许缺省这两个可选字段。
- UI 在历史字段卡片旁显示本次缓存状态、受限枚举中的原因、累计复用数、规则生成调用数和动作修复调用数。反馈取自已保存的消息，不随当前草稿重新计算；没有缓存信息的旧消息不补造统计。新增中文与英文文案，不展示模型费用或将规则生成计数解释为整个对话的模型计数。
- 真正的默认 Runtime 路径复现了既有保存问题：`persistDraft` 每次都发送 schedule/browserSettings/datasetSettings，即使没有修改，也会被手动草稿的 `INVALID_AI_PATCH` 检查拒绝，生成后的字段卡无法出现。现在只在这些设置相对当前规范草稿发生变化时提交它们；普通规则生成可以保存，手动设置保留。助手要求实际修改浏览器或数据写入设置时仍被原检查拒绝，没有放宽 Runtime 守卫。
- 既有缓存结果 Schema 原样移到新增 `shared/src/cache-results.ts`，避免 assistant 模块从聚合入口循环导入；原 `shared/src/validated-cache.ts` 中的缓存接口保持原样。没有新增依赖、迁移或真实 Provider 调用。

**真实 Runtime 与持久化证据**：`runtime/test/assistant.integration.test.ts` 使用本次创建的 Node HTTP 站点、实际 Chromium、真实 Level2 API、助手任务队列、临时 SQLite 和显式 ScriptedChatProvider/Mock 规则生成。各次请求均经过正式助手消息接口，没有直接构造消息代替生产逻辑。

| 场景            | 规则生成 Mock 调用 | 助手脚本化对话调用 | 结果                                                               |
| --------------- | ------------------ | ------------------ | ------------------------------------------------------------------ |
| 首次生成        | 2                  | 2                  | 规则 stored，动作 stored；两类统计独立保存                         |
| 再次生成        | 0                  | 2                  | 规则与动作各 hit；当前页面已更新，仍验证当前内容                   |
| 手动清理后生成  | 2                  | 2                  | 正式 clear API 删除本草稿的两个条目，分别报告 empty 后 stored      |
| 规则缓存损坏后  | 2                  | 2                  | 只修改本测试数据库的一条规则 payload，报告 corrupt；动作仍独立 hit |
| 关闭重开 SQLite | 不追加调用         | 不追加调用         | 四张历史 fields 卡片及其实际缓存结果均恢复                         |

这些是本地 Mock 与脚本化 Provider 的真实回调计数，不是模型准确率、真实 Token 或费用。缓存复用消除了本次规则生成的两个调用；每轮助手对话仍执行两次脚本化调用，因此不能声称整个助手零模型调用。浏览器、请求、网络策略、调度与 Dataset 手动设置在四轮生成后均保持不变。另一个实际 Runtime 用例分别要求关闭浏览器和更改写入方式，两个工具均 `INVALID_AI_PATCH`，规范草稿保持不变、规则 Mock 回调为零。

**UI 证据与边界**：新增 `ui/test/assistant-cache.test.ts` 的三项实际 React 服务端渲染测试覆盖独立缓存状态、原因和计数，拒绝未知/私密/多余元数据，保留独立有效结果，以及旧消息和英文。它们是组件渲染证据。实际 Electron 的 `e2e/desktop.spec.ts` 原有 12 项回归全部通过，覆盖默认助手加载与离线会话恢复、手动采集、动态浏览器、本地假登录及现有其他工作台；本阶段没有新增完整缓存字段卡 Electron 用例，不把组件或 API 测试称为该完整桌面路径。

**验证命令与退出码**：报告位于 `.artifacts/no-credentials-optimization/20261003T054244Z/`。

- 专项使用 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts`，明确选择 `runtime/test/assistant.integration.test.ts`、`plugins/ai-assistance/test/crawler-assistant.integration.test.ts`、`ui/test/assistant-cache.test.ts`（路径均在 `desktop/packages/` 下），附加 default/json Reporter；最终退出 0，3 个文件、14 项通过，3.78 秒，报告 `opt05-assistant-feedback-verified-final.txt/.json`。最终复验针对损坏缓存操作改用 Node 自带 SQLite 的测试修正，不能与前一版同名用例重复累加。
- 业务回归通过原隔离入口执行上一阶段 JSON 回归的 25 个文件，再加入 UI 新测试：退出 0，26 个文件、224 项通过，243.22 秒；`opt05-assistant-regression-final.txt/.json`。最新专项只更新其中同一个 Runtime 用例的损坏分支与计数说明，生产代码未改变；用例并集仍为 224 项。
- 全工作区 `bun --no-env-file run typecheck` 最终退出 0，`opt05-assistant-typecheck-repaired-final.txt`。全工作区 `lint` 退出 0，`opt05-assistant-lint-final.txt`；最新两份测试再次 ESLint 退出 0，`opt05-assistant-lint-repaired-final.txt`。
- `architecture:deps`、`architecture:check`、`client:check` 均退出 0：`opt05-assistant-deps-final.txt`、`opt05-assistant-catalog-final.txt`、`opt05-assistant-client-final.txt`。依赖图 445 modules、1407 dependencies，无违例；客户端已通过正式生成命令更新。
- `bun --no-env-file run desktop:test e2e/desktop.spec.ts` 退出 0，12 项通过，约 1.5 分钟；`opt05-assistant-electron-current.txt`。正式 Desktop 构建同步通过；既有大于 500 KB 的 chunk 提示仍保留，最终性能与打包验收属于后续任务。

**中间失败与处置**：

- `opt05-assistant-runtime-initial.txt/.json` 退出 1：新测试的 If-Match 未加引号，正式草稿 API 返回 428；改用契约接受的引号版本。
- `opt05-assistant-runtime-before-fix.txt/.json` 与 `opt05-assistant-runtime-diagnosed.txt/.json` 均退出 1：实际默认生成无 fields，进一步记录工具错误复现 `INVALID_AI_PATCH`；修复上述保存差量，守卫保持不变。
- 初次移动 Schema 错误地覆盖了已有 `shared/src/validated-cache.ts`，导致 `opt05-assistant-root-typecheck-current.txt` 退出 2。通过只读 Git 自动快照找回该文件的精确原内容，并核实 SHA-256 为 `f735cf7841591929febb3750ed67848a66c49864bb78873e3c4071277f80538c`；另建 cache-results.ts。恢复后根检查退出 0，之后完整工作区检查也通过。此接口文件不计入本阶段改动；没有重置或切换工作区。
- `opt05-assistant-runtime-current.txt/.json` 退出 1：新测试向 clear API 发送了错误的 draftId 属性；改用正式 cacheScope 契约。`opt05-assistant-ui-initial.txt/.json` 退出 1：英文缓存文案原先缺失；补齐真实文案后通过，没有放宽断言。
- `opt05-assistant-electron-final.txt` 退出 1：隔离桌面入口只接受文件名，错误传入的 `--grep` 在启动前被拒绝；改用上述原文件入口，完整 12 项退出 0，没有修改入口来跳过用例。
- 最新 `opt05-assistant-typecheck-current-final.txt` 退出 2：新测试直接导入 better-sqlite3，Runtime 工作区未声明该模块的类型。改用 Node 已有的 `node:sqlite` DatabaseSync，并断言只修改一条测试缓存；未补造类型、屏蔽错误或新增依赖。修正后的类型检查、实际损坏分支与 ESLint 均通过。
- `opt05-assistant-feedback-repaired-final.txt/.json` 退出 0，但错误指定不存在的 canonical-draft 文件导致实际只运行 2 文件、8 项；该结果只能证明这 8 项。随后从原 JSON 报告核实既有 6 项所在的 crawler-assistant 文件，用正确三文件入口再验证，最终计数以 verified-final 报告为准。

**改动清单与后续**：本阶段修改 shared 的 index/assistant、AI 插件的 assistant/crawler-assistant、UI 的 RuleCacheNotice/AssistantWorkspace/product-copy、生成客户端、Runtime 助手测试及本执行记录；新增 cache-results.ts 和 assistant-cache.test.ts。阶段源哈希、差量、Mock 指标、四份迁移核对及资源盘点分别保存为 `opt05-assistant-source-final.json`、`opt05-assistant-delta.json`、`opt05-assistant-metrics.json`、`opt05-assistant-migration-check.json`、`opt05-assistant-cleanup.json`。原目录迁移与未提交改动继续保留；没有暂存、提交、推送、部署、读取真实凭据或使用外部通知。

本阶段登记 649 个源文件，修改 10 个已有文件、新增 2 个、缺失 0 个；原缓存接口及 AI SQLite 四份迁移保持阶段前哈希。报告中的 224 项业务用例与 14 项专项按文件、完整标题及同名出现序号去重，不能相加；原有 Electron 12 项单独登记。资源盘点首次错误地把本聊天的三个 CUA Node 宿主计为测试遗留，断言退出 1；核对可执行文件与父进程后识别为应用支持进程并保留，未终止它们或清理未知资源。清理盘点仅记录本次测试归属与临时目录，不以工作目录相同推断进程可以终止。

相对原始 573 文件基线，本轮累计 100 个已有文件改变、76 个新增、缺失 0 个。最后全工作区 `format:check` 与 `git diff --check` 退出均为 0，报告 `opt05-assistant-format-final.txt`、`opt05-assistant-diff-final.txt`。所有上述测试和检查命令已结束；本项目测试进程与所盘点的测试目录前缀均为 0，应用支持及其他项目进程保留。HEAD 与 main 分支保持原值，未提交、推送或部署。

OPT05 仍需 sitemap 资格、有效单页终止、其他分页边界、detail 配置值引用的完整详情链路证据，以及 Stagehand 默认 CSS 悬停差异的调查。OPT06 至 OPT11 仍属于主目标并保持未完成；本阶段不把这些条件排除或提前登记为完成。

### 2026-10-04 OPT05：分页终止、sitemap 与详情配置值引用

状态仍为进行中。中断前已修改实现与夹具，属于实际进展；续跑先查询原句柄 32322、52904，均已不存在。专项没有生成 JSON、类型日志缺少完整工作区结束结果，进程核查也未找到原检查；这些中断结果不计为通过，退出码未确认。确认停止后使用新命令验证，没有因单次等待超时重复启动。

**实现与证据**：

- Crawler 用存在且明确 disabled/aria-disabled 的下一页控件提供瞬时终止证据，停止向禁用目标排队。浏览器加载更多在初始控件明确禁用时停止，流式游标也在实际禁用时结束。缺失选择器、循环链接、重复数据、隐藏控件或无关 DOM 变化不作为资格证据；点击之后仅禁用按钮却没有新记录，仍被拒绝。未新增公共 API 字段或持久化原始页面。
- sitemap 根据真实 XML 解析、接受的 URL/修改时间与详情结果验证，跳过原本未执行的 CSS 列表提取。发现记录具有实际字段检查，详情继续验证字段与关系；根/子 XML 参与结构和隐私检查。过滤条件有长度与字符约束，loc 中的认证参数参与私密值收集，反映私密值的候选不获资格。
- 默认 sitemap 初次分析直接使用 HTTP XML，避免进入 Chromium XML 查看器：原行为第一次使用查看器 DOM、后续使用原始 XML，因此复用被误标为 structure_changed。当前同一 XML 在 SQLite 重开后稳定报告 hit。显式 forceBrowser、已启用浏览器和配置动作仍按现有入口执行。
- 实际会话指纹按 origin 去重，普通分页数量及 URL 列表不再计入认证会话摘要。新普通分页按结构变化重新验证并零 Mock 复用；真实详情 Cookie/localStorage 改变仍由原业务测试证明 session_changed 后重新生成。
- 工具版本升级为 `crawl-plan-v2-stage-qualification`。旧资格摘要明确按 prompt_changed 失效，避免把实现升级误标为登录变化；原 generation/CAS 和失败保留旧条目规则不变。没有新增依赖或迁移。

| 真实夹具                  | 验证结果                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/Chromium 单页终止    | 原生 disabled 与 aria-disabled 各首次 Mock 2、重复 Mock 0，不请求下一页；恢复可用后验证两页四条记录，structure_changed 且 Mock 0。                                               |
| 分页错误与边界            | 缺失 next、循环链接、重复页面数据和页码模板重复内容拒绝资格并保留旧条目；页码模板新数据、加载更多及实际滚动新记录可以复用，纯样式变化不获资格。                                  |
| 禁用按钮的流式采集        | 三批请求后 terminal 为 false/false/true；本次 786 条全部写入，Append Dataset 连同原有一条共 787 条，原 Snapshot 不变，测试工作区回收。                                           |
| 嵌套 sitemap 与详情       | 根/子 XML、重复 URL、过滤及两页详情实际执行；首次 Mock 2，SQLite 重开后更新详情、Mock 0、两条记录；详情字段失效或发现为空不替换旧条目。                                          |
| 发现记录与隐私            | 没有 CSS 列表匹配仍验证实际发现记录；过滤候选反映子 loc 假认证值时 privacy_rejected，旧条目保留，值未出现在 SQLite/WAL。                                                         |
| 详情 fill/select 配置引用 | 完整列表与两页详情真实执行当前配置，payload 只存两个 detail 位置引用及空值；SQLite 重开后恢复两项动作并使用当前值，配置更改后使用新值。规则 Mock 为 2→0→2，三种假值不在 DB/WAL。 |
| 资格工具版本升级          | 真实 SQLite 的旧 crawl-plan-v1 条目按 prompt_changed 重新生成，实际 Mock 回调为 Schema/Rule 两次，随后新版命中且无 Mock 回调。                                                   |

上述为规则生成的 Mock 与实际 HTTP/浏览器统计，不是整个助手的对话计数、真实准确率、Token 或费用。详情预览的实际输出包含当前填写内容，但不作为缓存 payload 保存。

**检查入口与退出码**：Artifact 位于 `.artifacts/no-credentials-optimization/20261003T054244Z/`。

- 原隔离入口 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts` 选择上一阶段 26 个文件，附加 default/json Reporter：退出 0，234 项通过，299.22 秒，`opt05-discovery-regression-final.txt/.json` 与 `opt05-discovery-regression-exit.json`。组合规则 25 项包含本阶段新增 10 项；原实际会话失效、私密值、失败/CAS 与助手回归继续通过。
- 最后只升级资格版本并新增旧版升级用例，重跑 `plugins/ai-assistance/test/rule-cache.test.ts`：退出 0，51 项通过，9.41 秒，`opt05-discovery-version-final.txt/.json`。与整轮回归重复的用例不相加。
- `plugins/collection/test/browser-rounds.integration.test.ts` 通过同一入口按标题选择禁用终止、游标持久化和原记录上限：退出 0，3 项通过、29 项跳过，3.05 秒，`opt05-discovery-stream-final.txt/.json`。跳过项不计为本阶段通过；上述不同业务用例并集为 238 项、27 个文件。
- 全工作区 typecheck/lint 退出 0，`opt05-discovery-typecheck-final.txt`、`opt05-discovery-lint-final.txt`。最终版本标记与断言调整后，完整 typecheck 再次退出 0，`opt05-discovery-typecheck-current-final.txt`；相关三文件 ESLint 退出 0，`opt05-discovery-lint-current-final.txt`。
- architecture:deps、architecture:check、client:check 均退出 0，分别为 `opt05-discovery-deps-final.txt`、`opt05-discovery-catalog-final.txt`、`opt05-discovery-client-final.txt`；445 modules、1408 dependencies，无违例。公共 HTTP 契约与客户端未改变。
- `bun --no-env-file run desktop:test e2e/rule-cache.spec.ts` 退出 0；最后工具版本改动后再次运行同一入口，退出 0，原有两项通过，约 1.3 分钟，`opt05-discovery-electron-current-final.txt`。正式 Desktop 构建同步通过，既有大 chunk 提示保留。用例验证编辑器的规则 Mock 2→0→2、命中数/原因与手动清理，以及默认草稿的动作缓存和清理；没有新增 sitemap 或详情配置值的整条 Electron 用例，不将 API/浏览器夹具称为这些完整桌面路径。两个 Electron 报告不能重复计数。

**中间失败**：

- 修改实现前焦点验证退出 1，5 失败、19 跳过，`opt05-discovery-tests-before.txt/.json`；旧验证器拒绝明确单页终止与 sitemap。随后完整专项在用户中断时未生成报告，保留 `opt05-discovery-tests-current.txt`，不计通过。
- 续跑焦点退出 1，5 通过、4 失败、15 跳过，`opt05-discovery-focus-current.txt/.json`。单页扩展误报 session_changed/Mock 2，sitemap 第二次为 stored/structure_changed/Mock 0；修正实际会话摘要后，`opt05-discovery-key-focus.txt/.json` 退出 1，2 通过、2 失败、20 跳过，前者已通过而后者仍重现。保留严格 hit 断言，修复首次 XML 来源后，`opt05-discovery-sitemap-focus.txt/.json` 退出 0，2 通过、22 跳过。详情链路 `opt05-discovery-detail-focus.txt/.json` 退出 0，1 通过、24 跳过；随后两组都由上述 234 项回归覆盖。
- 流式专项第一次退出 1，2 通过、1 失败、29 跳过，`opt05-discovery-stream-focus.txt/.json`。实际已终止并写入 786 条，测试错误地忽略原有一条 Append 记录；改为 787 总数并增加原 Snapshot 精确不变断言，没有改动生产写入语义，最终三项通过。

**清单与后续**：修改 Crawler Runtime、AI analyzer/rule-cache、两份 AI 缓存测试、Collection 游标测试及本执行记录，没有新增源文件。阶段清单、差量、Mock 指标、四份迁移核对、资源盘点分别为 `opt05-discovery-source-final.json`、`opt05-discovery-delta.json`、`opt05-discovery-metrics.json`、`opt05-discovery-migration-check.json`、`opt05-discovery-cleanup.json`。下一步仍需调查 Stagehand CSS 悬停差异并核对 OPT05 全部条件；OPT06 至 OPT11 仍在主目标内，没有排除或提前登记为完成。未提交、推送、部署或读取真实凭据。

正常退出的检查与测试均已结束。资源盘点发现中断前遗留两个临时目录：仅在确认其创建时间位于本次中断日志的 00:51:23–00:51:52 UTC 区间、SQLite graph_revision 为本夹具的 composition-fixture、Crawlee 目录布局与隔离入口一致且 lsof 无打开文件之后，按两个完整目录名清理。没有按前缀删除未知资源、终止其他进程或触碰开发数据库；证据为 `opt05-discovery-interrupt-recovery.json`。随后本项目测试目录与进程盘点重新确认，最终格式和差量检查见 cleanup 报告。

最终登记 649 个文件，阶段修改 7 个已有文件、无新增和缺失；相对最初基线仍为 100 个修改、76 个新增、缺失 0。缓存接口原文件及四份 AI SQLite 迁移哈希不变。最终全工作区 format:check、文档格式检查与 git diff --check 退出均为 0，报告 `opt05-discovery-format-final.txt`、`opt05-discovery-doc-format-final.txt`、`opt05-discovery-diff-final.txt`。本阶段所盘点的临时目录与本项目测试进程均为零，45100 测试端口空闲，应用支持和其他项目进程保留；HEAD/main 不变。不同业务用例计数按文件、完整标题与同名出现序号核对为 238，Electron 两项另计。

### 2026-10-04 OPT05：CSS 悬停修正与任务完成核对

本阶段开始时核对 `opt05-discovery-source-final.json` 的 649 个文件，全部一致；保存 `opt05-hover-source-before.json` 后继续实现。本节完成 OPT05 的任务级验收；整个 OPT00 至 OPT11 主目标仍未完成。

**悬停调查与实际修正**：

- 启动参数专项分别尝试默认、enable-automation、移除 disable-features 和仅移除 RenderDocument，四项都产生可信鼠标事件，CSS 控制的记录区实际显示，却仍被裸 `matches(':hover')` 判为 false；四项均无模型调用。`opt05-hover-launch-probe.txt/.json` 退出 0，是诊断证据，不计为修复通过。
- 文档模式专项进一步确认：BackCompat 模式下，裸 `:hover` 为 false，但 `button:hover` 为 true，记录区实际可见；标准模式两种查询均为 true。移开原生鼠标后，两种模式的类型限定查询均变为 false，记录区重新隐藏；模型调用均为 0。证据 `opt05-hover-document-mode-probe.txt/.json`，退出 0。
- 原因符合 [WHATWG 的 :active/:hover 兼容模式规则](https://quirks.spec.whatwg.org/#the-active-and-hover-quirk)。先前“Stagehand CSS 悬停状态不生效”的判断只依据裸伪类查询，证据不足；本次补充实际 CSS 展开与离开状态后，确认是本项目观察校验的误判，不是 SDK 原生输入失效。
- 共享动作执行器改为 `CSS.escape(element.localName) + ':hover'`，仍检验真实悬停状态。没有强制伪类、合成事件、额外点击或放宽状态门槛。新增 Stagehand 两种文档模式的原生 hover → waitFor CSS 记录区、点击副作用为 0；另在普通 Chromium 上分别验证空执行器失败、实际 hover 成功、移开后空执行器再次失败。

**验证与实测**：

| 命令或范围                                                                                                                    | 退出码与实际结果                                                   | 本轮 Artifact                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 原生 CSS 新用例、修正前                                                                                                       | 1；兼容模式失败、标准模式通过，12 项跳过                           | `opt05-hover-before.txt/.json`                                                                |
| 隔离入口：Browser Runtime 两文件、action-cache、stagehand-action-cache、json-action-cache、rule-cache、rule-cache-composition | 0；7 个文件、152 项通过，511.12 秒；包含新增四项状态证明           | `opt05-hover-regression-final.txt/.json`                                                      |
| 状态证明文件专项                                                                                                              | 0；7 项通过，与上述同名用例重叠，不重复计数                        | `opt05-hover-state-proof-final.txt/.json`                                                     |
| 本阶段完整 typecheck、对应 ESLint、依赖边界                                                                                   | 均 0；依赖边界 445 模块、1409 依赖；OPT06 增量后的完整检查见下一节 | `opt05-hover-typecheck-final.txt`、`opt05-hover-lint-final.txt`、`opt05-hover-deps-final.txt` |

当前回归直接报告：HTTP 规则夹具首次 Mock 方法调用 2 次，重开 Repository 后重复调用 0 次、两次实际命中；原生动作夹具首次显式 Mock 修复 1 次，重开 SQLite 后重复调用 0 次、实际命中 1 次。它们是方法调用和命中数，不代表真实 Token、模型准确率或费用下降比例。

**OPT05 逐条核对**：

| 计划要求                                                               | 当前源码与权威证据                                                                                                             | 结论 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 经过验证的结构化规则与浏览器动作持久缓存                               | rule-cache/action-cache、AI 003/004 加性迁移；当前 152 项包含 SQLite 重开、当前数据与原生执行证明                              | 满足 |
| 先确定性执行、失败后受控修复                                           | 显式 repair 授权与调用额度；关闭 AI、零额度、无效状态、副作用不重放均通过                                                      | 满足 |
| 任务/规则版本、结构、动作语义、配置、Provider/模型/Prompt/工具版本入键 | 两类键的摘要构造与版本失效参数化测试；当前 Level2 真实 SQLite 升级 1→2，先 rule_changed/调用 2，再稳定命中/调用 0              | 满足 |
| 区分命中、验证失败、过期、规则变化与手动清理                           | 受限结果 Schema、UI 文案、损坏/TTL/CAS/owner 隔离；真实助手消息持久化和编辑器/默认草稿既有 Electron 证据                       | 满足 |
| 页面结构变化先验证旧规则/动作                                          | 兼容结构改动零调用重验；失效容器与无效候选不覆盖旧缓存，原生动作结构变化重验通过                                               | 满足 |
| 不跨认证会话复用敏感页面内容，不保存整页 DOM                           | 当前会话/配置摘要与瞬时私密值检查；实际 DB/WAL 扫描、短凭据、Token 反射、新会话值、list/detail 配置引用均通过                  | 满足 |
| 首次生成、后续 Mock 零调用；版本按预期失效                             | 当前两类实测调用/命中数；模型、Prompt、工具、规则、会话和配置变化分别覆盖                                                      | 满足 |
| 损坏自动降级且显示原因                                                 | 当前 corrupt payload 回退；默认助手腐败规则重新生成并恢复历史卡片，SSR 显示枚举原因；原两条 Electron 编辑器/默认草稿路径仍适用 | 满足 |
| 填表/Cookie/Token/整页内容不落入缓存，报告真实命中和 Mock 调用         | SQLite/WAL 和受限 payload 断言、配置值绑定；本节指标不混入真实模型费用                                                         | 满足 |
| 已实现的组合与原生路径                                                 | JSON、列表/详情、next/page/loadMore/infinite、sitemap、明确单页终止均在既有或当前有效报告中；CSS 原生状态误判已修正            | 满足 |

机器核对保存为 `opt05-completion-audit.json`，记录 11 个检查项、对应源文件哈希、通过的具体用例和报告；真实版本升级的断言位于 `runtime/test/level2.integration.test.ts` 379–408 行。首次核对器只搜索通用标题“rule version”，未找到嵌在 Level2 综合用例里的断言而拒绝，退出 1；检查实际源码并按真实标题和覆盖范围重新核对后退出 0。失败记录 `opt05-completion-audit-initial.json` 保留，没有把未找到标题解释为实现缺失或补造测试结果。

保留上一阶段 238 个不同业务用例及两项 Electron 证据；本阶段重跑的 152 项与它们部分重叠，不作简单加总。没有新增整条 Electron sitemap/详情配置值场景，不把 API/浏览器夹具称为这些完整桌面路径。OPT05 已完成；OPT06 至 OPT11 仍是主目标必做任务。

### 2026-10-04 OPT06：修复候选与数据质量验证关口

OPT06 进行中。确认已有 BrowserAction 的 `semanticGoal`/`expectedState` 契约、共享页面状态证明和有界动作修复，不重复另建动作执行器。新发现 `AiAssistanceService.testRepairProposal` 原先只判断记录数组非空，缺失字段、类型错误或导航容器也能登记 tested；曾经成功的提案复验失败后仍可能保留旧 testedAt。以下增量修复这些缺口，尚未完成整个 OPT06。

**实际改动**：

- 新增 `application/repair-validation.ts`。候选先通过既有 CrawlPlan 与选择器校验；保留当前字段名/类型及提取值语义、用户动作、列表/详情执行策略、关系、去重和资源上限。允许修复规则选择器和 next/loadMore 控件选择器；新增填表值、任意动作、删字段或把数值改成文本不能通过。浏览器动作目标修复继续使用既有显式有界上下文，模型不能借规则提案修改用户配置。
- 实际预览要求有记录、无提取警告、字段 inspection 有效、容器为内容、详情关系 resolved，并检查最终合并字段的缺失、空白及类型。失败不登记 tested，不激活规则；sitemap URL 输出按其发现字段检验，不按未使用的 CSS 列表字段检验。
- 开始每次复验先在 SQLite 清除旧 testedAt；成功后才重新授予资格。Repository 的同一方法增加兼容的 tested 参数，仅更新 pending 提案。复验失败后 apply 继续拒绝，当前 active version 不变；激活默认绑定读取到的当前版本进行 CAS。没有新增 migration 或更改已有迁移输入。
- Contracts 的内部 CrawlerService 补回已有可选 PreviewInspection 类型，供业务关口读取实际预览证据；HTTP Schema 与生成客户端未改变。AI/Collection 端口、Runtime 注入与 SQLite 同步。

**实际测试范围**：新增 `runtime/test/repair-validation.integration.test.ts`，使用真实 Runtime HTTP API、SQLite Collection Repository、隔离 Worker 与本地动态端口 HTTP，模型为显式 Mock 规则夹具。10 项验证包括布局变化后当前记录和显式激活、缺失字段、空字段、数字错误、导航容器、空结果、删字段、类型降级、注入动作，以及成功后复验失败清除资格。每条失败均核对实际 active version 未变化；非法候选不能落成提案，复验后 testedAt 确实为 null，apply 被拒绝。

| 验证                                                                                                                   | 退出码与结果                                                                                                                         | 本轮 Artifact                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初次隔离 Runtime/Collection 选择                                                                                       | 1；两个旧文件 17 项通过，新文件因错误跨包导入未收集                                                                                  | `opt06-qualification-initial.txt/.json`                                                                                                                     |
| 新 10 项第二次                                                                                                         | 1；1 通过、9 失败；质量错误实际映射 422，测试误预期 409；空结果的 auto 模式浏览器回退导致测试超时                                    | `opt06-qualification-second.txt/.json`                                                                                                                      |
| 修正夹具导入、使用现有 422 语义和 HTTP 模式后：新增文件、Product API、Collection Repository、实际 Assistant 与助手单元 | 0；5 个文件、39 项通过，12.51 秒；原 repair 正常激活和默认助手缓存仍通过                                                             | `opt06-qualification-final.txt/.json`                                                                                                                       |
| Level2、OpenAPI、助手缓存 UI、运行诊断 UI                                                                              | 0；4 个文件、17 项通过；真实规则升级与严格缓存原因展示继续通过                                                                       | `opt06-qualification-contract-final.txt/.json`                                                                                                              |
| 完整 TypeScript                                                                                                        | 初两次 2：业务端口漏了实际 inspection/可选 metadata 类型，随后 exactOptionalPropertyTypes 不匹配；修正内部类型后 0，未放宽运行时验证 | `opt06-qualification-typecheck.txt`、`opt06-qualification-typecheck-final.txt`、`opt06-qualification-typecheck-current.txt`                                 |
| 全库 ESLint、依赖边界、Catalog、生成客户端                                                                             | 均 0；447 模块、1416 依赖；没有未生成的 API 差量                                                                                     | `opt06-qualification-lint-final.txt`、`opt06-qualification-deps-final.txt`、`opt06-qualification-catalog-final.txt`、`opt06-qualification-client-final.txt` |

上述 39 与 17 项为 9 个不同文件、56 个不同业务用例；后续单独复跑 10 项用于提取实际 Mock 方法调用数，不重复计数。原有 152 项缓存/动作回归与这 56 项不存在文件重叠；本阶段当前通过用例并集为 208 项、16 个文件，状态证明专项的 7 项亦不重复计数。源清单、终态、阶段差量、实测指标与隔离资源核对见本阶段 `opt06-qualification-*` Artifact；收尾格式与差量检查结果在最后登记。

**下一步与明确未完成项**：修复提案的模型输入仍需统一去除 current 中的 fill/select 值、等待中的敏感 selector 及原始页面敏感材料；本次 10 个验证关口用例不等同于计划要求的完整固定评测。继续增加分页移动、提示注入、敏感信息与越权工具用例，提供可重复执行、带版本与调用/耗时/缓存指标的评测脚本，完成估算/Mock/实际结算/未知成本面板及上限停止验证，再核对 OPT06 全部要求。OPT07 至 OPT11 未开始，不排除或提前完成。全阶段没有真实 Provider、外部通知、开发库修改、提交、推送或部署。

本阶段收尾：Mock 规则夹具 `repair-quality-v1` 的 10 项专项再次退出 0，实际 `suggestRepair` 方法调用共 10 次，2168 毫秒为该文件测试体时间；不是 10 次真实模型推理或 Token 统计。机器报告 `opt06-qualification-metrics.json` 保存逐例期望结果与耗时、实际调用数和 208/16 去重回归计数；完整评测脚本仍待实施。对应 Vitest 原始报告为 `opt06-qualification-metrics-final.txt/.json`；Runtime 包类型与最后修改文件 ESLint 均退出 0。

全库 `format:check` 与 `git diff --check` 均退出 0，见 `opt06-qualification-format-final.txt`、`opt06-qualification-diff-final.txt`；登记本段后单独复查文档格式/diff，并刷新源快照。最终登记 651 个文件，本阶段修改 10 个已有文件、新增两个文件、缺失 0；相对最初基线 101 个修改、78 个新增、缺失 0。缓存接口原文件及四份 AI SQLite 迁移哈希保持不变。当前所有工具句柄均已终态；所盘点的测试临时目录与本项目测试进程均为 0，45100 端口空闲，原应用支持与其他项目进程保留。证据 `opt06-qualification-source-final.json`、`opt06-qualification-delta.json`、`opt06-qualification-migration-check.json`、`opt06-qualification-cleanup.json`。HEAD/main 不变，未暂存、提交、推送或部署。下一轮从 OPT06 未完成的输入脱敏、完整离线评测与成本信息继续，不重做仍有效的 OPT05 验收。

### 2026-10-04 OPT06：修复输入隐私、固定评测与请求停止边界

本阶段按 `opt06-privacy-source-before.json` 的 651 个文件继续；未改变 OPT00 至 OPT11 的主目标范围。OPT06 仍进行中，成本面板和费用上限用例尚未交付。以下指标仅来自 Mock/规则夹具，不表示真实模型准确率、Token 或结算费用。

**实际改动与隐私边界**：

- 新增 `plugins/ai-assistance/src/application/repair-privacy.ts`，在真实 `createRepairProposal` 服务入口统一投影模型输入。原始来源须在 1 MiB 与扫描节点上限内完成隐私扫描，再生成不超过 200 KB 的结构样本；不能安全完成时在 Provider 调用前拒绝。HTML 移除脚本、文本、注释、表单状态及非结构属性值；JSON 和嵌入的 JSON 赋值使用原有不执行脚本的提取器，只保留字段、数组样本及类型骨架。
- 模型的 current 不包含列表或详情动作。原 fill/select 值、等待选择器中的值、expectedState 属性值、请求认证材料、Cookie、存储状态、URL 私有参数和页面表单/秘密属性仅参与本地脱敏；同时处理 URI、JSON 与 HTML 编码形式，短值按独立词元匹配，避免把字段类型 `number` 中的字符当成秘密。指令、错误和解释有脱敏及长度上限。
- 模型响应先拒绝秘密回显，再检查当前字段与执行策略；只恢复未被模型改写的本地掩码路径，并恢复原用户动作。实际浏览器仍执行 fill/select/wait 与页面状态证明；通过预览不自动激活，显式 apply 仍受版本 CAS 保护。没有修改缓存格式或迁移输入。
- `PiAgentRuntime` 在每次 Provider 方法调用前重新检查取消与截止状态；同时在部分工具批次达到调用上限后终止后续轮次。修正前，嵌套工具超时会再次进入 Provider 方法；现有截止用例增加实际调用数断言，修正后为 1。工具额度为 1 的两动作批次只执行首项、调用 Provider 1 次；第二动作与下一轮均不执行。这是时间/工具调用边界证据，不作为尚未完成的费用上限证据。

**固定评测入口**：

```bash
bun --no-env-file run ai:evaluate
# 可选：指定本轮报告位置；无需凭据
bun --no-env-file run ai:evaluate --output=.artifacts/ai-evaluation/report.json
```

`desktop/tooling/evaluations/rule-repair-cases.ts` 固定 28 项身份与类别，版本 `repair-quality-v2`；`desktop/tooling/scripts/evaluate-rule-repair.ts` 调用既有隔离入口，不继承凭据环境。任何缺失、跳过、重复用例或缺失/非法计数均不能登记为通过。每例记录真实测试方法调用、候选/预览/激活检查次数、缓存请求/命中与耗时；报告保存相关源文件 SHA-256，运行前后变化则拒绝该轮有效性。输出带版本 JSON 和配套日志，默认创建独立 UUID 目录。

22 项真实 Runtime/API/SQLite/Chromium 用例覆盖布局、字段质量、非法规则/动作、提示注入、认证及填表值、未标记的等待状态值、一字符反射、原始/嵌入 JSON、分页按钮移动、旧验证资格失效和缓存当前数据；6 项 Pi 用例覆盖授权/越权工具、取消、嵌套截止和部分批次额度。分页用例实际读取第二页的不同记录；缓存用例首次两个 Mock 生成调用，重复两次读取新数据且没有增加调用；非法动作预览失败后 active version 不变，apply 仍拒绝。

**验证与实测**：

| 验证                                                                   | 退出码与实际结果                                                      | 本轮 Artifact                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 原四项隐私用例、修正前/后                                              | 1：四项均失败；随后 0：14 项通过                                      | `opt06-privacy-before.txt/.json`、`opt06-privacy-current.txt/.json`                                                            |
| 扩展五项的初次验证                                                     | 1：4 通过、1 失败、14 跳过；expectedState 值通过 class 泄露           | `opt06-privacy-extended-before.txt/.json`                                                                                      |
| 扩展修正后的初次全文件                                                 | 1：18 通过、等待夹具超时；空 div 无可见区域，修为有文字的真实可见元素 | `opt06-privacy-extended-final.txt/.json`                                                                                       |
| 增加隔离复位与计数后                                                   | 0：20 项通过                                                          | `opt06-privacy-metrics-current.txt/.json`                                                                                      |
| 截止后调用计数断言、修正前                                             | 1：仍调用 Provider 两次                                               | `opt06-deadline-before.txt/.json`                                                                                              |
| 一字符在多 class 中的反射、修正前                                      | 1：`b utility` 保留了配置值；按词元脱敏后已由固定评测覆盖             | `opt06-short-value-before.txt/.json`                                                                                           |
| 当前固定评测连续两次                                                   | 均 0：28/28 期望通过；源哈希前后及两次之间一致                        | `opt06-evaluation-stable-first.json/.log/.txt`、`opt06-evaluation-stable-repeat.json/.log/.txt`                                |
| 相关回归：Runtime、助手、Repository、Collection 草稿、OpenAPI 与客户端 | 0：10 文件、71 项通过；包含上述 28 项，不重复加总                     | `opt06-privacy-evaluation-regression.txt/.json`                                                                                |
| 完整 typecheck 与对应 ESLint                                           | 最终均 0；第一次类型检查发现 Cheerio 节点需显式缩窄，修正后通过       | `opt06-privacy-typecheck-first.txt`、`opt06-privacy-evaluation-typecheck-final.txt`、`opt06-privacy-evaluation-lint-final.txt` |
| 生成客户端、依赖边界                                                   | 均 0；450 模块、1426 依赖，无违例；HTTP Schema 未变                   | `opt06-privacy-evaluation-client.txt`、`opt06-privacy-evaluation-deps.txt`                                                     |

两次有效固定评测分别耗时 7913 与 9822 毫秒（完整入口墙钟时间，包含进程启动），具体逐例耗时保存在 JSON。两次计数完全一致：候选请求 21，实际预览检查 16，其中通过 8、拒绝 8；候选与预览总检查 37，拒绝 14。报告的修复验证通过率为 8/16=50%，验证拒绝率为 14/37≈37.84%；分母含故意错误用例和失败复验，不能解释为真实模型成功率。缓存 3 次分析中实际命中 2 次，即 66.67%；首次 2 个生成调用、重复 0 个生成调用。Mock 方法总调用 29：规则修复 20、规则分析 2、对话 7。显式激活请求 9，成功 1、拒绝 8。真实模型准确率、真实 Token 和结算费用均为 null。

早期 `opt06-evaluation-first`（27 项）及 `opt06-evaluation-current`（28 项）记录入口开发过程，但尚未加入运行前后源哈希守卫，不用于当前稳定源码证明。费用上限覆盖在当前报告中明确标为 pending；已有工具/截止限额不能替代金额上限。下一步实现成本来源、未知/未结算显示和预估金额上限，将金额停止场景纳入固定评测，再逐条核对 OPT06；随后继续 OPT07 至 OPT11。

本阶段收尾：完整 `format:check`、依赖边界复查及 `git diff --check` 均退出 0，见 `opt06-privacy-evaluation-format-final.txt`、`opt06-privacy-evaluation-deps-final.txt`、`opt06-privacy-evaluation-diff-final.txt`。当前源清单 654 个文件，本阶段修改 6 个已有文件、新增 3 个文件、缺失 0；详见 `opt06-privacy-evaluation-source-final.json` 与 `opt06-privacy-evaluation-delta.json`。原缓存接口及四份 AI SQLite 迁移哈希不变，证据 `opt06-privacy-evaluation-migration-check.json`。本阶段 22 个执行句柄均已终态；14 类临时目录计数均为 0，45100 端口空闲，没有本阶段测试进程残留。工作区 cwd 的原有 node 进程 51910 经可执行路径确认是 ChatGPT 的 `cua_node` 支持服务，保持运行；其他原支持进程亦保留。清理仅由隔离入口回收其自行创建的目录；未终止未知进程或清理共享资源。资源证据 `opt06-privacy-evaluation-cleanup.json`。HEAD/main 不变，未暂存、提交、推送、部署或读取真实凭据。

### 2026-10-04 OPT06：成本来源、跨队列额度与任务验收完成

OPT06 已完成，主目标 OPT00 至 OPT11 尚未完成。前阶段的语义动作状态证明、候选和实际记录质量关口、显式版本激活、输入脱敏继续适用。本阶段补齐费用信息、额度停止与当前回归证据，任务级核对为 `opt06-completion-audit.json`。

**实现与边界**：

- 共享契约增加可选 `costBudget`、结构化 accounting 和来源元数据。保留旧回复字段兼容性，费用面板对旧零占位、离线引导、缺失 Provider 用量显示“未知 / 未结算”。Mock、估算和服务方提供的结算分别显示，保留 CNY/USD 币种；混合 Token 来源明确标记。没有引入模型价格表、换汇或把 Token 推算成账单。
- 每轮核算通过本地异步上下文覆盖聊天及 Schema/规则生成、提取、解释和动作修复。独立 browser-heavy 队列恢复父轮上下文，不能另开额度；结束后的任务和脱离父轮的异步工作拒绝调用。并发轮隔离、失败后释放及脱离范围的工作由三个生命周期用例验证。
- 指定估价后，先为下一次 Provider 方法调用预留额度。达到上限或无法覆盖下一次调用时停止后续模型和工具；没有可用估价的真实 Provider 在首次请求前停止。上限是给定估价下的追加调用控制，不保证真实账单上限，单次方法内的 HTTP 重试不单独计价。
- 增加 `005-cost-accounting`，仅向 `ai_turns` 添加预算和核算列，保持原四份 AI SQLite 迁移及缓存接口文件哈希不变。HTTP 输入、生成客户端、服务、新旧助手和 UI 同步；失败保存已发生的调用，重试继承预算，为新 UUID 的一轮独立核算。
- 队列夹具初次揭示真实缺陷：第二次生成被预算拒绝后，分析器把异常当作普通 Provider 错误，仍保存确定性回退草稿。增加专门的预算停止异常，在普通分析与内嵌 JSON 回退中继续抛出。HTML、JSON、内嵌 JSON 均证明停止时只有 chat 1 次和 generateSchema 1 次，generateRule 未执行，草稿仍为 null、无操作卡、工具记录失败。
- 桌面预算表单支持上限、每次估价与币种；币种具有明确可访问名称。面板在未核算的离线回复中也显示保存的上限，估算仍为未知。实际窄屏截图发现通用 notice 的横向布局挤压内容，改为该费用面板的纵向布局；已复验可见且无横向溢出。用法补充在 `docs/product/assistant-acceptance.md`。

**评测与实测指标**：固定夹具升级为 `repair-quality-v3`，44 个期望覆盖 22 个实际修复/质量/隐私场景、12 个 Agent 场景、6 个 HTTP/队列场景、4 个费用 UI 场景。执行命令为：

```sh
bun --no-env-file run ai:evaluate --output=.artifacts/no-credentials-optimization/20261003T054244Z/opt06-cost-evaluation-final.json
bun --no-env-file run ai:evaluate --output=.artifacts/no-credentials-optimization/20261003T054244Z/opt06-cost-evaluation-repeat.json
bun --no-env-file run desktop:test e2e/assistant-cost.spec.ts
```

两次评测退出码均 0，44/44，源哈希完全相同且各次执行期间稳定，耗时 13.127 秒与 11.629 秒。实际 Provider 方法调用均 44：修复 20、规则分析 2、Agent 及队列 22。实际修复预览 16 次，8 次通过、8 次拒绝；候选与预览检查合计 37 次、拒绝 14 次；缓存夹具 3 次请求、2 次命中；激活请求 9 次、成功 1 次、拒绝 8 次。这些分母含故意失败与复验样本，是 **Mock/规则夹具** 指标，不能作为真实模型准确率或成本下降比例。真实模型 Token、实际费用和准确率均未测量；“实际结算”展示使用显式元数据夹具验证。

| 验证                                                                        | 当前结果与退出码                                                                                                                                                                                                       | Artifact                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 相关完整回归：全部 AI 插件、AI Runtime、实际助手/修复 Runtime、费用/缓存 UI | 18 文件、227 个不同用例。初次 226 通过、1 失败；失败是新增测试把新轮重试误预期为 attempt 2，现有契约为新 UUID、attempt 1。修正后两次整文件评测各 49 项通过、退出 0，覆盖该文件全部 11 项及其他三个评测文件；重叠不加总 | `opt06-cost-regression.txt/.json`、两次 `opt06-cost-evaluation-*.json/.log`                          |
| 独立队列预算停止                                                            | HTML/JSON/内嵌 JSON 三项均通过；每项真实方法调用 2、停止后无 generateRule、无回退草稿和操作卡                                                                                                                          | `opt06-cost-queued-fixed.txt/.json`、最终两次评测                                                    |
| 核算生命周期与 HTTP 失败/重试                                               | 并发额度隔离、scope 释放、脱离父轮调用拒绝均通过；HTTP 失败保存、预算继承和新轮独立核算通过                                                                                                                            | 回归报告中的 `cost-accounting.test.ts` 3 项和固定 `cost-failed-retry`                                |
| Electron 表单、历史及费用显示                                               | 1 项通过，退出 0；真实客户端预算载荷、SQLite 历史、两种语言、360px 可见面板和无溢出；测试体约 35 秒                                                                                                                    | `opt06-cost-desktop-layout.txt`、`opt06-cost-desktop-en-360.png`                                     |
| 原生 Stagehand                                                              | 参数化展开后 16 项通过，包含零调用复用、失效、隐私和真实副作用状态失败；未调用内建模型                                                                                                                                 | `opt06-cost-regression.json`                                                                         |
| TypeScript / ESLint / 格式                                                  | 根及全部工作区 TypeScript、全库 ESLint、格式退出 0；文档登记后复查在下文收尾                                                                                                                                           | `opt06-cost-typecheck-current.txt`、`opt06-cost-lint-verified.txt`、`opt06-cost-format-verified.txt` |
| 依赖 / Catalog / 生成客户端                                                 | 退出均 0；457 模块、1446 依赖，无违规                                                                                                                                                                                  | `opt06-cost-deps-final.txt`、`opt06-cost-catalog-final.txt`、`opt06-cost-client-final.txt`           |

**OPT06 逐条验收**：

| 计划要求                                       | 权威证据                                                                              | 结论 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | ---- |
| 语义目标、预期状态与实际状态验证               | 严格 BrowserAction Schema、共享执行器、当前浏览器状态与原生 Stagehand 16 项           | 满足 |
| 候选 Schema 和真实记录质量；失败不激活         | 固定缺失/空/数值错误/导航/空结果/字段删改/非法动作用例，直接核对提案与 active version | 满足 |
| 显式新版本、失败保留旧规则、复验撤回资格       | 布局正常激活及 failed-retest；SQLite testedAt 清除和 active version/CAS 断言          | 满足 |
| 不发送敏感填表与等待值；注入不能激活           | 当前 Provider 入参、结构骨架、编码形式、短值、反射/超限与本地恢复夹具                 | 满足 |
| 至少 12 个固定离线用例覆盖六类问题             | 当前 44 项，含布局、分页移动、字段缺失、无效动作、提示注入、敏感信息                  | 满足 |
| 调用、耗时、验证与缓存指标；版本化可重复报告   | 两次 44/44，源哈希相同且稳定，机器报告保留逐例 metrics                                | 满足 |
| 越权工具拒绝，取消与额度停止后无追加调用       | Agent allowlist/破坏性工具/次数/截止/取消；真实调用计数                               | 满足 |
| 费用来源、币种及未知值准确显示                 | Mock、缺失 SSE、显式结算夹具、混合来源和四项 UI，实际 Electron 历史                   | 满足 |
| 上限覆盖嵌套与独立队列，预算中断不能写回退草稿 | HTML、JSON、内嵌 JSON 的 chat1/schema1/rule0；草稿 null、无卡片、工具失败             | 满足 |
| 重开、失败与重试的预算/核算持久性              | 真实 SQLite 重开和 HTTP 失败重试、三个范围生命周期用例；加性 005                      | 满足 |
| 真实模型结果不混入本地指标                     | 各报告标题与 null 外部指标、隔离环境与 Mock/内存 Provider 响应                        | 满足 |
| 文档、契约与生成产物一致                       | 用法文档、共享/API/客户端、Catalog 检查、当前桌面专项与逐项机器核对                   | 满足 |

中间失败保留：初版两个 Pi 预算测试在实现前失败；SSE 测试缺少新来源元数据、手工 browser-handler 用例缺少真实父轮核算范围，修正测试后通过；最初 v3 评测 39/40 因上述预算回退缺陷退出 1，修复后 42/42，再增加离线预算和失败重试达到 44/44。测试本身的参数化字符串引号、同步拒绝断言、HTTP 重试 200 与新轮 attempt 1、桌面 API 桥接方式按实际契约修正，没有放宽业务断言或停止后草稿保护。任务审计首次误把 8 个单独 it 声明当作全部 Stagehand 用例，实际参数化展开为 16 项；核对器拒绝后按真实报告修正，记录 `opt06-completion-audit-initial.json`。任务完成只依据修正后逐条证据，不把初次失败改写为通过。

**本阶段收尾**：最终格式与 `git diff --check` 退出均 0，证据 `opt06-cost-format-final.txt`、`opt06-cost-diff-final.txt`。源登记共 660 文件，本阶段修改 27 个已有文件、新增 6 个、缺失 0，清单/哈希为 `opt06-cost-delta.json`、`opt06-cost-source-final.json`。原缓存接口与 AI 001–004 四份迁移文件未变，`opt06-cost-migration-check.json`；新迁移只有 005。任务审计有 12 个满足项，未把整个主目标登记完成。

本阶段及前一段成本实现的全部执行句柄已终态，退出码登记于 `opt06-cost-cleanup.json`。五个自有 Electron Profile 已移除，12 类临时目录检查为空；45100 空闲。按实际可执行路径和 cwd 盘点，本项目测试进程为零；工作区 cwd 的 ChatGPT 支持进程 51907、51910、51979 保留，其他应用支持与项目进程亦未终止。HEAD/main 保持原值；没有暂存、提交、推送、发布、部署、开发库修改或真实凭据读取。隔离入口只回收自建资源。

### 2026-10-04 OPT07 开始：现有能力与增量确认

OPT07 进行中，尚无清洗能力完成声明。已读取 Dataset 契约/服务、DatasetPage、Analytics Recipe 契约和 Worker normalization/models/methods。现有 Snapshot 使用一致读取、NDJSON 分批写入、指纹和 Parquet 物化，继续保留源数据不可变。当前 normalization 是物理类型推断；AnalysisRecipe 保存单一方法与参数，没有可复用的有序清洗步骤、逐步输入/输出 Snapshot 与版本记录。DatasetPage 已有字段、筛选、导出与分析入口，仍需增加清洗预览、Facet/质量和错误行反馈，以及配方复用、撤销/重做。

下一步在现有 Dataset/Worker 类型化边界内补齐六类操作：去首尾空白、空值归一、数字/日期转换、拆分、合并、按字段去重。逐项核对确定夹具、兼容 Snapshot 复用、类型错误、源 Snapshot 不变和契约生成。继续使用受限参数，不开放任意公式、Python 或 SQL。OPT08 至 OPT11 仍未开始，没有缩减主目标范围。

### 2026-10-04 OPT07 Worker 与持久化基础

**状态**：进行中。以下证明计算与存储边界，尚未证明桌面用户能够完成清洗流程，也不表示 OPT07 或主目标完成。继续沿用运行编号 `20261003T054244Z`、原 HEAD/main 和隔离夹具。

**实际改动**：

- Worker 新增内部方法 `dataset.clean_snapshot@1.0.0`，仅接受 trim、normalize_null、number/date convert、split、merge、dedupe 的判别联合参数；未知字段、任意公式、Python/SQL 步骤在提交前拒绝。数值转换拒绝非有限值和不安全大整数；转换错误按 fail/null 策略拒绝整个执行或置空，并记录错误行、字段和原因。
- 使用原不可变 Parquet 与校验和 Manifest 输入。静态校验完整步骤的字段/类型，再逐步生成独立 Parquet/Manifest；每步保留父指纹、顺序、参数、前后预览、质量、错误与删除计数。去重用本地 SQLite 索引跨批次保留第一条记录及其来源。失败、取消、资源超限或 SQLite 初始化失败只移除本次创建的输出目录。Worker Job 拒绝把结果 JSON 写到输入 Parquet/Manifest 的实际路径，包括符号链接别名。
- Facet 统计范围明确为前 50 种不同值，额外次数、未展示的已追踪次数和文本截断分别标记；预览最多 100 行、每行 25 个字段、文本 500 字符。报告上限 16 MiB；零步骤的质量查询同样受限。规范化后的字符串无法证明原始 JSON/文本来源，派生 Manifest 的两个来源计数为 null，不伪填零。
- 共享 Zod 与 Pydantic 参数/输出通过实际 Worker 夹具对照。长度限制统一按 Unicode 字符计算，严格要求 64 位指纹；新增命名生成客户端类型，并更新 Worker OpenAPI。
- Dataset 新增 `004-cleaning`，保存配方与不可变版本、逐步派生 Snapshot、输入/输出关联、报告 Artifact ID、当前选择与修订号。选择步骤 0 返回原 Snapshot，重做选择已有输出，不改原记录或已存 Snapshot。配方保存与选择均拒绝过期修订号；结果发布在同一事务内，校验步骤数量、指纹和各类操作的行数约束。原始记录列表统计只取采集 Run Snapshot，避免派生清洗结果覆盖采集统计。

**源码入口**：`desktop/analytics-worker/src/zhiyun_analytics_worker/cleaning.py`、`models.py`、`jobs.py`、`methods.py`；`desktop/packages/shared/src/cleaning.ts`；`desktop/packages/plugins/datasets/src/contracts/cleaning.ts`、`persistence/sqlite/cleaning.ts`、`migrations/sqlite/004-cleaning.ts`。Datasets 声明已有 Zod 的直接依赖，锁文件与本地链接已同步，安装跳过脚本；没有增加新的第三方库种类。

**验收证据与范围**：

| 检查               | 当前结果与证据                                                                                                                     | 能证明的范围                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Worker 全套        | `uv run pytest --junitxml=<Artifact>/opt07-worker-verified.xml`，退出 0；69 项通过，见 `opt07-worker-verified.log`                 | 六类确定结果、兼容第二个输入的配方复用、类型错误、源文件不变、取消/失败/资源清理、校验和与 HTTP 路径保护；包含原有 Worker 回归           |
| Dataset/客户端回归 | 隔离 Vitest 7 文件 25 项通过，退出 0；`opt07-datasets-verified.json/.log`                                                          | 真实 Worker 与现有 Snapshot 服务/客户端、批次与仓库回归；跨语言执行 7 项 `cleaning-quality-v1` 金样及 35 组参数边界                      |
| 当前持久化补充     | 隔离 Vitest `cleaning.repository.test.ts` 4 项，退出 0；`opt07-cleaning-repository-final.json/.log`                                | 版本不被覆盖、重开后持久化、逐步父关联、选择式撤销/重做、过期修订拒绝、原 Snapshot/记录/采集统计不变、第二步写入失败全事务回滚与行数约束 |
| 类型与 Lint        | `bun --no-env-file run typecheck`、`lint`，退出均 0；`opt07-typecheck-current.log`、`opt07-lint-current.log`                       | 根项目及全部 workspace 类型；全仓 TypeScript Lint                                                                                        |
| Python 规范        | `uv run ruff check src tests`、`ruff format --check src tests`，退出均 0                                                           | 19 个 Python 文件格式及当前源/测试静态检查                                                                                               |
| 生成契约/架构      | `worker:client:check`、`client:check`、`architecture:check`，退出均 0；各 `opt07-*-check.log` 与 `opt07-architecture-verified.log` | Worker 生成契约、已有 HTTP 客户端一致；新增迁移已登记且架构目录已生成                                                                    |
| 依赖边界           | `architecture:deps`，退出 0；`opt07-architecture-deps.log`                                                                         | 464 模块、1466 依赖，无跨边界违规                                                                                                        |
| 桌面构建           | `desktop:build`，退出 0；`opt07-desktop-build.log`                                                                                 | 新模块和共享导出能打包；仍有原有大 chunk 提示，未声称性能改善                                                                            |

Vitest 完整入口为 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts desktop/packages/plugins/datasets/test desktop/packages/capabilities/analytics-worker-client/test --reporter=default --reporter=json --outputFile=<Artifact>/opt07-datasets-verified.json`；持久化补充仅选 `cleaning.repository.test.ts`。Artifact 根目录同执行上下文。25 项与补充 4 项存在重叠，不相加计为 29。SQLite 单元测试使用 Artifact 标识夹具；真实 Worker 结果和 SQLite 发布尚未连成清洗服务链，不能据此声称真实 Artifact 发布或端到端撤销已验收。

**失败与修复**：保留 `opt07-contract-first` 的 Unicode 差异失败；修正两个解析器的长度语义后通过。第一次持久化测试缺本地 Zod 链接，完成 frozen-lockfile 安装后运行；第二次发现原始记录统计被派生 Snapshot 影响，修正统计查询后通过。相关失败仍保留在 `opt07-datasets-first`、`opt07-cleaning-repository-second`；原架构目录过期检查也保留，生成后重查通过。Python 全套的一项 statsmodels 时间频率推断警告来自既有 ARIMA 测试，不是清洗失败。

**源保护**：`opt07-foundation-migrations.json` 证明 Dataset 001–003 SQL 内容与本阶段基线相同，原缓存接口和 AI 001–004 迁移未变。源码与差量继续登记为 `opt07-foundation-source-final.json`、`opt07-foundation-delta.json`；当前代码检查前的登记为 `opt07-foundation-source-before-gates.json`。文档更新后的全仓格式与 `git diff --check` 退出均 0，见 `opt07-format-final.log`、`opt07-diff-final.log`。

**明确未完成与下一步**：实现 Dataset 清洗服务，把实际 Worker 每步结果复制发布到 ArtifactStore 并原子保存历史；补充 HTTP、生成客户端、Runtime 生命周期与权限；接入桌面操作表单、Facet/质量、前后预览、错误计数、配方版本复用和撤销/重做。再用真实本地 Artifact/Worker/SQLite/桌面证明六类操作完整路径、第二个 Snapshot 复用、类型错误与源内容不变。OPT08–OPT11 仍待完整实施，EXT01/EXT02 与真实 Provider、通知渠道、签名及发布范围不变。

**本阶段清理与核对**：`opt07-foundation-progress-audit.json` 明确 `opt07Complete=false`、`goalComplete=false`，保留上述待完成项。当前登记 670 文件，修改 15 个、新增 10 个、缺失 0；代码在最终检查期间保持一致，后续只更新本执行记录。`opt07-foundation-cleanup.json` 登记的执行句柄均已终态，五类独立临时目录计数为零，没有遗留项目测试进程；pytest 自管的系统临时夹具保留，没有清理共享临时根目录。进程盘点排除本次 lsof 探针；初次盘点中的 54261 已退出，未终止任何进程。ChatGPT 支持进程 51907、51910、51979 保留。HEAD/main 未变，没有暂存、提交、推送、发布、部署、开发库改动或真实凭据读取。

### 2026-10-04 OPT07：真实清洗服务、接口与桌面验收完成

**状态**：OPT07 已完成，主目标仍未完成。10 项逐条核对为 `opt07-completion-audit.json`，不能把本任务通过解释为 OPT08–OPT11 已验收。上一轮仅回答目标文件位置，没有推进实施；本轮重新读取计划、执行记录和当前源码，并从 Runtime 导入问题继续工作。

**实现**：

- `DatasetCleaningService` 把实际 Worker 输出连到 ArtifactStore 与同一 SQLite 连接上的清洗仓库。复制前验证输入 Artifact 所属插件、类型及数据集；校验报告的父指纹、行数、步骤顺序与参数。每步发布 Parquet/Manifest，报告引用改写为真实 Artifact ID；最终一次事务保存逐步 Snapshot 与历史。保存报告读取前核对 SHA256。
- 发布失败只移除本次生成的 descriptor 和独立 UUID 文件目录。平台增加按所有者删除 Artifact 的能力，并有实际 SQLite 测试。预览不发布 Snapshot；停止时取消 Worker 并确认终态，再回收工作区。无法确认终态时保留工作区，避免与仍运行的 Worker 争用；Runtime 在关闭 HTTP 服务前停止清洗，现有资源所有权与关闭顺序保持可验证。
- 新增 8 个类型化 HTTP 接口、命名 OpenAPI Schema 与生成客户端，覆盖预览、配方保存/列表/版本读取、应用/历史列表/读取和步骤选择。写接口要求幂等键，校验归一化请求哈希；成功重放、冲突、缺少键、失败释放与 CAS 过期都有证据。读/预览为 `workspace.read`，保存、应用、选择为 `task.write`；真实 Runtime 会话与未认证拒绝已验证。
- Dataset 页面接入七个操作选项（数字/日期同属转换类）、有序增删/移动、字面字段选择与受限参数、输入质量、Facet 范围说明、逐步前后预览、错误计数、版本保存/复用和历史。每步参数可展开查看；修改配方保存新版本，旧历史保留不可变版本。输入不兼容显示检查版本/步骤的中文或英文提示及具体 Worker 原因。
- 撤销/重做切换已经保存的 Snapshot；历史选中的版本传入“开始分析”，报告查看步骤独立于持久选择。新建输入后刷新原始采集表，避免停留在页上时仍显示旧记录。350px 左右的实际窄窗口展示保留表格内部滚动，页面无横向溢出。用法已补充到 `docs/product/user-journeys.md`。

**验证**：Artifact 根目录仍为 `.artifacts/no-credentials-optimization/20261003T054244Z/`。

| 验证               | 结果 / 退出码                                                      | 证据与范围                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实际服务与相关回归 | 14 文件、71 项通过 / 0                                             | `opt07-service-ui-regression-final.json/.log`：全部 Dataset、Worker 客户端、SQLite 平台、Runtime 清洗/OpenAPI/Level2、客户端与清洗 UI。7 组金样均读取已发布 Parquet 对照完整输出；包含旧版本在第二 Dataset 复用、实际中间版本、失败清理、停止、校验和与幂等边界         |
| Electron 完整流程  | 1 项通过 / 0；测试体 36.8 秒，入口报告 37.4 秒                     | `opt07-cleaning-desktop-ui-final.log`：本地 JSON 采集 → 七步表单 → 预览/错误行 → 保存/应用 → 7 次撤销与 7 次重做 → 分析版本链接 → 页面重载 → 第二个兼容输入复用 → 类型不兼容拒绝；原 Parquet/Manifest 哈希与记录保持不变，360px 视口无页面溢出，两种语言可用            |
| Worker 与跨语言    | 原 69 项 Worker 全套证据仍有效；当前 TS 回归包含跨语言对照         | `opt07-worker-verified.xml/.log`；37 份受保护源/契约/迁移哈希全部相同，含 Worker 全部已登记文件；当前仍执行 7 组金样与 35 组参数边界。69 与 71 属不同测试范围，不相加或当作全仓回归                                                                                     |
| 静态检查           | 全仓 typecheck、lint、format、架构目录、HTTP/Worker 客户端检查均 0 | `opt07-service-ui-*-final.log`。随后仅补充 UI 对 `METHOD_INCOMPATIBLE` 的说明和对应 E2E 断言，受影响 UI/Desktop 类型、两文件 Lint、全仓格式和实际 Electron 再通过；见 `opt07-ui-typecheck-final.log`、`opt07-ui-lint-final.log`、`opt07-service-ui-format-verified.log` |
| 依赖边界与构建     | 475 模块、1521 依赖，违规 0；实际桌面构建通过                      | `opt07-service-ui-deps-final.log` 与最终 Electron 入口的构建输出。保留已有约 591 KB 图表 chunk 提示，未声称包体或加载性能改善                                                                                                                                           |

相关 Vitest 命令为 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts desktop/packages/plugins/datasets/test desktop/packages/capabilities/analytics-worker-client/test desktop/packages/capabilities/storage-sqlite/test desktop/packages/runtime/test/cleaning.integration.test.ts desktop/packages/runtime/test/openapi.test.ts desktop/packages/runtime/test/level2.integration.test.ts desktop/packages/client/test desktop/packages/ui/test/dataset-cleaning.test.ts --reporter=default --reporter=json --outputFile=<Artifact>/opt07-service-ui-regression-final.json`。桌面命令为 `bun --no-env-file run desktop:test e2e/cleaning.spec.ts`。静态命令为根 `typecheck`、`lint`、`format:check`、`architecture:check`、`architecture:deps`、`client:check`、`worker:client:check`；UI 补充类型命令为 `bun --no-env-file run --filter @zhiyun/ui --filter @zhiyun/desktop typecheck`。

**中间失败保留**：服务初次 Runtime 测试缺 SDK 测试依赖，增加 Runtime 的客户端 devDependency 并安装既有 workspace 链接；随后修正对未直接依赖的 shared 导入，沿用 contracts 再导出。类型检查分别发现可选参数显式 undefined 与生成类型的差异，已改为只传实际存在的属性；Lint 要求被捕获异常保留 cause，已修正。第一次 Electron 用例误取不存在的 Run.datasetId，第二次选择器同时匹配操作列表和表单，后续一轮在新输入选中前读取了旧 ID；依次改为查询来源 Dataset、精确匹配与等待实际选择变化。失败日志及上下文保留为 `opt07-service-*-first`、`opt07-runtime-client-second`、`opt07-ui-typecheck-first/second`、`opt07-cleaning-desktop-first/second/final`；当前最终成功日志没有覆盖这些失败。

**资源与来源保护**：当前已登记 682 份文件，最后 UI 检查期间源哈希不变；登记与阶段差量分别保存在 `opt07-service-ui-source-before-last-checks.json`、后续 final 源清单和 delta。37 份保护检查见 `opt07-service-ui-protected.json`，原 Dataset 001–003 SQL 的前阶段保护证据继续适用。`opt07-service-ui-cleanup.json` 记录执行句柄终态、21 类临时目录为空、45100 空闲；没有项目测试进程残留，支持进程 51907、51910、51979 保留。初次盘点中的 62332 是检查命令本身的 shell，后续 ps 确认已退出，初次记录也保留。所有测试使用自建 Profile/SQLite/本地源与 Worker，没有开发库改动、真实凭据读取、真实模型/外部通知调用、暂存、提交、推送或发布。Python 自管共享临时根没有被清理。

本轮完成的是开发桌面与相关业务链路；Cloud 全回归、完整 Desktop E2E、未签名包冒烟和最终全仓交付仍属于 OPT11。真实 Provider、支付消息、签名/公证、跨平台和公网部署继续属于已列出的范围外事项。

### 2026-10-04 OPT08 开始：分析问题与溯源差量

已读取实际 Worker 方法目录与 `analytics.py`、AnalyticsPage/AnalysisJobPage/AnalysisChart、分析任务/结果契约、服务、SQLite 仓库和 HTTP 接口。现有 `group.aggregate`、`time.trend`、`stats.descriptive`、`stats.outliers` 能支撑首轮四类问题；可复用现有类型化参数校验和任务队列，不新建分析服务。

当前问题入口只是按方法 ID 筛选目录，尚未根据所选字段生成四类问题的可用性、默认参数或缺字段说明。Job 已保存输入 Snapshot/参数/状态，Result 已保存 Snapshot 与 Artifact，但缺清洗配方版本、输入指纹和父分支的冻结溯源。Result 读取返回整份 tables/series；页面收到后再截取最多 10000 行，不能证明服务端分页或大结果首屏读取。图表当前猜测首个字符串/数值键，并把其他类型映射为 bar；没有图表错误边界和兼容结果比较。

下一步先补充四类问题与参数选择，再通过稳定契约保存输入/清洗版本/分析参数/父结果关联，增加受限的分支与比较、结果页分页及图表失败回退。四类问题分别用实际 Worker 固定数据证明从入口到结果的路径；大结果验收必须证明首屏无需读取全量 Artifact。OPT08 尚未有完成声明，OPT09–OPT11 仍未开始；主目标范围没有缩小。

### 2026-10-04 OPT08：溯源、分支与分页后端验证

**状态**：进行中，`opt08Complete=false`、`goalComplete=false`。上一目标轮次只回答计划文件入口，分类为无进展；本轮重查现有源码后接通后端并取得以下新证据。四类问题的真实 Runtime 链路已验证，桌面入口和结果页尚未完成，不能据此登记完整 OPT08 验收。

**实现与读取边界**：

- Job 创建时冻结输入指纹、源 Snapshot、清洗不可变版本与步骤、分析配方 ID/修订号、问题 ID、父结果 ID。结果从 Job 复制实际分析参数和溯源，保存成功状态与 Worker 版本；旧数据库保留未知溯源为 null，不凭当前版本补造历史。删除或修改分析配方不改变已创建任务；幂等重放不依赖当前 Worker 或配方可用性，失败任务重试沿用冻结信息。任务元数据先于队列分发写入。
- `002-result-lineage` 是新的前向迁移，原 Analytics 001 SQL 未修改。既有表格与序列回填为按结果/集合/行序号存储的记录，原 JSON 列保留供明确请求的完整导出使用。首屏查询明确不选择这两个全量列；每个集合默认预览 20 行，行接口默认 50 行、最多 200 行，游标绑定结果、table/series 与集合，响应上限 4 MiB。仍同时保存旧 JSON 与逐行数据，尚未声称 SQLite 空间下降。
- 新增 `getAnalysisResultPage`、`branchAnalysisResult`、`compareAnalysisResults`，同步 Plugin Descriptor、命名 OpenAPI Schema、生成客户端与 SDK。前两类读接口为 `workspace.read`，分支为 `analysis.write`；分支只接受 parameters 并要求幂等键，保留原输入与方法，原结果不写入。比较核对 Dataset、Snapshot/已知指纹、方法版本、采样、字段/聚合语义和表结构，不兼容返回 409 与原因。空异常表仍保存字段 Schema，可与同一输入的非空结果比较。
- 每个实际分析结果发布 `analysis.result` JSON Artifact，引用和冻结溯源随结果保存。发布失败回收本次 descriptor 与独立结果目录；已存结果不会重复执行。每次队列尝试使用独立 Worker UUID，避免持久化失败后重试命中 Worker 已结束任务、却没有结果文件。无法确认 Worker 终态时保留其工作区，终态后才清理。
- Worker 分组表和趋势表不再截断到 10000 行或抽稀时间桶；异常表保留全部匹配行，不再只留前 100 条。表上限 1000000 行、整个结构化结果 64 MiB，超限明确失败。图表仍最多 10000 点，分组/趋势超过时给出范围说明，完整表格保留供分页。四类问题输出明确的 xFields/yFields，分布为箱线图、异常点为字段异常数量；这些映射尚待 UI 使用。

**验收证据**：Artifact 根目录继续为 `.artifacts/no-credentials-optimization/20261003T054244Z/`。

| 检查             | 当前结果 / 退出码                                                                     | 能证明的范围与证据                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 后端与相关回归   | 9 文件、28 项通过 / 0                                                                 | `opt08-backend-regression-verified.json/.log`：所有 Analytics 测试、新增 7 项 SQLite/服务测试、实际 Runtime 分析/清洗、OpenAPI、Level2 与 SDK 回归                                                                       |
| 四类问题实际链路 | 包含在上述 Runtime 用例中 / 0                                                         | 550 条本地记录 → 三步清洗 → 四种类型化 Recipe/问题 → Worker → Artifact/SQLite → 结果；删除分析配方后仍保留修订 1；原 Parquet 哈希与原 Snapshot 未变                                                                      |
| 首屏无需全量数据 | 实际 Runtime 与 SQLite 两类证据 / 0                                                   | `opt08-runtime-metrics.json`：首屏 3181 B、完整 Worker Artifact 44358 B（7.17%）；临时移走自有 Artifact 后首屏与三页读取仍通过。SQLite 测试另把旧全量 JSON 列设为不可解析内容，预览及全部 10003 行分页仍可读、无重复遗漏 |
| 分支、比较与恢复 | 包含在 28 项中 / 0                                                                    | 阈值 1.5 分支为 10，原结果 JSON 不变；1 条异常与 0 条异常表可比较，跨方法拒绝；超限参数与错误问题/方法组合拒绝。第一次结果持久化故障后第 2 次尝试成功，旧 Artifact descriptor 不存在，只保留最终引用                     |
| 存储/权限边界    | 包含在 28 项中 / 0                                                                    | 实际 001 老库升级与重开，行写入失败整事务回滚，不同结果/集合/类型游标拒绝，越界与超大页拒绝；真实 Runtime 三个新接口未认证请求均 401，Graph 权限匹配                                                                     |
| Worker 全套      | 73 项通过 / 0                                                                         | `opt08-worker-final.xml/.log`：原 69 项加 4 项完整大表、趋势桶、超过 100 条异常及空表 Schema、显式资源上限与图表编码。保留既有 ARIMA 时间频率推断警告                                                                    |
| 静态与契约       | 根 typecheck、lint、format、Worker Lint、架构目录/依赖、HTTP 与 Worker 客户端检查均 0 | `opt08-backend-typecheck-passed.log`、`opt08-backend-lint-verified.log` 和各 `opt08-*-check*-final.log`、`opt08-worker-lint-final.log`；依赖检查为 480 模块、1546 依赖、0 违规                                           |

TypeScript 命令为 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts desktop/packages/plugins/analytics/test desktop/packages/runtime/test/analytics-lineage.integration.test.ts desktop/packages/runtime/test/cleaning.integration.test.ts desktop/packages/runtime/test/openapi.test.ts desktop/packages/runtime/test/level2.integration.test.ts desktop/packages/client/test --reporter=default --reporter=json --outputFile=<Artifact>/opt08-backend-regression-verified.json`；Python 为 Worker 目录下 `uv run pytest --junitxml=../../<Artifact>/opt08-worker-final.xml`。先前 6 项存储、20 项分析 Worker 和补充 8 项测试均与最终范围重叠，不另相加。字节数是当前样例读取边界的观测，不是加载时间、内存或整体性能结论；本轮尚未运行 OPT08 Electron E2E、桌面构建或打包验收。

**源码入口**：Analytics 的 `contracts/index.ts`、`application/index.ts`、新 `application/provenance.ts`、`persistence/sqlite/index.ts`、新 `results.ts` 与迁移 `002-result-lineage.ts`；HTTP/Plugin Descriptor、Runtime `openapi.ts`、客户端与架构生成目录；Worker `analytics.py`。新增测试为 `plugins/analytics/test/results.integration.test.ts`、`runtime/test/analytics-lineage.integration.test.ts` 与 `analytics-worker/tests/test_analysis_questions.py`。

**中间失败与来源保护**：首个 SQLite 测试夹具误用 `test.sqlite3`，被现有受控路径校验拒绝，改为隔离目录中的 `zhiyun.sqlite3`；6 个初始化前留下的空目录逐个验证名称、创建时间与空目录状态后用 rmdir 清理，见 `opt08-initial-fixture-cleanup.json`。两次类型检查暴露测试辅助函数循环推断、精确可选属性和清洗 Schema 默认字段差异；补充显式类型、读取内部 Snapshot 元数据、传入实际默认字段后根类型检查通过，没有放宽业务断言。失败日志 `opt08-results-tests.log`、`opt08-backend-typecheck-final.log`、`opt08-backend-typecheck-verified.log` 保留。

代码检查后的登记为 `opt08-backend-source-code-verified.json`，包含 689 文件；相对本轮开始改动 13 个、新增 3 个、缺失 0。原 Analytics 001、原缓存/AI 迁移及除本次明确调整 analytics.py 外的已登记 Worker 源与契约，37 份哈希保护均通过，见 `opt08-backend-protected.json`。文档更新后的 source-final/delta、进度审计和自有句柄/临时资源清理单另存 `opt08-backend-*`；保持原 HEAD/main，没有暂存、提交、推送、开发库改动、真实 Provider/通知或外部凭据读取。

**未完成与下一步**：在 AnalyticsPage 根据字段 Schema 提供四类问题的可用性、受限默认参数及缺时间/数值字段原因；从已有结果打开分支参数并比较兼容结果；ResultTable 使用服务器游标翻页，图表使用明确字段映射并在加载/渲染失败时保留解释和表格。最后用真实 Electron 固定数据验证四类问题完整用户路径、溯源链接、分支不覆盖、不兼容拒绝、分页与图表失败回退。OPT09–OPT11 仍未开始，EXT01/EXT02 与已列外部事项范围不变。

### 2026-10-04 OPT08：四类问题入口、结果交互与桌面验收完成

**状态**：OPT08 已完成；10 项核对见 `opt08-completion-audit.json`，`opt08Complete=true`、`goalComplete=false`。OPT09、OPT10、OPT11 仍是主目标中的必做任务，尚未开始；EXT01、EXT02 与明确列出的外部事项保持范围外。目标执行入口仍是 `docs/product/zhiyun-no-credentials-optimization-plan.md`，本文件仅维护进度与证据。

**入口与冻结结果**：新增四类问题卡片，由所选 Snapshot 的字段 Schema 推荐字段和受限参数；缺时间或数值字段时显示清洗/换版本原因。时间趋势只有日期时可按记录数量汇总。选择问题后使用已有类型化 Analysis Recipe 保存方案，并把 Recipe ID、问题 ID 交给现有 Job 接口；运行成功直接进入任务详情。表单校验类型、枚举、数量、去重和数值范围，省略清空的可选参数，运行时仍由 Runtime/Worker 作权威校验。

结果展示运行时保存的 Snapshot、清洗版本/步骤、分析方案 revision、参数、状态与 Artifact ID。新增 `/analytics/results/:resultId` 固定链接；数据版本与清洗版本链接打开 Dataset 页中的只读历史面板，通过确切 Snapshot 和清洗会话读取当时的字段与不可变配方版本，不自动改变清洗历史选择。创建分支只编辑参数、沿用固定输入和方法，随后可比较父结果；比较面板支持最近结果和手动结果 ID，不兼容的服务端原因直接显示。执行与分支入口按 `analysis.write` 权限提供。

**分页与图表**：表格和图表分别使用集合游标，首屏 20 行、后续页 50 行；界面只保留游标位置，离开的页查询立即失效，不在首屏自动下载完整 Artifact。表格沿用完整列声明，空异常表仍展示列。四类输出按明确编码呈现柱图、折线、箱线及异常统计；已有频率、关键词、预测、PCA 等输出按方法和既定字段映射，未知类型或缺映射时解释原因。图表采用延迟加载的 ECharts 实例，初始化、缩放和销毁受控，加载/渲染错误由独立边界处理，表格与解释保持可用。结果文件保留已有保存/导出路径。

新增 `analysis-questions.ts`、`analysis-chart.ts` 及 `components/analysis/` 的历史输入、分支/比较、分页表格和图表组件；更新 AnalyticsPage、AnalysisJobPage、DatasetPage、SchemaForm、版本选择器、双语文案及路由。通用 Card 现在转交 HTML 属性，支持区域标识；窄屏版本详情改为单列，分页、图表重试和文件按钮不逐字断行。

| 验收条件                             | 实际证据与结果                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 四类问题从选择完成到可查看结果       | 新 `desktop/e2e/analysis-questions.spec.ts` 使用实际 Electron Main、utility Runtime、队列、SQLite、Artifact 与 Python Worker；本地采集 550 条数据，经三步类型清洗后逐个点击问题并执行，四类结果和图表均可查看，Recipe revision 1 与清洗版本正确 |
| 字段可用性与参数范围                 | 实际桌面缺时间/数值字段时四个入口禁用且说明原因；分支阈值 11 无法运行，10 可运行。UI 单元测试覆盖文字字段、日期计数、缺方法、字面字段名、NaN、数量、重复值及非法字段                                                                            |
| 回到输入与清洗版本                   | 从结果点击确切清洗版本，历史面板显示固定 Snapshot ID、配方名称与 convert 操作；源 Parquet/Manifest 与数据库元数据在分析后完全一致                                                                                                               |
| 分支不覆盖父结果                     | 阈值 1.5 分支为 10，父结果重新 GET 后深比较完全一致；父结果 1 条异常、分支 0 条异常，输入与父关联正确                                                                                                                                           |
| 兼容比较与不兼容拒绝                 | 真实 UI 比较父子结果，显示阈值差异及空/非空异常表；换为分组结果时 HTTP 409，界面显示方法不兼容原因                                                                                                                                              |
| 大结果无需完整 Artifact 才能显示首屏 | 临时移走自有 `analysis.result` 文件，真实结果页仍显示 20 行并翻完 550 行，550 个唯一分组无重复遗漏；上一页和图表下一页亦可用。后端现有 10003 行与 4 MiB 页边界证据继续有效                                                                      |
| 图表确定性与双类失败回退             | UI 单元测试验证多分组、多数值和 JSON 键顺序不改变映射、箱线四分位与数值散点轴；实际 Electron 注入 Canvas 初始化故障及中止图表模块加载，两种情况下解释和 20 行表格保留                                                                           |
| 中英文与窄屏                         | 360 px 视口无页面横向溢出，实际移动导航切换语言；保存并目视核对中英两张完整页面截图。相邻清洗 E2E 再次通过七步操作、第二输入复用、撤销/重做、类型拒绝和源文件保护                                                                               |

**验证汇总**：合并分析后端、Runtime、客户端与 UI 的 TypeScript 回归 25 文件、89 项通过；显示修正后全部 UI 16 文件、61 项再次通过，属于上述 89 项的重复范围，不相加。最终 Electron 2 项通过、退出 0（分析约 46.3 s、清洗约 38.2 s）；构建随该命令完成。全仓 typecheck、lint、format、架构依赖（489 模块、1581 依赖、0 违规）、架构目录、HTTP 客户端和 Worker 客户端检查全部退出 0。Worker 73 项沿用上阶段未改动源码的实际报告，当前哈希核对保持有效；保留既有 ARIMA 频率警告。

命令为 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts desktop/packages/ui/test desktop/packages/plugins/analytics/test desktop/packages/runtime/test/analytics-lineage.integration.test.ts desktop/packages/runtime/test/cleaning.integration.test.ts desktop/packages/runtime/test/openapi.test.ts desktop/packages/runtime/test/level2.integration.test.ts desktop/packages/client/test --reporter=default --reporter=json --outputFile=<Artifact>/opt08-ui-combined-final.json`；显示修正后 UI 使用同一隔离入口。桌面为 `bun --no-env-file run desktop:test e2e/analysis-questions.spec.ts e2e/cleaning.spec.ts`，每个测试自行创建本机动态端口夹具和独立临时 Profile，本地 Runtime nonce/token 由应用生成并只在 Renderer 闭包中使用，无外部凭据。

当前证据为 `opt08-ui-combined-final.json/.log`、`opt08-ui-mobile-regression.json/.log`、`opt08-ui-electron-mobile-final.log`、`opt08-ui-electron-report.html`、`opt08-ui-desktop-metrics.json`、`opt08-ui-cleaning-metrics.json` 和各 `opt08-ui-*-check*-final.log`/`opt08-ui-mobile-*.log`；截图为 `opt08-ui-zh-360.png`、`opt08-ui-en-360.png`、`opt08-ui-cleaning-regression-en-360.png`。图表 chunk 仍有大于 500 kB 的构建提示；体积观测登记在 `opt08-ui-build-metrics.json`，不是加载耗时或整体性能结论，后续 OPT10 仍须测量。

**中间失败与修复**：首轮 UI 空表断言未考虑已有“数值”译名，修正期望；异步导航改为 await 后 Lint 通过；E2E 初版直接引用未声明的 Client 包，改为仅描述实际断言字段的测试类型，UI 溯源夹具补齐完整契约字段。实际 E2E 首轮发现 Card 不转交区域属性；随后发现旧 React 图表包装器在当前构建器下默认导入为对象，已改用 ECharts 实例并显式处理异常。第三轮在窄屏直接点击隐藏侧栏语言按钮失败，改为通过移动导航展开、切换并关闭；没有强制点击或绕过可见性。中间日志保留为 `opt08-ui-tests.log`、`opt08-ui-lint.log`、`opt08-ui-typecheck-with-e2e.log`、`opt08-ui-electron-first.log`、`opt08-ui-electron-repaired.log`、`opt08-ui-electron-chart-diagnostic.log`、`opt08-ui-electron-native-chart.log`。最终日志中的 409、图表渲染异常和模块加载失败均为明确断言的故障夹具；应用关闭时的连接中断未造成用例失败。

**保护与后续**：源码基线为 689 文件，新增 9 份源/测试文件；最终代码核对 698 文件无缺失、无验证期间变化，见 `opt08-ui-mobile-source-code.json`、`opt08-ui-mobile-hash-guard.json`；原 Backend/Worker 与既有迁移保持原哈希，文档登记后的差量和来源保护另存 `opt08-ui-source-final.json`、`opt08-ui-delta.json`、`opt08-ui-protected.json`。用户的 `.DS_Store` 视为已有系统元数据，未删除或计入源文件增量。资源清单为 `opt08-ui-cleanup.json`，各自有 Profile/Runtime/Worker 临时目录已移除、45100 无监听、全部执行句柄终态；未终止其他进程或删除共享 pytest 临时根。保持原 HEAD/main，没有暂存、提交、推送、部署、开发库修改、真实 Provider 或外部通知。

下一步执行 OPT09：可配置字段过滤、绝对/比例阈值、连续触发、冷却与聚合、三类规则、桌面本地通知及拒绝回退、睡眠唤醒策略。之后继续 OPT10 的服务端完整历史分页与实测性能，以及 OPT11 的全量检查、隔离数据库/E2E 和本机未签名包验收。本轮完成 OPT08 不代表整个主目标完成。

### 2026-10-04 OPT09：条件规则、应用内事件、通知回退与调度后端

**状态**：进行中。主目标仍包含 OPT00–OPT11；OPT09 尚未完成，OPT10、OPT11 未开始，EXT01/EXT02 与明确列出的外部事项保持范围外。前一目标执行回合已写入条件规则与存储代码，并产生测试导入失败证据，属于进展；中间“选择哪个文件”的答复仅说明执行入口。本回合继续从实际代码和失败日志推进，没有重启或缩小目标。

**已接入的行为**：复用 Dataset 已提交的 Run Changes，按字段统计 added/updated/removed，结构化值深比较；不保存变化前后的字段值副本。包含与排除字段同时生效，排除优先。三类条件规则支持绝对数量或比例，记录减少要求实际下降；显式空值比例规则把字段缺失计入空值，比例使用百分点增幅，绝对值使用相对于基线预期的额外空值数量。未声明新模式的旧空值规则继续保留原来的比例下限与增幅语义。Schema 校验比例上限、整数量阈值、重复规则/字段、连续次数和时间范围。

新增 SQLite 003 向前迁移，原 001/002 迁移没有改写。不可变 Evaluation、连续次数、冷却状态、聚合事件、Run 关联及通知 Outbox 在同一事务中保存；重复 Run 不重复记账。规则配置签名包含旧/新阈值语义，配置变化不会继续沿用旧连续次数。聚合记录保存异常次数、计划通知次数和未通知次数；计划通知次数不是系统已送达次数。关闭事件保留历史，并产生可追溯的关闭事件；健康评估记录恢复事件。

新增三个受权限约束的 HTTP/SDK 入口：任务事件列表、单个聚合事件的完整 Run 历史游标分页、关闭事件。列表内嵌最近 20 次记录，完整关联历史通过 `/monitoring-alerts/{alertId}/runs` 读取；列表可请求 1–500 条，历史页可请求 1–500 条。游标校验版本、日期、UUID、任务与事件范围，非法或跨范围游标拒绝。OpenAPI、客户端生成类型与架构目录已同步。

**本地通知**：桌面 Main 使用 Electron Notification 的 `show`/`failed` 事件确认结果，支持不可用、失败和 1.5 秒内无法确认的情况；只有 `show` 事件登记为 shown。Host Capability 返回结果，Runtime 持久化 `monitoring.notification.local` 事件，系统通知拒绝或抛错不会使监控 Job 重试或改变 Collection Run 的成功状态。通知正文仅含异常数量、任务和 Run ID，不拼接字段值、字段名、采集错误或系统错误；失败 Run 的本地通知也由独立监控队列负责，移除原先直接显示 raw error 的路径。通用监控 Notifier 的真实交付错误仍保留原有 Outbox 重试；这里只包含本地 OS 通知失败。已有外部输出配置的产品边界没有改写，本轮测试未调用真实外部通知渠道。

Electron 说明未签名 macOS 程序可能收到 `failed`，因此本机未签名验收不能以原生横幅显示作为完成条件，必须验证应用内记录与失败回退；参考 [Electron Notification 官方说明](https://www.electronjs.org/docs/latest/api/notification)。本轮还没有进行实际 Electron 的 OPT09 新路径验收。

**沿用现有调度器**：将 CollectionScheduler 按职责提取到 `application/scheduler.ts`，保持原队列、Active Run 约束与 cron。Main 监听 powerMonitor 睡眠/恢复并检查本机 online 状态，经既有 utility IPC 传递环境；Bootstrap 带初始状态，Supervisor 保留最新状态供重启使用。睡眠/离线时停止 cron，恢复按 `skip` 或 `run-once` 处理；周期观察也识别遗漏的时钟/睡眠间隔。相同恢复信号与正在执行的触发操作合并，已经补跑的时段不会再次补跑；配置签名包含 misfirePolicy。普通 cron 执行仍可用。入队失败后只取消本次创建且确认未入队的 Run；无法确认的队列状态交由已有恢复机制处理。

**中间失败与修复**：首个条件测试未声明 Dataset 工作区测试依赖，补充 devDependency；夹具误用不存在的 tracked 模式，修正为已有 snapshot 模式。随后跨连接读不到监控事件，实际加载路径表明监控仍使用 better-sqlite3 12.11.1，而 Dataset/平台使用 13.0.3；驱动对齐后 33 项监控测试通过且事件可读。检查还发现共享同一数据库的 Recruitment 残留旧范围，亦对齐到项目已有 13.0.3，并纳入回归。安装只更新本地工作区依赖与锁文件，使用 `bun --no-env-file install --ignore-scripts`，没有引入新外部运行库。

类型检查暴露测试中的 UUID 模板推断和 EventEmitter this 推断，已修正；Lint 的异常参数赋值和内联 import 类型亦修正，没有放宽检查。调度夹具第一版规则形状不符合现有 Schema，修正为有效 JSON rule 并补齐初始化失败清理。该次遗留的 4 个自有目录逐一核对创建时间、仅含测试 SQLite、1 个任务且 0 个规则后清理，见 `opt09-scheduler-fixture-cleanup.json`。中途完整回归加载了队列修复前的 Scheduler，新增入队故障断言失败；最终源码专项重跑 5 文件、15 项通过，完整回归随后再次执行。

**当前验证**：Artifact 根目录为 `.artifacts/no-credentials-optimization/20261003T054244Z/`。

- 三类规则各自验证基线、不触发、两次连续触发、冷却、聚合、重开 SQLite、重复 Run 幂等、恢复与关闭；另验证原型字段名、结构化值、排除字段、绝对空值阈值和事务回滚。初次修复后监控共 33 项通过，日志为 `opt09-monitoring-foundation-third.json/.log`。
- HTTP 使用 205 次聚合异常，最近 20 条内嵌、每页 17 条读取完整 Run 历史，唯一 ID 无遗漏；验证非法/跨任务游标、未知事件、幂等键、关闭与保留历史。真实 Runtime 验证未认证 401、本地通知抛错后的成功状态、应用内告警与 Run 查询。原生通知边界单元测试覆盖支持、拒绝/失败、show、静默超时、构造失败和监听器清理。相关首轮 9 文件、53 项通过，最终修复专项 5 文件、15 项通过，范围重叠不相加。
- 调度验证睡眠、离线、时钟间隔、初始离线、精确 cron 边界、持久化触发时间后的新实例启动、重复恢复信号、普通 cron 和入队失败；旧 Run 先取消成为终态后，重复恢复不会新增 Run。主进程环境观察器验证去重和清理。当前最终专项报告为 `opt09-foundation-repaired-tests.json/.log`。
- 最终源码根 typecheck、lint、架构依赖/目录和 HTTP 客户端检查退出 0；架构依赖为 501 模块、1619 依赖、0 违规。格式检查退出 0，但本段文档追加后还须重新检查。完整回归和桌面构建的最终结果见下方登记。

命令使用根隔离入口 `bun --no-env-file desktop/tooling/scripts/test-isolated.ts`，完整范围为监控、Collection、Recruitment 全部测试、两个 Desktop 通知/环境测试、Runtime Level2/OpenAPI 与客户端测试，JSON 输出 `opt09-foundation-combined-final.json`；修复专项同入口指定 HTTP、Scheduler、两个 Desktop 测试和 Level2。静态命令为根 `bun --no-env-file run typecheck`、`lint`、`format:check`、`architecture:deps`、`architecture:check`、`client:check`；构建为 `bun --no-env-file run desktop:build`。日志使用 `opt09-foundation-*` 前缀，前期失败日志保留。

**来源保护与未完成项**：当前登记 710 个源/测试/文档文件，本阶段新增 12 个文件、改动 24 个既有文件；这不包括本段执行记录更新。代码快照为 `opt09-foundation-source-code.json`，48 份已有 Worker/迁移哈希保护均通过，源码/基线无缺失。最终差量、验证期间哈希与资源清理在下方登记。

下一步实现 TaskDetail 健康页的三类条件配置、明确稳定默认值与预览说明，以及应用内聚合事件、完整 Run 分页与关闭入口；保留旧策略语义、写权限、中文/英文与窄屏体验。随后用实际 Electron、Main/utility Runtime、隔离 SQLite 和本地网页夹具验证三类完整用户路径、通知失败可查、真实 IPC 环境信号不重复调度，并核对需要补强的边界与契约。现有单元/Runtime 测试、代码接线或一次构建不能代替这项验收；OPT09 不登记为已完成。

**本回合最终核对**：

| 验证              | 最终结果 / 退出码                            | 证据                                                                                                                                |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 受影响完整回归    | 20 文件、185 项全部通过 / 0；约 231.92 s     | `opt09-foundation-combined-final.json/.log`；包含原 Collection 的实际浏览器与进程中断恢复，并且最终 Scheduler 源码下的 6 项全部通过 |
| 根类型检查与 Lint | 均 0                                         | `opt09-foundation-typecheck-verified.log`、`opt09-foundation-lint-final.log`                                                        |
| 架构与客户端      | 目录、501 模块/1619 依赖、客户端生成检查均 0 | `opt09-foundation-architecture-check.log`、`opt09-foundation-deps-first.log`、`opt09-foundation-client-check.log`                   |
| 桌面构建          | 0                                            | `opt09-foundation-desktop-build.log`；Main、utility Runtime 与 Renderer 成功生成；此结果不包含启动或新路径 E2E                      |
| 依赖审计          | 0；本地安全补丁 14 项通过                    | `opt09-foundation-dependency-audit.log`；沿用既有记录的构建期例外，没有新增例外                                                     |
| 格式与差量        | 代码格式、文档最终格式、diff 检查均 0        | `opt09-foundation-format-check.log`、`opt09-foundation-document-check-final.log`、`opt09-foundation-diff-check-final.log`           |

构建体积仅作观测：图表 chunk 549.94 kB、gzip 185.98 kB，utility Runtime 约 21.94 MB；仍存在大于 500 kB 的图表提示，见 `opt09-foundation-build-observations.json`。本回合没有首屏/图表加载耗时或内存测量，不据此宣称性能改善；OPT10 继续承担实测要求。

最终来源为 `opt09-foundation-source-final.json`、`opt09-foundation-delta.json` 和 `opt09-foundation-progress-audit.json`。710 个文件无缺失，较开始新增 12 份、修改 25 份（含执行记录）；最终回归期间除登记文档外 709 个文件哈希完全一致，48 份已有迁移/Worker 哈希均通过。所有本回合 exec 句柄终态，三个新增测试前缀的临时目录均 0；前述失败夹具 4 个目录已清理，资源清单见 `opt09-foundation-cleanup.json`。保持原 HEAD/main，未暂存、提交、推送、部署、修改开发库、终止未知进程、读取真实凭据或发送真实外部通知。

这份核对证明本阶段代码与测试进展，不能证明 OPT09 的全部验收；状态继续为进行中，配置/预览、应用内事件界面与实际 Electron 新路径仍待完成。整个主目标保持 active，后续 OPT10/OPT11 不减少。

### 2026-10-04 OPT09 完成证据：规则界面、完整事件历史和实际桌面验收

**状态**：OPT09 已完成。核对入口为本轮 Artifact 根目录中的 `opt09-completion-audit.json`；主目标仍为 OPT00–OPT11，`goalComplete=false`。前一回合只回答执行文件，没有改动或新增验收证据，属于无进展；本回合重新检查实际文件和运行状态后接续实现，没有重做已有效的前序验收。

**本阶段增量**：新增 `ui/src/monitoring.ts`、`components/monitoring/QualityPolicyEditor.tsx`、`MonitoringAlerts.tsx`、UI 语义测试及 `desktop/e2e/monitoring.spec.ts`。TaskDetail 质量页接入三类条件的单位、阈值、连续次数、冷却、聚合、包含/排除字段、稳定默认值、即时解释、保存与放弃操作。共享 Schema 拒绝越界、空输入、非整数量阈值和非法基线；无写权限时编辑与保存均不可用。旧空值策略打开后明确显示“比例下限和增幅”，不会自动改变持久化语义。原来的其他规则保留在折叠区域中。

预览与实际算法一致：记录数基线使用中位数；字段变化的比例分母为本次记录数加删除数；显式空值条件使用百分点增幅，绝对数量按基线比例预计的空值数计算。比例恰好达到阈值时容许浮点运算的机器精度误差，不对用户阈值作小数舍入；小于阈值和没有真实变化仍不触发。规则、字段顺序改变不影响语义签名；阈值或基线配置改变会开始新的连续次数。成功评估中一个字段恢复而另一个仍异常时，分别更新事件；失败采集不会误判其他字段已恢复。聚合窗口结束后仍保留冷却状态。

监控事件列表新增稳定游标分页，按不可变 `first_at DESC,id DESC` 排序；Run 历史继续使用独立游标，按时间与 Run ID 排序。HTTP、SDK、Shared Schema、OpenAPI 生成类型和 UI 同步返回 `items` 与 `nextCursor`。游标绑定任务、列表类型及事件，拒绝非法、空、跨任务、混用列表/Run 的游标。界面分别以 10 条事件和 20 条 Run 分页，可以返回上一页；关闭事件保留全部历史。健康度与 Evaluation 定期刷新，独立监控 Job 完成后不依赖重新运行采集才能看到结果。

**修复的实际问题**：桌面验收发现成功采集覆盖了原 Run 元数据，导致定时触发和错过后补跑标记丢失。`CollectionRepository.completeRun` 现在合并创建时的元数据与本次完成数据；原定时来源、任务版本和补跑标记保留，当前 Dataset 引用仍以完成结果为准。Repository 测试覆盖真实 Dataset 持久化；实际补跑成功后也确认 `scheduled=true,misfire=true`。

**逐条验收**：

| 要求                               | 当前证据与实际结果                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 复用变化检测与字段过滤             | 独立监控 Job 读取已提交 Run Changes；包含/排除字段同时生效，排除优先。真实桌面夹具每次修改私有标记字段，而过滤后的规则只针对 price 触发。新增、更新、删除 Change 类型均带真实 source Run。                                                 |
| 三类规则的绝对与比例阈值           | Domain 与条件集成覆盖字段变化绝对/比例、记录减少绝对/比例、空值百分点/基线预期数量。精确边界、较小变化、零变化、缺失字段及旧空值语义均通过。                                                                                               |
| 三类触发、不触发、连续、冷却与聚合 | 每类均完成基线、不触发、第一次等待连续、第二次计划通知、第三次冷却、恢复与关闭；SQLite 重开与重复 Run 幂等也通过。另验证冷却结束、聚合结束、局部恢复、配置修改和事务回滚。                                                                 |
| 默认值与预览                       | UI 与 Shared 校验一致；重置显示连续 1 次、冷却 300 s、聚合 3600 s；无效连续次数不能保存，保存后读取策略验证数值与字段过滤。旧空值策略保持原语义。                                                                                          |
| 应用内事件与 Run 溯源              | 创建、更新、恢复和关闭事件分别验证真实 Run ID；界面链接打开对应 Run。关闭后可读取全部关联历史；不同任务不会共享游标或事件。                                                                                                                |
| 完整历史分页                       | HTTP 使用 205 次聚合异常和另一任务的 205 个独立事件，17 条一页读取全部唯一 ID；独立事件全部创建时间相同，仍按 UUID 稳定排序。实际桌面 24 个真实 Run 按 20＋4 条读取，13 个事件按 10＋3 条读取，前后翻页无重复/遗漏。                       |
| Main 本地通知拒绝与不可用          | 在本轮 Electron Main 中模拟 `failed` 和 `isSupported=false`，不改变操作系统权限或显示真实横幅。经过真实 Host HTTP/utility Runtime，持久化结果分别为 failed/unsupported；三类 Collection Run 均成功，应用内事件可读。                       |
| 通知隐私与外部边界                 | 捕获 Main 的 4 条原生调用消息；正文只含数量和任务/Run ID。消息及监控 Outbox/Event 不含私有标记、字段名或原生错误。临时数据库外部输出投递记录为 0；没有配置或调用真实 Provider、Webhook、邮件或短信。                                       |
| 睡眠、恢复、离线与去重             | 在自有 Main 中模拟 suspend、resume、online 状态；OS 保持原状态。离线跨过真实 cron 时点，恢复但仍离线时两任务都 0 Run；上线后 skip 为 0、run-once 成功 1 次；成功成为终态后重复 resume，仍只有 1 次。经过真实 Main→utility IPC 和现有队列。 |
| 启动与调度边界                     | SQLite/LocalQueue 专项 6 项覆盖初始离线、启动前错过、精确时点、持久化后的新实例、普通 cron、时间间隔和入队失败；观察器测试覆盖状态去重与监听器清理。                                                                                       |
| 中文、英文与窄屏                   | 360×900 的真实 Renderer 两种语言都没有页面横向溢出；检查截图并补齐状态、首次与下一页文案。Run 表格在其容器中滚动，长 UUID 不扩大页面。                                                                                                     |

**最终验证命令与结果**（均从仓库根目录使用 `bun --no-env-file`）：

| 命令/范围                                                                                                                                  | 结果与退出码                                                  | 证据                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop/tooling/scripts/test-isolated.ts`：全部 Monitoring/UI、Collection Repository、Runtime Level2/OpenAPI、客户端与 Main 通知/环境测试 | 28 文件、130 项通过 / 0                                       | `opt09-ui-boundary-regression.json/.log`                                                                                             |
| 同隔离入口：`collection/test/scheduler.integration.test.ts`                                                                                | 1 文件、6 项通过 / 0                                          | `opt09-scheduler-final.json/.log`；与上行文件不重叠                                                                                  |
| 最终文案后再跑 `ui/test`                                                                                                                   | 17 文件、65 项通过 / 0；属于上行范围的复验，不重复相加        | `opt09-ui-regression-verified.json/.log`                                                                                             |
| `run desktop:test e2e/monitoring.spec.ts`                                                                                                  | 实际 Electron 1 项完整路径通过 / 0，约 2.4 min；52 次成功 Run | `opt09-electron-paging-final.log`、`opt09-electron-evidence.json`、`opt09-electron-final-report/` 与 `opt09-electron-final-results/` |
| `run typecheck`、`run lint`                                                                                                                | 根检查全部通过 / 0                                            | `opt09-ui-typecheck-verified.log`、`opt09-ui-lint-verified.log`                                                                      |
| `run architecture:deps`、`run architecture:check`、`run client:check`                                                                      | 506 模块、1643 依赖、0 违规；目录和生成客户端均通过 / 0       | `opt09-ui-architecture-deps.log`、`opt09-ui-architecture-check.log`、`opt09-ui-client-check.log`                                     |
| `run format:check`、`git diff --check`                                                                                                     | 完成登记后最终检查通过 / 0                                    | `opt09-ui-format-verified.log`、`opt09-ui-diff-verified.log`                                                                         |

**中间失败保留**：第一次桌面测试停在嵌套 Select 标签的精确匹配，为下拉框增加明确无障碍名称；同时修正脚本的 Event cursor 列及 Run metadata 属性。第二次在实际成功补跑后发现创建元数据丢失并修复。第三次完整通过；截图检查暴露英文状态/分页词缺失，补齐后桌面再通过。新增翻页验证的最终版本完整通过。一次根类型检查发现测试把有第二个参数的 productCopy 直接传给 map，改成显式单参数回调；最终根类型与 UI 回归均通过。对应失败日志为 `opt09-electron-first.log`、`opt09-electron-second.log`、`opt09-electron-typecheck-first.log` 和 `opt09-ui-typecheck-final.log`；不删失败或以局部通过代替最终验收。

**来源与清理**：本阶段在上回合 710 份文件上新增 5 份、修改 17 份代码/测试/契约，另更新本执行记录；源清单为 `opt09-ui-source-code.json` 与最终快照。最终桌面和检查期间源哈希无变化；49 份已有 Worker/迁移（包含已新增的监控 003）无修改或缺失。五次自有桌面 Profile 全部删除，匹配的进程为 0，测试站点 45100 可重新绑定；新增 Monitoring/HTTP/Scheduler 临时前缀目录均为 0。所有本阶段 exec 句柄终态，清理记录为 `opt09-ui-cleanup.json`。原 HEAD/main 保持不变，未暂存、提交、推送、部署、改动开发库、终止未知进程或读取真实凭据。

构建仅登记观测：最终隔离桌面构建使用 `NODE_ENV=test`，图表 566750 B，utility Runtime 21939618 B，图表仍有大 chunk 提示。`opt09-ui-build-observations.json` 记录文件与压缩方法；此构建与前序生产环境体积不能直接比较。本阶段没有首屏/图表耗时测量，也没有宣称性能改善；OPT10 的同环境前后测量仍是必做项。本机原生横幅真正送达和其他系统运行未作为已验证结果。

### 2026-10-04 OPT10：完整历史与性能改造清单

**状态**：进行中，目前只完成清单确认和差量界定，服务端/UI 改造、隔离数据库验收、职责提取与性能测量尚未完成。OPT00–OPT09 已验收，OPT11 未开始；完整主目标继续 active，不排除任何 OPT10/OPT11 必做项。

`platform/server/src/app.ts` 有两组固定取最近 200 条的查询，共 21 个列表。用户列表是 orders、credits、periods、devices、sessions、usage；后台列表是 users、prices、models、subscriptions、orders、refunds、credits、periods、devices、staff、jobs、audit、requests、agreements、inbox。后台当前先获取固定数组，再对序列化行做客户端过滤；Portal 的 orders、credits、devices、sessions 页面同样没有完整历史分页。接口清单及源码哈希见 `opt10-readonly-inventory.json`。

下一步保持用户/员工权限和测试收件箱边界，用共享 Schema 定义每个列表的可用过滤项、查询参数与作用域游标；服务端采用参数化值和固定列/排序清单，Portal/Admin 同步分页与过滤；在本轮隔离 PostgreSQL 中为每个被改造列表建立超过 200 条合法历史记录，验证同排序值、跨页完整性、错误游标、用户及角色隔离，并更新生成契约与客户端。

性能部分先在相同构建与运行环境中建立首屏/图表加载基线和 Runtime 依赖组成，再对 TaskEditorPage、AI assistant application、Runtime level2 等受影响大文件提取职责模块并复验行为。记录前后构建体积与加载测量；已有懒加载无收益时记录结论，不把目录移动、行数减少或仅消除警告当作性能优化。OPT11 继续负责全量静态/业务检查、Cloud/桌面 E2E、Worker 构建冒烟及本机未签名包的真实采集与分析验证。

### 2026-10-04 OPT10：Cloud 完整历史分页与浏览器验收

**状态**：Cloud 部分已实施并验收，OPT10 整体仍为进行中，OPT11 未开始。前一个目标回合仅确认已知执行文件，没有实施增量或新验收证据，属于无进展；本回合重新核对实际工作区后完成以下改造。没有重置已有工作，也没有缩小 OPT00–OPT11 主目标。

**接口与契约**：将 `/me/{orders,credits,periods,devices,sessions,usage}` 六个接口，以及 `/admin/{users,prices,models,subscriptions,orders,refunds,credits,periods,devices,staff,jobs,audit,requests,agreements,inbox}` 十五个接口，统一改为 `{ items, nextCursor }`。默认每页 50 条，上限 100 条；支持服务端文字、适用状态与时间范围，以及八个适用 Admin 列表的用户编号过滤。Schema 拒绝未知参数、重复参数、不合法页大小、状态、UUID、时间范围和 cursor。

保留原排序字段，并使用 UUID 作为降序的唯一后续排序条件。时间游标在 PostgreSQL 内生成六位小数的 UTC 时间字符串；绑定参数先作为 text，再由 SQL 转成 timestamptz，防止 postgres.js 的 Date 序列化丢失微秒。范围参数最多六位小数，校验同样比较到微秒。cursor 绑定资源、登录主体、角色和已生效过滤条件，改变页大小允许继续翻页；角色与所有权始终由认证主体校验。表名、排序列、过滤表达式均来自服务端静态定义，用户输入只进入绑定值；文字中的 `%`、`_` 与反斜线按字面量搜索。

管理员、普通用户、不同资源及不同筛选条件之间不能直接复用 cursor。普通用户不可通过参数修改所属用户；客服、财务、运营和所有者分别遵守原权限。会话和管理员搜索仅使用可返回的字段，digest、csrf、password_hash、mfa_secret 不进入列表或搜索。测试收件箱继续要求模拟环境。新增 `0003_list_indexes.sql` 为各排序及普通用户范围增加索引，未编辑已有迁移。OpenAPI 和客户端生成产物同步；同 URL 的 GET 列表和 POST 创建模型/价格响应已按 HTTP 方法区分，创建接口继续返回单条结果。

**Portal/Admin**：新增 Cloud UI 共用列表 hook 和控件，以服务端查询替代最近 200 条的客户端过滤。包含搜索、适用状态、时间、用户编号、清除筛选、上/下一页、当前条数及失败重试；切换资源、账户或筛选重置翻页位置。旧请求中止且响应按请求标识隔离，不覆盖更新后的列表。订单、流水、用量、设备和会话页面接入同一机制；积分与 AI 请求用量切换现在保留真实视图状态，不再被账户刷新覆盖。表格使用记录 ID，加载失败不伪装成无记录。

**隔离数据库验收**：`platform/server/tests/lists.test.ts` 在每轮专属 PostgreSQL 内另建随机 `_test` 数据库，建库、迁移、种数据与删除均仅作用于自有数据库。21 个列表分别使用 205 条可搜索记录，每页 17 条遍历到末尾；时间列表同时间戳排序，管理员邮箱保持唯一排序。逐项比较完整 ID 序列，验证没有重复、遗漏或停在 200 条；覆盖文字、大小写、字面通配字符、状态、包含边界的时间范围、页大小切换、非法/跨范围 cursor、身份/角色/用户隔离、敏感字段不返回也不被搜索。另用相差一微秒的记录验证跨页与范围边界，验证同 URL 的 POST 创建成功后能从 GET 列表查到单条记录。

首轮断言误将 JSON 字段名中的下划线视为不应匹配，同时实际发现时间参数被驱动截断；修正断言并补充包含 `%` 与 `_` 的真实字段值夹具，修复参数精度后通过。浏览器回归随后发现 GET 分页契约误用于同 URL 的 POST 响应，修复方法维度并新增业务回归。初始失败日志与报告保留，没有覆盖为成功结果。

**真实浏览器验收**：新增 `platform/portal/e2e/lists.spec.ts`，在自有 `_e2e_test` 数据库种入 205 条历史记录。实际 Portal 订单、Admin 用户和 Admin 用户范围订单列表均翻完五页并逐项比较完整序列，末页五条且下一页禁用，可以返回上一页；搜索最旧一条记录成功。验证 Portal 状态过滤、流水/用量往返切换、设备和会话历史检索；阻塞旧请求的真实服务端响应，先呈现新筛选结果再释放旧响应，列表不被覆盖。390 与 1440 像素下 Portal 和 Admin 无页面横向溢出。Admin 启动早于测试登录的竞争通过明确等待应用就绪修复；筛选 select 使用明确标签，测试等待有上限。

原商业 E2E 的模型创建、测试、价格发布、模拟购买、重复支付通知、订阅/积分、取消续费和退出登录同时通过。另有响应式公开页面测试通过。打包 Electron 商业测试本轮依其运行条件跳过，没有作为已验收；当前宿主未签名包与完整桌面交付仍留在 OPT11。

| 验证              | 本轮结果与证据                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud 隔离测试    | `cloud:test` 退出 0；Tooling 18 项，Server 73 项、3351 个断言，Server 6.18 秒；`opt10-cloud-list-tests-third.log`                                                                  |
| Cloud 浏览器      | `cloud:e2e` 退出 0；3 项通过、1 项打包商业测试按条件跳过，18.0 秒；`opt10-cloud-list-e2e-third.log`，`opt10-cloud-list-e2e-final-report/` 与 `opt10-cloud-list-e2e-final-results/` |
| 契约与 Cloud 类型 | OpenAPI/生成客户端及六个 Cloud/Portal/Admin 工作区通过；`opt10-cloud-list-types-third.log`                                                                                         |
| 根类型检查        | 根与全部工作区通过；`opt10-cloud-root-typecheck.log`                                                                                                                               |
| 受影响 Lint       | 全部本阶段代码、夹具及配置通过；`opt10-list-lint-third.log`                                                                                                                        |
| 架构依赖          | 512 模块、1662 依赖，无违规；`opt10-cloud-architecture-deps.log`                                                                                                                   |
| Cloud 构建        | Server、Next.js Portal、Vite Admin 均通过；`opt10-cloud-build.log`                                                                                                                 |
| 差量与来源        | `opt10-cloud-list-source-code.json`；7 个新文件、13 个既有文件改动；49 份已有 Worker/迁移哈希保持一致。Next 构建另自动更新生成的 `next-env.d.ts` 引用，最终快照另行登记            |

**Runtime 依赖体积基线**：另用过滤后的 `testEnvironment()`、`NODE_ENV=test`、Bun 1.4.0，按现有 utility build 的同一组 target/format/packages/external 参数构建到自有 Artifact 目录，仅增加 metafile 输出。重新构建的 21939618 B 与现有测试构建逐字节一致，SHA256 为 `153a5f735e6782b7fb37867d0ad07bf81eb6818ab165cdae60abdfdfa48c6d88`；Python gzip level 9、mtime 0 为 3943165 B。metafile 包含 3749 个输入模块，直接归属字节合计 21577744 B，其余是 bundler 包装等开销。最大的依赖直接贡献为 jsdom 3238197 B、cssstyle 937887 B、undici 927585 B、parse5 711729 B、iconv-lite 629604 B；工作区源码合计 1634984 B。依赖各自统计，未把传递依赖重复归给上游包。

metafile 中 jsdom 的两个工作区直接导入入口是 `desktop/packages/extraction/src/index.ts` 与 `validation.ts`，下一步需结合实际首屏、提取和图表加载测量决定是否调整，不能仅凭 jsdom 大就删除必要提取能力。构建脚本为 `opt10-runtime-composition-build.ts`，成功日志 `opt10-runtime-composition-baseline.log`，完整 metadata、bundle 与汇总保存于 `opt10-runtime-composition/`。首次 stdin 命令参数解析失败另存 `opt10-runtime-composition-build.log`，未计为有效测量。

**尚未完成**：本阶段没有修改 Desktop 源码，没有记录首屏/图表加载耗时，也没有宣称性能改善。已有页面和图表的 React.lazy 入口仅经代码清单确认，不能据此视为加载验收。`TaskEditorPage.tsx`、AI application `assistant.ts`、Runtime `level2.ts` 的职责提取与前后同环境测量继续执行；OPT11 的最终全量检查、Worker 构建冒烟与本机包采集/分析仍为必做。完整主目标保持 active。

**来源与资源**：最终清单为 `opt10-cloud-list-source-final.json`，执行核对为 `opt10-cloud-list-progress-audit.json`。在先前 715 份清单上新增 7 个源文件；13 份实施文件、生成的 `next-env.d.ts` 及本执行记录共 15 份既有文件变化。补录此前清单遗漏但自 2026-09-12 已存在的 `platform/deploy/.env.example`，仅登记其哈希与文件元数据，不视为本阶段新增或据此声称有旧哈希保护；最终清单 723 份。49 份已有 Worker/迁移无变化，Desktop 源码无变化，保持原 HEAD/main，未暂存、提交、推送或部署。

Cloud 构建会自动将 `next-env.d.ts` 切换到构建生成的类型引用；构建之后再次运行 Cloud 契约与六个工作区类型检查通过，见 `opt10-cloud-after-build-check.log`。全仓格式检查及 `git diff --check` 通过。六个本轮自有 Docker 项目的容器、卷和网络均为 0；最新 E2E 的 62933、62934、62935 端口可绑定，匹配测试进程和 Cloud 测试临时目录均为 0；所有执行句柄终态。清理记录为 `opt10-cloud-list-cleanup.json`。未操作开发数据库、正常桌面 Profile、未知进程、真实 Provider 或外部消息通道。

### 2026-10-04 OPT10 完成证据：职责模块、真实规则修复与加载测量

**状态**：OPT10 已完成，完整主目标仍为 active，OPT11 尚未验收。前回合仅回答执行文件，属于无进展；本回合先核对 Cloud 阶段的 723 份文件，哈希均未变化，再实施桌面部分，没有重做已有效的 Cloud 验收或缩减主目标。

**职责提取**：`TaskEditorPage.tsx` 把规则历史、版本差异和修复提案显示提取到 `components/task-editor/RuleHistory.tsx`；任务编辑状态、预览与真实 API 操作继续由页面负责。`assistant.ts` 把工具描述与参数 Schema 提取到 `application/assistant-tool-catalog.ts`，权限过滤、费用核算、执行、调用持久化和事件仍由 AssistantService 包装。`level2.ts` 把可替换 Worker 适配器和会话保留生命周期分别提取到 `analytics-worker-adapter.ts`、`ai-conversation-retention.ts`；产品图解析、Plugin 注册和组合保持原边界，Worker 不可用错误及 30 天清理/24 小时周期不变。文件行数仅作为差量记录，不作为性能收益。

**修复验收暴露的旧入口问题**：专业编辑器此前用 `window.prompt` 收集失败现象，当前真实 Electron 返回 `prompt() is not supported.`，点击后无法发送提案请求。现在在规则历史卡片内填写失败现象，支持空输入禁用、取消、生成建议；只生成提案，仍须实际测试后才能应用。输入框使用明确无障碍名称，新文案提供中文和英文。此限制也见 Electron 的历史[官方问题记录](https://github.com/electron/electron/issues/472)，本轮结论依据当前宿主的实测信息。

新增 `desktop/e2e/task-rule-history.spec.ts` 在独立临时 Profile 和动态 localhost HTML 中创建两份真实 RuleVersion，实际点击比较与回滚。回滚生成 v3，旧 v1/v2 的完整记录未变；Mock 修复读取当前页面并预览两条 name/price 记录，测试前“确认应用”禁用，测试成功后应用生成 v4，旧 v1/v2/v3 未变。第二份提案被拒绝后，当前版本及全部历史保持不变；空输入和取消均未生成提案。报告为 `opt10-rule-history.json` 与 `opt10-rule-history-final-playwright-report/`，最终 1 项通过、35.2 秒、退出 0。Mock 结果不代表真实模型修复准确率。

**同环境测量方法**：前后使用完全相同的 `desktop/e2e/loading-performance.spec.ts`，其 SHA256 均为 `0eacc64ecc350ec3cd37591e696f7198de7d37fbc8ff5723488e4117f3d8e625`。每个阶段顺序启动三个全新 Electron Profile，使用过滤后的 `testEnvironment()`、`NODE_ENV=test`、macOS arm64、Node 24.18.0、Bun 1.4.0。首屏为宿主单调时钟从启动 Electron 到“首页”可见；每次真实采集 localhost 的 24 条 JSON，生成 ready Snapshot 并由 Worker 1.0.0 执行 group.aggregate 得到四组结果，再测量进入结果页到 Canvas 首次出现非透明像素。数据准备耗时独立记录，未并行运行其他本轮基准、构建或业务测试。

| 阶段/样本 | 启动至首页可见（ms） | 进入结果至图表首绘（ms） |
| --------- | -------------------- | ------------------------ |
| 前 / 1    | 3094.25              | 169.71                   |
| 前 / 2    | 1941.23              | 707.97                   |
| 前 / 3    | 1729.45              | 760.66                   |
| 后 / 1    | 2216.52              | 444.14                   |
| 后 / 2    | 1538.04              | 755.03                   |
| 后 / 3    | 1536.32              | 452.28                   |
| 前中位数  | 1941.23              | 707.97                   |
| 后中位数  | 1538.04              | 452.28                   |

OS 文件缓存与调度未受控，宿主时间包含 Playwright 等待开销，图表等待包含帧轮询；每阶段只有三次样本。中位数虽下降，不据此把速度变化归因于职责提取，也不宣称统计上证明了性能提升。数据准备中位数为前 1024.38 ms、后 1019.91 ms，不计入图表耗时。

**懒加载实证**：`app://` 的 Resource Timing 未完整返回动态脚本，第一轮错误断言留存。改用 Chromium Debugger 的 scriptParsed 收集已存在及后续解析的脚本，六份首页清单均有 index/HomeDashboardPage 作为测量正对照、图表模块为 0；每次完成真实分析并绘图后，均有且仅有一个 AnalysisChart 模块，实际 Canvas 已绘制。结合现有 React.lazy 入口，说明图表没有进入首页执行路径；没有为了消除 chunk 提示增加拆分。

| 受影响构建产物  | 前原始字节 | 后原始字节 | 前 gzip 字节 | 后 gzip 字节 |
| --------------- | ---------- | ---------- | ------------ | ------------ |
| utility Runtime | 21939618   | 21939748   | 3960500      | 3960586      |
| AnalysisChart   | 566750     | 566750     | 190716       | 190716       |
| TaskEditorPage  | 123468     | 125170     | 29537        | 29992        |
| Renderer index  | 389200     | 389200     | 116017       | 116026       |

本表统一使用实际测量进程的 Node zlib gzip level 9，不能与 Vite 输出或 Python gzip 数字混用。图表 SHA256 前后相同；入口原始大小未变，但引用的 chunk 名称更新，因此 hash/gzip 可略变。编辑器增加规则历史组件与可用修复表单，原始大小增加 1702 B；Runtime 增加 130 B，没有包体积下降。

**Runtime 决策**：按相同 build 参数再生成 metafile，3752 个输入模块，产物与实际测试构建逐字节一致。jsdom 直接贡献仍为 3238197 B，其工作区导入用途是同步 XPath 提取与校验；cssstyle、undici、parse5 的直接贡献同样未变。没有证明移除或延迟这些依赖能在保持公共同步 API、XPath 行为及打包边界的同时获得收益，因此保留必要能力，不做推测性 bundle 改造。Python gzip level 9/mtime 0 的组成报告为前 3943165 B、后 3943249 B，仅在这组报告内部比较。

| 验证                     | 命令与实际结果                                                                                                                                                                                          | 证据                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI/助手/Runtime 业务回归 | `bun --no-env-file desktop/tooling/scripts/test-isolated.ts desktop/packages/ui/test desktop/packages/plugins/ai-assistance/test desktop/packages/runtime/test`；41 文件、321 项通过，532.03 秒，退出 0 | `opt10-desktop-extraction-tests.log`                                                                                                                                       |
| 规则历史与修复           | `bun --no-env-file desktop/tooling/scripts/test-e2e-isolated.ts development e2e/task-rule-history.spec.ts`；实际 Electron 最终 1 项通过，退出 0                                                         | `opt10-rule-history-e2e-third.log`、`opt10-rule-history.json`                                                                                                              |
| 前后加载与随附构建       | 同一隔离入口执行 `e2e/loading-performance.spec.ts`，两个阶段各 1 项/3 个 Profile 通过，退出 0                                                                                                           | `opt10-desktop-loading-baseline-second.log`、`opt10-desktop-loading-after.log`、`opt10-loading-baseline.json`、`opt10-loading-after.json`、`opt10-loading-comparison.json` |
| 依赖组成构建             | `bun --no-env-file <Artifact>/opt10-runtime-composition-after-build.ts`，退出 0，实际产物相等                                                                                                           | `opt10-runtime-composition-after.log`、`opt10-runtime-composition-after/summary.json`                                                                                      |
| 受影响类型与 Lint        | UI、Assistant、Runtime、Desktop 类型通过；最终表单/文案/夹具类型与 Lint 再通过，均退出 0                                                                                                                | `opt10-desktop-extraction-types.log`、`opt10-desktop-extraction-lint.log`、`opt10-rule-history-types-final.log`、`opt10-rule-history-lint-final.log`                       |
| Plugin/Profile 边界      | 架构目录通过，依赖检查 519 模块、1681 依赖、无违规，退出 0                                                                                                                                              | `opt10-desktop-extraction-architecture.log`、`opt10-desktop-extraction-deps-final.log`                                                                                     |

**失败与处置**：保留首轮 Resource Timing 断言失败、旧 prompt 入口失败，以及修复表单隐式标签精确匹配失败。分别用 scriptParsed、界面内输入、明确 aria-label 修复；最终真实桌面完整通过。失败日志为 `opt10-desktop-loading-baseline.log`、`opt10-rule-history-e2e.log`、`opt10-rule-history-e2e-second.log`，失败 HTML/结果均另存，不覆盖为成功。

**来源与资源**：桌面基线为 `opt10-desktop-source-before.json`，在 Cloud 723 份文件上新增测量夹具，成为 724 份。之后新增四个职责模块与一份规则历史 E2E，修改三个原大文件、文案和本执行记录；最终源清单、差量与逐条核对分别保存于 `opt10-source-final.json`、`opt10-desktop-extraction.patch`、`opt10-completion-audit.json`。十个本轮自有 Profile 全部删除，匹配进程为 0，45100 可重新绑定，测量/规则历史/Runtime/助手/Stagehand 测试临时前缀均为 0；见 `opt10-desktop-cleanup.json`。原 HEAD/main 保持不变，无提交、推送、部署、开发库改动或未知进程终止。

OPT10 的 Cloud 要求继续由上一节 21 个列表各 205 条完整历史、过滤、微秒/同值排序、游标拒绝、角色/所有权隔离、契约和实际 Portal/Admin 证据证明；本回合核对对应源码未变化。OPT11 仍须完成覆盖最终工作区的全部静态/业务检查、隔离 Cloud/Desktop E2E、Worker 构建与冒烟、新路径说明和当前宿主未签名包的真实采集、Dataset 与分析验收。整个主目标尚未完成。

### 2026-10-04 OPT11 进行中：最终回归、使用说明与当前资源复测

本阶段补齐 README、[用户路径](../product/user-journeys.md) 与 [本地验证指南](../examples/no-credentials-workflows.md)，覆盖清洗配方、四类分析与分支、条件监控、规则历史修复、隔离 Cloud 和本机包的可运行样例。检查三份文档的 18 个本地链接，缺失为 0，见 `opt11-document-links.json`。加强 `desktop/e2e-packaged/packaged.spec.ts`：独立 Profile、实际 packaged 标志与可执行文件、Worker ready、30 条 Dataset/ready Snapshot、成功分析及导出结果、语料 30 条导出。去掉已过时的分析列表导航预期，沿用当前分析提交后自动打开 Job 的行为；包测试仍在执行，代码存在不等于已经通过。

执行器 `opt11-safe-run.ts` 使用过滤后的 `testEnvironment`、`bun --no-env-file` 和白名单命令，逐条记录命令、开始/结束、退出码与环境方式；不输出继承环境或鉴权信息。初始最终源码清单 `opt11-source-before.json` 共 730 个文件，相对 OPT10 只有上述文档和打包夹具差量，OPT10 实现未改变。Cloud E2E 启动 Next 开发服务器后自动把 `next-env.d.ts` 指向 `.next/dev/types`；记录该生成变化，并在服务器结束后补跑根类型与 Cloud 检查，两项均为 0，见 `opt11-next-env-observation.json`、`opt11-post-e2e-types.log`。

| 检查                         | 实际结果                                                                                                   | 退出码与证据                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 静态、格式、架构与生成客户端 | Lint、Worker Ruff、Prettier、依赖边界、Catalog、Desktop/Worker Client、Cloud 契约、根与 Cloud 类型全部通过 | 各 0；`opt11-static-gates.log` 与逐命令 JSON；后续文档仍需最终格式复核 |
| 全量 TypeScript 业务测试     | 125 个文件、843 项通过，876.92 秒；临时 SQLite/Artifact、真实本地 Chromium/Worker 与显式 Mock              | 0；`opt11-business-gates.log`、`opt11-business-tests.json`             |
| Python Worker 测试           | 73 项通过，3.87 秒；保留 ARIMA 时间频率推断警告                                                            | 0；同一业务日志、`opt11-worker-tests.xml`                              |
| 隔离 Cloud 业务回归          | 18 项工具测试、73 项服务器测试、3351 个服务器断言；21 个列表完整历史、权限、模拟商业流程                   | 0；`opt11-cloud-tests.log`                                             |
| Cloud 浏览器回归             | 3 项通过，17.2 秒；打包商业条件专项 1 项跳过，不计为包验收                                                 | 0；`opt11-cloud-e2e.log`、`opt11-cloud-final-playwright-report/`       |
| 根工程构建                   | Desktop 与 Cloud 全部通过；图表 chunk 提示仍存在                                                           | 0；`opt11-build.log`                                                   |
| Worker 本机构建与二进制冒烟  | 新构建 macOS arm64 PyInstaller onedir；实际归一化、分析与语料验证通过                                      | 各 0；`opt11-worker-package.log`                                       |
| 依赖审计与许可证             | 保持原审计门槛，无新增例外；14 项本地安全补丁测试/42 断言通过；1069 条 Node、51 条 Python 许可证记录       | 各 0；`opt11-static-gates.log`；原构建期 ICNS 例外见 OPT01             |

`opt11-prior-acceptance-revalidation.json` 核对 OPT05–OPT09 的 55 条阶段要求，其中 58 条具名业务证明按文件和用例名称匹配最终报告，全部通过。部分文件在后续任务中改变，因此不声称所有旧源码哈希仍相同；差量见 `opt11-prior-source-revalidation.json`，行为由当前全量业务测试和仍待完成的完整桌面回归补强。

**当前代码资源复测**：后续任务修改过采集与持久化链路，不能把早期 HTTP/SQLite 报告直接当成最终源码实测。沿用不可变原始实现、1024 字节/条分页夹具、同一硬件和测量协议，顺序运行 baseline、stream、pipeline，各 1 万/10 万条三次；Python 另外新建六个 Worker，完成归一化、描述统计与全部 Parquet 数据校验。共 24 组采样，数据均正确。报告与源码哈希在 `opt11-collection-resources/opt04-performance/`、`opt11-python-resources/report.json`，命令和退出码汇总 `opt11-resource-revalidation.json`。

| 三次中位数                        | 1 万条     | 10 万条      |
| --------------------------------- | ---------- | ------------ |
| 原实现 HTTP 耗时                  | 70.093 ms  | 639.422 ms   |
| 当前 HTTP 耗时                    | 84.311 ms  | 648.454 ms   |
| 当前 HTTP 吞吐 / 初始原实现基线   | 84.93%     | 98.30%       |
| 当前 HTTP 增量峰值 RSS            | 60.44 MiB  | 80.50 MiB    |
| 实际 Artifact/SQLite 采集耗时     | 942.347 ms | 11738.773 ms |
| 实际 Artifact/SQLite 增量峰值 RSS | 109.47 MiB | 162.95 MiB   |
| Python 归一化耗时                 | 242.791 ms | 840.820 ms   |
| Python 归一化增量峰值 RSS         | 76.70 MiB  | 104.09 MiB   |
| Python 描述统计耗时               | 73.257 ms  | 69.983 ms    |
| Python 描述统计增量峰值 RSS       | 39.98 MiB  | 49.45 MiB    |

HTTP 10 万/1 万条增量 RSS 比为 1.332，小于 3；两档吞吐均不低于初始基线 80%，相邻重新测量原实现的吞吐比为 83.14%/98.61%，也通过。生产写入 RSS 比为 1.489；没有原始完整写入链路的吞吐基线，不与纯 HTTP 消费器相比。每批最多 250 条，请求数与夹具一致。Python 与浏览器内存不混入 HTTP 门槛；Chromium 真实故障场景内存记录仍见 OPT04，最新桌面恢复路径待完整 E2E 验证。

采样期间没有并行构建、业务套件或其他基准，但公开 Electron ZIP 下载仍在后台，已在报告登记；OS 缓存与调度未受控，短操作的采样峰值是下界，三次结果只作有明确范围的观测，不声称因果性能提升。性能汇总脚本第一次读取错误的记录数键，未改变或重跑实际采样，改用报告中的 `total` 后完成校验；保留各采样原始日志。

**剩余工作**：打包仍在下载公开 Electron 依赖，不能使用工作区已有旧包作为本轮成功证据。等待该命令结束并验证增强的实际包冒烟，再单独运行完整 Desktop E2E，最后核对所有阶段要求、最终差量/哈希、格式与 diff、专属 Compose/进程/Profile/端口清理。OPT11 和整个主目标均保持未完成。

### 2026-10-04 OPT11：当前宿主完整应用包验收通过

首轮公开 Electron 44.0.0 下载完成后，Forge package 退出 0。实际包已完成 Worker ready、动态采集 30 条、Dataset 读取、ready Snapshot 和分析成功检查，但旧的非精确“分析结果”标题同时匹配新增的“比较分析结果”，Playwright 严格定位拒绝两个元素；整条冒烟退出 1。首轮日志、HTML/结果和失败说明分别保留在 `opt11-desktop-package.log`、`opt11-packaged-first-{playwright-report,test-results}/`、`opt11-packaged-first-failure.json`。这里只修正测试为 `exact: true`，没有修改产品行为或放宽成功条件；Desktop 类型和该夹具 ESLint 均退出 0，见 `opt11-packaged-fixture-checks.json`。

第二轮完整执行 `bun --no-env-file run test:smoke:desktop-package`，重新构建并打包当前应用，实际测试 1 项通过、退出 0，测试套件 53.0 秒，命令总耗时约 65.13 秒。应用明确 `app.isPackaged=true`，可执行文件在本次 `desktop/out/ZhiYun-darwin-arm64/ZhiYun.app/Contents/MacOS/ZhiYun`。从包内浏览器完成动态采集，Runtime API 读取全部 30 条 Dataset，输入 Snapshot 为 ready/30 条；包内 Worker ready/ok，分析为 succeeded，导出的 `data.profile` 结果 ID、Snapshot 和 Worker 版本一致；语料实际预览 20/30 条、构建并导出 30 条 JSONL。

结构化证据为 `opt11-packaged-smoke.json`，完整报告保存于 `opt11-packaged-final-{playwright-report,test-results}/`，成功日志为 `opt11-desktop-package-second.log`。包内 Worker 二进制 SHA256 `2f1f4e37e22fcebb31d11dd78d6e8d0c451ec0edd37aec7c511fe973d4bb39f0` 与本轮新 PyInstaller 产物相同。Main 的 packaged 分支只选择 Resources 内 Worker，浏览器目录也来自 Resources；鉴权只在测试闭包内使用，不借用开发 Worker 或正常用户数据。实际目录内非符号链接文件合计 1485723045 字节，属于未压缩 `.app`，不当作安装器下载体积；归档 hash 与路径见 `opt11-packaged-artifact-audit.json`。

`codesign -dv` 显示二进制 ad hoc/linker 签名、TeamIdentifier 未设置，无开发者证书及公证。这里的“未签名包”指本机无需证书的开发分发验证，不声称二进制完全没有本机签名，也没有发布、安装器分发或跨系统验收。首轮和第二轮两个精确 Profile 均已删除，包测试之后匹配该 Profile 的进程为 0；保留源日志与只读观察，不终止未知进程。

额外完成冻结锁文件安装（`--frozen-lockfile --ignore-scripts`，退出 0），当前仍保留最初 573 个采样文件、456 条原迁移删除条目与原 HEAD/main，见 `opt11-frozen-install.json`、`opt11-original-worktree-preservation.json`。当前完整 Desktop 套件已实际收集为 9 个文件/24 项，正单独运行 `test:e2e:desktop`，日志 `opt11-desktop-e2e.log`。尚未有最终退出码，因此 OPT11 与主目标仍未完成；待套件结束后核对所有阶段要求、源码及自有资源，再登记最终结论。

### 2026-10-04 OPT11 完成：最终桌面、逐项要求与资源核对

当前 macOS 27 arm64 工作区的完整 `bun --no-env-file run test:e2e:desktop` 已退出 0，24 项/9 个文件全部通过，14.4 分钟；机器报告明确 expected 24、unexpected 0、flaky 0、skipped 0。完整 HTML/原始结果保存在 `opt11-desktop-final-{playwright-report,test-results}/`，原始嵌入报告 ZIP、报告元数据和八份 JSON 附件另存于 `opt11-desktop-final-report.zip`、`opt11-desktop-report-metadata.json`、`opt11-desktop-evidence/`。`opt11-desktop-acceptance-summary.json` 按实际附件核对下列行为：

- 四类问题调用实际 Worker，保留原始/清洗输入与配方版本；550 行表格完整分页，兼容分支与比较保留父结果，图表加载和渲染失败均保留解释/表格。
- 清洗七步覆盖六类受限操作、撤销/重做、第二个输入复用、类型拒绝与源 Artifact 不变；规则版本比较/回滚及修复验证后激活均通过实际界面。
- Mock 规则首次调用 2 次、复用 0 次、清理后重新调用 2 次；动作确定性缓存复用与清理通过，未推导真实费用下降。
- 条件监控再次完成 52 次成功运行、三类条件、事件/Run 历史、关闭后的记录保留、本地拒绝与生命周期 IPC，外部送达尝试为 0。
- 实际 utility/Main/Renderer 故障均恢复 778 条完整记录和相同统计，旧 Snapshot 不变；Main/utility 同一 job 为 attempt 2，Renderer 为 attempt 1。第四次 Renderer 崩溃停止自动恢复；实际启动后断言失败的专项正确回收自有进程。

最新三类 Chromium RSS 求和峰值分别为 utility 520.20 MiB、Main 440.00 MiB、Renderer 441.09 MiB，范围是本用例采集 Chromium 与 helpers，约 100ms 加 ps 延迟采样，峰值为下界且可能重复计入共享页。对应恢复到结果核对耗时 43.215/42.974/11.330 秒，仍包含 lease 与分页等待；不与 HTTP 或 Python 测量混用。报告 `opt11-desktop-recovery-summary.json`。最终加载三样本中位数为首屏 1551.41 ms、图表首绘 740.86 ms；三份首页有 HomeDashboardPage 正对照且 AnalysisChart 为 0，绘图后均为 1。相对 OPT10 的 matched before/after 观测再次体现时间波动，保留原采样限制，不宣称确定提速。

| 主目标要求                                                  | 最终有效证明                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPT00 基线、隔离、危险目标拒绝与回收                        | 573 个基线文件和 456 个迁移删除条目保留，HEAD/main 不变；当前 Cloud 18 项工具测试含危险 DB/占用端口拒绝，独立 `_test`/Redis/动态端口及最终资源核对             |
| OPT01 原审计门槛、锁、兼容回归、许可证                      | 最终网络审计与补丁回归通过、无新增 ignore；8 项低于 high、1 项原 ICNS 例外明确保留；冻结锁安装、当前类型/测试/构建、两类许可证及包内 hash 一致                 |
| OPT02 多样本、字段质量、非法规则及草稿/模板路径             | 最终业务报告的 extraction/preview/draft 测试，加当前实际三样本保存→运行→Dataset、静态/动态/无限滚动与模板 E2E                                                  |
| OPT03 四类失败、脱敏、不改变结果、所选导出/清理             | 最终 diagnostics Shared/Crawler/Collection/UI 测试，实际三样本流程中的诊断导出与清理；未增加 DOM/截图/任意异常文本默认导出                                     |
| OPT04 四条分批/背压、中断一致性、取消/不可变/回收、资源目标 | 当前 streaming 37 项、browser-rounds 32 项及 queue recovery 12 项；原 37 个采集进程/2 个 Chromium 中断窗口，最新三类真实宿主恢复；当前 24 组独立资源采样及清理 |
| OPT05 本地验证缓存、完整键、失效/降级/隐私与零重复调用      | 完成审计 11 项、最终缓存/原生动作业务测试与两条真实桌面缓存路径；实际调用与命中数保留                                                                          |
| OPT06 状态/Schema/质量验证、授权/注入/隐私、预算与固定评测  | 12 条完成审计，版本 repair-quality-v3 的 44 项固定期望连续两次通过；当前真实修复、权限/成本/停止/隐私业务回归，费用未知不填零                                  |
| OPT07 六类清洗、版本/复用/错误、不可变源及严格契约          | 完成审计 10 项、当前 73 项 Worker/清洗领域/HTTP/Artifact 测试与实际桌面七步路径；仅类型化步骤，无任意公式/Python/SQL 接口                                      |
| OPT08 四类问题、准确溯源、冻结分支、比较拒绝、分页          | 完成审计 10 项、当前 lineage/results 业务回归和四问题真实桌面，550 行/大结果存储/Artifact 离线路径与两类图表故障回退                                           |
| OPT09 三类条件、阈值/冷却/聚合、Run 溯源、睡眠及通知保护    | 完成审计 12 项、当前 scheduler/conditional rules 业务测试和 52 次实际桌面运行；无真实外部通知发送                                                              |
| OPT10 21 个列表完整历史、游标/权限、职责提取与实测          | 每列表 205 条的最新 Cloud 73 项与浏览器；当前全部业务及规则历史 E2E；原 matched 构建/加载与组成报告、当前懒加载正对照，明确没有包体积收益                      |
| OPT11 所有必做命令、当前包、本地样例、最终源码与清理        | 21 个计划脚本全部退出 0，diff/格式/链接通过；24 项完整 Desktop、3 项 Cloud（另 1 条件专项跳过）、1 项实际包、Worker 二进制与全链路报告及最终清理               |

**最终来源与清理**：全量检查开始后的生产实现未变化；包测试只有精确标题定位修正，已用 Desktop 类型、ESLint 和成功包 E2E 验证；Next 自动生成的类型入口已在 Cloud E2E 结束后补跑类型。文档追加按最终格式、链接与 diff 检查复核。所有 730 个记录文件仍存在，没有新增未记录源码；与原始 573 个基线比较，修改 150 个、新增记录 157 个、缺失 0。原迁移删除条目、HEAD/main 保持一致；最终清单为 `opt11-source-final.json`，逐项结论、命令元数据与范围核对为 `opt11-completion-audit.json`。

`opt11-final-cleanup.json` 记录所有阶段工具句柄已终态，自有 Profile/登记进程身份无残留；15 类临时前缀目录均为 0，45100 可绑定，两个当前专属 Compose 项目的容器/卷/网络均为 0，自己的 Electron 下载临时目录已删除。没有针对未知进程或共享环境进行清理。应用包与报告作为交付产物保留，公开依赖缓存正常保留；不把这些产物当成测试残留。

OPT00 至 OPT11 的实施与计划验收全部满足，主目标已完成。实际验证范围限于当前宿主、本地网页/JSON、显式 Mock、模拟商业与隔离数据库。此前的中间失败保留，不覆盖为成功；Cloud 条件包商业专项跳过不当作通过，其主目标所需的独立包采集/数据/Worker 分析已实际通过。EXT01/EXT02 和本文件列明的真实外部事项保持原范围，没有签名公证、发布、推送、生产部署或真实模型/消息效果的完成声明。
