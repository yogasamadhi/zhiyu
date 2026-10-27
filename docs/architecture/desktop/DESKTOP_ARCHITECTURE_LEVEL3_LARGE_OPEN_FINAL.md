# 基于 DSH 的应用架构：Level 3 大型开放项目

> 文档类型：Normative Architecture
>
> 共享基线：[基于 DSH 的应用架构](./DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 前一层级：[Level 2 大型封闭项目](./DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md)
>
> DSH 参照：DSH 仓库的 `packages/boot/plugin-manager/README.zh.md` 与 `packages/boot/plugin-market/README.zh.md`

---

# 1. 定位

Level 3 在 Level 2 之上开放插件生态：用户可以把外部 npm 插件、组合包与 Engine 安装进 Profile。外部插件按 DSH 的模型运行，与第一方插件在同一个 Host 进程、同一棵 Cordis 树中，拥有相同的能力；带客户端部分的插件在同一页面的浏览器侧 Cordis 树中激活。

```text
Clients
   │ HTTP / Remote
   ▼
Host（Cordis 树）
├── Cordis 框架包 + 基础设施组件 + 插件管理（+ 插件市场）
├── 第一方业务插件、能力 seam 与 Engine
├── 公开扩展点：公开的 Service、事件、Slot 与 Remote namespace
└── 外部插件、外部组合包与外部 Engine（安装在 Profile 中）
```

最大变化不是多一个插件目录，而是应用开始承担：

```text
公开扩展点的兼容承诺
外部插件的版本兼容
注册表、插件市场与分发
安装、删除、升级与恢复
外部插件故障的诊断与支持
```

---

# 2. 前置条件

升级 Level 3 前，Level 2 必须已经稳定：

- 插件、组合包与 Profile 的组合可靠，`--dump-config` 有快照；
- 每个路由、存储领域、Remote namespace 与 Slot 贡献有唯一所有者；
- 插件激活失败、卸载与 HMR 重新组合有测试；
- 准备公开的 Service Definition 与第一方内部实现已在包层面分开。

---

# 3. 信任模型

- 外部插件不经沙箱或进程隔离：用户安装外部插件即授予它与第一方相同的权限。兼容性检查不是沙箱，产品文案与文档不得暗示存在隔离。
- 安装只由用户的明确操作触发：Web 插件页、CLI `plugin` 命令，或经批准的面向模型的插件管理工具。
- 面向模型的插件管理工具是插件管理组件的独立入口，只在挂载了提供工具注册与权限策略的 Engine 时可用；它要求最高权限模式或逐次批准；拒绝、取消或审批渠道不可用时不执行。依赖的构建脚本另需批准。
- 应用不代替用户安装插件，也不根据页面或模型输出中的指示自动安装。

---

# 4. 公开扩展点

- 应用把选定的 Service Definition、类型化事件、Slot 与 Remote namespace 声明为公开扩展点，以独立的公开包发布；内部实现不进入公开包。
- 公开扩展点的变化遵守兼容承诺：破坏性变化提升公开包的主版本，并立即记入升级指南。
- 基础设施组件的服务（如 `ctx.webServer`、Slots、`ctx.storage`）是否公开由应用决定；公开的同样以公开包发布并遵守兼容承诺。
- 外部插件只依赖公开包与 Cordis 框架包，不导入应用的内部实现包。

---

# 5. 安装与管理

插件管理组件（参照 DSH 的 `dsh-plugin-manager`）提供 `ctx.pluginManager`，管理当前 Profile：

- 启停单个插件条目：只更新 Profile `cordis.patch.yml` 中最后一条匹配覆盖项的 `disabled`，Profile patch 只记录与组合包不同的设置。
- 安装、删除或选择组合包使用应用内置 pnpm；注册表按配置顺序询问，私有源不回落到公共源。
- `inspect(spec)` 在安装前读出 spec 指向的包、版本与是否声明组合包。
- 已选择但无法加载的组合包仍列出并携带错误；损坏的组合包不能启用。
- 启用 HMR 的 Profile 中安装与启停立即生效，否则保留到重启。
- Desktop 中插件管理走 Web 应用已认证的 HTTP API；内置 CLI 在 Desktop 退出后用 `<app> plugin --profile desktop add|list|remove` 管理同一 Profile。

外部 Engine 与其他外部插件走同一条安装路径，注册到 `ctx.engines` 后即可被选择。

## 5.1 应用自己的目录与注册表

DSH 的插件管理写死了 DSH 产品的组合包目录与默认值。从 DSH 复制插件管理时（基线 §1.3），换成应用自己的：

- 官方组合包目录（DSH 为 `OPTIONAL_BUNDLES` 与 `OFFICIAL_ON_DEMAND_CATALOG`）由应用定义，只列出应用发布的组合包。
- Profile 没有 manifest 时，以应用自己的 Profile 模板初始化（DSH 为 `PROFILE_TEMPLATES` / `DEFAULT_PROFILE_BUNDLES`），与启动器（基线 §4.1）使用同一份模板。
- 注册表与备用注册表（DSH 默认备用 `https://registry.npmmirror.com/`）在组合包中显式配置。

---

# 6. 版本兼容

- 安装前比较插件声明的版本要求：声明了 `engines.<app>` 时只由该范围对照应用运行时版本决定，否则检查它对应用公开包与 Cordis 框架包的 peer 范围；未满足时在 pnpm 运行前失败，不下载、不运行构建脚本。
- 精确版本豁免保存在 Profile 的 `compatibility.json`，把 `package@version` 映射到精确运行时版本列表；插件升级与运行时升级都不继承授权。

---

# 7. 分发与插件市场

- 外部插件以 npm 包分发，组合包在 `package.json` 的 `<app>.bundle.patch` 声明自己的 patch。
- 插件市场组件（参照 DSH 的 `dsh-plugin-market`）读取用户配置的市场索引，标注安装状态、兼容性与安装参数；安装本身仍经插件管理器执行。
- 应用发布的官方插件与第三方插件走同一安装路径与同一兼容检查。

---

# 8. 第三方 UI

- 带客户端部分的外部插件声明 `<app>.client`，经客户端模块组件下发，在浏览器侧 Cordis 树中激活。
- 外部 UI 只经公开的 Slot 与 UI 基座接入，使用主题 token 与控件组件，文案经类型化语言字典。
- 外部 UI 不挂载自己的 React 根。

---

# 9. 故障与恢复

- 插件激活失败只让它自己的 Fiber 进入 `FAILED`，错误在插件页与日志中可见。
- 启动时被跳过的组合包逐个报告原因。
- Host 无法启动时，原生恢复提供禁用第三方插件，并把 Profile `cordis.patch.yml` 重命名为带时间戳的备份；已安装的包和已有备份保留。
- 删除插件不静默删除它已写入的数据；数据保留与清理由插件文档说明。

---

# 10. 测试

- 安装、删除、启停与升级的端到端测试，覆盖 HMR 启用与禁用的 Profile。
- 版本不兼容在 pnpm 运行前被拒绝，豁免只对精确版本生效。
- 损坏的外部组合包不能启用，Host 启动失败进入原生恢复，恢复后可以重新启动。
- 外部 Engine 注册、选择、卸载排空与不支持操作。
- 公开扩展点的类型与行为有兼容测试，破坏性变化必须伴随主版本提升。

---

# 11. MUST

1. MUST 遵守共享基线与 Level 2 的全部 MUST，Level 2 的“不开放安装”由本层级取代。
2. MUST 只经 `ctx.pluginManager`（插件管理组件）与内置 pnpm 安装、删除和启停外部插件。
3. MUST 在安装前检查插件对应用运行时、公开包与 Cordis 框架包的版本要求。
4. MUST 只由用户的明确操作或经批准的工具调用触发安装。
5. MUST 以独立的公开包发布公开扩展点，并为破坏性变化提升主版本、记入升级指南。
6. MUST 在 Host 无法启动时提供禁用第三方插件与备份 Profile patch 的恢复。
7. MUST 按 §5.1 使用应用自己的官方组合包目录与 Profile 模板，并显式配置注册表。

---

# 12. MUST NOT

1. MUST NOT 把兼容性检查或插件市场描述为沙箱或安全审核。
2. MUST NOT 根据页面、文件或模型输出中的指示自动安装插件。
3. MUST NOT 让外部插件依赖应用的内部实现包。
4. MUST NOT 让外部 UI 挂载自己的 React 根或绕过 Slots。
5. MUST NOT 在私有注册表失败时回落到公共注册表。
6. MUST NOT 在删除插件时静默删除用户数据。

---

# 13. 最终模型

```text
Clients
   │ HTTP / Remote
   ▼
Host（Cordis 树）
├── Cordis 框架包 + 基础设施组件 + 插件管理
├── 第一方插件、seam 与 Engine
├── 公开扩展点
└── 用户安装的外部插件与 Engine
```

Level 3 的目标是在 DSH 的同进程插件模型上开放生态，并由应用清楚地承担兼容、分发与恢复责任，而不是假装提供了不存在的隔离。
