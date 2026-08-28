# ADR 0008: Supervised Python Analytics Worker

## Status

Accepted

## Decision

TypeScript 继续拥有产品业务状态、HTTP API、Job、Dataset、Corpus、凭据和 Artifact。数据分析与语料批处理运行在同机、无状态、受监督的 Python 3.12 Worker 中，使用独立 `/worker/v1` 协议、随机 loopback 端口、每次启动 token 和 generation。

Worker 使用 Polars、DuckDB、PyArrow、NumPy、SciPy、pandas、statsmodels、scikit-learn、jieba 和 datasketch。Desktop 以签名 PyInstaller `onedir` 资源分发，Headless Release 内置 Linux x64 Worker；最终用户不依赖系统 Python 或 uv。

## Consequence

Worker 不写业务数据库、不持有产品凭据、不接收任意 Python/SQL/公式、不加载远程代码。Runtime 通过不可变 Dataset Snapshot 和受控 Job Workspace 交付数据，并校验结构化结果。Worker 故障使 Analytics/Corpus 降级，但不得影响采集和 Dataset 浏览。
