# Desktop 架构文档

本目录定义一套通用应用架构：完全参照 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的架构，直接复用 DSH 的 Cordis 框架包，按 DSH 组件的设计编写应用自己的基础设施组件，构建自己的桌面、Web 与无界面应用。它不针对具体产品；产品的业务域、品牌和定位由各应用自己的文档定义。

## 文档

- [基于 DSH 的应用架构](./DESKTOP_ARCHITECTURE_BASELINE.md)：最高优先级规范，覆盖分层、复用的 Cordis 框架包与基础设施组件、Cordis 插件、Profile 与组合包、应用启动、桌面应用、Web 应用、能力 seam、数据、Engine 插件、外部插件、工具链与约定；三个层级共享这一基线。
- [Level 1 小型项目](./DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md)：一个应用插件按 Application / Domain / Adapter 分层，随包 Engine，不开放安装。
- [Level 2 大型封闭项目](./DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md)：按业务域拆分的第一方插件、组合包与多个 Profile，不开放安装。
- [Level 3 大型开放项目](./DESKTOP_ARCHITECTURE_LEVEL3_LARGE_OPEN_FINAL.md)：Level 2 加上插件管理器与插件市场，用户可安装同进程运行的外部插件与 Engine。

层级只增减组合粒度与开放能力，不是质量排名；按真实需求选择，详见基线 §1.4。

## DSH 参照

本目录未覆盖的设计问题，以 DSH 对应文档与源码的做法为设计参照。下表路径相对于 DSH 仓库根目录：

| 主题           | DSH 路径                                    |
| -------------- | ------------------------------------------- |
| 总体架构       | `docs/architecture.zh.md`                   |
| Cordis         | `docs/cordis-primer.zh.md`                  |
| 桌面应用       | `apps/desktop/README.zh.md`                 |
| HTTP 载体      | `docs/subsystems/web-server.zh.md`          |
| 浏览器客户端   | `docs/subsystems/web-client.zh.md`          |
| 客户端模块     | `docs/subsystems/client-modules.zh.md`      |
| Remote 网关    | `docs/api-gateway.zh.md`                    |
| 样式           | `docs/web-styling.zh.md`                    |
| 存储           | `docs/subsystems/storage.zh.md`             |
| Session 持久化 | `docs/subsystems/persistence.zh.md`         |
| 凭据           | `docs/subsystems/credentials.zh.md`         |
| 子进程         | `docs/subsystems/subprocess.zh.md`          |
| 插件管理       | `packages/boot/plugin-manager/README.zh.md` |
| 启动与 Profile | `packages/boot/app-boot/README.zh.md`       |
| Agent 栈       | `docs/subsystems/core.zh.md`                |

DSH 源码以锁定快照引入项目，推荐放在只读的 `vendor/deepseek-harness/`，并以锁文件记录仓库、版本与源码哈希。应用只直接依赖其中的 Cordis 框架包，不依赖 `dsh-*` 组件包、DSH 组合包、`dsh` CLI 包与 `apps/*`。DSH 以 MIT 许可发布：基础设施组件、启动器、壳与 Host 可以从 DSH 源码复制改写，需保留版权与许可声明并去掉 DSH 的产品内容（见基线 §1.3）。

本目录的文档只互相链接，不链接所在仓库的其他位置，可以整体复制到其他项目作为架构文档。
