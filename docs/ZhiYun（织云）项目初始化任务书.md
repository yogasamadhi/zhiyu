# ZhiYun（织云）项目初始化任务书

你现在是 ZhiYun 项目的首席架构师和初始化开发者。

请直接在当前仓库中完成项目初始化和第一阶段 MVP，不要只给建议、架构图或伪代码。

如果仓库为空，从零初始化。

如果仓库已经存在内容，先检查现有结构，尽量保留合理内容，不要无意义覆盖。

遇到普通技术选择请自行做合理决策，不要频繁询问用户。

---

# 1. 项目名称

项目正式名称：

**ZhiYun**

中文名：

**织云**

推荐仓库名：

```text
zhiyun
```

产品显示名称：

```text
ZhiYun 织云
```

名称寓意：

> 像织网一样，从 Web 中采集、整理和结构化数据。

---

# 2. 项目定位

ZhiYun 是一个：

> **实用、智能、开箱即用的 Web 数据采集平台。**

英文定位：

> **Practical Intelligent Web Data Extraction Platform**

项目目标不是为了制造一个全新的“AI 爬虫概念”，也不是单纯做一个 Crawlee GUI。

第一目标是：

> **让用户尽可能少写代码，就能稳定地把网页中的数据采集下来。**

用户应该能够：

```text
输入 URL
   +
描述自己想要的数据
   ↓
系统分析网页
   ↓
自动或半自动生成采集规则
   ↓
预览数据
   ↓
保存任务
   ↓
重复运行
   ↓
定时采集
   ↓
导出或写入数据库
```

AI 是辅助能力，不是所有任务的默认执行方式。

---

# 3. 产品原则

始终遵循以下原则。

## 3.1 实用优先

不要为了所谓“创新”增加无意义复杂度。

优先级：

```text
能稳定工作
>
容易使用
>
容易维护
>
性能
>
高级智能化
>
概念上的差异化
```

---

## 3.2 确定性优先

能用传统方式解决的问题，不默认调用 AI。

推荐执行顺序：

```text
API / JSON
    ↓
HTTP
    ↓
CSS / XPath / DOM
    ↓
Playwright Browser
    ↓
AI Extraction
    ↓
AI Browser Agent
```

原则：

> Deterministic when possible, AI when useful.

---

## 3.3 AI 是辅助工具

AI 第一阶段主要解决：

- 用户自然语言需求理解；
- 自动生成字段 Schema；
- 自动生成 CSS/XPath 提取规则；
- 无规则网页的数据抽取；
- 辅助判断页面结构；
- 采集失败后的规则修复建议。

不要让普通采集任务每次执行都调用 LLM。

理想模式：

```text
第一次
AI 辅助生成规则
       ↓
保存规则
       ↓
以后重复使用传统规则
       ↓
成本低
速度快
结果稳定
```

---

# 4. 第一阶段核心目标

第一阶段不要做“大而全的平台”。

必须先实现以下完整闭环：

```text
创建任务
   ↓
输入 URL
   ↓
定义需要的数据字段
   ↓
分析网页
   ↓
生成/编辑规则
   ↓
预览结果
   ↓
保存任务
   ↓
再次运行
   ↓
查看历史结果
   ↓
导出数据
```

如果这条链路没有真正跑通，就不要提前开发复杂 Agent、分布式任务或企业功能。

---

# 5. 第一阶段最重要功能

MVP 必须优先完成：

## 5.1 URL 采集

支持：

- 普通 HTML 页面；
- JSON/API；
- JavaScript 动态网页；
- 列表页；
- 详情页。

---

## 5.2 字段提取

支持：

- CSS Selector；
- XPath；
- Text；
- HTML；
- Attribute；
- URL；
- Number；
- Date。

---

## 5.3 浏览器采集

使用：

```text
Playwright
```

支持基础：

- 页面加载；
- 点击；
- 等待；
- 滚动；
- 分页；
- Cookie；
- Headers；
- 浏览器 Session。

---

## 5.4 AI 辅助

用户可以输入：

```text
提取商品名称、价格、销量和商品链接
```

AI 帮助生成：

```text
字段 Schema
+
候选 Selector
```

必须允许用户：

```text
查看
编辑
测试
确认
```

AI 生成的规则不能黑盒直接保存为正式规则。

---

## 5.5 数据预览

抓取后展示表格：

```text
商品名称 | 价格 | 销量 | URL
```

显示：

- 记录数量；
- 当前 URL；
- 使用方式；
- HTTP / Browser；
- 是否使用 AI；
- 执行时间；
- 错误信息。

---

## 5.6 任务保存

任务保存：

- URL；
- 规则；
- Headers；
- Cookie 配置；
- 浏览器设置；
- 分页设置；
- Schema；
- 输出设置。

---

## 5.7 重复运行

保存后的任务必须可以直接：

```text
Run
```

而不需要重新分析网页。

---

## 5.8 定时任务

MVP 支持：

```text
Manual
Cron
```

例如：

```text
每天 08:00
每小时
每 30 分钟
```

---

## 5.9 数据导出

第一阶段支持：

```text
CSV
JSON
Excel
```

另外支持保存到：

```text
PostgreSQL
```

---

# 6. 技术栈

项目采用 Monorepo。

主要语言：

```text
TypeScript
```

AI 服务：

```text
Python
```

---

# 7. TypeScript 技术栈

使用：

```text
Node.js
TypeScript
pnpm workspace
```

核心依赖：

```text
Crawlee
Playwright
Cheerio
Zod
Fastify
Drizzle ORM
PostgreSQL
Redis
Pino
Vitest
```

前端：

```text
React
TypeScript
Vite
```

UI 可以使用：

```text
shadcn/ui
```

如果引入不会显著增加复杂度，可以使用。

---

# 8. Python AI Service

建立：

```text
services/ai
```

使用：

```text
Python 3.12+
uv
FastAPI
Pydantic
PydanticAI
pytest
ruff
```

职责仅限于 AI 相关能力：

```text
自然语言 → Schema
HTML → Extraction Rule
HTML → Structured Data
Rule 修复建议
数据质量辅助判断
```

不要在 Python 中复制 Crawlee 的传统爬虫能力。

---

# 9. AI Provider

AI 服务不能绑定单一模型厂商。

设计：

```text
AiProvider
```

第一阶段至少支持：

```text
Mock Provider
OpenAI-Compatible Provider
```

OpenAI-Compatible Provider 应允许配置：

```env
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
```

以后可以兼容：

```text
OpenAI
DeepSeek
Qwen
GLM
MiniMax
Gemini
Anthropic
Local Model
```

没有 API Key 时整个项目必须仍然能够启动。

---

# 10. Crawlee

Crawlee 是 ZhiYun 的主要传统采集 Runtime。

负责：

```text
Request Queue
HTTP crawling
Browser crawling
retry
concurrency
session
proxy
request lifecycle
```

不要让业务代码到处直接依赖 Crawlee。

建立：

```text
packages/crawler-runtime
```

作为 Adapter。

例如：

```ts
export interface CrawlRequest {
  url: string;
  rule?: ExtractionRule;
  browser?: boolean;
}

export interface CrawlResult<T = unknown> {
  records: T[];
  metadata: CrawlMetadata;
}
```

业务层调用 ZhiYun 自己的 Runtime API。

---

# 11. Stagehand

Stagehand 第一阶段作为可选 AI Browser 能力接入。

不要默认所有 Browser Task 都使用 Stagehand。

规则：

```text
普通网页自动化
→ Playwright

复杂、未知网页操作
→ Stagehand
```

建立：

```text
packages/browser-runtime
```

内部再区分：

```text
PlaywrightAdapter
StagehandAdapter
```

第一阶段 Stagehand 可以只完成接口、配置和一个最小 Demo。

---

# 12. Vendor 策略

项目允许 Vendor：

```text
vendor/
├── crawlee/
└── stagehand/
```

但是不要为了 Vendor 而 Vendor。

如果普通依赖已经能够满足当前开发需求：

第一阶段允许先使用正常 package dependency。

同时预留：

```text
vendor/
vendor/README.md
vendor/vendor.lock.json
```

未来确认需要深度修改时再同步上游源码。

绝对不要：

```text
Fork Playwright
Fork Chromium
```

第一阶段也不要 Vendor：

```text
Firecrawl
Crawl4AI
ScrapeGraphAI
Scrapy
```

这些项目可以作为架构参考，但不要拼装进核心 Runtime。

---

# 13. Monorepo 结构

建立：

```text
zhiyun/
│
├── apps/
│   ├── web/
│   └── api/
│
├── packages/
│   ├── crawler-runtime/
│   ├── browser-runtime/
│   ├── extraction/
│   ├── rules/
│   ├── scheduler/
│   ├── storage/
│   ├── shared/
│   └── config/
│
├── services/
│   └── ai/
│
├── tooling/fixtures/
│   ├── static-site/
│   └── dynamic-site/
│
├── vendor/
│
├── patches/
│
├── docs/
│   ├── architecture.md
│   ├── concepts.md
│   └── adr/
│
├── tooling/scripts/
│
├── docker-compose.yml
├── pnpm-workspace.yaml
├── package.json
├── .env.example
├── .gitignore
├── README.md
└── LICENSE
```

注意：

第一阶段不要拆成十几个微服务。

---

# 14. Web 页面

第一阶段建立 4 个主要页面。

## 页面 1：任务列表

展示：

```text
任务名称
URL
状态
最后运行时间
记录数量
调度方式
```

支持：

```text
新建
运行
编辑
删除
```

---

## 页面 2：创建任务

第一屏保持简单。

字段：

```text
任务名称

URL

我想获取什么：
[ 获取商品名称、价格、销量和链接 ]

[分析网页]
```

高级配置折叠起来。

---

# 15. 页面分析

点击：

```text
分析网页
```

系统执行：

```text
检查 URL
   ↓
HTTP 请求
   ↓
分析 HTML
   ↓
必要时 Browser
   ↓
发现列表/数据结构
   ↓
AI 可选辅助
```

然后生成建议字段：

```text
name
price
sales
url
```

---

# 16. Rule Builder

第二阶段 UI 可以逐渐发展为可视化 Rule Builder。

但 MVP 至少需要显示：

```text
字段
Selector
类型
示例值
```

例如：

| Field | Selector         | Type | Preview |
| ----- | ---------------- | ---- | ------- |
| name  | `.product-title` | text | iPhone  |
| price | `.price`         | text | ¥5999   |
| url   | `a`              | href | ...     |

用户可以手动修改 Selector。

必须提供：

```text
测试规则
```

---

# 17. Extraction Rule

ZhiYun 自己定义 Rule Schema。

不要直接持久化 Crawlee 内部对象。

第一版：

```json
{
  "type": "css",
  "container": ".product-card",
  "fields": {
    "name": {
      "selector": ".product-title",
      "value": "text"
    },
    "price": {
      "selector": ".price",
      "value": "text"
    },
    "url": {
      "selector": "a",
      "value": "attribute",
      "attribute": "href"
    }
  }
}
```

支持：

```text
css
xpath
json
```

---

# 18. Rule Version

虽然第一阶段产品不需要强调 Self-Healing，但数据结构必须支持 Rule Version。

至少：

```text
Rule
RuleVersion
```

例如：

```text
Rule
└── v1
└── v2
└── v3
```

修改规则不要直接覆盖历史版本。

这能为未来：

```text
回滚
AI 修复
A/B 验证
```

保留能力。

---

# 19. 数据模型

至少包含：

## CrawlTask

```text
id
name
startUrl
instruction
status
schedule
createdAt
updatedAt
```

---

## CrawlRun

```text
id
taskId
status
startedAt
finishedAt
requestCount
recordCount
browserUsed
aiUsed
error
metadata
```

---

## ExtractionRule

```text
id
taskId
name
activeVersionId
createdAt
updatedAt
```

---

## RuleVersion

```text
id
ruleId
version
type
definition
generatedBy
createdAt
```

generatedBy：

```text
human
ai
system
```

---

## ExtractedRecord

```text
id
taskId
runId
sourceUrl
data JSONB
createdAt
```

---

# 20. PostgreSQL

使用 PostgreSQL 保存：

```text
tasks
runs
rules
rule_versions
records
```

使用：

```text
JSONB
```

保存结构化采集数据。

ORM：

```text
Drizzle ORM
```

---

# 21. Redis

Redis 第一阶段主要用于：

```text
temporary queue
cache
locks
task state
```

业务最终状态不要只保存在 Redis。

---

# 22. Scheduler

实现简单 Scheduler。

支持：

```text
manual
cron
```

接口：

```ts
interface Scheduler {
  schedule(taskId: string, cron: string): Promise<void>;
  unschedule(taskId: string): Promise<void>;
}
```

第一阶段不做复杂分布式 Scheduler。

---

# 23. API

Fastify API 至少提供：

```text
POST   /api/tasks
GET    /api/tasks
GET    /api/tasks/:id
PUT    /api/tasks/:id
DELETE /api/tasks/:id

POST   /api/tasks/:id/analyze
POST   /api/tasks/:id/run

GET    /api/tasks/:id/runs
GET    /api/runs/:id

GET    /api/runs/:id/records

GET    /api/tasks/:id/rules
POST   /api/tasks/:id/rules/test
```

---

# 24. AI API

Python FastAPI 至少提供：

## POST /schema

自然语言：

```text
我要名称、价格和链接
```

返回：

```json
{
  "fields": [
    {
      "name": "name",
      "type": "string"
    },
    {
      "name": "price",
      "type": "string"
    },
    {
      "name": "url",
      "type": "string"
    }
  ]
}
```

---

## POST /generate-rule

输入：

```json
{
  "html": "...",
  "instruction": "...",
  "schema": {}
}
```

返回：

```text
Candidate ExtractionRule
```

---

## POST /extract

作为没有稳定规则时的 AI 结构化抽取能力。

---

# 25. 页面分析策略

第一阶段不需要做复杂 AI Smart Router。

实现简单、可靠的策略即可。

例如：

```text
请求 URL
   ↓
Content-Type 是 JSON
   ↓
JSON

否则获取 HTML
   ↓
HTML 中已有目标内容
   ↓
HTTP + DOM

否则
   ↓
Playwright

仍无法确定结构
   ↓
AI 辅助
```

未来再做更智能的 Router。

---

# 26. 分页

第一阶段支持常见：

```text
Next Button
Page Number
Load More
Infinite Scroll
```

分页配置属于 Task。

不要一开始试图自动识别世界上所有分页形式。

---

# 27. 登录态

第一阶段支持基础：

```text
Cookie
Headers
```

以及：

```text
使用本地浏览器 Session
```

但不要开发：

```text
验证码破解
Cloudflare 绕过
账号攻击
付费墙绕过
```

---

# 28. Proxy

预留 Proxy 配置：

```text
HTTP
HTTPS
SOCKS
```

第一阶段只需要基础配置入口和 Crawlee Adapter 支持。

不要开发 Proxy Marketplace。

---

# 29. 请求控制

默认提供：

```text
timeout
retry
retry backoff
concurrency
request delay
max requests
max runtime
domain rate limit
```

保证软件不会默认无限制请求网站。

---

# 30. Robots.txt

提供：

```text
respectRobotsTxt
```

配置。

默认建议开启。

---

# 31. 导出模块

建立：

```text
packages/exporters
```

如果不想额外 package，也可暂放 storage。

实现：

```text
CSV
JSON
XLSX
```

设计统一接口：

```ts
interface DataExporter {
  export(records: unknown[], options: ExportOptions): Promise<ExportResult>;
}
```

---

# 32. Fixtures

不要使用公开互联网网站作为自动测试基础。

建立：

```text
tooling/fixtures/static-site
tooling/fixtures/dynamic-site
```

---

## Static Fixture

页面：

```text
/products
```

包含：

```text
商品名称
价格
销量
详情链接
分页
```

用于测试：

```text
HTTP
CSS Selector
分页
```

---

## Dynamic Fixture

数据通过 JavaScript 延迟加载。

用于测试：

```text
Playwright
滚动
Load More
```

---

# 33. MVP E2E

必须真正完成这一条：

```text
打开 ZhiYun

        ↓

新建任务

URL:
fixture/products

需求：
获取商品名称、价格、销量和链接

        ↓

分析网页

        ↓

得到字段和 Selector

        ↓

预览 10 条数据

        ↓

保存任务

        ↓

再次点击运行

        ↓

直接使用已保存 Rule

        ↓

结果写入 PostgreSQL

        ↓

前端查看结果

        ↓

导出 CSV / Excel
```

这条链路必须真实工作。

---

# 34. AI Demo

另外实现一条：

```text
没有人工 Rule
      ↓
用户输入自然语言
      ↓
Mock AI
      ↓
生成 Candidate Rule
      ↓
测试 Rule
      ↓
展示结果
```

没有真实 API Key 也必须可以演示。

---

# 35. Docker Compose

建立：

```text
docker-compose.yml
```

包含：

```text
PostgreSQL
Redis
```

如果 fixtures 需要独立 Server，也可以增加。

不要强制开发人员所有服务必须通过 Docker 运行。

---

# 36. 开发体验

希望新开发者可以：

```bash
git clone ...
cd zhiyun

pnpm install

docker compose up -d

pnpm dev
```

然后启动：

```text
Web
API
Fixtures
```

AI Python 服务如果无法合并到 `pnpm dev`，README 提供：

```bash
cd services/ai

uv sync

uv run uvicorn ...
```

最好通过根目录 script 一并启动。

---

# 37. Root Scripts

至少：

```text
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm format
```

---

# 38. 环境变量

建立：

```text
.env.example
```

至少：

```env
DATABASE_URL=
REDIS_URL=

WEB_PORT=
API_PORT=
AI_SERVICE_URL=

AI_PROVIDER=
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=

CRAWLER_CONCURRENCY=
CRAWLER_TIMEOUT=
CRAWLER_MAX_REQUESTS=
```

禁止提交真实 Secret。

---

# 39. TypeScript 规范

必须：

```text
strict = true
```

尽量避免：

```text
any
```

跨模块数据使用：

```text
Zod
```

定义 Schema 和 Type。

---

# 40. Python 规范

使用：

```text
type hints
Pydantic
ruff
pytest
```

避免大量：

```text
dict[str, Any]
```

作为永久核心模型。

---

# 41. Logging

使用：

```text
Pino
```

每次运行至少记录：

```text
taskId
runId
url
duration
requestCount
recordCount
browserUsed
aiUsed
error
```

---

# 42. 错误分类

至少定义：

```text
CrawlerError
NavigationError
ExtractionError
RuleError
ValidationError
AiError
StorageError
ExportError
```

不要只：

```text
console.error("failed")
```

---

# 43. README

README 首页明确介绍：

# ZhiYun 织云

> Practical Intelligent Web Data Extraction Platform

说明：

```text
ZhiYun 是什么
适合做什么
核心功能
架构
如何启动
如何建立第一个 Task
如何配置 AI
如何运行测试
```

---

# 44. Architecture 文档

建立：

```text
docs/architecture.md
```

使用 Mermaid。

至少包含：

```text
              Web UI
                 ↓
               API
                 ↓
             Task
                 ↓
           Crawl Runtime
          /            \
       HTTP           Browser
        ↓               ↓
     Cheerio        Playwright
        \               /
         \             /
          Extraction
              ↓
             Rule
              ↓
          PostgreSQL
              ↓
            Export

AI Service
    ↓
辅助 Schema / Rule / Extraction
```

---

# 45. ADR

建立：

```text
docs/adr
```

至少：

```text
0001-use-typescript-runtime.md
0002-use-crawlee.md
0003-use-playwright.md
0004-python-ai-service.md
0005-own-rule-schema.md
```

保持简洁。

---

# 46. 第一阶段不要做

严格禁止为了“架构漂亮”提前加入：

```text
Kafka
Kubernetes
复杂微服务
多租户
RBAC
企业 SSO
Billing
Payment
Marketplace
复杂 Agent Runtime
浏览器集群
代理池 SaaS
CAPTCHA bypass
Anti-bot warfare
复杂 Self-Healing
自动修改生产 Rule
完整插件市场
```

除非当前 MVP 已全部完成。

---

# 47. 为未来预留，但不重点实现

代码结构要允许未来增加：

```text
AI Rule Repair
Self Healing
Rule Version Rollback
MCP
REST Data API
Webhook
Plugin System
Distributed Workers
Multi User
Team Workspace
Cloud Deployment
Desktop Application
```

但不要第一版全部做出来。

---

# 48. UX 原则

ZhiYun 面向的不只是开发者。

所以普通用户看到的界面应该是：

```text
URL
+
我想获取什么
+
开始
```

复杂配置放：

```text
高级设置
```

不要第一屏出现几十个：

```text
XPath
Headers
Cookie
Concurrency
Retry
Proxy
WaitUntil
Selector
```

高级用户需要时再展开。

---

# 49. 产品理念

不要把 ZhiYun 做成：

> 一个需要学习半天才能使用的“低代码爬虫 IDE”。

也不要做成：

> 一个输入 Prompt 后完全不知道 AI 在干什么的黑盒。

理想状态：

```text
简单用户
→ AI/自动识别帮他完成

高级用户
→ 可以完全控制规则
```

两种模式应该共存。

---

# 50. 第一阶段验收标准

完成初始化后，至少满足：

- [ ] Monorepo 初始化完成
- [ ] pnpm workspace 正常
- [ ] TypeScript strict
- [ ] React Web 可以打开
- [ ] Fastify API 正常
- [ ] PostgreSQL 正常
- [ ] Redis 正常
- [ ] Drizzle migration 正常
- [ ] Crawlee Runtime 可用
- [ ] Playwright Runtime 可用
- [ ] static fixture 可以采集
- [ ] dynamic fixture 可以采集
- [ ] Extraction Rule 可以创建
- [ ] Rule 可以保存
- [ ] 已保存 Rule 可以重复运行
- [ ] 用户可以新建 Task
- [ ] 用户可以运行 Task
- [ ] 用户可以查看 Records
- [ ] CSV 导出可用
- [ ] JSON 导出可用
- [ ] Excel 导出可用
- [ ] Scheduler 基础功能可用
- [ ] Python AI Service 可以启动
- [ ] Mock AI Provider 可用
- [ ] AI 可以生成 Candidate Rule Demo
- [ ] README 完整
- [ ] 测试可执行
- [ ] 无真实 Secret
- [ ] 没有真实 LLM Key 也能开发

---

# 51. 初始化执行顺序

请按照下面顺序实际完成。

## Phase 1

初始化：

```text
pnpm workspace
TypeScript
ESLint
Prettier
Vitest
```

---

## Phase 2

创建目录结构。

---

## Phase 3

配置：

```text
PostgreSQL
Redis
Drizzle
```

---

## Phase 4

建立：

```text
shared
storage
rules
extraction
crawler-runtime
browser-runtime
```

---

## Phase 5

实现：

```text
static fixture
dynamic fixture
```

---

## Phase 6

跑通：

```text
HTTP crawl
Browser crawl
Rule extraction
```

---

## Phase 7

建立 Fastify API。

---

## Phase 8

建立 React Web。

---

## Phase 9

跑通：

```text
Create Task
Analyze
Preview
Save Rule
Run
View Records
Export
```

---

## Phase 10

建立 Python AI Service。

实现：

```text
Mock Provider
Schema API
Generate Rule API
```

---

## Phase 11

增加 Scheduler。

---

## Phase 12

补齐：

```text
tests
README
architecture
ADR
```

---

# 52. 完成前必须实际检查

运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Python：

```bash
cd services/ai
uv run pytest
```

如果出现可以修复的问题，请直接修复。

不要把明显可解决的问题留给用户。

---

# 53. 最终向用户报告

完成后输出：

```text
1. 当前 ZhiYun 已实现什么
2. 哪些功能可以实际运行
3. 哪些只是预留接口
4. 项目目录结构
5. 如何启动
6. 如何运行测试
7. 如何创建第一个爬虫任务
8. 当前已知限制
9. 下一步最值得开发的 3 个功能
```

不要声称没有实现的功能已经完成。

---

# 54. 最重要的要求

ZhiYun 第一阶段的目标不是：

> 做世界上技术最复杂的 AI Crawler。

而是：

> **做一个真正可以拿来抓数据的软件。**

核心路线：

```text
简单网页
→ 简单解决

复杂网页
→ Browser

不确定的网页
→ AI 辅助

规则生成后
→ 保存

以后重复运行
→ 不依赖 AI

数据
→ 可预览
→ 可保存
→ 可导出
→ 可定时
```

始终优先：

> **实用、稳定、透明、可控。**

现在开始直接初始化 ZhiYun 项目，不要停留在方案讨论阶段。
