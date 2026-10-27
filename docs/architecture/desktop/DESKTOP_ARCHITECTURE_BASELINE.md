# 基于 DSH 的应用架构

> 文档类型：Normative Architecture
>
> 架构参照：[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 仓库的 `docs/architecture.zh.md`
>
> 适用范围：参照 DSH 架构、复用 DSH Cordis 框架构建的桌面、Web 与无界面应用

---

# 0. 文档权威

本文定义一套通用应用架构：应用完全参照 DeepSeek Harness（下称 DSH）的架构，直接复用 DSH 的 Cordis 框架包；HTTP、Remote、浏览器启动、存储、凭据等基础设施由应用自己的组件提供，这些组件按 DSH 对应组件的设计编写，可以从 DSH 源码复制改写。应用在其上用自己的插件、组合包和 Profile 组装出自己的应用。本文不针对任何具体产品；产品的业务域、品牌和定位由各应用自己的文档定义。

本文是三个层级共享的基线。应用按规模与开放程度选择 [Level 1 小型项目](./DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md)、[Level 2 大型封闭项目](./DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md) 或 [Level 3 大型开放项目](./DESKTOP_ARCHITECTURE_LEVEL3_LARGE_OPEN_FINAL.md)（见 §1.3）；层级文档只在本基线之上增减组合粒度与开放能力，不改变进程、HTTP 与插件模型。

本文未覆盖的设计问题，以 DSH 对应文档和源码的做法为设计参照，不另立一套。本文描述规范，不记录实现进度。

文中 `<app>` 表示应用名（启动器命令、URL scheme、目录名与 `package.json` 字段名），`<APP>` 是它的大写形式（环境变量与全局变量），`@<scope>` 表示应用自有包的 npm scope。

---

# 1. 分层

```text
┌─ 应用层（应用自有）──────────────────────────────────────────┐
│ 启动器 · Electron 壳 · Desktop Host · Web 壳 · 组合包 · Profile │
│ 业务插件 · Engine seam 与各 Engine 插件 · 业务 UI 插件          │
├─ 基础设施组件层（应用自有，参照 DSH 组件编写）──────────────────┤
│ 启动与 Profile · HTTP 载体 · 连接认证 · Remote · 客户端模块      │
│ 浏览器启动 · Slots/渲染器/主题/控件 · 存储 · 凭据 · 设置 · 子进程 │
├─ Cordis 框架层（直接复用 DSH 锁定快照，不修改）─────────────────┤
│ Cordis · Cosmokit · Schemastery · Loader · Include · Group      │
│ Timer · HMR · Logger Console                                    │
└──────────────────────────────────────────────────────────────┘
```

依赖只能自上而下：应用层依赖基础设施组件层与框架层，基础设施组件层只依赖框架层与通用第三方库。基础设施组件不含任何产品内容（品牌、业务域、产品文案、产品组合包），因此可以在同一组织的多个应用之间共享。

## 1.1 复用的 Cordis 框架包

| 包                                          | 用途                                               |
| ------------------------------------------- | -------------------------------------------------- |
| `@deepseek-ai/cordis`                       | 插件、上下文、服务、事件、effect 与 Fiber 生命周期 |
| `@deepseek-ai/cosmokit`                     | 通用工具                                           |
| `@deepseek-ai/schemastery`                  | `Config` schema 与校验                             |
| `@deepseek-ai/cordis-plugin-loader`         | 从配置树加载插件                                   |
| `@deepseek-ai/cordis-plugin-include`        | `cordis.yml` 包含与 `applyEntryPatches`            |
| `@deepseek-ai/cordis-plugin-group`          | 配置条目分组                                       |
| `@deepseek-ai/cordis-plugin-timer`          | `ctx.timer`                                        |
| `@deepseek-ai/cordis-plugin-hmr`            | 模块热重载                                         |
| `@deepseek-ai/cordis-plugin-logger-console` | 控制台日志                                         |

这些包是应用唯一直接依赖的 DSH 代码。DSH 的其他包（`dsh-*` 组件包、组合包、`dsh` CLI 与 `apps/*`）都不作为依赖。

## 1.2 基础设施组件

每个组件是应用自有的 Cordis 插件包，包名为 `@<scope>/infra-<name>`，按右列 DSH 包的设计编写。组件沿用 DSH 的 `ctx` 服务键与服务契约，因此 DSH 的子系统文档对它们同样适用，从 DSH 复制的代码也不需要改动调用方。

| 能力               | 参照的 DSH 包                                                                                                                                   | `ctx` 键 / 入口                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 启动与 Profile     | `dsh-app-boot`、`dsh-home-paths`、`dsh-launch-environment`、`dsh-cmdline`、`dsh-http-proxy`                                                     | 由应用启动器调用（见 §4）；`ctx.profileContext` 由启动器提供  |
| 配置 HMR           | `dsh-hmr`（`packages/boot/hmr`）                                                                                                                | 配置监视与重新组合，基于框架的 HMR 与 Timer                   |
| 设置与配置编辑     | `dsh-settings`、`dsh-config-editor`                                                                                                             | 设置分节、`ctx.configEditor`                                  |
| HTTP 载体          | `dsh-host-webserver`                                                                                                                            | `ctx.webServer`                                               |
| Web 运行与静态页面 | `dsh-web-app`、`dsh-host-frontend-static`                                                                                                       | Web 启动参数与回退席位（见 §6.2）                             |
| 连接与认证         | `dsh-client-connection`                                                                                                                         | `ctx.connection`                                              |
| Remote             | `dsh-typert-registry`、`dsh-typert-loader`、`dsh-typert-protocol`、`dsh-typert-generator`、`dsh-api-gateway`、`dsh-api-remotes`                 | Host：`ctx.typert`、`ctx.typertGateway`；Client：`ctx.remote` |
| Remote 访问控制    | `dsh-api-remote-access`                                                                                                                         | `ctx.remoteAccess`：按调用方类型的方法级策略                  |
| 客户端模块         | `dsh-client-modules`、`dsh-client-hmr`                                                                                                          | `ctx.clientModules`                                           |
| 浏览器启动         | `dsh-client-web`                                                                                                                                | 两阶段启动                                                    |
| UI 基座            | `dsh-client-ui-slots`、`dsh-client-ui-renderer`、`dsh-client-ui-theme`、`dsh-client-ui-primitives`、`dsh-client-ui-layout`、`dsh-client-locale` | Slots、React 根、主题、控件、文案                             |
| 存储               | `dsh-storage`、`dsh-storage-domain`、`dsh-storage-json`、`dsh-storage-sqlite`                                                                   | `ctx.storage`                                                 |
| 凭据               | `dsh-credentials`、`dsh-credentials-local`                                                                                                      | `ctx.credentials`                                             |
| 子进程             | `dsh-subprocess`、`dsh-subprocess-local`                                                                                                        | `ctx.subprocess`                                              |
| 插件管理           | `dsh-plugin-manager`、`dsh-plugin-market`                                                                                                       | `ctx.pluginManager`（只在 Level 3）                           |

- 组件之间的依赖按 DSH 对应包的 `inject` 关系保持：例如网关需要 `typert` 与 `remoteAccess`，静态页面需要 `webServer` 与 `connection`，连接需要 `credentials`。挂载以依赖闭包为单位，缺少的服务由另一个组件或启动器提供，否则依赖方一直等待，不会启动。
- 应用只编写它用到的组件；DSH 中的其他能力（人工审批与提问、设置页、Agent 栈等）在需要时同样以参照方式编写。
- Engine 不属于基础设施组件，见 §9。

## 1.3 复用规则

- 应用是独立项目，不是 DSH 的二次开发：不以 DSH 仓库或 DSH 产品（`dsh` CLI、`apps/*`、DSH 组合包与 Profile）为起点修改。应用参照 DSH 的架构编写自己的启动器、壳、Host、基础设施组件、业务插件与 UI。
- Cordis 框架包以原包名和原版本取自锁定的 DSH 快照，源码与许可证保持不变；不 fork、不打补丁，定制只经 Cordis 的方式：改 `config`、用 patch 禁用或替换条目、挂载另一个实现同一 Service 的插件。
- DSH 以 MIT 许可发布。基础设施组件、启动器、壳与 Host 可以从 DSH 源码复制改写：复制的文件保留 DSH 的版权与许可声明，应用的第三方声明记录来源路径与 DSH 版本。复制后的代码归应用所有，可以按应用需要演进；DSH 升级时由应用决定是否对照来源合并。
- 复制时去掉 DSH 的产品内容，换成应用自己的：
  - 包在 `package.json` 的 `<app>` 字段声明自己：`<app>.profile`、`<app>.bundle.patch`、`<app>.client`。
  - 应用 home 由 `<APP>_HOME` 决定，默认 `~/.<app>`；应用与独立安装的 DSH 互不共享 Profile 和数据。
  - 认证 cookie 前缀、认证失败提示中的命令名、新建 Profile manifest 的名称与浏览器启动全局变量（`window.__<APP>_BOOT__`）使用应用名。
  - Profile 模板、默认组合包、官方组合包目录与默认备用注册表（DSH 为 `registry.npmmirror.com`）由应用自己定义。
- 升级 DSH 快照只影响框架包；每一项对外可感知的破坏性变化记入应用的升级指南。

## 1.4 层级

Level 1、Level 2、Level 3 是复杂度与开放程度的选择，不是质量排名。三个层级都建立在本基线上：同样的 Cordis 插件模型、Profile 叠加、进程模型、Web/HTTP/Remote 与数据规则；区别只在应用自有业务代码的插件粒度，以及是否允许用户安装外部代码。

```text
Level 1 = 小型产品：一个应用插件 + 基础设施组件 + 随包 Engine
Level 2 = 大型封闭产品：多个第一方业务插件、组合包与 Profile，不开放安装
Level 3 = 大型开放产品：Level 2 + 外部 npm 插件、组合包与 Engine 安装
```

| 维度                | Level 1                             | Level 2                                 | Level 3                                      |
| ------------------- | ----------------------------------- | --------------------------------------- | -------------------------------------------- |
| 应用业务插件        | 一个应用插件，内部分层              | 每个业务域一个插件，按包组组织          | 同 Level 2，另有对外承诺的公开扩展点         |
| 组合包              | 一个应用组合包                      | base / web / headless / 业务域 / Engine | 同 Level 2，另加用户安装的外部组合包         |
| Profile             | `web`、`desktop`（可选 `headless`） | 多个 Profile 与 overlay                 | 同 Level 2                                   |
| Engine              | 随包发布的 Engine 插件              | 第一方 Engine 组合包，按 Profile 选择   | 另可安装外部 Engine 插件                     |
| 插件管理组件        | 无                                  | 无                                      | 有，提供安装、删除、启停与组合包选择         |
| `<app> plugin` 命令 | 无                                  | 无                                      | 有                                           |
| 公开扩展承诺        | 无                                  | 无，扩展点只对第一方                    | 公开 Service、事件、Slot 与 Remote namespace |

| 条件                                                                 | 选择    |
| -------------------------------------------------------------------- | ------- |
| 单一产品、小团队、官方功能、业务模块稳定                             | Level 1 |
| 多业务域、多团队并行、多个产品形态，所有代码由同一官方信任域构建     | Level 2 |
| 有真实的第三方插件或 Engine 生态需求，并愿意承担兼容、分发和支持成本 | Level 3 |

选择高于真实需求的层级会增加生命周期、兼容性与发布成本，同样是架构错误。升级层级时保留本基线，只增加该层级要求的组合粒度与开放能力。

---

# 2. Cordis

Cordis 是底层框架（DSH 仓库 `docs/cordis-primer.zh.md`）：插件向共享上下文贡献服务、类型化事件和可逆副作用。应用的每一部分都是插件，包括存储、凭据、HTTP 载体、Remote 网关、业务域、Engine 和浏览器 UI，因此每个都可以从配置替换。不存在需要打补丁的特权内核；扩展应用的方式是把插件挂载到其他插件旁边，各项注册在插件卸载时撤销。

- **插件实现 Service。** 插件是带可选 `inject` 和 `apply(ctx)` 的函数，或由 Cordis 管理生命周期的 `Service` 子类。
- **上下文是服务容器。** 服务占据稳定的 `ctx.<key>`，其他插件按 key 查找服务，不导入具体实现。
- **`inject` 声明依赖。** 插件等待所需服务就绪才启动；启动顺序由服务依赖表达。
- **类型化事件用于通信。** 事件名通过声明合并注册，以 `emit`、`waterfall`、`parallel`、`serial` 或 `bail` 分发；分发模式是事件公开约定的一部分。
- **注册是可逆副作用。** 路由、Remote 方法、事件监听、定时器、子进程和 UI 贡献经 `ctx.effect()`、`ctx.on()` 或返回 disposer 的 `register()` 安装。

同一个 effect 内的 disposer 倒序串行执行，Fiber 卸载时各 effect 并发释放；有先后依赖的资源放进同一个 effect 并逐步 await。Fiber 状态为 `PENDING / LOADING / ACTIVE / FAILED / UNLOADING / DISPOSED`。

`waterfall` 是环绕中间件：监听器必须调用 `next()` 才能委托，不调用即短路，只有拥有该决策的策略监听器可以这样做。

---

# 3. Profile 与组合包

运行中的应用是一棵插件树，由启动时按序叠加的各层组合而成。

**Profile** 是存放在 `$<APP>_HOME/profiles/<name>` 中的具名组装。它列出自己叠放的组合包，存放自己安装的树外插件，并保存用户自己的 `cordis.patch.yml`。

**组合包（Bundle）** 是 Cordis 配置条目及其挂载代码的分发格式，因此它插入的内容始终可以被上层 patch。组合包插入框架包、基础设施组件与业务插件的条目。

## 3.1 叠加顺序

```text
[]（空根）
→ Profile 中按列出顺序的各组合包 patch
→ Profile 的 cordis.patch.yml
→ home 级 patch
→ 本次启动的 --patch overlay
```

组合包按 Profile 列出的顺序叠加，不做依赖排序。一条 patch 按 id 定位一个条目并整体替换其 `config`，或插入新条目；不做深合并。后一层可以定位前一层插入的条目。叠加由启动组件调用 Include 的 `applyEntryPatches` 完成，应用不另写合并算法。

`cordis.yml` 只在插件 `config` 和条目 `disabled` 中允许 `!!js` 表达式；其余元数据保持字面值。按环境或部署选择插件使用 overlay。

## 3.2 应用的 Profile 与组合包

下表是 Level 2 与 Level 3 的典型组合；Level 1 的单组合包形式见 [Level 1](./DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md)。

| 组合包               | 内容                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `bundle-base`        | 存储、凭据、设置与配置编辑、子进程、Remote 注册表、网关与访问控制、配置 HMR、Engine seam 与业务域插件；Level 3 另含插件管理 |
| `bundle-web`         | Web 运行与静态页面、HTTP 载体、客户端模块、连接认证、Remote 客户端桥接、controller、浏览器 UI 插件                          |
| `bundle-headless`    | 一次性运行入口，不启动服务器                                                                                                |
| `bundle-engine-<id>` | 一个 Engine 插件及其依赖条目，可选                                                                                          |

| Profile    | 组合包栈                          | 用途                     |
| ---------- | --------------------------------- | ------------------------ |
| `web`      | `bundle-base` + `bundle-web`      | 浏览器应用               |
| `headless` | `bundle-base` + `bundle-headless` | 不带服务器的一次性运行器 |
| `desktop`  | 由 `web` 模板初始化，Desktop 独占 | 桌面应用（见 §5）        |

Engine 组合包由产品按需加入 Profile；Level 3 中用户也可以安装。确定性测试、端到端测试和受限能力集合用 `--patch` overlay 表达，不另设 Profile。

## 3.3 HMR

HMR 由 YAML 控制：`bundle-base` 启用仅监视配置的配置 HMR 组件，监视 Profile manifest 与两份用户 patch，配置变化立即重新组合；`headless` 禁用它。Level 3 中插件管理的启停和安装在启用 HMR 的 Profile 中立即生效，否则保留到重启。开发期客户端 bundle 的热更新由客户端 HMR 组件的 `/plugins/events` 推送。HMR 要求 `--expose-internals`。

```bash
<app> --profile web --dump-config
```

它打印出实际启动的配置树；其中任何条目都可以由用户自己的 patch 替换。

---

# 4. 应用启动

受支持的 Node 应用只通过具名 Profile 启动：`<app> --profile <name>` 或 `<app> <name>`。`plugin` 是管理命令，同名 Profile 必须用 `--profile plugin` 选择。

应用启动器是应用自有的 CLI 包，基于启动组件装载 Profile、分层环境并运行组合。包 bin、仅用于构建和测试的可执行文件、demo 和进程内直接挂载插件都不是应用启动器；启动入口检查把每个包 bin 和根脚本归入显式类别，拒绝绕过启动器的 Node 应用路径。

## 4.1 启动器职责

启动器的 Profile runner 按 DSH `apps/cli/src/profile-boot.ts` 的 `runProfile` 编写，可按 §1.3 复制改写。Desktop Host 与 CLI 共用这一个 runner。它在 Cordis 根上下文提供插件依赖、而插件本身不提供的启动事实：

1. 用应用自己的 Profile 模板初始化缺失的 Profile。
2. 在任何插件挂载前，按启动环境安装 HTTP 代理，并安装 fail-loud 处理；SIGTERM 退出码为 0，SIGINT 为 130。
3. 在任何配置条目挂载前 provide `profileContext`（Profile 名、目录、patch 路径、install anchor、已启动的组合包、overlay、home 与 cwd）与启动环境快照。
4. 挂载解析 Profile 内包的插件包加载器，按 runtime resolution 解析包。
5. 提供命令行参数、受控退出与 `appReady`；根 Fiber 进入 `ACTIVE` 且 Loader 就绪后提交 `appReady`。

`--dump-config`、`--patch`、Profile 别名与 Level 3 的 `plugin` 命令同样在启动器中实现。

## 4.2 Web 启动参数

Web 启动参数由 Web 运行组件的 `startup` 入口解析（见 §6.2），以不可变服务值提供给其他条目：

| 参数                         | 含义                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `--host <ip>`                | 一个具体的本机 IPv4/IPv6 字面量；拒绝 `0.0.0.0`、`::` 等通配地址 |
| `--port <n>`                 | 监听端口；`0` 由系统分配                                         |
| `--tls-cert` / `--tls-key`   | 成对出现，直接提供 HTTPS                                         |
| `--public-url <url>`         | 对外公告的应用根；只改变打印和打开的地址，不授予信任             |
| `--trusted-host <authority>` | 额外被接受的 authority，可重复                                   |
| `--no-open`                  | 不打开浏览器                                                     |

默认只监听 loopback；非 loopback 且未启用 TLS 的监听器在启动时警告。

---

# 5. 桌面应用

## 5.1 进程模型

```text
┌─ Electron 主进程（壳）────────────────────────────────────┐
│ 单实例锁 · 窗口/托盘/菜单 · <app>-app:// 协议 · 更新器      │
│ 原生对话框 · 快捷键 · 致命错误恢复                         │
│        │ spawn(ELECTRON_RUN_AS_NODE=1, --expose-internals,  │
│        │       stdio: [ignore, pipe, pipe, ipc])            │
│        ▼                                                    │
│ ┌─ Desktop Host 子进程 ─────────────────────────────────┐   │
│ │ 共享 Profile runner：profile=desktop                   │   │
│ │   --no-open --host 127.0.0.1 --port 0                  │   │
│ │ = 完整 Web 应用的 Cordis 树（同一进程内全部插件）       │   │
│ └────────────────────────────────────────────────────────┘   │
│        ▲ HTTP 转发 / WebSocket（只给所属窗口附加凭据）       │
│ ┌─ 渲染进程 ───────────────────────────────────────────┐    │
│ │ <app>-app://app/ 打包的 Web 资源                      │    │
│ │ 浏览器启动组件两阶段启动 → 浏览器侧 Cordis 插件树     │    │
│ └───────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

Electron 壳与 Desktop Host 是应用自有包，按 DSH `apps/desktop` 与 `apps/desktop-host` 的模式编写：

- Electron 主进程是壳，不拥有业务路由或工作流。
- Desktop Host 用 Electron 自带的 Node 运行，调用与 CLI 共享的 Profile runner 和完整 Web 应用；用户机器不需要系统 Node 或 pnpm。
- Host 与主进程只经 Node IPC 通信，消息为：`ready`（URL 与启动注入）、`fatal`、`shutdown`、`shutdown-complete`、`quit-inspection`、`update-tasks`。应用可增加自己的 IPC 消息，每类消息有唯一所有方。
- Host 默认监听 `127.0.0.1` 上系统分配的端口，可由 `webserver.config.port` patch 覆盖。

## 5.2 页面加载与传输

1. 主窗口立即从 `<app>-app://app/` 加载打包的 Web 入口，显示共享启动页。
2. Host 就绪后，主进程把启动注入交给页面，页面在同一文档中激活客户端插件。
3. 主进程把应用 HTTP 请求转发给已认证的 Host，转发时丢弃 `transfer-encoding`、`connection`、`keep-alive` 响应头，并把插件 bundle 响应标记为 `no-store`。
4. WebSocket 流直接连接 Host，只为所属应用窗口附加凭据。
5. `<app>-app://shell/` 不联系 Host，只提供壳自有的更新与恢复文档。

Preload 只向 `<app>-app://app` 文档暴露启动就绪、致命启动失败上报、原生目录选择和壳自有桥接；不暴露业务方法、文件系统、原始 IPC、shell 或任意 pnpm 参数。插件管理走 Web 应用已认证的 HTTP API，不经 IPC。

## 5.3 状态归属

- 主进程在访问任何 Profile 前获取进程生命周期单实例锁，并独占 `$<APP>_HOME/profiles/desktop` 及其包管理器状态；CLI 不能启动该 Profile。
- CLI 与 Desktop 共享 `$<APP>_HOME` 下的产品数据，但不共享可执行包、插件启用状态、锁文件或 `node_modules`。
- 签名应用从 `app.asar` 提供运行时、Desktop Host 及其完整生产依赖树；Profile 只安装外部插件。首次启动不复制核心包，也不运行 pnpm。
- 安装后的 `resources/runtime/cli/bin/<app>` 用 Desktop 的 Electron 和内置 pnpm 运行普通 CLI 分派入口；Level 3 中可在 Desktop 退出后用 `<app> plugin --profile desktop add|list|remove` 管理插件。

## 5.4 生命周期

- 关闭主窗口只隐藏窗口，页面与 Host 继续运行，任务不中断。
- 普通退出入口先向 Host 查询退出会中断什么，确认后再退出；查询失败或超时按有运行中任务处理。安装更新、恢复对话框、系统关机等已确认过的路径跳过查询。
- 主窗口、主文档、preload、渲染进程、Web 启动或 Host 的致命失败，在每个应用进程中打开一次原生恢复对话框，提供退出、重启、备份 Profile patch 并重启；Level 3 另提供禁用第三方插件。不通过启动超时推断故障。
- 首个致命弹窗前向平台日志目录写入崩溃报告。
- macOS 和 Linux 从图形界面启动时，在首个 Host 启动前读取一次账户登录 shell 的环境，供 Host 和子进程使用。

## 5.5 发布身份与更新

| 决策       | 结果                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| 发布身份   | Electron 壳与运行时使用同一精确版本；运行时升级必须发布新 Desktop 版本                              |
| 运行时     | 所有包操作使用内置 pnpm；包脚本通过 `node` shell 启动器转发给 Electron                              |
| 包来源     | `app.asar` 携带完整生产依赖树；Profile 只安装外部插件                                               |
| 运行时描述 | `desktop-runtime.json` 绑定壳版本、Electron Node 版本、平台、架构、共享包版本与文件清单，打包时验证 |
| 更新       | 壳、匹配的运行时与 pnpm 组成一个已签名更新单元                                                      |

---

# 6. Web 应用

Web 是同一个 Host 加浏览器载体：Host 进程在同一端口同时提供页面、插件脚本和 API。Desktop 运行的就是这套 Web 应用。本节各项由基础设施组件提供，行为与 DSH 对应包一致；Web 壳（Vite 入口、品牌资源）是应用包。

## 6.1 HTTP 载体

HTTP 载体组件（参照 `dsh-host-webserver`）基于 `node:http`，配置 `tls` 时改用 `node:https`，提供 `ctx.webServer`：

- `register({ kind: 'exact' | 'prefix', path, handler })` 注册 HTTP 路由；`registerUpgrade()` 注册精确匹配的 upgrade 路由；`registerFallback()` 认领唯一的回退席位，无人认领时返回 404。
- 匹配顺序：精确表、最长前缀、回退。同一张表内路径重复是配置错误。
- `collectIndexInjections()` 收集启动注入行，`renderIndex(html)` 渲染注入并应用 `tapIndex` 转换。
- 可选 gzip；SSE、range 和已编码内容保持不变。
- 监听失败或 TLS 材料不可用时拒绝初始化，绝不退回 HTTP；handler 抛错返回 400 并记录警告，进程不退出。
- 它不提供服务器级认证或来源策略，由路由所有者实施。

| 路径                         | 所有组件    | 用途                            |
| ---------------------------- | ----------- | ------------------------------- |
| 回退席位                     | 静态页面    | 托管 Web 构建产物               |
| `/api`（前缀）               | 连接与认证  | Remote 一元调用                 |
| `/connect`                   | 连接与认证  | 非浏览器 API 调用方换取 cookie  |
| `/api/remote.mux`（upgrade） | Remote 网关 | 多路复用的 Remote 流            |
| `/plugins`（前缀）           | 客户端模块  | 客户端插件 bundle 与 combo 脚本 |
| `/plugins/events`            | 客户端 HMR  | 开发期客户端热更新事件流        |

功能插件自有的下载等路由由其所有插件经 `ctx.effect()` 注册，插件卸载时移除。

## 6.2 Web 运行与静态页面

Web 运行组件（参照 `dsh-web-app` 及其 `startup` 入口）在 `bundle-web` 中挂载：

- 从应用 Web 壳包的 exports 解析 dist，部署不硬编码，并在其上挂载静态页面组件。
- `startup` 入口解析 §4.2 的参数与 `--help` 文本。
- 打印带进程令牌的地址；`--public-url` 只替换公告地址；未传 `--no-open` 时打开默认浏览器。
- 非 loopback 的 HTTP 监听发出暴露警告。

静态页面组件（参照 `dsh-host-frontend-static`）认领回退席位，从该 dist 目录提供页面：

- 根路径与 index 路径渲染 `index.html` 并写入启动注入，统一插入 `<base href="./">`，因此同一份页面可以挂在剥离前缀的代理之后。
- 不存在的路径返回空 404，不回退到 SPA 首页；越出 dist 返回 403；不支持的方法返回 405。
- 只有 index 需要认证；静态资源公开。

## 6.3 认证与请求信任

连接与认证组件（参照 `dsh-client-connection`）拥有浏览器认证、请求信任和 Peer：

- 每个进程生成随机启动令牌。启动器打开带 `?token=` 的应用地址；只有 `GET /` 与 `/connect` 接受令牌，验证后写入绑定 authority 的签名 cookie 并 303 重定向到干净地址。cookie 签名密钥是 `ctx.credentials` 中由连接组件拥有的 grant 记录。
- 认证前，请求的 `Host` 必须是 loopback、监听器绑定的 IP，或 `trustedHosts` 中的条目；附带的 `Origin` 必须同 authority；不采信转发头。
- 每个请求代表一个 Peer：`principal` 指明调用方，`interactions` 决定能否参与转发事件，`signal` 在作用域结束时中止。
- 认证通过的请求在传输请求体前经过 `connection/request` waterfall；Desktop 用它在安装更新期间拒绝新 API 工作而不取消已接纳的工作。

## 6.4 Remote

业务服务用 `@Remote` 或 `@RemoteScope(key)` 标记开放给 Client 的方法；未标记的方法不进入生成的 Client 类型，也不能被调用。Remote 组件参照 DSH 的 typert 与 api 包。

- 构建期生成严格 descriptor、运行时 codec 与声明合并；Client 侧把方法挂到 `ctx.remote.<namespace>` 及作用域 Context 的 `remote.<namespace>`。
- 复杂 Host 对象不跨 wire 传输：业务包经 `TypertLookupMap` 声明它与 wire identity 的关联，并向 `ctx.typert.lookups` 注册解析提供方，网关在调用前把 id 解析为 Host 对象。
- 一元调用走 `/api` 上的 HTTP；含二进制字段的结果以 JSON 元数据加字节附件的 multipart 响应返回。
- 返回 `Iterable`、`AsyncIterable` 或 `RemoteStream` 的方法走 `/api/remote.mux` WebSocket 上的逻辑流。`$events` 流的首帧 `ready` 建立一个 connection generation；流结束、报错或首帧不是 `ready` 都使当前 generation 失效。
- `ctx.remote.$on()` 把 allowlist 内的普通事件交付给根 Client Context，把作用域 waterfall 事件交付给对应作用域 Context。
- 断线后按退避策略重连；浏览器 `offline` 中断活动工作并暂停自动尝试；`ctx.connection.reconnect()` 立即重试。

## 6.5 Controller 与 Client model

每个 API controller 包拥有配对的 Host face 与 Client face：Host face 拥有权威 mutation 顺序、访问策略与流生产；Client face 基于相同的生成 wire 类型维护与 React 无关的 model，公开 observable snapshot 与 command，不复制第二份业务真相。每代流先给出完整 baseline，再给出增量；重连时用新 baseline 替换 model。

```text
Host 状态 → Remote 传输 → Client model → UI adapter → 视图快照 → Slots → React
```

用户操作通过 callback 反向进入注入的 Client service 或生成的 Remote namespace。展示组件不接收 Cordis `ctx`、传输对象或其他功能插件的实现。

## 6.6 浏览器侧

浏览器侧也是一棵 Cordis 树：

1. 客户端模块组件扫描 Host Loader 中声明了 `<app>.client` 的包，组合出启动图并写入 `window.__<APP>_BOOT__`；浏览器 bundle 在 `/plugins` 下以带 revision 的资源或 combo 脚本提供，响应为 `Cache-Control: public, max-age=31536000, immutable`。
2. 浏览器启动组件两阶段启动：模块阶段从启动图建立懒加载模块表并预取 `immediately` 条目；插件阶段用 Cordis Loader 激活图中每个条目，全部就绪后才交给渲染器。
3. Slots 组件提供类型化 Slot 注册表；渲染器组件是唯一通过 `useSyncExternalStore` 绑定 observable、拥有 React context 并只调用一次 `renderSlot('root')` 的包。

装上一个带客户端部分的插件，浏览器下次启动就加载它的 UI；不存在构建期写死的 UI 注册表。

| 层   | 选择                                                                     |
| ---- | ------------------------------------------------------------------------ |
| 构建 | Vite 构建 Web 壳，各包由 tsdown 打包                                     |
| 视图 | React 18                                                                 |
| 样式 | CSS Modules + `clsx`；主题 token 由主题组件拥有；不添加组件库或 Tailwind |
| 控件 | 跨功能包复用的控件只在控件组件中                                         |
| 文案 | 类型化语言字典与 `t`；拒绝硬编码文案                                     |
| 校验 | zod                                                                      |

应用的品牌、首页布局和产品 UI 以客户端插件形式注册到 Slots，不写进 UI 基座组件。

---

# 7. 业务插件与能力 seam

一项可替换能力由 Service Definition、Service Provider 与 Consumer 三个角色组成，三者完整存在，只有在角色独立演进时才拆分包。

- 应用包位于 `packages/<group>/<pkg>/`，包名为 `@<scope>/<group>-<pkg>`。
- 每个服务、存储领域、路由、Remote namespace 和 UI 贡献有唯一所有插件。
- 插件之间通过 `ctx.<key>` 服务、类型化事件或公开的只读投影协作，不导入同级插件的实现，不写其他插件拥有的领域。
- 新行为挂在已文档化的扩展点上，不修改编排插件；基础设施组件已提供的 seam 直接使用，不另建平行 seam。

事件：

- 事件通过声明合并扩展事件 map，JSDoc 标注 `@mode` 与载荷 `@param`。
- 持久事实写入仅追加日志或存储领域；其余事件是实时扩展点。
- 存储领域写入在提交后发出 `DomainChanged`（`put` 携带新快照，`deleted` 为墓碑），仅限进程内。
- 选定的 Host 事件经 `$events` 转发给 Client，未在 allowlist 中的事件不出 Host。

---

# 8. 数据与凭据

## 8.1 存储

存储组件参照 DSH 的 storage 包，提供 `ctx.storage`：

- 枢纽 `ctx.storage.backend` 是名称到后端的表；多个后端并存挂载，哪个后端服务哪个消费方由消费方自己的配置决定。
- 每个领域由其所有包用 `defineDomain(spec)` 声明一次：领域名、格式版本、兼容的旧版本列表、记录 schema 与布局。声明在模块加载时、触碰介质前校验。
- 文档型领域（设置、单文档状态、缓存）使用 DSH 的记录模型：zod 记录 schema、`single` 或 `per-record` 布局，每条记录一行。
- 需要跨表事务、二级索引或关联查询的领域使用关系型后端：领域声明自己的表与不可变的前向迁移，写入经事务提交，查询以只读投影公开。这是存储组件对 DSH 记录模型的扩展，领域所有权与格式演进规则不变。
- 权威数据的记录不通过 schema 时整次 open 拒绝；只有派生数据可声明 `backup-and-skip`。
- 领域格式变化时提升版本；当前 schema 也接受的旧版本记入兼容列表，写入总是标记当前版本。
- 已发布的持久格式只以新版本命名的后继代际演进，绝不移动、覆盖或删除已提交的代际；前驱不意味着回退或降级支持。SQLite 使用单调递增的 `SCHEMA_VERSION`，已提交的迁移不修改。

## 8.2 凭据

凭据组件参照 DSH 的 credentials 包，提供 `ctx.credentials`：

- 设置分节与 `cordis.yml` 只携带 `CredentialRef`（branded 类型），值归凭据提供方所有；消费方每次操作解析一次引用，不跨操作缓存。
- Remote 方法、日志和工具结果不返回凭据明文；跨 Remote 的只有不含值的凭据信息视图。
- 提供方可替换：DSH 的本地提供方是 home 下的私有明文文件；Desktop 可以使用由系统密钥服务加密的提供方，加解密经壳的专用 IPC 通道交给主进程，主进程只做加解密，不接触业务。

---

# 9. Engine

Engine 是执行 Agent 或工作流的引擎。每个 Engine 都是插件，应用想加入哪个就加入哪个，不限于某一种 agent loop。

## 9.1 Engine seam

| 角色               | 归属                                                             |
| ------------------ | ---------------------------------------------------------------- |
| Service Definition | 应用自有的 `ctx.engines`：Engine 注册表与统一的 Session/Run 接口 |
| Service Provider   | 每个 Engine 一个插件，以 `bundle-engine-<id>` 组合包分发         |
| Consumer           | 应用的会话 controller、业务插件与 UI                             |

- Engine 插件经 `ctx.engines.register(id, provider)` 注册，返回 disposer；插件卸载时注销，并停止和排空它创建的所有运行。
- Provider 声明自己支持的能力；Consumer 按 Engine id 选择 Provider。引用未注册的 Engine 显式失败，不静默改用其他 Engine。
- 不支持的操作返回类型化结构错误，绝不静默 fallback。
- Engine 发起的审批、提问和工具请求经应用的人机交互 seam 交给用户决定，不由 Engine 插件自行放行。
- Engine 的配置（模型、端点、凭据引用、可执行路径）是经 Schemastery 校验的 `Config` 字段。

## 9.2 Engine 实现方式

- **外部进程 Engine**：Provider 经 `ctx.subprocess` 启动和回收引擎进程，进程登记在 effect 中，插件卸载时终止；协议消息在进程边界校验。
- **进程内 SDK Engine**：Provider 直接调用引擎的 JS SDK，长生命周期资源同样登记在 effect 中。
- **参照 DSH Agent 栈**：DSH 的 Agent 栈（`dsh-agent`、`dsh-agent-loop`、`ctx.llm`、`ctx.tools`、Session 包）依赖 DSH 的组件包，不直接挂载。需要同类能力时，参照它编写应用自己的 Engine 插件；也可以把独立安装的 DSH 作为外部进程 Engine 运行。

## 9.3 记录

- 应用的 Session/Run 是持久业务事实；Engine 的线程、会话或 checkpoint 只是可恢复的执行句柄。
- 应用交给 Engine 的每一项输入和 Engine 报告的每一项结果都写入应用的仅追加 Session 日志，可从日志重建；Engine 内部自行组装的模型请求由该 Engine 负责。
- 参照 DSH Agent 栈编写的 Engine 同时遵守 DSH 的“模型可见 ⟺ 已记录”：进入模型请求的任何内容都必须能从 Session 日志重建。

---

# 10. 外部插件

只有 Level 3 允许用户安装外部代码。外部插件以 npm 包形式安装进 Profile，与第一方插件在同一个 Host 进程、同一棵 Cordis 树中运行，拥有与第一方相同的能力；兼容性检查不是沙箱。安装、兼容、公开扩展点、分发与恢复见 [Level 3](./DESKTOP_ARCHITECTURE_LEVEL3_LARGE_OPEN_FINAL.md)。

Level 1 与 Level 2 不挂载插件管理组件，启动器不提供 `plugin` 命令；运行的代码全部来自签名发布物。

---

# 11. 源码、工具链与产物

```text
<repo>/
├── apps/
│   ├── cli/            # <app> 启动器（Level 3 另含 plugin 命令）
│   ├── desktop/        # Electron 壳
│   ├── desktop-host/   # Electron Node 模式的私有 Host
│   └── web/            # Vite Web 壳
├── packages/
│   ├── infra/<name>/   # 基础设施组件
│   └── <group>/<pkg>/  # 应用自有插件、组合包与 Engine
└── vendor/deepseek-harness/  # 锁定的 DSH 快照，只读：框架包来源与设计参照
```

- Cordis 框架包从锁定快照准备到忽略提交的构建目录，保留 DSH 包名、版本、源码与 MIT 许可证；不从 registry 解析，不修改原始 vendor。
- pnpm 负责依赖与构建，独立 Node 运行时与 pnpm 都锁定为满足 DSH 快照要求的精确版本；Desktop Host 使用 Electron 内嵌 Node。
- 全部 ESM；跨包使用包名，本包内相对导入使用 `.ts`。
- 同时有 Host 与 Client 程序的包提供分面的 tsconfig 叶子配置与仅作 solution 的根配置。
- 静态检查与测试通过 tsconfig `paths` 解析到 `src`，在干净树上通过；消费构建产物 `lib/` 的检查显式声明该依赖。
- Desktop 发布包不依赖源码目录或仓库外链接。
- 从 DSH 复制改写的文件保留 MIT 版权与许可声明，来源路径与 DSH 版本记入应用的第三方声明；依赖检查拒绝 Cordis 框架包以外的 `@deepseek-ai/*` 依赖。

---

# 12. 编码约定

| 约定             | 要求                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| 注册即 effect    | 每个贡献经 `ctx.effect()` / `ctx.on()`；注册表的 `register()` 返回 disposer                               |
| 判别联合         | 按判别标签 switch；封闭联合以 `assertNever` 结尾，可合并扩展的联合走有文档的默认分支                      |
| 显式默认值       | 包边界上的默认值是所属实现中的显式 `resolve(request): Spec`，不在 `run()` 中隐式 `?? default`             |
| 无硬编码可调参数 | 随部署变化的选择是可在 `cordis.yml` 修改、经 Schemastery 校验的 `Config` 字段                             |
| 配置错误显式失败 | 自洽的错误在加载时失败，否则在最早可判定处失败；不静默跳过缺失的引用对象                                  |
| branded id       | 跨边界的不透明 id 使用 branded 类型，不使用裸 `string`                                                    |
| 校验位置         | 同进程有类型边界信任 TypeScript；在解析器、配置、队列、模型/工具 JSON、文件、Worker、进程与 wire 边界校验 |
| 错误处理         | 类型化、结构化、本地化且可操作的失败；停止依赖工作并可见地报告未知结果                                    |
| 空 `catch`       | 命名错误并说明原因，`try` 只包一条语句                                                                    |

---

# 13. 验证

- 按改动面选择证据：聚焦的行为测试、用户可见输出快照、构建产物冒烟和真实 API 端到端测试。
- 能力 seam、生命周期路径和对话输出变化同时规划单元、端到端和快照覆盖。
- 每个基础设施组件有覆盖其服务契约的测试；从 DSH 复制的组件一并复制或改写 DSH 对应的测试。
- 每个 Engine 插件有覆盖注册、卸载排空、不支持操作和进程失败的测试。
- Electron 端到端测试保持主窗口与凭据窗口隐藏，不抢占桌面焦点。
- 发布覆盖 macOS、Windows、Linux 的安装、首次启动、升级、签名/公证、卸载与离线启动。

---

# 14. MUST

1. MUST 让应用的每一部分都是 Cordis 插件，不建立需要打补丁的特权内核。
2. MUST 直接复用 DSH 的 Cordis 框架包，以原包名、原版本取自锁定快照。
3. MUST 只经配置、patch 与替换插件定制 Cordis 框架包。
4. MUST 以 Profile 与组合包组合插件树：空根、按列出顺序的组合包 patch、Profile patch、home patch、`--patch` overlay。
5. MUST 只通过具名 Profile 启动受支持的 Node 应用，并让启动器把 `<APP>_HOME` 设为应用自己的目录。
6. MUST 让 Desktop 由 Electron 壳以 Electron Node 模式启动私有 Host，Host 运行完整 Web 应用。
7. MUST 让 Desktop 独占 `profiles/desktop`，壳与运行时使用同一精确版本作为一个签名更新单元发布。
8. MUST 由同一个 Host 进程在同一端口提供页面、插件脚本与 API，每条路由由其所有插件注册。
9. MUST 拒绝通配监听地址，并按 Host/Origin 信任检查与令牌换签名 cookie 认证每个 API 请求与 WebSocket 流。
10. MUST 用 `@Remote` / `@RemoteScope` 声明 Client 可调用的方法，Client 类型来自生成的 descriptor 与 codec。
11. MUST 让每个 controller 包拥有配对的 Host face 与 Client face，Client model 不复制业务真相。
12. MUST 让浏览器 UI 由客户端插件组成，经 Slots 组合，并只由渲染器包挂载 React 根。
13. MUST 让每个服务、存储领域、路由、Remote namespace 与 UI 贡献有唯一所有插件。
14. MUST 经 `ctx.storage` 与 `defineDomain` 持久化数据，并以版本与兼容列表演进格式。
15. MUST 只在配置中携带凭据引用，Remote 不返回凭据明文。
16. MUST 让每个 Engine 作为 `ctx.engines` 的 Provider 插件注册，可独立安装和卸载。
17. MUST 把交给 Engine 的输入与 Engine 报告的结果写入仅追加 Session 日志。
18. MUST 按 §1.4 选择层级，并只在 Level 3 允许安装外部插件。
19. MUST 由启动器在任何配置条目挂载前提供 `profileContext`、启动环境与命令行服务，并以应用自己的模板初始化 Profile。
20. MUST 让基础设施组件按 DSH 对应包的设计编写，沿用其 `ctx` 服务键与服务契约，并按依赖闭包挂载。
21. MUST 为从 DSH 复制的代码保留版权与许可声明，并在第三方声明中记录来源路径与 DSH 版本。

---

# 15. MUST NOT

1. MUST NOT fork 或打补丁修改 Cordis 框架包与原始 vendor。
2. MUST NOT 依赖 Cordis 框架包以外的 DSH 包：`dsh-*` 组件包、DSH 组合包、`dsh` CLI 包与 `apps/*`。
3. MUST NOT 在应用代码中保留 DSH 的产品内容：DSH 的包字段名、home 变量、cookie 前缀、Profile 模板、组合包目录与默认注册表。
4. MUST NOT 让 Electron 主进程拥有业务路由或工作流，或经 preload 暴露业务方法。
5. MUST NOT 让包 bin、demo 或进程内直接挂载成为应用启动路径。
6. MUST NOT 让插件导入同级插件的实现或写其他插件拥有的领域。
7. MUST NOT 为基础设施组件已提供的能力另建平行 seam。
8. MUST NOT 让基础设施组件包含产品内容或依赖业务插件。
9. MUST NOT 在 `waterfall` 监听器中不调用 `next()` 而短路，除非它拥有该决策。
10. MUST NOT 把应用限定在单一 Engine，或在 Engine 缺失、不支持操作时静默 fallback。
11. MUST NOT 添加组件库或 Tailwind，或在功能组件中写入颜色字面量与主题选择器。
12. MUST NOT 移动、覆盖或删除已提交的持久数据代际。
13. MUST NOT 在插件中硬编码随部署变化的可调参数。
14. MUST NOT 把兼容性检查描述为沙箱。
