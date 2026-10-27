# 基于 DSH 的应用架构：Level 2 大型封闭项目

> 文档类型：Normative Architecture
>
> 共享基线：[基于 DSH 的应用架构](./DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 前一层级：[Level 1 小型项目](./DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md)
>
> 升级目标：[Level 3 大型开放项目](./DESKTOP_ARCHITECTURE_LEVEL3_LARGE_OPEN_FINAL.md)

---

# 1. 定位

Level 2 把应用自有代码拆为多个第一方 Cordis 插件，按组合包与 Profile 组装出多个产品形态，用于防止单个应用插件演化为承载所有业务的巨型服务。

```text
Clients
   │ HTTP / Remote
   ▼
Host 进程（一棵 Cordis 树）
├── Cordis 框架包 + 基础设施组件
├── 第一方业务插件（每个业务域一个，Host face + Client face）
├── 第一方能力 seam（Service Definition / Provider / Consumer）
├── Engine seam 与第一方 Engine 插件
└── 浏览器侧：各插件的 Client face 经 Slots 组合
```

插件在本层级是内部工程机制，不是用户生态。用户不能安装代码，应用不承担公开扩展点、第三方兼容或分发承诺。

---

# 2. 适用条件

适合：

- 多个稳定的业务域；
- 多团队并行维护；
- 需要多个产品形态，例如完整版、受限版、测试与端到端组合；
- 路由、服务、事件、存储领域与 UI 贡献需要统一生命周期与所有权；
- 所有运行代码由同一官方信任域构建和签名。

不应只因为“插件听起来先进”而选择 Level 2；业务规模不足时选择 Level 1。

---

# 3. 组合模型

## 3.1 插件

- 应用包位于 `packages/<group>/<pkg>/`，包名为 `@<scope>/<group>-<pkg>`；每个业务域一个插件包，必要时按 Service Definition / Provider / Consumer 拆分。
- 每个插件声明 `inject`，只经 `ctx.<key>` 服务、类型化事件与公开只读投影与其他插件协作，不导入同级插件的实现。
- 每个插件是它的服务、存储领域、路由、Remote namespace、controller 与 UI 贡献的唯一所有者。

## 3.2 组合包

| 组合包               | 内容                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bundle-base`        | 存储、凭据、设置与配置编辑器、子进程、Remote 注册表、网关与访问控制、HMR 默认值、Engine seam 与核心业务插件 |
| `bundle-web`         | Web 运行与静态页面、HTTP 载体、客户端模块、连接认证、Remote 客户端桥接与 UI 基座                            |
| `bundle-headless`    | 一次性运行入口                                                                                              |
| `bundle-<domain>`    | 一个可选业务域的插件条目                                                                                    |
| `bundle-engine-<id>` | 一个第一方 Engine 插件及其依赖条目                                                                          |

## 3.3 Profile

- 每个产品形态是一个 Profile 模板，列出有序的组合包；`desktop` 由 `web` 模板初始化。
- 受限能力、测试与端到端组合用 `--patch` overlay，不另设 Profile。
- 业务插件的启停由 Profile patch 中条目的 `disabled` 表达；可选业务域与 Engine 通过 Profile 选择组合包。
- 每个 Profile 的 `--dump-config` 结果纳入快照测试，组合变化在评审中可见。

---

# 4. 生命周期

- 插件激活由 `inject` 驱动：所需服务就绪才启动，服务消失时依赖方随之卸载。
- 插件激活失败只让它自己的 Fiber 进入 `FAILED`，依赖它的插件保持等待；失败可见地报告，不静默跳过。
- 每个路由、Remote 方法、监听、定时器、子进程与 UI 贡献经 effect 注册；配置 HMR 重新组合时，变化的条目卸载并撤销全部贡献后重新激活。
- 有先后依赖的资源放进同一个 effect 并逐步 await；独立资源并发释放。

---

# 5. 能力 seam

- 一项可替换能力的三个角色完整存在；Provider 可替换而 Consumer 不变。
- 基础设施组件提供的 seam（存储、凭据、子进程、设置）直接使用；业务插件只为基础设施没有的能力定义自己的 Service Definition。
- 包边界上的默认值是显式 `resolve(request): Spec`；随部署变化的选择是 `Config` 字段。

---

# 6. Controller 与 UI

- 每个业务插件的 API 由它自己的 controller 包提供，Host face 与 Client face 配对，Client model 不复制业务真相。
- 每个插件的 Client face 声明 `<app>.client`，经客户端模块组件下发，在浏览器侧 Cordis 树中激活；UI 经 Slots 注册，只有渲染器包挂载 React 根。
- 每个插件拥有自己的类型化语言字典；跨插件复用的控件只放在 UI 基座包。

---

# 7. 数据所有权

- 每个存储领域由唯一插件以 `defineDomain` 声明并写入；其他插件只经该插件的服务或只读投影读取。
- 跨插件的状态变化经 `DomainChanged` 或插件自己的类型化事件传递。
- 格式以版本与兼容列表演进，已提交代际不移动、覆盖或删除。

---

# 8. Engine

- 每个 Engine 是一个第一方 Provider 插件，以 `bundle-engine-<id>` 分发，由 Profile 选择。
- 同一 Profile 可以同时挂载多个 Engine；Consumer 按 Engine id 选择，缺失时显式失败。
- Engine 自己的服务（如模型调用、工具注册）挂在该 Engine 的插件子树中，不占用其他插件的服务键。

---

# 9. 不开放安装

- 不挂载插件管理组件，启动器不提供 `plugin` 命令。
- Profile 只安装签名发布物中携带的包；原生恢复不提供“禁用第三方插件”。
- 扩展点只对第一方开放，可以随应用版本自由调整，不承担第三方兼容承诺。

---

# 10. 架构门禁

- 每条路由、每个 Remote namespace、每个存储领域与每个 Slot 贡献有唯一所有插件，重复即失败。
- 插件不导入同级插件的实现，不写其他插件的存储领域。
- `cordis.yml` 与组合包中的裸插件名必须出现在其解析清单的 `dependencies` 中。
- 每个包 bin 与根脚本归入显式类别，拒绝绕过启动器的 Node 应用路径。
- 门禁接入顶层检查，每个门禁至少有一个证明它会拒绝违规输入的用例。

---

# 11. 测试

- 每个插件有覆盖激活、卸载撤销贡献与激活失败的测试。
- 每个 Profile 有 `--dump-config` 快照与启动冒烟测试。
- 每个 Engine 插件有注册、卸载排空、不支持操作与进程失败的测试。
- Controller 有 Host face 与 Client face 的配对测试，覆盖 baseline、增量与重连。

---

# 12. MUST

1. MUST 遵守共享基线的全部 MUST。
2. MUST 按业务域拆分第一方插件，每个插件是其贡献的唯一所有者。
3. MUST 只经服务、类型化事件与只读投影在插件之间协作。
4. MUST 用组合包与 Profile 表达产品形态，用 overlay 表达测试与受限组合。
5. MUST 让每个插件的 Client face 经客户端模块组件与 Slots 接入浏览器。
6. MUST 让 Engine 作为第一方 Provider 插件，以组合包按 Profile 选择。
7. MUST 把所有权与启动入口规则接入架构门禁。

---

# 13. MUST NOT

1. MUST NOT 挂载插件管理组件、提供 `plugin` 命令或安装签名发布物以外的代码。
2. MUST NOT 让插件导入同级插件的实现或写其他插件拥有的领域。
3. MUST NOT 为了测试或受限组合另设 Profile。
4. MUST NOT 建立在所有插件之上做集中编排的业务服务。
5. MUST NOT 为基础设施组件已提供的能力另建平行 seam。

---

# 14. 升级到 Level 3 的触发条件

只有出现真实的第三方插件或 Engine 生态需求，并愿意承担以下长期成本时升级：

```text
公开扩展点的兼容承诺与升级指南
外部插件的版本兼容检查
注册表、插件市场与分发
安装、删除、升级与恢复的用户流程
外部插件故障的诊断与支持
```

升级时编写并挂载插件管理组件，并把选定的 Service、事件、Slot 与 Remote namespace 声明为公开扩展点；第一方插件结构不变。

---

# 15. 最终模型

```text
Clients
   │ HTTP / Remote
   ▼
Host（Cordis 树）
├── Cordis 框架包 + 基础设施组件
├── 第一方业务插件 × N
├── 第一方能力 seam
└── 第一方 Engine 插件 × N
```

Level 2 的目标是让大型封闭产品拥有可靠的组合、生命周期与所有权，而不是提前模拟一个尚不存在的插件生态。
