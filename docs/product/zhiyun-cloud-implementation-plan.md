# 织云商业平台实施与验收计划

应用目录收敛为 `desktop/` 与 `platform/`：Electron 及其本地运行时位于 `desktop/`，Portal、Admin 和 Server 分别位于 `platform/portal`、`platform/admin`、`platform/server`；已取消旧浏览器工作台与 Headless 发行入口，详见 [ADR 0011](../adr/0011-desktop-cloud-apps.md)。

更新：2026-09-10。对应 [商业架构规范](../architecture/ZHIYUN_CLOUD_COMMERCIAL_ARCHITECTURE.md)。本轮目标为 Web、Admin、Server 与 Electron 账户/AI 接入的可运行测试交付。

## 一、已确定的商业规则

1. 非 AI 桌面功能始终免费，包括采集、分析、语料、定时任务、导出和本地数据管理。
2. 自带 API Key 免费使用 AI 助手，不要求云账户或订阅，密钥留在本机。
3. 订阅提供平台托管 AI 和每月积分，月付/年付均按月给额度；未用积分不结转。
4. 本轮只实现模拟微信、模拟支付宝，不实际扣款；自动签约、周期收费、取消、退款也全部模拟。
5. 管理员配置并发布完整的价格、积分、模型和费率版本后才开放测试购买；商品默认未发布、试用关闭、无积分加购包。
6. 工具和数据工作由 Electron 执行；云端只转发必要模型上下文与计量，默认不保存对话正文。
7. 托管模式实时校验订阅、积分和最多 2 台设备；不会自动切换到用户 Key。

## 二、P0–P5 实施对应

| 阶段              | 已落地的代码与行为                                                                                                                                                                                  | 验证入口                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| P0 工程和数据库   | `platform/portal`、`platform/admin`、`platform/server`；共享 `platform/packages/cloud-{contracts,client,ui}`；Drizzle 模型、SQL 迁移、PostgreSQL 事务、Redis 回退；API/Worker 双入口；独立命令与 CI | `cloud:check`、`cloud:build`、`architecture:deps`、`cloud:test` |
| P1 身份与页面     | 手机/邮箱验证、密码登录、重置、验证绑定、会话撤销；独立后台身份/TOTP/RBAC；官网、用户中心、后台运营页面；同源代理、CSRF、所有权、no-store                                                           | 真实数据库身份测试、Web E2E                                     |
| P2 模拟支付和积分 | 两渠道成功/失败/取消/延迟/重复/乱序/未知；不可变价格及快照、日历服务期、按月积分；预占/结算/释放/过期/调整；渠道确认退款                                                                            | `platform/server/tests/platform.test.ts`                        |
| P3 AI 和 Electron | 明确 hosted/byok；PKCE、safeStorage、主进程代理；现有 Provider 的所有模型调用复用 hosted transport；流式工具事件、服务端用量、幂等与 review；本地工具无商业门禁                                     | Provider 回归、网关测试、打包应用商业 E2E                       |
| P4 运营和交付     | 商品/模型发布、连接测试、退款、积分补偿、设备撤销、异常请求补偿、失败任务重排、审计/指标；容器、HTTPS 路由、环境示例、备份恢复                                                                      | 构建、容器、运行手册及下面的验收证据                            |
| P5 模拟自动续费   | 微信/支付宝签约、原账期唯一收费意图、查询恢复、取消、切换渠道前结束旧协议；可注入时钟与跨应用实例恢复                                                                                               | 两渠道周期测试、取消及服务期保留测试                            |

代码评审重点：数据库约束与事务决定支付和积分正确性；浏览器状态、Redis 和 Electron 展示缓存不决定权益。`review` 请求不会被后台自动再次发送给模型。

## 三、从空库运行

```bash
bun install --frozen-lockfile
bun run cloud:infra
bun run cloud:migrate
bun run cloud:dev
```

默认访问 Portal `http://localhost:3100`、Admin `http://localhost:3101`。API 为 `http://localhost:3200/api/cloud/v1`。这些命令独立于 `bun run dev` / Electron 启动；桌面本地功能不需要先启动云数据库。

使用安全的终端环境设置 `CLOUD_BOOTSTRAP_EMAIL`、`CLOUD_BOOTSTRAP_PASSWORD`，然后运行：

```bash
bun run --filter @zhiyun/cloud-server admin:create
```

导入命令输出的一次性 TOTP 注册 URI，登录 Admin，按以下顺序完成测试准备：

1. 创建 mock 模型，设置测试积分费率、上下文和输出上限；点击测试启用。
2. 创建月付或年付价格版本，指定每月积分及已启用模型；发布测试商品。
3. Portal 注册/验证或登录，购买测试套餐，在模拟收银台选择结果。
4. Electron 设置 → AI 模型 → 登录云账户，在系统浏览器授权设备。
5. 刷新账户、选择托管模型并切换为 hosted；验证助手调用与积分流水。
6. 手动切换 BYOK，确认本地功能可继续运行；在 Portal 解绑设备、取消未来续费；在 Admin 核查模拟退款及审计。

本地开发不预置公开售价、不自动创建管理员、不自动发布测试商品。E2E 种子只能写入独立的 `_e2e_test` 数据库，不写入开发或生产业务库。

## 四、验收矩阵

| 范围     | 本轮自动化覆盖                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 身份隔离 | 一次性验证码、失败次数提交、验证绑定冲突、邮箱密码重置撤销会话、用户资源越权、Origin/CSRF、用户/后台身份隔离、MFA 必需与重放 |
| 桌面凭证 | PKCE S256/redirect 绑定、一次性码、2 台设备限制、刷新重放撤销 family、设备撤销后拒绝托管                                     |
| 支付     | 两渠道重复/乱序通知、支付成功后迟到失败、关单后确认成功、unknown 查询原支付、退款确认前后权益                                |
| 订阅     | 月底、闰年、年付逐月发放、提前续费不补充当前额度、取消续费保留已付服务期、同产品单协议                                       |
| 积分     | 并发预占不透支、重复结算、过期后释放不恢复额度、退款后保留消费记录、异常 usage 转 review                                     |
| 网关     | SSE、function tool_call、多次调用关联回合、重复 ID 不调用两次、缺少 usage、上游异常、取消、跨应用实例恢复                    |
| 运维     | Redis 故障回退、数据库迁移、持久任务恢复、环境拒绝生产模拟、未发布或模型不完整拒绝购买                                       |
| 浏览器   | Admin 发布 → Portal 购买 → 重复模拟通知 → 余额/订单 → 签约和取消 → 退出；独立浏览器隔离；390/1440 宽度公共页面无横向溢出     |
| 原有桌面 | AI Provider 单元回归、桌面助手/静态采集/动态采集/隔离登录/离线样例/响应式与可访问性、打包程序完整采集分析                    |

### 可复现命令

```bash
bun run cloud:check
bun run cloud:test
bun run cloud:build
bun run architecture:deps
bun run cloud:e2e
bunx vitest run desktop/packages/ai-runtime/test desktop/packages/plugins/ai-assistance/test/provider-catalog.test.ts desktop/packages/plugins/ai-assistance/test/pi-adapter.test.ts
bun run desktop:test
bun run desktop:package
bun run --filter @zhiyun/desktop test:packaged
CLOUD_DESKTOP_E2E=true bun run cloud:e2e
```

最后一条在 macOS 上使用实际打包的 `.app`，需要先执行 `desktop:package`。它校验 `app.isPackaged`，通过独立浏览器完成真实本地 PKCE 流程，验证加密凭证文件、模拟购买、托管助手、手动 BYOK、解绑与退出。CI 的 Linux Web 作业跳过这一 macOS 专项，不能把跳过当作通过。

最终执行结果集中记录于 [交付验收记录](../verification/zhiyun-cloud-acceptance.md)，包含命令、实测范围与尚未开展的外部联调。后续代码改变后需重新执行受影响的检查，不沿用旧结果。

## 五、本轮边界与后续接入

- 真实微信/支付宝主动支付、签约、代扣、退款：本轮不引入能力，也没有联调结果。
- 阿里云短信和 SMTP：适配代码及关闭开关已提供，真实账户、模板、发件域及送达结果未验证。
- 真实 OpenAI-compatible 测试模型：配置、地址允许列表、测试密钥引用与预算已提供；本轮使用模拟上游及流式故障夹具，不消耗真实模型资源。
- 公网域名、证书、备案/商户合同、生产资源池：未开通，未执行公网生产部署。
- 试用默认关闭；本轮没有开放自助领取试用、积分加购包、比例升降级或部分金额退款。当前退款为模拟全额退款。
- 管理表格首版查询最近 200 条并提供筛选；长期运营的大规模历史检索与导出可另立迭代，不改变账本存储完整性。
- 不明上游用量需要人工核查与补偿释放；标准兼容协议没有通用历史账单查询，本轮不把推测的 Token 数当作真实费用。

这些外部事项必须单独记录供应商环境、测试账户、真实响应和验收日期。模拟结果不替代真实联调，也不意味着已经具备正式收款资格或生产模型资源。
