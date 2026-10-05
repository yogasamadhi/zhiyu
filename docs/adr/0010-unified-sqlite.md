# 0010 — Web、Headless 和 Desktop 统一 SQLite

> 2026-09-10 更新：本文中的浏览器工作台、Headless 启动和独立发行内容属于历史方案，已由 [应用入口收敛决策](0011-desktop-cloud-apps.md) 替代；本地 Runtime、SQLite、插件与 Worker 的边界继续保留。

日期：2026-09-10。状态：已接受，验证记录见下方。

## 决策与范围

根据用户“彻底移除 Redis/PostgreSQL，统一使用 SQLite”的要求，移除 PostgreSQL Repository、迁移实现、Redis/BullMQ 队列及其依赖、开发服务和 CI 服务。Web/Headless 与 Desktop 使用现有 SQLite Repository 和 LocalPlatformJobQueue。Identity 增加 SQLite 实现，通过立即事务保护首次管理员创建、最后一位管理员、登录限流及一次性邀请/重置令牌。

作业、租约、取消、幂等和执行结果保存在 SQLite，进程内调度器按资源类别执行任务。一个数据目录对应一个 Runtime，本轮不引入共享磁盘或多副本部署。

当前 better-sqlite3 驱动在本机 Bun 1.4.0 直接运行时触发原生模块崩溃；Node.js 24 下的真实 SQLite 测试通过。因此 Bun 继续负责依赖、脚本和构建，Headless 源码通过 Node.js + tsx 启动；Linux 发行包内置 Node.js 24、JavaScript bundle 和原生 SQLite 模块。Desktop 继续使用 Electron utilityProcess。

## 数据与兼容

- SQLite 已有迁移 checksum 不改动；Identity 使用新增迁移。旧 PostgreSQL 迁移实现移除，不再是可选后端。
- 移除外部 PostgreSQL 输出驱动及新建入口。旧输出记录可读取、停用或删除，读取时显示禁用；执行明确失败，不触发数据库连接。
- 共享输出模型中的旧类型和 SQLite 历史迁移中的类型值仅用于读取旧数据。错误脱敏仍识别旧连接串。它们不代表保留数据库依赖或运行能力。
- Redis/PostgreSQL 环境变量不再参与配置，部署仅保留织云和可选的 HTTPS 代理。
- 历史 ADR、实施基线和旧架构分析保留原始决策，本记录覆盖其中的双存储部署要求。

## 本机工作区迁移

在停止旧写入的条件下，先保存 PostgreSQL 自定义格式备份和一致性快照，再初始化独立 SQLite 数据库并在单个事务中导入业务表。迁移元数据采用当前 SQLite 迁移生成的记录，不复用 PostgreSQL checksum。

21 个非空业务表完成记录数量核对，包括 5 个任务、30 个数据集、480 条数据集记录、3 次运行、3 个规则版本、90 个 Artifact 引用、61 条已终结作业和 346 条幂等记录。外键检查和 `integrity_check` 通过后，将文件复制到 `.data/headless/zhiyun.sqlite3`。随后逐字段核验 54 张业务表、2697 条记录，修正一个 JSON 布尔值的编码差异后，全部原业务字段值一致。原凭据和 Artifact 目录保留。原数据库与 Redis 容器停止，原数据卷未删除。

备份及本机验证明细位于忽略提交的 `.artifacts/sqlite-transition/`。其中备份与快照包含工作区数据和敏感配置，不能提交到版本库或作为普通测试夹具。当前已完成的是本机现有工作区迁移，不提供未经验证的任意旧版本一键迁移承诺。

## 验证

- SQLite Identity、Collection 和本地队列针对性测试：31 项通过。
- 输出相关测试：56 项通过。
- 全部 TypeScript 测试：433 项通过（独立临时 SQLite 数据目录）。
- Python Worker：39 项通过。
- Web 端到端：9 项通过；Desktop 端到端：8 项通过。
- macOS arm64 自包含安装包：1 项通过，实际完成动态采集与分析。
- `bun run release:verify` 完整通过；此轮运行时 Redis/PostgreSQL 容器均已停止。
- Node API bundle：实际完成 SQLite 初始化、管理员创建、重启后登录及静态 Web 服务验证。
- `bun run dev:headless`：API、Web 和自定义 SQLite 数据目录实际启动验证通过。
- 部署 Compose 配置、备份恢复脚本语法、Linux 包脚本类型检查通过。
- Linux x64 发行包和 Compose 备份恢复由对应 CI 作业验证；本机为 macOS arm64，不将其他平台视为已验证。
