# macOS arm64 验收记录

日期：2026-10-26。目标宿主为 DeepSeek Harness **0.2.1-rc.3**；Web 和已安装 Desktop 使用同一个 `dsh-zhiyun@0.1.0` tarball。本文记录在真实宿主上运行的自动化验收。

## 安装产物

- 文件：`out/dsh-zhiyun-0.1.0.tgz`，565,095,711 字节。
- SHA-256：`76c3682e83c8a0e6cec142279f877be1abd127498c3be4f5509efe2c7143dfec`。
- 随包 Node v24.18.0、better-sqlite3 13.0.3、冻结的 macOS arm64 Worker、Playwright 1.62.1 与 Chromium 1234。
- `resources/manifest.json` 校验 40 个资源文件；浏览器、Worker 和运行依赖以保留符号链接的压缩包交付。首次启动校验并展开到当前 profile 的 Runtime 缓存。
- `THIRD_PARTY_NOTICES.json` 包含资源版本、宿主依赖声明、607 个实际 Runtime 包及 51 个 Python 包的许可证信息；仓库 Node 许可证清单作为保守超集一并提供。

报告位于源码目录，不写入已经验收的 tarball，避免修改报告改变安装包校验值。

## 实际宿主验收

| 项目                                                 | Web                                          | Desktop                              |
| ---------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| tarball 安装，侧边栏与工作台打开                     | 通过                                         | 通过                                 |
| 手动规则的静态采集、动态 Chromium 采集，各 12 条记录 | 通过                                         | 通过                                 |
| 幂等运行、过期版本返回 412                           | 通过                                         | 通过                                 |
| Snapshot、清洗预览和执行、统计分析                   | 通过                                         | 通过                                 |
| 原始 Snapshot 指纹不变                               | 通过                                         | 通过                                 |
| 语料预览、构建及导出 Artifact                        | 通过                                         | 通过                                 |
| 503 故障触发持久监控告警                             | 通过                                         | 通过                                 |
| 主题、语言、内部路由及关闭面板后 Runtime 保持运行    | 通过                                         | 通过                                 |
| 禁用后子进程退出，重新启用后历史可读                 | 通过                                         | 通过                                 |
| 文件传输                                             | 分块下载及工作区保存通过                     | 工作区原生保存通过                   |
| DSH 模型适配                                         | 无默认模型时手动业务、Agent 指定模型调用通过 | 明确的本地 Fixture Provider 调用通过 |

Web 额外通过：两个 Workspace 的数据隔离、DSH 凭据引用绑定、工作台手动凭据输入。保存后的任务响应不含凭据明文。模型测试只使用 `zhiyun-fixture` Provider，不调用真实模型账户。Web 额外创建真实 DSH Agent，通过工具注册表调用 AI 规则分析，确认使用 `fixture-agent` 模型；持久用量事件中的模型、Provider 与 `billingSource: dsh` 均核对通过。

Web 独立安装位于 `/private/tmp/zhiyun-dsh-independent/`，由独立安装的官方 CLI 启动；macOS sandbox 拒绝读取整个原仓库，并拒绝执行 Python/uv。该受限进程仍完成上述业务闭环。自动化浏览器驱动运行在 sandbox 外，驱动文件不属于插件运行依赖。未以仓库链接安装代替独立安装。

实际安装的 Desktop 为 `/Applications/DeepSeek Harness.app`。验收使用独立 DSH home、profile 和 Electron user-data-dir，未修改用户日常 profile。

## 接口、资源与生命周期

- 真实 DSH 工具注册表执行 `zhiyun_workspaces`、`zhiyun_operation_schema` 和业务查询通过；操作目录共 147 个白名单操作，注册 11 个工具。
- 真实 Typert Gateway 拒绝非 owner Peer。事件流取消后从持久 cursor 重连，序号从 1 继续到 2；已取消请求及任意导出目录凭据被拒绝。
- 插件测试 6 项通过，覆盖白名单、路径与凭据边界、条件响应、Artifact 流取消、真实 SQLite/冻结 Worker、队列模型身份持久化、Runtime SIGKILL 后 Worker/浏览器回收及重新启动。
- 受限 Web 宿主正常退出后，验收追踪的 Host、Runtime、Worker 均不存在；Desktop 退出后自有进程列表也为空。
- Host、Client、Runtime、Workbench 类型检查、ESLint、格式检查和构建通过。构建检查 Node 语法及 React Query 单实例，防止迁移构建工具后生成不可用产物。
- 公共客户端测试 7 项通过，包括 Workspace 切换期间旧请求不能跨传输层执行的回归。
- Python Worker 测试 73 项通过，包含全部 18 种分析方法；ARIMA 夹具有一个日期频率推断提示。
- 产品架构生成一致性和依赖边界通过：611 个模块、1823 条依赖。

最终全量 TypeScript 业务回归通过：127 个测试文件、859 项测试全部通过，用时 876.65 秒。包括持久队列 SIGKILL 恢复、浏览器轮次恢复、取消、Worker 故障恢复、版本冲突及规则缓存回归。此前两轮各 858 项中有一个不同的浏览器时序用例失败，分别单独重跑通过；保留这些历史日志，最终全量结果以 `business-tests-release.log` 为准。

## 证据

日志和截图位于仓库 `.artifacts/dsh-plugin/`：

- `artifact-sha256.txt`、`package-final.log`：产物身份与打包清单。
- `independent-install-final.log`、`desktop-install-final.log`：两种宿主安装记录。
- `independent-e2e-final.log`、`desktop-e2e-final.log`：完整业务与生命周期结果。
- `independent-interface-final.json`、`desktop-interface.json`：真实工具注册表与 Gateway 结果。
- `repository-denied.log`、`python-denied.log`、`uv-denied.log`：独立安装约束实际生效。
- `web-pages.png`、`web-dataset.png`、`desktop-workbench.png`：真实工作台截图。
- `test-final.log`、`client-tests-final.log`、`worker-tests-final.log`、`business-tests-release.log`：最终测试记录。
- `typecheck-final.log`、`lint-final.log`、`format-check-final.log`、`architecture-final.log`、`shutdown-final.json`：工程与回收检查。
- `model-usage-final.json`：真实 Agent 工具调用的持久模型用量与费用来源。
- `business-tests.log`、`business-tests-final.log`、`recovery-regression.log`、`action-cache-regression.log`：此前波动及单独重跑记录。

本次未进行公开发布、签名公证、其他宿主版本或其他平台架构验收。冻结 Worker 和浏览器增大了安装包体积，首次启动需要展开资源；后续启动复用当前 profile 的缓存。签名发布前仍需重新按目标发布流程审核资源及许可证。
