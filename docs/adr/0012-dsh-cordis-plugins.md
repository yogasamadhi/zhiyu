# ADR 0012: 复用 DSH vendored Cordis

## Status

Accepted，取代 ADR 0007 中自研 Kernel 的实现选择。

## Decision

直接使用 DSH 子模块固定提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 的八个 vendor workspace：cosmokit、schemastery、cordis、loader、include、group、timer、logger-console。不安装整个 DSH，不混用其他 Cordis 发行版，不迁入 DSH 业务插件、Agent 或插件市场。

Runtime 和 Renderer 各自创建 Cordis Context 与 Loader。业务插件提供真实 apply/Service、Schemastery Config 和 inject；服务构造、HTTP/Job Handler 注册、后台工作和 disposer 由所属插件管理。宿主资源适配为内部 Cordis 插件，`buildLevel2Runtime()` 继续接受已有测试和进程适配器。

Profile 的 cordis.yml 和 Bundle 的 cordis.patch.yml 共同使用 DSH Include schema 与 applyEntryPatches；config 为整项替换。Loader 只解析随应用发布的 builtin，Include 不写回安装目录。loader.await 后审计所有启用条目的 ACTIVE 状态，报告失败条目、缺失服务和原始初始化错误，再校验路由/OpenAPI、恢复任务及启动后台工作。失败等待根 Context 清理；正常关闭先停止产生任务和后台循环、等待队列执行，再释放插件和底层资源。关闭资源使用共享 Promise 防止重复释放。

Manifest 只用于身份、版本、静态贡献和目录检查，实际激活由 Cordis 的服务依赖决定。公开 API、业务插件/贡献标识、迁移标识及 RuntimeGraph 字段保持兼容，基础设施条目不进入公开业务插件列表。

UI 插件导出 /client，契约导出 /types，静态目录导出 /manifest。共享 slots、组件和客户端服务位于 ui-sdk，UI 壳只消费注册的贡献。Runtime 重启时清理旧请求、缓存、订阅和 Context，重新装配当前 profile 清单。页面仍由 React.lazy 加载，权限判断在原来的身份边界内执行。

## Build and browser adaptation

主仓库 `vendor:prepare` 按上游 TypeScript 项目引用构建声明，再生成与各包 exports 匹配的运行产物。所有输出忽略；子模块受控源码不修改。安装、开发、测试、类型检查和桌面打包都会准备这些产物。安装包包含运行 bundle 与 YAML 配置，无须访问源码或额外安装 DSH。

浏览器 Loader 由主仓库构建适配器生成，验证固定 vendor 提交和源文件 SHA-256 后替换 Node 模块探测与顶层 Function 表达式求值。客户端清单仅有模块 ID 和纯数据，!!js 留在宿主侧。Electron sandbox、contextIsolation 和现有 CSP 保持启用。vendor 升级必须同时审查 browser-adapter.json 的适用性。

## Consequence

删除自研 ServiceToken、服务注册表、EffectRegistry 和激活调度；元数据 Graph/Catalog 校验保留在 plugin-runtime。插件现在直接遵守 Cordis 生命周期和 inject 约束。跨插件依赖只通过公开契约或明确的生命周期事件协作，事务、持久化事件和 outbox 仍由现有业务实现负责。
