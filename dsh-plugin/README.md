# 织云 DSH 插件

`dsh-zhiyun` 将织云本地业务 Runtime、DSH 工具和内嵌工作台打包在一起。当前目标是 **macOS arm64 + DeepSeek Harness 0.2.1-rc.3**。桌面应用继续独立保留。

## 开发

在仓库根目录运行：

```sh
pnpm install
pnpm run dsh-plugin:build
pnpm --filter dsh-zhiyun typecheck
pnpm run dsh-plugin:test
pnpm run dsh-plugin:package
```

资源准备需要预先构建 `desktop/analytics-worker/dist/macos-arm64/analytics-worker`，并准备 `desktop/resources/playwright`。开发环境使用 Python/uv 构建 Worker；最终安装包携带冻结 Worker，不要求用户安装 Python/uv。

三个独立编译目标分别是 DSH Host、Node Runtime 和 React 18 工作台。Host 依赖由 DSH 提供，业务包编入 Runtime/工作台。Typert Remote 元数据由官方 `@deepseek-ai/dsh-typert-generator` 生成；临时编译面只保留实际 Remote 方法签名，避免混合两套 Cordis 的 Context 声明。

## 安装

使用与目标宿主相同的 DSH CLI，在目标 profile 安装生成的 tarball：

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-zhiyun-0.1.0.tgz
```

重启相应 profile 后，在侧边栏打开“织云”。Web 与 Desktop 使用同一个安装包。开发时可使用 `link:/absolute/path/zhiyu/dsh-plugin`，但链接安装不能代替独立安装验收。

数据按 DSH home、profile 和 Workspace ID 隔离，默认保存在 `$DSH_HOME/zhiyun/`（未设置时使用 DSH 的默认 home）。不读取织云 Electron 数据库。禁用插件停止自有进程，保留业务数据；重新启用使用持久队列与租约恢复语义。不要手动删除运行中的锁文件。

模型来自 DSH。对话工具固定使用当前 Agent 的模型；工作台使用 DSH 默认选择。未配置模型时可手动建规则，AI 操作会明确失败。凭据仅通过工作台手动输入或登录浏览器采集，DSH 凭据服务保存明文，业务配置保存引用。

导出默认保存到当前工作区 `exports/zhiyun/`。原生目录选择器可用时可选择其他目录。Web 的 Artifact 内容通过 Remote 分块传输。插件面板使用内部路由，不改变宿主会话和页面 URL。

## 工具与边界

工具按 collection、datasets、cleaning、analysis、corpus、monitoring、outputs、templates、jobs 分组，另有 `zhiyun_workspaces` 与 `zhiyun_operation_schema`。`zhiyun_operation_schema` 提供操作参数结构，operationId 取自随包产品目录，业务 API 保留原有校验、ETag 和幂等语义。工具结果有大小及分页上限。Remote 不接受任意 URL、文件路径或宿主管理请求，首版只允许本机 owner。

`resources/manifest.json` 记录资源 SHA-256；启动前校验。`THIRD_PARTY_NOTICES.json` 和 `resources/licenses/` 提供资源版本与许可证信息。源码与验收结果应结合 `ACCEPTANCE.md` 阅读；未通过项目不应解释为已交付能力。
