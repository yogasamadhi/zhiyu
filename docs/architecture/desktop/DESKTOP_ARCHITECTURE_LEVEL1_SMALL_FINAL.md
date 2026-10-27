# 基于 DSH 的应用架构：Level 1 小型项目

> 文档类型：Normative Architecture
>
> 共享基线：[基于 DSH 的应用架构](./DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 升级目标：[Level 2 大型封闭项目](./DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md)

---

# 1. 定位

Level 1 用最少的应用自有业务插件建立完整的应用：基础设施组件提供 HTTP、连接认证、Remote、浏览器启动、存储与凭据，应用把自己的业务放进一个应用插件，Engine 以随包发布的插件接入。

```text
Desktop / Web / CLI
        │ HTTP / Remote
        ▼
Host 进程（一棵 Cordis 树）
├── Cordis 框架包
├── 基础设施组件：webserver · web-runtime · connection · gateway · client-modules
│                storage · credentials · settings · subprocess
├── 应用插件 @<scope>/app（Host face + Client face）
│   ├── Application：controller、用例、事务顺序
│   ├── Domain：纯业务模块
│   └── Adapter：存储领域、Engine 调用、外部 API
├── Engine seam（ctx.engines）
└── Engine 插件（随包发布，一个或少数几个）
```

Level 1 不是简化掉基线：进程模型、同端口提供页面与 API、Host/Origin 认证、Remote、Slots 与存储规则全部照基线执行。它只是不把业务拆成多个插件，也不开放安装。

---

# 2. 适用条件

适合：

- 单人或小团队；
- 单一产品目标；
- 功能全部由官方维护；
- 业务模块数量稳定；
- 不需要用户安装插件；
- 不需要多个产品形态的 Profile。

产品只是 MVP、但已确定会发展为多业务域时，仍可从 Level 1 起步：基线边界不变，升级时只是把应用插件拆分为业务插件。

---

# 3. 组合

- 一个应用组合包 `bundle-app`：按顺序插入基础设施组件条目（按基线 §1.2 的依赖闭包）、应用插件、Engine seam 与随包 Engine 条目。
- Profile：`web` 与 `desktop`；需要一次性运行时增加 `headless`。三者都叠放 `bundle-app`，由各自的 Profile patch 区分 HTTP 载体与运行入口。
- 测试与端到端组合用 `--patch` overlay。
- 不挂载插件管理组件，启动器不提供 `plugin` 命令，原生恢复不提供“禁用第三方插件”。
- 配置 HMR 可在 `web` 与 `desktop` 启用，`headless` 禁用；开发期客户端热更新照基线。

---

# 4. 应用插件内部结构

应用插件是一个同时有 Host face 与 Client face 的包。Host face 内部按三层组织：

## 4.1 Application

- 实现 `@Remote` controller 与用例，拥有 mutation 顺序与访问策略。
- 通过 `inject` 获取 `ctx.storage`、`ctx.credentials`、`ctx.engines` 等服务。
- 只有 Application 与 Adapter 接触 Cordis `ctx`。

## 4.2 Domain

- 纯业务规则与数据类型，不导入 Cordis、基础设施组件、Node API 或 Adapter。
- 通过 Application 传入的接口访问持久化与 Engine。

## 4.3 Adapter

- 用 `defineDomain` 声明应用拥有的存储领域。
- 调用 `ctx.engines`、外部 HTTP API 与子进程；凭据只经 `CredentialRef` 解析。
- 长生命周期资源经 `ctx.effect()` 登记。

Client face 提供 Client model 与 UI 插件：model 基于生成的 Remote 类型，UI 经 Slots 注册，样式使用主题组件的 token 与控件组件。

---

# 5. 模块边界

```text
Application → Domain
Application → Adapter 接口
Adapter     → Domain 类型、基础设施服务
Domain      → 无
```

- Domain 不依赖 Application 或 Adapter。
- 模块之间不通过全局可变状态共享数据。
- 应用插件是它所有存储领域、路由、Remote namespace 与 UI 贡献的唯一所有者。

---

# 6. Engine

- Engine 照基线 §9 作为 `ctx.engines` 的 Provider 插件，与应用插件是不同的包。
- Engine 插件随应用发布，在 `bundle-app` 中固定挂载；增减 Engine 是一次应用发布。
- 交给 Engine 的输入与 Engine 报告的结果写入仅追加 Session 日志。

---

# 7. 数据、任务与事件

- 存储照基线 §8：一个领域一个声明，格式以版本与兼容列表演进。
- 后台任务由应用插件经 effect 管理，插件卸载时停止并排空。
- 应用事件通过声明合并定义，持久事实写入日志或存储领域，选定事件经 `$events` 转发给 Client。

---

# 8. 推荐仓库结构

```text
<repo>/
├── apps/
│   ├── cli/
│   ├── desktop/
│   ├── desktop-host/
│   └── web/
├── packages/
│   ├── infra/<name>/   # 基础设施组件（基线 §1.2）
│   ├── app/            # 应用插件：src/host/{application,domain,adapter}，src/client
│   ├── engine-api/     # ctx.engines Service Definition
│   ├── engine-<id>/    # Engine 插件
│   └── bundle-app/     # 应用组合包
└── vendor/deepseek-harness/
```

---

# 9. MUST

1. MUST 遵守共享基线的全部 MUST。
2. MUST 把业务放在一个应用插件中，并按 Application / Domain / Adapter 分层。
3. MUST 让 Domain 不依赖 Cordis、基础设施组件、Node API 与 Adapter。
4. MUST 让 Engine 作为独立的 Provider 插件随包发布。
5. MUST 用一个应用组合包组成 `web`、`desktop` 与可选 `headless` Profile。

---

# 10. SHOULD

1. SHOULD 让 Application 层的每个用例可以在不启动 HTTP 载体的情况下测试。
2. SHOULD 让 Domain 测试不需要 Cordis 上下文。
3. SHOULD 在 Engine 数量增长或需要按产品形态选择 Engine 时考虑升级 Level 2。

---

# 11. MUST NOT

1. MUST NOT 挂载插件管理组件或提供 `plugin` 命令。
2. MUST NOT 把业务代码写进 Electron 主进程、preload 或 Desktop Host 入口。
3. MUST NOT 让 Domain 直接访问存储、凭据或 Engine。
4. MUST NOT 为了“插件化”把一个稳定的小产品拆成多个业务插件。

---

# 12. 升级到 Level 2 的触发条件

出现以下多个信号时升级：

```text
业务域快速增长
多人或多团队长期并行
业务模块需要独立启停或独立生命周期
需要多个产品形态的 Profile
需要按 Profile 选择 Engine
应用插件内部的数据所有权开始模糊
```

升级时把应用插件按业务域拆为多个第一方插件，把 `bundle-app` 拆为 base / web / headless / 业务域 / Engine 组合包；基线、进程与 HTTP 边界不变。

---

# 13. 最终模型

```text
Clients
   │ HTTP / Remote
   ▼
Host（Cordis 树）
├── Cordis 框架包 + 基础设施组件
├── 应用插件（Application / Domain / Adapter）
└── Engine 插件
```

Level 1 的目标是以最少的应用自有机制得到完整、可测试、可演进的应用。
