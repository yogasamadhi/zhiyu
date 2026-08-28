from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import orjson
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from zhiyun_analytics_worker.analytics import (
    ANALYSIS_METHODS,
    AnalysisResourceError,
    AnalysisValidationError,
    execute_analysis,
)


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
def snapshot(tmp_path: Path) -> Path:
    rows = []
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for index in range(60):
        group = "a" if index < 30 else "b"
        rows.append(
            {
                "__zhiyun_record_key": f"record-{index:03d}",
                "__zhiyun_source_url": f"https://example.test/{index}",
                "value": float(index + (4 if group == "b" else 0)),
                "feature_a": float(index % 11),
                "feature_b": float((index * 3) % 17),
                "category": group,
                "target": index % 2,
                "captured_at": start + timedelta(days=index),
                "text": (
                    f"数据分析 样本文本 number {index} positive"
                    if index % 2
                    else f"机器学习 测试语料 number {index} negative"
                ),
                "nullable": None if index % 7 == 0 else index,
            }
        )
    path = tmp_path / "snapshot.parquet"
    pq.write_table(pa.Table.from_pylist(rows), path)
    return path


METHOD_PARAMETERS: dict[str, dict[str, Any]] = {
    "data.profile": {},
    "data.missing_duplicates": {"keyFields": ["__zhiyun_record_key"]},
    "stats.descriptive": {"fields": ["value", "feature_a"]},
    "category.frequency": {"field": "category", "topN": 10},
    "group.aggregate": {
        "groupFields": ["category"],
        "valueFields": ["value"],
        "aggregations": ["count", "mean", "max"],
    },
    "stats.correlation": {"fields": ["value", "feature_a", "feature_b"]},
    "stats.outliers": {"fields": ["value"], "method": "iqr"},
    "time.trend": {
        "timeField": "captured_at",
        "valueField": "value",
        "interval": "week",
        "aggregation": "mean",
    },
    "text.profile": {"fields": ["text"], "topN": 20},
    "data.quality_report": {},
    "stats.hypothesis_test": {
        "test": "ttest",
        "valueField": "value",
        "groupField": "category",
    },
    "stats.regression": {
        "targetField": "value",
        "featureFields": ["feature_a", "feature_b"],
        "model": "ols",
    },
    "time.arima": {
        "timeField": "captured_at",
        "valueField": "value",
        "order": [1, 1, 0],
        "forecastSteps": 5,
    },
    "ml.clustering": {
        "featureFields": ["value", "feature_a"],
        "algorithm": "kmeans",
        "clusters": 3,
    },
    "ml.pca": {"featureFields": ["value", "feature_a", "feature_b"]},
    "ml.isolation_forest": {
        "featureFields": ["value", "feature_a"],
        "contamination": 0.1,
    },
    "text.tfidf": {"textFields": ["text"], "maxFeatures": 100, "topN": 10},
    "text.classification": {
        "textFields": ["text"],
        "targetField": "target",
        "maxFeatures": 100,
        "testSize": 0.25,
    },
}

GOLDEN_TABLE_IDS: dict[str, set[str]] = {
    "data.profile": {"columns"},
    "data.missing_duplicates": {"missing", "duplicateSamples"},
    "stats.descriptive": {"descriptive"},
    "category.frequency": {"frequency"},
    "group.aggregate": {"groups"},
    "stats.correlation": {"correlation"},
    "stats.outliers": {"outlierSummary", "outlierSamples"},
    "time.trend": {"trend"},
    "text.profile": {"keywords"},
    "data.quality_report": set(),
    "stats.hypothesis_test": {"test"},
    "stats.regression": {"coefficients"},
    "time.arima": {"forecast"},
    "ml.clustering": {"clusters", "assignments"},
    "ml.pca": {"variance", "loadings"},
    "ml.isolation_forest": {"outliers"},
    "text.tfidf": {"keywords"},
    "text.classification": {"confusionMatrix"},
}


def test_method_catalog_is_complete_and_versioned() -> None:
    assert len(ANALYSIS_METHODS) == 18
    assert set(METHOD_PARAMETERS) == {item.id for item in ANALYSIS_METHODS}
    for method in ANALYSIS_METHODS:
        assert method.version == "1.0.0"
        assert method.parameterSchema["additionalProperties"] is False
        assert method.outputSchema["required"] == [
            "summary",
            "metrics",
            "tables",
            "series",
            "artifacts",
            "warnings",
            "sampling",
        ]


@pytest.mark.asyncio
@pytest.mark.parametrize("method_id", sorted(METHOD_PARAMETERS))
async def test_all_analysis_methods_return_bounded_structured_results(
    method_id: str, snapshot: Path, tmp_path: Path
) -> None:
    context = Context(METHOD_PARAMETERS[method_id], tmp_path, snapshot)
    result = await execute_analysis(context, method_id)
    assert set(result) == {
        "summary",
        "metrics",
        "tables",
        "series",
        "artifacts",
        "warnings",
        "sampling",
    }
    assert all(len(series.get("data", [])) <= 10_000 for series in result["series"])
    assert result["sampling"]["inputRows"] == 60
    assert {table["id"] for table in result["tables"]} == GOLDEN_TABLE_IDS[method_id]
    orjson.dumps(result)
    if method_id == "text.tfidf":
        assert (tmp_path / "tfidf-document-matrix.npz").is_file()


@pytest.mark.asyncio
async def test_rejects_unknown_formula_sql_and_oversized_correlation(
    snapshot: Path, tmp_path: Path
) -> None:
    with pytest.raises(AnalysisValidationError, match="Unknown analysis parameters"):
        await execute_analysis(
            Context(
                {
                    "targetField": "value",
                    "featureFields": ["feature_a"],
                    "formula": "value ~ __import__('os').system('id')",
                },
                tmp_path,
                snapshot,
            ),
            "stats.regression",
        )
    with pytest.raises(AnalysisValidationError, match="Unknown analysis parameters"):
        await execute_analysis(
            Context({"sql": "SELECT * FROM snapshot"}, tmp_path, snapshot),
            "data.profile",
        )
    with pytest.raises(AnalysisResourceError, match="at most 50"):
        await execute_analysis(
            Context(
                {"fields": [f"field_{index}" for index in range(51)]},
                tmp_path,
                snapshot,
            ),
            "stats.correlation",
        )
