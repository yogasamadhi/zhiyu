from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from zhiyun_analytics_worker import analytics


@dataclass
class Context:
    parameters: dict[str, Any]
    workspace: Path
    input_path: Path

    async def report(self, _phase: str, _progress: float) -> None:
        return None

    def cancelled(self) -> bool:
        return False


@pytest.fixture
def large_snapshot(tmp_path: Path) -> Path:
    path = tmp_path / "large.parquet"
    start = datetime(2020, 1, 1, tzinfo=UTC)
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "__zhiyun_record_key": f"key-{index:05d}",
                    "group": f"group-{index:05d}",
                    "value": float(index % 10),
                    "date": start + timedelta(days=index),
                }
                for index in range(10_003)
            ]
        ),
        path,
    )
    return path


@pytest.mark.asyncio
async def test_group_table_is_complete_beyond_chart_limit(large_snapshot: Path) -> None:
    result = await analytics.execute_analysis(
        Context(
            {"groupFields": ["group"], "valueFields": ["value"], "aggregations": ["mean", "count"]},
            large_snapshot.parent,
            large_snapshot,
        ),
        "group.aggregate",
    )
    rows = result["tables"][0]["rows"]
    assert len(rows) == 10_003
    assert [row["group"] for row in rows] == [f"group-{index:05d}" for index in range(10_003)]
    assert rows[-1] == {"group": "group-10002", "value_mean": 2.0, "count": 1}
    chart = result["series"][0]
    assert len(chart["data"]) == 10_000
    assert chart["encoding"] == {"xFields": ["group"], "yFields": ["value_mean", "count"]}
    assert "all groups remain in the paged table" in result["warnings"][0]


@pytest.mark.asyncio
async def test_trend_keeps_every_bucket_and_marks_chart_bound(large_snapshot: Path) -> None:
    result = await analytics.execute_analysis(
        Context(
            {
                "timeField": "date",
                "valueField": "value",
                "interval": "day",
                "aggregation": "mean",
                "movingAverage": 3,
            },
            large_snapshot.parent,
            large_snapshot,
        ),
        "time.trend",
    )
    rows = result["tables"][0]["rows"]
    assert len(rows) == 10_003
    assert rows[2]["movingAverage"] == 1.0
    assert rows[-1]["value"] == 2.0
    assert (
        rows[-1]["date"] == (datetime(2020, 1, 1, tzinfo=UTC) + timedelta(days=10_002)).isoformat()
    )
    assert len(result["series"][0]["data"]) == 10_000
    assert result["series"][0]["encoding"] == {
        "xFields": ["date"],
        "yFields": ["value", "movingAverage"],
    }
    assert "all buckets remain in the paged table" in result["warnings"][0]


@pytest.mark.asyncio
async def test_outliers_expose_all_rows_and_stable_empty_columns(tmp_path: Path) -> None:
    path = tmp_path / "outliers.parquet"
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "__zhiyun_record_key": f"key-{index}",
                    "value": float(index % 10 if index < 800 else 100),
                }
                for index in range(1000)
            ]
        ),
        path,
    )
    result = await analytics.execute_analysis(
        Context({"fields": ["value"]}, tmp_path, path), "stats.outliers"
    )
    assert result["tables"][0]["rows"][0]["outlierCount"] == 200
    samples = result["tables"][1]
    assert len(samples["rows"]) == 200
    assert samples["rows"][-1]["__zhiyun_record_key"] == "key-999"
    assert samples["columns"] == [{"name": "__zhiyun_record_key"}, {"name": "value"}]
    assert result["series"][0]["encoding"] == {"xFields": ["field"], "yFields": ["outlierCount"]}
    normal = tmp_path / "normal.parquet"
    pq.write_table(
        pa.Table.from_pylist(
            [{"__zhiyun_record_key": "a", "value": 1.0}, {"__zhiyun_record_key": "b", "value": 1.0}]
        ),
        normal,
    )
    empty = await analytics.execute_analysis(
        Context({"fields": ["value"]}, tmp_path, normal), "stats.outliers"
    )
    assert empty["tables"][1]["rows"] == []
    assert empty["tables"][1]["columns"] == samples["columns"]
    distribution = await analytics.execute_analysis(
        Context({"fields": ["value"]}, tmp_path, path), "stats.descriptive"
    )
    assert distribution["series"][0]["type"] == "boxplot"
    assert distribution["series"][0]["encoding"] == {
        "xFields": ["field"],
        "yFields": ["min", "q25", "median", "q75", "max"],
    }
    assert distribution["tables"][0]["rows"][0]["count"] == 1000


@pytest.mark.asyncio
async def test_complete_tables_fail_explicitly_at_resource_bound(
    large_snapshot: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(analytics, "MAX_TABLE_ROWS", 2)
    with pytest.raises(analytics.AnalysisResourceError, match="row limit"):
        await analytics.execute_analysis(
            Context(
                {"groupFields": ["group"], "valueFields": ["value"], "aggregations": ["mean"]},
                large_snapshot.parent,
                large_snapshot,
            ),
            "group.aggregate",
        )
