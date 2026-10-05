# 产品体验 API 增量说明

所有接口使用 `/api/v2`，完整机器可读定义在 `desktop/packages/runtime/src/openapi.ts`，生成客户端类型在 `desktop/packages/client/src/openapi.generated.d.ts`。现有 Cookie/CSRF、Desktop session、角色权限和 RFC 7807 问题响应沿用原实现。

## 统一草稿

| 方法                 | 路径                                   | 说明                                                 |
| -------------------- | -------------------------------------- | ---------------------------------------------------- |
| GET / POST           | `/collection-drafts`                   | 列出可继续草稿 / 创建部分配置草稿，可传已有 `taskId` |
| GET / PATCH / DELETE | `/collection-drafts/{draftId}`         | 读取、编辑、删除草稿                                 |
| POST                 | `/collection-drafts/{draftId}/preview` | 预览当前版本并保存采集指纹和样本                     |
| POST                 | `/collection-drafts/{draftId}/commit`  | 保存任务、规则版本，可同时运行；`run` 默认 true      |
| POST                 | `/examples/products/drafts`            | 创建已登记的离线商品样例草稿                         |
| POST                 | `/inspection-sessions`                 | `taskId` 或 `draftId` 二选一，打开受保护的点选会话   |

草稿读取与更新返回 ETag。修改、删除、预览和提交携带 `If-Match`；修改请求携带 `Idempotency-Key`。重复创建、预览、修改和提交使用原请求标识重放；相同幂等标识不能用于不同请求。短时并发的相同请求等待原请求完成；超过等待窗口返回可恢复的冲突。

草稿状态为 editing、committing、committed。提交在数据库中保留提交意图，任务、规则版本和运行使用确定性标识，恢复时复用已有结果。规则指纹忽略名称、计划和输出变动。过期版本返回 412，预览缺失或失效返回 409，空预览返回 422。

AI 会话可携带 `collectionDraftId`。AI 插件通过运行时组合契约读取与更新草稿，限定为名称、网址、目标、分页和提取规则；不会替换凭据、请求、浏览器、输出等手动设置。旧会话在继续编辑时转换。

样例标识由服务器校验，不能用任意 URL、脚本或自定义示例内容执行。样例的来源、执行器、手动计划和输出限制由服务器控制。

## 列表、字段和导出

- 任务列表：`query`、`status`、`sort`、`direction`、`limit`、`cursor`，保留旧调用形式。
- 数据集列表：`query`（来源任务名称/网址）、`sort`（更新时间/记录数）、`direction`、`sourceTaskId`、分页参数。组合层批量提供来源摘要和质量摘要，不跨插件读取业务表。
- 记录列表：`query`、JSON 编码的 `filters` / `sort`、`includeRemoved` 和分页参数；旧 `filter` 对象继续兼容。
- 字段描述：`GET /datasets/{datasetId}/fields?snapshotId=...`。指定版本时读取版本 manifest；`name` 是实际物理字段名，`label` 是来源显示名。未指定版本时轻量抽样，返回 `sampled: true` 和样本数，不代表完整 schema 评估。
- 数据版本未就绪时字段接口返回 409；创建版本返回准备中时客户端继续读取状态。
- 导出：`POST /datasets/{datasetId}/exports` 使用与列表相同的查询对象，可传 `fields`；服务端一致性读取与流式处理保持原实现。
- 差异：`GET /datasets/{datasetId}/diff?from=...&to=...` 使用两个运行的历史状态比较，统计全量差异后分页。

筛选为最多 20 个 AND 条件，仅支持标量字段。示例：

```json
{
  "query": "商品",
  "filters": [
    { "field": "价格", "operator": "gte", "type": "number", "value": 100 },
    { "field": "名称", "operator": "not_empty" }
  ],
  "sort": { "field": "价格", "direction": "asc", "type": "number" },
  "fields": ["名称", "价格"]
}
```

允许的操作符为 eq、ne、contains、gt、gte、lt、lte、empty、not_empty，不接受表达式或 SQL。排序以稳定 ID 为次级键。新游标绑定查询指纹，查询变化后必须从第一页开始；旧 at/id 游标在原默认排序下仍可使用。列表返回 `totalCount` 和 `matchedCount`。

## 分析与语料输出

`POST /corpora/{corpusId}/preview` 接收 `snapshotId`、完整 `recipe`，执行受控 Worker 预览。最多使用前 20 行输入并返回最多 20 个文档和文本块样本；正式构建使用原版本全量数据。版本必须属于该语料库且状态 ready。Worker 不可用返回 503，失败请求释放幂等占位，允许同标识重试。

分析结果导出在实例文件存储生成可下载 JSON Artifact；语料导出返回已有不可变文件。客户端通过现有 Artifact 内容/保存接口下载或保存，历史结果无需在线 Worker。

## 体验指标

| 方法与路径                       | 权限             | 内容                                        |
| -------------------------------- | ---------------- | ------------------------------------------- |
| GET `/workspace`                 | workspace.read   | 持久化工作区标识                            |
| POST `/experience/events`        | workspace.read   | 创建入口事件；只接受 eventId、draftId、type |
| GET `/experience/summary`        | workspace.manage | 当前实例的汇总指标                          |
| GET / PUT `/experience/settings` | workspace.manage | 开关、90 天保留期、revision                 |
| DELETE `/experience/events`      | workspace.manage | 清除本地事件，204                           |

设置更新使用 ETag/If-Match 和幂等键，清除使用幂等键。前端不能报告运行、导出、分析或同步成功，这些由相应服务端结果确认。事件按事件标识去重，匿名关联按工作区散列，示例不写入。普通成员不能读取其他成员的指标汇总。

## 数据迁移与边界

增加 Platform、Collection、Datasets 的增量迁移，沿用现有迁移校验和，不重建已有 1.0 数据。新增草稿、指标、工作区配置和历史运行顺序。现有权限、规则版本、会话、数据与旧路径保留。

凭据继续使用原安全存储；浏览器中只保存创建请求标识和隔离的界面偏好，不缓存完整任务配置或敏感内容。新增接口及生成客户端、插件路由贡献和架构目录同步检查。

## 织云助手 API（2026-09-10）

`/api/v2/assistant` 包含 capabilities、conversations、messages、context、turns、actions、lessons 和 lesson-progress。具体请求/响应以 OpenAPI 与生成客户端为准。

会话与上下文 revision 独立。更新 context 使用 context.revision；更新元数据或课程进度使用 conversation.revision；执行 action 使用 action.revision。所有写接口使用 Idempotency-Key，正式操作在服务端复验权限、参数和资源版本。

`POST /conversations/{id}/actions` 仅准备卡片，`POST /actions/{id}/execute` 才执行。`load_more` 是固定分页练习事件。Collection 的 `/api/v2/collection-drafts/{draftId}/browser-session/login` 复用安全登录，支持取消、幂等重放和版本冲突清理。历史无所有者会话保留共享范围，新会话归当前身份。

参见 [助手实施与验收记录](assistant-acceptance.md)。
