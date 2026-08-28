# ZhiYun 织云

> Practical Intelligent Web Data Extraction Platform

ZhiYun 是一个透明、可编辑、可重复运行的 Web 数据采集平台。当前同时提供两种形态：

- Electron Level 1 桌面应用：本地 SQLite、托盘 Cron、内置 Runtime，不依赖 Bun、Node、Python、Docker、PostgreSQL 或 Redis。
- Bun Headless/Web：PostgreSQL + Redis/BullMQ，适合开发、自动化和后续服务化部署。

两种形态共享同一个 Runtime、HTTP `/api/v1` 协议、生成式 Client、React UI、采集器、提取规则和 TypeScript AI Provider。

## 核心能力

- HTTP/Cheerio、JSON API、Sitemap URL 发现与 Playwright 动态页面采集
- 统一 CrawlPlan：列表、分页、详情页、Browser Actions、合并和去重
- CSS、XPath、JSONPath、HTML 内嵌 JSON 规则与不可变 Rule Version
- 可视化页面点选、规则测试、版本 Diff/回滚和 AI 修复建议
- Next、页码、Load More、Infinite Scroll
- 手动运行、五段 Cron、任务互斥、取消和崩溃恢复
- 持久 Domain Event、实时进度 SSE、Cursor Pagination
- RFC 7807 Problem Details、Trace ID、ETag/If-Match、Idempotency-Key
- CSV、JSON、XLSX Artifact 与桌面原生保存对话框
- Snapshot/Upsert/Append Dataset、Added/Updated/Removed 变更历史
- Webhook、外部 PostgreSQL 与带任务 Scope 的只读 Data API
- Mock / OpenAI-compatible TypeScript AI Provider；无密钥自动回退 Mock
- 中英文共享 UI；Web 与 Electron Renderer 不复制业务页面
- Desktop safeStorage 与 Headless AES-256-GCM 凭据存储

## 桌面开发

环境只需 Bun 1.4+。第一次动态采集前安装浏览器资源：

```bash
bun install
bun run desktop:browser
bun run dev
```

`bun run dev`（也可直接执行 `bun run.ts`）默认启动 fixtures、Vite Desktop Renderer 与 Electron；`bun run desktop:dev` 作为显式桌面别名继续可用。SQLite Runtime 由 Electron `utilityProcess` 监督。关闭窗口后应用驻留托盘，Cron 继续运行；托盘或应用菜单“退出”会进行最长 30 秒的有序关闭。

常用桌面命令：

```bash
bun run desktop:build       # Main / Preload / Runtime / Renderer
bun run desktop:test        # Electron Playwright E2E
bun run desktop:package     # 未制作为安装器的应用目录
bun run test:smoke:desktop-package # 启动自包含产物并执行动态采集
bun run desktop:make        # macOS DMG/ZIP 或 Windows Squirrel
```

Forge 固定为 7.11.2，Electron 固定为 44.0.0，`better-sqlite3` 固定为 13.0.3。Chromium 位于 `resources/playwright` 并在安装包中置于 ASAR 外。签名凭据只从 CI 环境变量读取：

- macOS：`MAC_CODESIGN_IDENTITY`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- Windows：`WINDOWS_CERTIFICATE_FILE`、`WINDOWS_CERTIFICATE_PASSWORD`

不配置签名时仍可生成本地测试安装包；首版不包含 publish 或 autoUpdater。

应用开发与运行以 Bun 为入口。生成安装器的构建机还需要对应平台的原生编译工具；Forge DMG maker 的两个 host addon 会通过 `node-gyp` 调用构建机 Node/Python 编译。它们只参与制作 DMG，不进入应用运行依赖，最终用户仍不需要安装 Bun、Node 或 Python。

## Headless/Web 开发

环境需要 Bun 1.4+、Docker 与 Docker Compose：

```bash
cp .env.example .env
bun install
bun run browser:install
bun run dev:headless
```

`bun run dev:headless` 等价于 `bun run.ts --headless`。默认地址：Web `http://127.0.0.1:45173`、API `http://127.0.0.1:45300`、fixtures `http://127.0.0.1:45100`；PostgreSQL 和 Redis 的宿主机端口分别为 `45432`、`46379`。`run.ts` 会检查锁文件、启动 PostgreSQL/Redis、执行 Drizzle migration，再启动 API、Web 和 fixtures。

若默认应用端口已被其他程序占用，`run.ts` 会在启动服务前自动选择后续可用端口，并同步更新 Vite 代理与 fixture URL。通过 `API_PORT`、`WEB_PORT`、`FIXTURE_PORT` 或 `DESKTOP_RENDERER_PORT` 显式指定端口时，端口冲突会直接报错而不会静默改用其他端口。

```bash
bun run.ts --headless --skip-docker
bun run.ts --headless --skip-migrate
bun run.ts --headless --skip-install
bun run.ts --headless --stop-infra
```

## 创建第一个任务

任务列表提供“添加示例任务”：它会创建一个带完整 CSS 规则的豆瓣电影 Top 250 任务，仅在手动运行时使用内置浏览器读取当前一页（最多 25 条），不使用 AI、不开启翻页或详情页追抓，也不会在创建时自动访问外网。示例遵守 robots.txt，单并发、零重试，并设置 5 秒域名请求间隔。

红果、番茄和 B站的内置公开趋势任务统一从顶部“偏好与趋势”入口启用，不再混在普通任务列表中；来源卡仍可打开对应的原始采集任务。

1. 点击“新建任务”。
2. 使用 `http://127.0.0.1:45100/products`，输入“获取商品名称、价格、销量和链接”。
3. 分析网页，检查并测试候选规则。
4. 确认保存规则后运行任务。
5. 在运行结果中查看历史记录并导出 CSV、JSON 或 XLSX。

动态页面使用 `http://127.0.0.1:45100/dynamic-products`，启用 Browser，分页设为 Load More，Selector 使用 `#load-more`。

公开短剧元数据的保守示例见 [红果短剧采集计划](docs/examples/hongguo-short-drama.md)。它从官方 sitemap 发现详情 URL，只读取详情页公开结构化数据，并默认限制为 20 条、单并发且遵守 robots.txt。

## 使用偏好与趋势

1. 打开顶部导航“偏好与趋势”。首次进入只显示将要创建的数据源、更新频率和隐私说明，不会自动联网。
2. 点击“一键启用”，幂等创建红果最新短剧、番茄男女频阅读榜和 B站综合热门任务，并启动首次同步。
3. 通过来源卡控制启用状态和自动更新，或点击“立即更新 / 更新全部”；红果每天 17:00、番茄每天 16:30、B站每 6 小时的第 15 分钟自动更新，时区为 `Asia/Shanghai`。
4. 在内容卡上选择“喜欢”“不感兴趣”“读完/看完”，也可以添加手动标签，或导入番茄详情、红果详情、B站视频和 `b23.tv` 链接。
5. 偏好画像按明确证据实时计算。系统不读取浏览器历史、Cookie、平台观看记录或账号收藏；抖音仅显示待接入位置，小红书第一版不接入。

来源失败时保留上次成功数据并显示错误/陈旧状态。趋势分数只在各来源内部归一化，热门词来自标题、分类和显式标签的本地分词统计，不使用 AI，也不把跨平台原始播放量和阅读量直接比较。

## AI 与凭据

默认 Mock Provider 不需要密钥。启用 OpenAI-compatible Provider：

```env
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=your-model
AI_API_KEY=your-key
```

Headless 生产必须提供 base64 编码的 32-byte `ZHIYUN_CREDENTIAL_KEY`，以及至少 32 字符的 `ZHIYUN_ADMIN_TOKEN`。默认只监听 `127.0.0.1`；远程监听还必须设置明确的 `ZHIYUN_ALLOWED_ORIGINS` 与 HTTPS `ZHIYUN_PUBLIC_URL`。Authorization、Cookie、Proxy-Authorization 和浏览器 storage state 通过 `TaskCredentialBindings` 引用 CredentialStore；日志不记录解析后的明文。Desktop 由 Host 的 `safeStorage` 加密，并可在任务高级设置中指定登录 URL，通过隔离的受控登录窗口保存 Cookie/localStorage；业务 Renderer 不具备凭据、文件、数据库或业务 IPC 权限。

网络策略会检查初始 URL、每次重定向和浏览器子请求，阻止非 HTTP(S)、云 Metadata、危险保留地址和不允许的私网目标。敏感 Header 与 Cookie 不会跨 Origin 发送。开发环境自动允许本地 fixtures；Headless production 默认拒绝私网。

## 验证命令

```bash
bun run lint
bun run format:check
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:conformance
bun run test:security
bun run test:performance
bun run build
bun run test:e2e:web
bun run test:e2e:desktop
bun run test:smoke:desktop-package
bun run release:verify
```

Python AI 服务、uv 与 `services/ai` 已从产品代码及应用运行链删除；AI 能力由 TypeScript Provider 提供。

## 项目结构

```text
apps/
  api/                 Bun Headless 装配入口
  web/                 Vite Web 入口
  desktop/             Electron Main / Preload / Renderer / Forge
packages/
  contracts/           Runtime contracts 与共享 API 类型
  runtime/             DI Runtime、API v1、Worker、SSE
  client/              OpenAPI operation 类型与 Runtime Client
  ui/                  Web/Desktop 共用 React UI
  storage/             PostgreSQL Repository
  sqlite-storage/      SQLite Repository、迁移与恢复
  scheduler/           BullMQ 与 Local Queue/Scheduler
  platform/            Credential/Artifact adapters
  ai-runtime/          Mock/OpenAI-compatible TypeScript Provider
  crawler-runtime/     Cheerio/Playwright Crawlee adapter
  preferences/         内置趋势源、归一化、画像计分与热门词
  outputs/             Webhook/PostgreSQL output adapters
fixtures/              静态与动态测试站点
docs/                  架构、概念与 ADR
```

更完整的边界和数据流见 [架构文档](docs/architecture.md) 与 [桌面迁移分析](docs/architecture/desktop/ZHIYUN_DESKTOP_MIGRATION_ANALYSIS.md)。

## License

Apache-2.0
