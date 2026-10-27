# 开发与验收复现

日常开发、构建和安装见 [README.md](README.md)，本次安装包身份及真实结果见 [ACCEPTANCE.md](ACCEPTANCE.md)。全部测试驱动只用于开发，不作为安装包的运行依赖。

## 工程检查

在仓库根目录运行：

```sh
pnpm --filter dsh-zhiyun typecheck
pnpm --filter dsh-zhiyun lint
pnpm exec prettier --check dsh-plugin/src dsh-plugin/scripts dsh-plugin/test
pnpm run dsh-plugin:build
pnpm run dsh-plugin:test
pnpm exec vitest run desktop/packages/client/test/runtime-client.test.ts
pnpm run architecture:check
pnpm run architecture:deps
pnpm run worker:test
pnpm test
```

全量测试包含真实浏览器和进程故障恢复用例。请在停止验收用宿主和浏览器后单独执行，减少与其他重任务争用资源。不要给测试注入真实模型或输出账户。

## 宿主测试驱动

`scripts/business-flow.ts` 启动本地 HTML/动态 HTML 夹具，通过白名单业务接口验证采集、幂等、版本冲突、不可变 Snapshot、清洗、分析、语料、故障告警和导出。

`scripts/e2e-web.ts` 使用真实 Web 入口，并额外操作工作台导航、凭据对话框和下载。`scripts/e2e-desktop.ts` 启动 `/Applications/DeepSeek Harness.app`，使用 `.artifacts/dsh-plugin/desktop-home/` 与 `desktop-user-data/` 隔离用户环境。Desktop profile 首次建立可运行 `scripts/desktop-bootstrap.ts`；安装插件时应使用该 Desktop 自带 CLI。

`test/fixtures/host.mjs` 是独立的验收插件，注册明确的本地模型 Provider，并通过真实工具注册表和 Typert Gateway 检查权限及调用。它不随 `dsh-zhiyun` 安装包发布。验收 profile 可在自己的 Cordis patch 中插入该文件 URL，配置 `report` 输出路径，按需配置 `workspace` 夹具目录、`auditStreams: true` 和 `auditAgent: true`。事件续传检查要求目标 Workspace 已有业务事件。

```sh
# 官方 DSH Web CLI 运行后，将其发布的含 token 地址保存在日志中。
DSH_TEST_LOG=/absolute/path/host.log \
DSH_TEST_HOME=/absolute/path/isolated-dsh-home \
pnpm exec tsx dsh-plugin/scripts/e2e-web.ts

# 只在隔离 Desktop profile 配置 zhiyun-fixture/fixture 默认模型后启用模型检查。
DSH_TEST_MODEL_FIXTURE=1 pnpm exec tsx dsh-plugin/scripts/e2e-desktop.ts
```

`presentation-flow.ts` 检查宿主主题、语言和关闭面板后的 Runtime 生命周期；`lifecycle-flow.ts` 通过 DSH 插件管理 Remote 实际禁用和重新启用插件。它会检查验收 profile 内 Runtime 锁对应的进程，因此只对隔离 profile 运行。

## 独立安装约束

构建 tarball 后，将其及官方 DSH CLI 安装在原仓库以外的目录。验收所需的 Fixture 插件也应复制到外部目录，且依赖由外部 CLI 提供。使用干净的 DSH home/profile，通过该 CLI 安装 tarball。

macOS 可用以下 sandbox 策略验证 Runtime 不依赖原仓库和 Python/uv，将路径替换为实际仓库绝对路径：

```scheme
(version 1)
(allow default)
(deny file-read* (subpath "/absolute/path/to/zhiyu"))
(deny process-exec (regex #"(^|/)(python([0-9.]*)?|uv)$"))
```

在此策略下启动外部官方 CLI 和被测插件，Host 日志也必须写入仓库以外。另行尝试读取仓库文件、执行 Python 和 uv，确认都被拒绝。驱动程序可以从 sandbox 外连接宿主；业务 Runtime、Worker 和采集浏览器必须由受限宿主启动。

结束后正常关闭验收宿主，检查追踪的 Node、Worker、浏览器进程全部退出；保留 profile 的业务数据验证后续读取。不要修改用户日常 profile，也不要删除运行中的 Runtime 锁文件。
