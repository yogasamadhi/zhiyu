# 无需外部凭据的本地优化验证指南

这些样例使用本地网页、JSON、Mock AI、模拟支付和独立临时数据库。业务 Token、API Key、支付密钥与签名证书均不需要用户填写。命令从仓库根目录执行，前提是已安装 README 中列出的 Bun/Node/Python/uv、项目依赖及本地 Chromium；Cloud 验证另外需要本机 Docker。

## 手动体验内置样例

打开桌面应用，在首页选择内置商品样例，确认字段与预览后保存运行。进入任务的数据页查看 Dataset；创建输入版本后可以预览清洗、保存配方并在分析页运行。这个样例不需要访问公网或配置模型。

条件监控需要多次成功采集才能建立基线和产生变化。下面的自动样例会控制本地数据变化，无需编辑正常任务、修改系统睡眠状态或配置通知渠道。

## 按用户路径运行样例

`desktop:test` 使用过滤后的测试环境，构建当前桌面并启动自有本地夹具。各专项创建独立临时 Profile，API 的 nonce/token 由应用在测试内部生成；结束后关闭自有应用并清理目录。测试不继承外部 Provider、支付或签名凭据，不读取正常桌面数据。

| 路径                  | 本地数据与检查结果                                              | 测试文件                         |
| --------------------- | --------------------------------------------------------------- | -------------------------------- |
| 多样本字段与列表/详情 | 三个本地列表/详情样本，确认字段并运行到 Dataset                 | `e2e/desktop.spec.ts`            |
| 规则/动作缓存         | 本地商品页面、显式 Mock 调用数、复用与手动清理                  | `e2e/rule-cache.spec.ts`         |
| 助手预算与费用说明    | Mock/估算、历史恢复和预算停止，不当成真实模型账单               | `e2e/assistant-cost.spec.ts`     |
| 清洗配方              | 确定夹具包含空白、空值、转换失败、重复与拆分/合并；旧输入不改写 | `e2e/cleaning.spec.ts`           |
| 四类分析与分支        | 550 条本地记录，清洗后分析、分页、冻结输入与图表失败回退        | `e2e/analysis-questions.spec.ts` |
| 条件监控              | 本地价格、数量、空值变化；事件/Run 溯源、通知失败与错过后补跑   | `e2e/monitoring.spec.ts`         |
| 规则版本与修复        | 两条本地商品记录，比较、回滚、Mock 修复、测试后应用及拒绝       | `e2e/task-rule-history.spec.ts`  |
| 进程中断恢复          | 自有 Collection 进程和临时数据，URL/批次边界后的恢复            | `e2e/recovery.spec.ts`           |

例如只运行清洗与四类分析：

```bash
bun --no-env-file run desktop:test e2e/cleaning.spec.ts e2e/analysis-questions.spec.ts
```

只运行规则历史与修复：

```bash
bun --no-env-file run desktop:test e2e/task-rule-history.spec.ts
```

确定的清洗输入与预期输出见 `desktop/tooling/evaluations/cleaning-fixtures.json`。固定修复夹具见 `desktop/tooling/evaluations/rule-repair-cases.ts`，离线评测入口为：

```bash
bun --no-env-file run ai:evaluate
```

评测报告固定夹具的验证、拒绝、调用与耗时，不证明真实网页覆盖率、模型准确率或线上费用。

## Cloud 完整历史与商业回归

```bash
bun --no-env-file run cloud:test
bun --no-env-file run test:e2e:cloud
```

入口自行创建随机 Docker Compose 项目、独立 PostgreSQL/Redis 与动态端口；数据库以 `_test` 或 `_e2e_test` 结尾，结束后清理自有资源。不要将它们改成连接开发或生产数据库的手动测试命令。

服务端样例对 21 个列表分别读取 205 条历史，以每页 17 条核对完整序列；浏览器样例读取五页历史、搜索最旧记录、切换筛选和账户视图。商业流程使用模拟购买、订阅、支付通知与取消续费。打包商业场景可能因其连接条件跳过；跳过不等于完成本机安装包验收。

## 首屏与图表加载观测

```bash
bun --no-env-file run desktop:test e2e/loading-performance.spec.ts
```

顺序启动三个新 Profile，每次真实采集 24 条 JSON 并由本地 Worker 完成分组分析。报告在 `desktop/test-results/` 下的 `loading-performance.json`，包含首屏、图表首绘、独立的数据准备时间、已解析脚本和相关 bundle 大小/hash。首页应没有 AnalysisChart 脚本，结果绘制后应出现它。

测量时不要并行构建或运行其他基准。新 Profile 不等于清空 OS 文件缓存，三次样本只作观测，不能据此声称统计上证明提速。Node zlib、Python gzip 与 Vite 使用不同压缩方法，比较时采用同一口径。

## 当前宿主的未签名包

```bash
bun --no-env-file run worker:build
bun --no-env-file run worker:smoke
bun --no-env-file run test:smoke:desktop-package
```

最后一个入口过滤环境，构建并打包当前宿主应用，再用独立 Profile 运行本地动态采集、读取 Dataset、创建 ready Snapshot、完成 Worker 分析并导出结果。还会检查语料预览、构建和 30 条导出记录。报告为 `desktop/test-results/` 下的 `packaged-smoke.json`，结束时由测试清理 Profile；不替换已安装应用，也不使用开发者证书、公证、发布或部署。macOS 二进制可能包含本机 ad hoc 签名，它不需要用户提供证书。

Worker 构建只生成当前操作系统和架构的本地产物，不能据此声称其他系统安装与运行已验证。

## 查看实际验收状态

样例可运行与本轮验收通过是两件事。当前任务状态、命令退出码、性能观测、失败处置和资源清理证据，以 [优化执行记录](../verification/zhiyun-no-credentials-optimization.md) 为准；完整范围见 [优化实施计划](../product/zhiyun-no-credentials-optimization-plan.md)。
