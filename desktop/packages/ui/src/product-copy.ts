import i18n from './i18n.js';

// Literal legacy page copy is centralized here while existing translation keys remain stable.
const copyCatalog = `
字段值变化|Field value changes
基线运行次数|Baseline runs
最少基线运行次数|Minimum baseline runs
新条件默认：连续 1 次异常、冷却 300 秒、聚合 3600 秒。旧策略保持原语义，只有保存后才生效。|New conditions default to 1 abnormal run, 300 seconds of cooldown and a 3600 second aggregation window. Existing policies keep their semantics and changes apply only after saving.
启用此条件|Enable this condition
阈值单位|Threshold unit
百分点增幅|Percentage point increase
百分比|Percentage
绝对数量|Absolute count
旧策略：比例下限和增幅|Legacy: rate floor and increase
触发阈值|Trigger threshold
连续异常次数|Consecutive abnormal runs
冷却时间（秒）|Cooldown in seconds
聚合窗口（秒）|Aggregation window in seconds
包含字段|Include fields
排除字段|Exclude fields
条件预览|Condition preview
使用此条件默认值|Use defaults for this condition
其他已有质量规则|Other existing quality rules
保存监控策略|Save monitoring policy
放弃未保存修改|Discard unsaved changes
请检查阈值、连续次数、时间范围和基线设置。绝对阈值必须是整数；比例为 0–100；最少基线次数不能大于基线次数。|Check thresholds, consecutive runs, durations and baseline settings. Absolute thresholds must be integers, percentages must be 0–100, and minimum baseline runs cannot exceed baseline runs.
每个字段发生新增、更新或删除的记录数量至少|For each field, the number of added, updated or removed records is at least
每个字段发生新增、更新或删除的记录占比至少|For each field, the share of added, updated or removed records is at least
记录数比基线中位数至少减少|Record count falls below its baseline median by at least
变化占比以本次记录数加删除数为分母。|The change ratio uses this run's record count plus removed records as its denominator.
空值数量比按基线比例预计的数量至少增加|Null count exceeds the count expected from its baseline rate by at least
保留旧策略：空值比例至少|Preserve the legacy policy: null rate is at least
，并比基线至少上升|, and rises above baseline by at least
空值比例比基线至少上升|Null rate rises above baseline by at least
个百分点|percentage points
按整个任务的记录数量比较，字段过滤不参与此规则。|Compare the task's total record count. Field filters do not apply to this condition.
包含：|Include:
排除：|Exclude:
所有字段|All fields
排除优先；缺失字段计入空值。|Exclusions take priority; missing fields count as nulls.
排除优先。|Exclusions take priority.
基线就绪且实际发生变化后评估。冷却期间继续记录异常；聚合不会延长冷却。0 秒表示关闭对应限制。|Evaluation starts when the baseline is ready and an actual change occurs. Abnormal runs are still recorded during cooldown. Aggregation does not extend cooldown. Set a duration to 0 to disable that limit.
监控事件|Monitoring events
通知未显示时，仍可在这里查看事件。计划通知次数不代表系统已送达；关闭事件保留历史，后续异常仍会重新记录。|Events remain available here when system notifications are not shown. Planned notifications do not confirm delivery. Closing an event keeps its history; later anomalies will still be recorded.
正在读取事件|Loading events
异常中|Open
已恢复|Recovered
已关闭|Closed
首次|First occurrence
下一页|Next page
异常次数|Abnormal occurrences
计划通知次数|Planned notifications
未通知次数|Unnotified occurrences
最近异常|Latest anomaly
收起运行记录|Hide run history
查看运行记录|View run history
关闭此事件|Close this event
当前页没有监控事件|No monitoring events on this page
事件页|Event page
事件运行记录|Event run history
通知决策|Notification decision
已计划通知|Notification planned
冷却期间|During cooldown
等待连续异常|Waiting for consecutive anomalies
仅记录事件|Event recorded only
运行记录页|Run history page

操作|Actions
缓存命中|Cache hit
缓存已保存|Cache saved
未使用缓存|Cache not used
本次跳过缓存|Cache bypassed
已在当前页面验证并复用规则|Rule verified and reused on the current page
首次创建已验证规则缓存|Verified rule cache created
页面结构已变化，已重新验证旧规则|Page structure changed; the previous rule was verified again
规则版本已变化|Rule version changed
采集配置或动作已变化|Collection configuration or actions changed
登录或请求上下文已变化|Login or request context changed
模型配置已变化|Model configuration changed
提示词或工具版本已变化|Prompt or tool version changed
缓存已过期|Cache expired
缓存已损坏，已回退到重新生成|Cache is corrupt; generation was requested again
当前数据或未执行的步骤尚未通过缓存验证|Current data or unexecuted steps have not passed cache validation
规则包含不适合持久缓存的值|Rule values are not suitable for persistent caching
模型未提供可验证的缓存身份|The model did not provide a verifiable cache identity
此次分析没有独立缓存范围|This analysis has no separate cache scope
分析期间缓存已被手动清理|Cache was cleared during analysis
缓存存储暂不可用，已继续分析|Cache storage is unavailable; analysis continued
规则生成失败，未缓存备用规则|Rule generation failed; the fallback rule was not cached
页面结构超过缓存指纹限制|Page structure exceeds the cache fingerprint limit
累计复用|Total verified reuses
本次规则生成调用|Rule generation calls this time
动作缓存命中|Action cache hit
动作缓存已保存|Action cache saved
未使用动作缓存|Action cache not used
本次跳过动作缓存|Action cache bypassed
已执行并验证当前页面动作|Current page actions executed and verified
首次创建已验证动作缓存|Verified action cache created
页面结构已变化，已验证当前动作|Page structure changed; current actions verified
动作缺少验证条件或未达到预期状态|Actions lack validation conditions or did not reach the expected state
动作包含不适合持久缓存的选择器|Action selectors are not suitable for persistent caching
本次动作修复调用|Action repair calls this time
状态|Status
重试|Retry
来源：|Source:
已就绪|Ready
质量策略已保存；告警不会把成功采集改判为失败，也不会暂停输出。|Quality policy saved. Alerts do not change collection outcomes or pause outputs.
任务输出绑定已更新。|Task output connections updated.
投递已重新进入队列。|Delivery queued again.
任务 ID 缺失|Task reference is missing
任务详情不可用，请返回任务列表后重试。|Task details are unavailable. Return to the task list and retry.
计划|Schedule
健康度|Quality
最近记录数|Latest record count
最近状态|Recent status
最近运行没有发现质量问题。|No quality issues were found in the latest run.
至少三次成功运行后启用统计型质量判断。|Statistical quality checks begin after three successful runs.
查看数据|View data
质量详情|Quality details
任务配置|Task settings
· 活动规则|· Active rule
未建立|Not created
· 输出绑定|· Output connections
规则与设置|Rules & settings
管理目的地|Manage destinations
质量策略|Quality policy
启用任务质量告警|Enable quality alerts
质量策略暂不可用，健康度与历史仍可查看。|Quality policy is unavailable. Quality status and history remain accessible.
当前健康度|Current quality
· 基线|· Baseline
建立中|Preparing
尚未发现质量问题；请结合评估状态查看|No issues found yet. Check the assessment status for context.
解释原因 / 生成修复建议|Explain failure / suggest a fix
评估与恢复历史|Assessment & recovery history
时间|Time
记录数|Records
字段画像|Field profile
问题|Issues
已恢复/正常|Recovered / healthy
尚无质量评估|No quality assessments yet
推荐分析|Suggested analysis
当前规则没有数值字段，可先运行一次并在数据画像中确认类型。|No numeric fields in this rule. Run the collection and check the field types.
当前规则没有文本字段。|This rule has no text fields.
打开分析工作台|Open analysis workspace
先查看并准备数据|View and prepare data first
从文本创建语料库|Create a corpus from text
选择文本字段，清洗与分块后构建可导出的语料。|Select text fields, clean and chunk them, then build an exportable corpus.
创建语料库|Create corpus
先准备数据版本|Prepare a data version first
任务输出绑定|Task output connections
编辑者可绑定管理员已经创建的目的地，但不能新建目的地或查看秘密。|Editors can connect destinations created by administrators. Creating destinations and viewing secrets require separate permissions.
· 已禁用|· Disabled
尚无输出目的地|No output destinations yet
最近运行投递|Latest run deliveries
目的地|Destination
格式 / 记录|Format / records
最终位置|Final location
最近运行没有数据投递记录|No deliveries for the latest run
运行历史|Run history
开始时间|Start time
变化|Changes
引擎|Engine
尚无运行记录|No runs yet
正在加载本页补充数据…|Loading supporting data…
部分数据暂不可用，但任务详情仍可继续使用：|Some supporting data is unavailable. Task details remain usable:
运行失败|Run failed
空结果|Empty result
记录数骤降|Record count drop
字段消失|Missing field
空值率骤升|Null rate spike
字段类型改变|Field type changed
内容变化阈值|Content change threshold
上一步|Back
下一步|Next
第|Step
新增|Added
更新|Updated
未跟进|Not tracked
已收藏|Saved
计划投递|Planned application
已投递|Applied
面试中|Interviewing
已获 Offer|Offer received
未通过|Rejected
已撤回|Withdrawn
已忽略|Ignored
地点未提供|Location not provided
匹配|Match
来源|Source
薪资|Salary
发布时间|Posted at
平台职位 ID|Platform job reference
职位链接|Job link
职位名称|Job title
公司名称|Company name
工作地点|Location
职位描述|Job description
截止时间|Deadline
经验要求|Experience
学历要求|Education
雇佣类型|Employment type
技能标签|Skills
职位状态|Job status
搜索档案已更新|Search profile updated
搜索档案已创建|Search profile created
文件不能超过 50 MB|The file must be smaller than 50 MB
请选择搜索档案和导入文件|Choose a search profile and a file to import
职位数据已导入|Jobs imported
职位雷达|Job radar
导入你合法取得的招聘数据，跨来源去重并跟踪求职进度。|Import your recruitment data, combine duplicates across sources and track applications.
＋ 新建搜索档案|New search profile
职位雷达工作区|Job radar workspace
匹配职位|Matched jobs
搜索档案|Search profiles
来源与通知|Sources & notifications
导入职位|Import jobs
正在加载职位与搜索档案…|Loading jobs and search profiles…
当前搜索档案|Current search profile
同一职位的多个来源合并展示，来源事实仍分别保留。|Multiple sources for the same job are grouped while preserving each source record.
搜索职位或公司|Search jobs or companies
城市|City
最低月薪|Minimum monthly salary
最高月薪|Maximum monthly salary
最早发布时间|Posted after
最晚发布时间|Posted before
全部来源|All sources
BOSS 直聘|BOSS Zhipin
猎聘|Liepin
汇博招聘|Huibo
全部流程状态|All tracking states
当前档案还没有匹配职位。完成一次文件导入后会显示在这里。|No matching jobs yet. Import a file to see results here.
导入职位数据|Import job data
个来源记录|source records
原职位 ↗|Original job ↗
求职进度|Application progress
先创建一个职位搜索档案。|Create a job search profile first.
不限关键词|Any keyword
高优先级|High priority
普通|Normal
编辑搜索档案|Edit search profile
新建搜索档案|New search profile
档案分别控制来源、匹配条件和通知优先级。|Each profile defines its sources, matching criteria and notification priority.
编辑当前档案|Edit current profile
档案名称|Profile name
包含关键词|Include keywords
TypeScript，数据工程|TypeScript, data engineering
更多匹配条件、来源与通知（可稍后设置）|More matching criteria, sources & notifications (optional)
关键词规则|Keyword matching
命中任一关键词|Match any keyword
命中全部关键词|Match every keyword
排除关键词|Exclude keywords
上海，杭州|Shanghai, Hangzhou
3-5年，5-10年|3-5 years, 5-10 years
本科，硕士|Bachelor, Master
全职，兼职|Full-time, part-time
包含公司|Include companies
排除公司|Exclude companies
最低月薪（元）|Minimum monthly salary (CNY)
最高月薪（元）|Maximum monthly salary (CNY)
通知优先级|Notification priority
普通（每日摘要）|Normal (daily digest)
高（即时通知 + 每日摘要）|High (immediate + daily digest)
摘要时间|Digest time
新鲜度（天）|Freshness (days)
摘要时区|Digest timezone
接受远程|Include remote jobs
启用档案|Enable profile
通知输出|Notification destination
保存中…|Saving…
保存档案|Save profile
取消编辑|Cancel editing
删除当前档案|Delete current profile
招聘来源|Recruitment sources
当前支持文件导入与原站跳转。此实例未安装招聘平台同步适配器。|File imports and original site links are supported. This instance has no recruitment synchronization adapter.
个职位簇包含此来源|job groups include this source
文件导入 / 原站跳转|File import / original site
已授权|Authorized
授权已撤销|Authorization revoked
授权异常|Authorization error
待授权|Authorization pending
仅支持合法文件导入和原站跳转；不调用隐藏接口、不自动登录。|Supports file imports and original site links. No hidden API calls or automatic login.
打开原站搜索|Search on original site
运行已审查的官方授权适配器|Run the reviewed authorized adapter
此实例仅支持文件导入与原站跳转|This instance supports file imports and original site links
同步中…|Syncing…
实时同步|Synchronize
未安装同步适配器|Sync adapter not installed
CSV/JSON · 最大 50 MB / 100,000 行 · 原文件不保留|CSV/JSON · Up to 50 MB / 100,000 rows · Original files are not retained
导入步骤|Import steps
文件|File
映射|Mapping
确认|Confirm
结果|Results
请先创建搜索档案。|Create a search profile first.
导入到档案|Import into profile
数据来源|Data source
先在原站搜索并合法导出数据 ↗|Search and export data from the original site ↗
解析中…|Parsing…
预览并识别字段|Preview and identify fields
识别到|Detected
行、|rows,
列。请确认字段映射。|columns. Confirm the field mapping.
不导入|Do not import
保存为可复用映射|Save a reusable mapping
映射名称|Mapping name
检查完成|Finish checking
确认导入|Confirm import
档案|Profile
数据行|Data rows
描述会转为纯文本，联系方式字段会被丢弃或脱敏；文件内容在请求完成后不保留。|Descriptions become plain text. Contact fields are removed or redacted; file contents are not retained after processing.
导入中…|Importing…
开始导入|Start import
导入完成|Import complete
导入失败|Import failed
有效行|Valid rows
未变化|Unchanged
错误|Errors
错误摘要|Error summary
行：|Row:
完整 JSONL 报告 Artifact：|Complete JSONL report:
继续导入|Import another file
权限不足|Permission required
类型|Type
删除|Delete
名称|Name
停用|Disable
撤销|Revoke
输出目的地管理仅限管理员|Only administrators can manage output destinations
编辑者可以在任务中绑定管理员已创建的目的地，但不能创建外部投递通道或 Data API Token。|Editors can connect destinations created by administrators. Creating delivery channels and API tokens requires administrator access.
输出已创建，尚未选择目录|Output created. Choose a directory to continue.
输出已创建，凭据尚未设置|Output created. Configure credentials to continue.
输出与目录授权已安全保存|Output and directory permission saved securely
输出与凭据已安全保存|Output and credentials saved securely
已加入输出重试队列|Output retry queued
自动化|Automation
设置定时采集、数据同步、通知和 API 访问。|Configure scheduled collections, data synchronization, notifications and API access.
自动化分组|Automation sections
计划任务|Scheduled tasks
数据同步|Data synchronization
消息通知|Notifications
API 访问|API access
在采集任务中设置运行频率，支持单独暂停或恢复计划。|Set each collection's frequency. Schedules can be paused and resumed independently.
已暂停|Paused
管理采集计划|Manage schedules
新增连接|Add connection
连接信息|Connection details
本地目录|Local directory
S3 / 兼容对象存储|S3 / compatible object storage
保存输出|Save output
已连接的目的地|Connected destinations
测试连接|Test connection
更换目录|Change directory
选择目录|Choose directory
替换凭据|Replace credentials
安全输入凭据|Enter credentials securely
启用|Enable
尚未配置输出|No outputs configured
只读 Data API Token|Read-only Data API token
Token 只在创建时显示一次|Tokens are shown only once when created
创建 Token|Create token
每分钟请求上限|Requests per minute
有效天数（0 为永久）|Valid days (0 for no expiration)
任务 Scope（不选择表示全部任务）|Task scope (empty means all tasks)
全部|All
永久|No expiration
最近发送|Recent deliveries
加载开发演示 Webhook|Load development webhook
订阅事件|Subscribed events
保存后将在 Host 安全窗口输入 Connection string。|After saving, enter the connection string in the host's secure dialog.
保存后将打开原生目录选择器；目录授权会加密保存。|After saving, choose a directory in the native dialog. Directory permission is encrypted.
根目录内子目录（可选）|Subdirectory within root (optional)
使用相对路径；实际根目录由 Headless 的 ZHIYUN_OUTPUT_ROOT 锁定。|Use a relative path. The root is configured by ZHIYUN_OUTPUT_ROOT in headless mode.
工作表名称|Worksheet name
写入模式|Write mode
自动（Snapshot/Upsert 替换，Append 追加）|Automatic (replace snapshots/upserts, append new rows)
Replace（快照默认）|Replace (default for snapshots)
Append（带 Run ID 去重）|Append (deduplicated by run)
字段顺序（逗号分隔）|Field order (comma separated)
保存后安全输入服务账号 JSON，并将表格共享给其中的 client_email。|After saving, enter the service account JSON securely and share the sheet with its client_email.
服务账号 JSON|Service account JSON
兼容端点（可选）|Compatible endpoint (optional)
使用 Path-style URL（MinIO 等）|Use path-style URLs (MinIO, etc.)
服务端加密|Server-side encryption
不指定|Unspecified
保存后在 Host 安全窗口输入 S3 凭据；也可使用运行环境 IAM。|After saving, enter S3 credentials in the secure dialog, or use the environment's IAM credentials.
Access Key ID（留空使用环境 IAM）|Access Key ID (empty for environment IAM)
Session Token（可选）|Session token (optional)
文件格式|File format
Parquet（需要分析 Worker）|Parquet (requires analytics Worker)
归档路径模板|Archive path template
同时原子更新 latest 文件 / 对象|Also atomically update the latest file/object
AI Provider 目录为空|AI provider catalog is empty
选择模型厂商和模型 ID；调用地址由系统维护，仅需手动配置 API Key。|Choose a model provider and model. The service address is managed automatically; only an API key is needed.
已连接|Connected
模型厂商|Model provider
模型 ID|Model
（预览）|(preview)
Provider 调用地址|Provider endpoint
系统调用地址|Managed endpoint
官方模型文档|Official model documentation
当前为旧版自定义地址配置。请重新选择厂商、替换对应 API Key 并测试后保存。|This uses a legacy custom endpoint. Select a provider, replace its API key, test the connection and save.
已通过 safeStorage 加密保存|Encrypted with secure storage
尚未配置|Not configured
切换模型厂商后，请替换为该厂商签发的 API Key。|After switching providers, replace the API key with one issued by that provider.
API Key 已安全保存，请执行连接测试。|API key saved securely. Test the connection to continue.
替换 Key|Replace key
配置 Key|Configure key
连接测试通过，可保存并热切换。|Connection test passed. Save to apply without restarting.
Provider 已保存并热切换，无需重启 Runtime。|Provider saved and applied without restarting.
保存 Provider|Save provider
API Key 已删除，聊天切换到演示模式。|API key removed. AI assistance is disconnected; manual editing remains available.
删除 Key|Delete key
Headless 配置为只读。请使用 AI_BASE_URL、AI_MODEL 和 AI_API_KEY 环境变量后重启服务。|Headless settings are read-only. Set AI_BASE_URL, AI_MODEL and AI_API_KEY, then restart the service.
版本|Version
Chromium 资源|Chromium resources
未检测到|Not detected
Desktop Runtime 诊断不可用|Desktop diagnostics are unavailable
服务就绪状态|Service readiness
数据库与队列异常会阻止接入流量；分析 Worker 降级不影响采集。|Database or queue failures prevent new requests. Analytics Worker degradation does not affect collection.
未就绪|Not ready
运行时间|Uptime
队列积压|Queued jobs
调度器|Scheduler
运行中|Running
作业状态|Job status
暂无作业|No jobs
正在读取服务状态|Loading service status
修改|Change
的登录密码。成功后所有会话都会撤销，需要重新登录。|login password. All sessions will be revoked after saving; sign in again to continue.
当前密码|Current password
新密码|New password
确认新密码|Confirm new password
正在修改…|Updating…
修改密码|Change password
SQLite / 迁移|SQLite / migrations
作业队列|Job queue
分析 Worker|Analytics Worker
播放|Views
点赞|Likes
收藏|Favorites
分享|Shares
评论|Comments
在读|Readers
字数|Word count
月票|Monthly votes
概览|Overview
数据|Data
质量|Quality
分析|Analysis
输出|Output
运行|Runs
刷新|Refresh
拒绝|Deny
变化监控|Change monitoring
字段名称|Field name
添加字段|Add field
输出目的地|Output destination
普通列表页|List page
从重复列表卡片提取字段|Extract fields from repeated list cards
列表加详情页|List and detail pages
发现详情链接并补充正文|Find detail links and collect their text
下一页分页|Next page pagination
重复翻页采集列表|Collect lists across pages
无限滚动|Infinite scroll
滚动加载动态列表|Load dynamic lists by scrolling
提取公开结构化接口|Extract from a public structured API
Sitemap 批量详情|Sitemap detail pages
批量发现并采集详情页|Discover and collect detail pages in batches
已登录浏览器采集|Authenticated browser collection
复用安全登录会话|Reuse a secure login session
监控价格、库存或内容变化|Monitor price, stock or content changes
获取商品名称、价格、销量和链接|Collect product names, prices, sales and links
新任务必须通过原子初始化保存任务与首个规则版本|New tasks must save the task and initial rule version together
AI Extract Demo 已完成；预览不会保存或修改正式规则。|AI extraction preview complete. The saved rule is unchanged.
预览请求已完成，但未提取到记录；请调整规则后再运行。|Preview completed without records. Adjust the rule before running.
请先生成或选择规则|Generate or choose a rule first
保存并运行前，请先选择模板或分析网页生成规则。|Choose a template or analyze the page to generate rules before saving and running.
预览未提取到数据，已取消创建和运行。请调整字段或页面动作后重试。|No data was found. Adjust fields or browser actions, then retry creating the task.
任务已创建，但 Runtime 未返回首次运行记录。|Task created, but the first run record was not returned.
预览未提取到数据，已取消运行。请调整规则后重试。|No data was found. Adjust the rule and retry.
登录已取消|Login canceled
登录态已安全保存|Login state saved securely
凭据已由 Desktop Host 加密保存|Credentials encrypted by the desktop host
凭据已删除|Credentials deleted
请先保存任务，再逐步执行浏览器动作|Save the task before executing browser actions step by step
开发环境商品采集|Development product collection
已加载开发环境演示地址；该入口不会出现在生产构建中。|Development demo address loaded. This entry is hidden in production builds.
描述当前规则失败现象|Describe the rule failure
规则失败现象|Rule failure
生成修复建议|Generate repair suggestion
页面结构变化，当前规则提取不到数据|The page structure changed and this rule finds no data
AI 修复建议已生成；请先查看 Diff 并测试|AI repair suggestion generated. Compare and test it before applying.
应用前必须先测试修复建议|Test the repair suggestion before applying it
修复建议已创建为新 RuleVersion|Repair saved as a new rule version
修复建议已拒绝|Repair suggestion rejected
选择创建方式|Choose creation mode
手动配置当前表单，或交给 AI 助手对话生成并测试同一种任务草稿。|Edit the task manually or use AI assistance to generate and test rules.
✦ AI 对话创建|Create with AI
官方模板|Built-in templates
参数|Parameters
可稍后在规则编辑器继续微调 Selector。|You can refine selectors in the rule editor later.
商品采集|Product collection
加载开发演示|Load development demo
保存草稿|Save draft
预览通过后保存并运行|Preview, save and run
登录 Session|Login session
登录 URL|Login URL
重新登录|Sign in again
打开安全登录窗口|Open secure login window
敏感请求凭据（由 Desktop Host 安全输入）|Request credentials (entered securely by desktop host)
Authorization / 敏感 Headers|Authorization / sensitive headers
已保存|Saved
未设置|Not configured
替换|Replace
安全输入|Enter securely
允许 localhost / 私网（可能访问本机服务）|Allow localhost / private networks (may access local services)
数据保留策略（留空表示不自动删除）|Retention policy (empty disables automatic deletion)
Run 保留天数|Run retention days
最多保留 Run 数|Maximum retained runs
导出 Artifact 保留天数|Export retention days
日志保留天数|Log retention days
先创建输出目的地|Create an output destination first
可视化点选|Select visually
页面检查器|Page inspector
选择字段后点击截图中的元素|Choose a field, then click an element in the screenshot
关闭|Close
移除详情步骤|Remove detail step
添加详情步骤|Add detail step
高级输入与 URL 发现|Advanced inputs & URL discovery
列表输入源 JSON（留空表示直接解析响应）|List input source JSON (empty parses the response directly)
列表输入源必须是有效 JSON|List input source must be valid JSON
Sitemap 发现 JSON（留空表示关闭）|Sitemap discovery JSON (empty disables it)
Sitemap 发现配置必须是有效 JSON|Sitemap discovery must be valid JSON
取值|Value
示例 / 空值|Sample / nulls
空值|Null
详情页步骤|Detail page step
详情 URL 字段|Detail URL field
详情运行模式|Detail execution mode
详情并发|Detail concurrency
合并优先级|Merge priority
详情失败策略|Detail failure policy
详情规则 JSON|Detail rule JSON
JSON 尚未形成有效规则，保存时仍使用上次有效内容|JSON is not a valid rule yet. The previous valid version will be saved.
详情输入源 JSON（留空表示直接解析响应）|Detail input source JSON (empty parses the response directly)
详情输入源必须是有效 JSON|Detail input source must be valid JSON
详情 Browser Actions (JSON)|Detail browser actions (JSON)
详情 Actions 必须是有效 JSON|Detail actions must be valid JSON
RuleVersion 历史 ·|Rule history ·
版本不可变；回滚与修复都会创建新版本|Versions are immutable. Rollback and repair create a new version.
AI 修复建议|AI repair suggestions
回滚到此版本|Roll back to this version
修复建议|Repair suggestion
查看 Diff|Compare changes
测试|Test
确认应用|Apply suggestion
失败|Failed
数据预览|Data preview
对话创建爬虫|Create a collection with AI
说清楚目标，逐步确认站点、规则和预览；任务只会在你点击确认卡后创建。|Describe your goal, confirm the page, rules and preview, then save the collection.
创建中…|Creating…
新会话|New conversation
尚未连接 AI 模型|No AI model connected
你可以继续手动配置或使用内置样例。连接模型后，可返回当前草稿。|Continue manually or use the built-in example. Return to this draft after connecting a model.
前往设置|Open settings
会话|Conversations
还没有会话，先新建一个。|No conversations yet. Create one to begin.
归档|Archive
选择一个会话|Choose a conversation
你|You
AI 助手|AI assistant
AI 助手 · 生成中|AI assistant · generating
例如：采集这个商品列表的名称、价格和详情链接，每天早上 9 点运行…|For example: collect product names, prices and links every day at 9 am…
不在聊天中输入账号、密码、Cookie 或 Token。|Do not enter account credentials, passwords, cookies or tokens in chat.
取消|Cancel
重试中…|Retrying…
重试 Turn|Retry message
AI 正在处理…|AI is working…
发送|Send
草稿会实时显示在这里。|Your draft will appear here as it changes.
实验性站点发现|Experimental site discovery
选择公开站点|Choose a public site
搜索摘要可能不准确；只有你确认后才会访问页面。|Search summaries may be inaccurate. The page is accessed after your confirmation.
任务草稿|Collection draft
待补充|Incomplete
待确认|Awaiting confirmation
采集目标|Collection goal
调度|Schedule
分页|Pagination
模式|Mode
浏览器|Browser
HTTP 优先|HTTP preferred
检测到登录墙。请先创建任务，再到任务编辑页配置 Login Session；聊天不会读取登录凭据。|Login is required. Configure a secure login session in task settings; the chat does not read login credentials.
规则与测试|Rules & tests
已生成|Generated
待生成|Not generated
查看 CrawlPlan|View extraction plan
AI 分析页面后会生成强类型规则。|AI generates editable extraction rules after analyzing the page.
测试中…|Testing…
重新测试|Test again
规则测试后最多展示 10 条公开数据。|Rule testing shows up to 10 preview records.
最终确认|Final confirmation
创建任务与初始规则？|Create task and initial rule?
将按当前 r|Using draft revision
草稿原子创建，重复点击不会产生重复任务。|to create the task. Repeated clicks will not create duplicates.
确认创建|Create task
恢复创建|Resume creation
对话中|In conversation
等待选站|Choose a site
草稿就绪|Draft ready
测试中|Testing
等待确认|Awaiting confirmation
创建中|Creating
已创建|Created
已归档|Archived
搜索站点|Search sites
分析页面|Analyze page
更新草稿|Update draft
生成规则|Generate rules
测试规则|Test rules
准备确认卡|Prepare confirmation
手动|Manual
职位簇无法加载。|Job group could not be loaded.
正在加载职位详情…|Loading job details…
返回职位雷达|Back to job radar
← 返回职位雷达|← Back to job radar
聚类置信度|Grouping confidence
求职流程|Application workflow
当前状态|Current status
备注|Notes
保存备注|Save notes
首次发现|First seen
最后发现|Last seen
匹配原因|Match explanation
未指定搜索档案，或该档案尚无匹配解释。|No search profile selected, or no match explanation is available.
来源字段差异|Differences between sources
职位|Job
地点|Location
来源职位|Source jobs
每条来源事实独立保留；可选择部分记录手动拆分。|Each source record is retained. Select records to split them manually.
拆分所选来源|Split selected sources
选择拆分|Select to split
薪资：|Salary:
未提供|Not provided
经验：|Experience:
学历：|Education:
类型：|Type:
打开原职位 ↗|Open original job ↗
可能重复的职位簇|Possible duplicate job groups
候选簇|Candidate group
相似度|Similarity
合并到当前职位|Merge into this job
变更记录|Change history
暂无业务字段变化。|No field changes yet.
· 来源记录|· Source record
审计记录仅限管理员|Audit records require administrator access
审计事件不可通过普通 API 修改或删除。|Audit events cannot be edited or deleted through ordinary APIs.
工作区审计|Workspace audit
查看身份、任务、运行、质量、输出与系统操作的最小必要记录。|View minimal records of identity, task, run, quality, output and system operations.
审计事件|Audit events
不记录密码、Cookie、服务账号 JSON、访问密钥或采集页面正文。|Passwords, cookies, service account JSON, keys and collected page contents are excluded.
本页|This page
条|records
时间 / 结果|Time / outcome
资源|Resource
操作者|Actor
追踪|Trace
正在加载审计记录…|Loading audit records…
尚无审计事件|No audit events yet
上一页|Previous page
安全详情|Security details
系统 / 未认证|System / unauthenticated
网络|Network
成功|Success
管理员|Administrator
编辑者|Editor
只读|Viewer
成员管理仅限管理员|Member management requires administrator access
编辑者和只读成员无法查看邀请、修改角色或生成密码重置链接。|Editors and viewers cannot manage invitations, roles or password reset links.
邀请已创建。链接只会完整显示这一次，请立即复制。|Invitation created. Copy the link now; it is shown only once.
链接已复制到剪贴板。|Link copied.
无法自动复制，请手动选中链接复制。|Could not copy automatically. Select and copy the link manually.
成员与邀请|Members & invitations
单工作区固定使用管理员、编辑者和只读三档角色。|The workspace supports administrator, editor and viewer roles.
织云只保存 Token 哈希，关闭此提示后无法再次查看同一个链接。|Only the token hash is stored. This link cannot be shown again after closing.
复制链接|Copy link
已保存，关闭|Saved, close
工作区成员|Workspace members
角色或停用状态变化会撤销该成员现有会话。|Changing a role or disabling a member revokes their active sessions.
人|members
成员|Member
角色|Role
加入时间|Joined at
已停用|Disabled
正常|Active
重置密码|Reset password
重新启用|Enable again
正在加载成员…|Loading members…
邀请新成员|Invite a member
邀请 72 小时内有效；P2 不发送邮件，请复制一次性链接并安全交给对方。|Invitations expire after 72 hours. Copy and securely share the one-time link; email is not sent automatically.
邮箱|Email
生成邀请链接|Create invitation link
尚无邀请|No invitations yet
等待接受|Pending acceptance
已接受|Accepted
已撤销|Revoked
已过期|Expired
· 有效至|· Valid until
重新生成|Regenerate
当前会话需要重新验证，请登录后再执行写操作。|Sign in again before making changes.
导出已取消|Export canceled
分析中…|Analyzing…
AI 解释失败|AI explanation failed
失败解释|Failure explanation
仅作为诊断建议，不会修改或激活规则。|Diagnostic suggestion only. Rules are not changed or activated.
查看数据与差异|View data & changes
创建分析|Create analysis
创建语料|Create corpus
取消导出|Cancel export
运行日志|Run logs
暂无日志|No logs yet
请求历史|Request history
暂无请求|No requests yet
工作区操作记录|Immutable activity log
采集助手|Crawler Assistant
工作区访问|Workspace access
一次性邀请链接|One-time link
任务范围 ·|task scope ·
尝试次数|attempt
Webhook 地址|Webhook URL
HMAC 密钥|HMAC Secret
此输出类型已停用，请改用文件输出或 Webhook|This output type is no longer supported. Choose a file destination or Webhook.
电子表格标识|Spreadsheet ID
存储桶|Bucket
区域|Region
文件前缀|Prefix
KMS 密钥标识|KMS Key ID
访问密钥|Secret Access Key
职位详情|Job Cluster
职位雷达|Recruitment Radar
AI 模型连接|AI Provider
· 配置版本|· Revision
AI 提取测试|AI Extract Demo
不分页|None
下一页链接|Next
页码递增|Page Number
加载更多|Load More
无限滚动|Infinite Scroll
分页网址模板|URL Template
请求超时（毫秒）|Timeout (ms)
重试次数|Retries
并发请求数|Concurrency
请求间隔（毫秒）|Request delay (ms)
最多请求数|Max requests
数据更新方式|Dataset mode
完整快照|Snapshot
按唯一字段更新|Upsert
追加记录|Append
唯一标识字段|Unique key fields
提取规则|Rule Builder
记录容器|Container
文本|String
数字|Number
日期|Date
文本内容|Text
属性值|Attribute
自动选择|Auto
内置浏览器|Browser
优先详情页字段|Detail wins
优先列表页字段|List wins
保留列表记录|Keep list record
跳过此条记录|Skip
停止本次运行|Fail run
比较版本|Diff
使用中|active
浏览器操作 JSON|Browser Actions JSON
正在连接织云工作区…|Connecting to your workspace…
正在检查工作区身份…|Checking workspace access…
正在恢复登录会话…|Restoring your session…
无法连接工作区|Unable to connect to the workspace
首次部署|First-time setup
初始化织云工作区|Set up your ZhiYun workspace
使用部署时配置的 Bootstrap Token 创建首位管理员。完成后该 Token 将永久失效。|Use the deployment bootstrap token to create the first administrator. The token expires permanently after setup.
管理员邮箱|Administrator email
显示名称|Display name
管理员密码|Administrator password
正在初始化…|Setting up…
创建管理员并进入工作区|Create administrator and enter workspace
登录织云|Sign in to ZhiYun
使用工作区管理员邀请你加入时登记的邮箱与密码。|Use the email and password registered when you joined this workspace.
邮箱|Email
密码|Password
正在登录…|Signing in…
登录|Sign in
接受工作区邀请|Join this workspace
设置你的显示名称与密码。邀请链接只能使用一次，密码至少 12 个字符。|Choose a display name and a password of at least 12 characters. This invitation can only be used once.
设置密码|Set password
正在加入…|Joining…
接受邀请|Accept invitation
设置新密码|Set a new password
重置链接只能使用一次。成功后，其他已登录会话会立即失效。|This reset link can only be used once. Other signed-in sessions expire after your password is reset.
新密码|New password
正在保存…|Saving…
保存并返回登录|Save and return to sign in
至少 12 个字符|At least 12 characters
浏览器动作|Browser actions
按顺序执行点击、填写、等待和滚动；登录密码请使用安全 Login Session 或 CredentialStore。|Run clicks, fills, waits and scrolling in order. Use secure login sessions or credential storage for passwords.
动作编辑模式|Action editor mode
卡片|Cards
高级 JSON|Advanced JSON
动作|Action
点击|Click
填写|Fill
选择下拉项|Select an option
按键|Key press
悬停|Hover
等待时间|Wait
等待元素|Wait for an element
滚动|Scroll
执行中…|Running…
执行此步|Run this step
复制|Duplicate
删除|Delete
尚无动作。页面会直接进入采集规则。|No browser actions. The page will proceed directly to extraction.
＋ 添加动作|Add action
禁止在“填写”动作中保存密码、Cookie 或 Token；需要登录时请使用安全 Login Session 或 CredentialStore。|Do not store passwords, cookies or tokens in Fill actions. Use secure login sessions or credential storage.
正在执行|Running
执行成功|Succeeded
执行失败|Failed
等待毫秒|Wait duration (ms)
滚动次数|Scroll count
元素 Selector|Element selector
从页面选择|Select from page
填写内容|Value to fill
选项值|Option value
疑似密码输入框：此值不会通过保存校验。|This appears to be a password field. Saving this value is not allowed.
禁止在浏览器动作中保存密码；请使用安全 Login Session 或 CredentialStore。|Passwords cannot be stored in browser actions. Use a secure login session or credential storage.
这个动作不使用 Selector|This action does not use a selector
运行计划|Schedule
计划频率|Frequency
手动|Manual
每 N 分钟|Every N minutes
每小时|Hourly
每天|Daily
工作日|Weekdays
每周|Weekly
每月|Monthly
高级 Cron|Advanced cron
间隔分钟（最少 5 分钟）|Interval in minutes (minimum 5)
每小时第几分钟|Minute of each hour
执行时间|Run at
星期|Day of week
星期一|Monday
星期二|Tuesday
星期三|Wednesday
星期四|Thursday
星期五|Friday
星期六|Saturday
星期日|Sunday
每月日期（1–28）|Day of month (1–28)
Cron（分 时 日 月 周）|Cron (minute hour day month weekday)
时区|Time zone
错过执行|Missed runs
跳过（默认）|Skip (default)
恢复后补跑一次|Run once after recovery
未来 5 次执行|Next 5 runs
夏令时跳变已按所选时区计算。|Daylight saving changes follow the selected time zone.
无法预览执行时间：|Cannot preview schedule:
保存后由 Runtime 校验计划；升级 Runtime 后此处会显示未来执行时间。|The service validates the saved schedule. Future run times require a compatible runtime.
仅手动运行|Manual only
每 {{minutes}} 分钟运行|Every {{minutes}} minutes
每小时第 {{minute}} 分钟运行|Hourly at minute {{minute}}
每天 {{time}} 运行|Daily at {{time}}
工作日 {{time}} 运行|Weekdays at {{time}}
每周{{day}} {{time}} 运行|Every {{day}} at {{time}}
每月 {{day}} 日 {{time}} 运行|Monthly on day {{day}} at {{time}}
上移第 {{step}} 步|Move step {{step}} up
下移第 {{step}} 步|Move step {{step}} down
退出失败：{{message}}|Sign out failed: {{message}}
`.trim();
const translations = new Map(
  copyCatalog.split('\n').map((line) => {
    const split = line.indexOf('|');
    return [line.slice(0, split), line.slice(split + 1)];
  }),
);
i18n.addResourceBundle('en', 'productCopy', Object.fromEntries(translations), true, true);
i18n.addResourceBundle(
  'zh-CN',
  'productCopy',
  Object.fromEntries([...translations.keys()].map((key) => [key, key])),
  true,
  true,
);
export function productCopy(
  value: string | undefined,
  values: Record<string, string | number> = {},
): string {
  if (value === undefined) return '';
  return i18n.t(value, { ...values, ns: 'productCopy', keySeparator: false, defaultValue: value });
}
