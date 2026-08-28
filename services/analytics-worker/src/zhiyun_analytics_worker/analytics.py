from __future__ import annotations

import asyncio
import math
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

import orjson

from .models import MethodDescriptor

METHOD_VERSION = "1.0.0"
MAX_INPUT_BYTES = 5 * 1024**3
MAX_SERIES_POINTS = 10_000
MAX_CORRELATION_COLUMNS = 50
MAX_CORRELATION_ROWS = 200_000
MAX_ML_ROWS = 100_000


class AnalysisMethodContext(Protocol):
    parameters: dict[str, Any]
    workspace: Path
    input_path: Path | None
    report: Callable[[str, float], Awaitable[None]]
    cancelled: Callable[[], bool]


class AnalysisValidationError(ValueError):
    pass


class AnalysisResourceError(AnalysisValidationError):
    pass


RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["summary", "metrics", "tables", "series", "artifacts", "warnings", "sampling"],
    "properties": {
        "summary": {"type": "object"},
        "metrics": {"type": "object"},
        "tables": {"type": "array"},
        "series": {"type": "array"},
        "artifacts": {"type": "array"},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "sampling": {"type": "object"},
    },
}


def object_schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        **({"required": required} if required else {}),
    }


FIELD = {"type": "string", "minLength": 1, "maxLength": 255, "format": "field-selector"}
FIELDS = {
    "type": "array",
    "items": FIELD,
    "minItems": 1,
    "maxItems": 50,
    "uniqueItems": True,
    "format": "field-list",
}


def descriptor(
    method_id: str,
    category: str,
    parameters: dict[str, Any],
    *,
    field_types: list[str],
    visualizations: list[str],
    sampling: bool = False,
    max_rows: int | None = None,
) -> MethodDescriptor:
    limits: dict[str, Any] = {"maxInputBytes": MAX_INPUT_BYTES}
    if max_rows is not None:
        limits["defaultMaxRows"] = max_rows
    return MethodDescriptor(
        id=method_id,
        version=METHOD_VERSION,
        category=category,
        titleKey=f"analytics.methods.{method_id}.title",
        descriptionKey=f"analytics.methods.{method_id}.description",
        supportedFieldTypes=field_types,
        parameterSchema=parameters,
        outputSchema=RESULT_SCHEMA,
        recommendedVisualizations=visualizations,
        resourceLimits=limits,
        supportsSampling=sampling,
    )


ANALYSIS_METHODS = [
    descriptor(
        "data.profile",
        "data-quality",
        object_schema({}),
        field_types=["any"],
        visualizations=["table"],
    ),
    descriptor(
        "data.missing_duplicates",
        "data-quality",
        object_schema({"keyFields": {**FIELDS, "minItems": 0}}),
        field_types=["any"],
        visualizations=["bar", "table"],
    ),
    descriptor(
        "stats.descriptive",
        "statistics",
        object_schema({"fields": FIELDS}, ["fields"]),
        field_types=["integer", "number"],
        visualizations=["table", "boxplot"],
    ),
    descriptor(
        "category.frequency",
        "category",
        object_schema(
            {
                "field": FIELD,
                "topN": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 20},
            },
            ["field"],
        ),
        field_types=["string", "integer", "boolean"],
        visualizations=["bar", "pie", "table"],
    ),
    descriptor(
        "group.aggregate",
        "aggregation",
        object_schema(
            {
                "groupFields": {**FIELDS, "maxItems": 5},
                "valueFields": FIELDS,
                "aggregations": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["count", "sum", "mean", "min", "max", "median"],
                    },
                    "minItems": 1,
                    "uniqueItems": True,
                },
            },
            ["groupFields", "valueFields", "aggregations"],
        ),
        field_types=["string", "integer", "number", "boolean"],
        visualizations=["bar", "table"],
    ),
    descriptor(
        "stats.correlation",
        "statistics",
        object_schema(
            {
                "fields": FIELDS,
                "method": {"type": "string", "enum": ["pearson", "spearman"], "default": "pearson"},
            },
            ["fields"],
        ),
        field_types=["integer", "number"],
        visualizations=["heatmap", "table"],
        sampling=True,
        max_rows=MAX_CORRELATION_ROWS,
    ),
    descriptor(
        "stats.outliers",
        "statistics",
        object_schema(
            {
                "fields": FIELDS,
                "method": {"type": "string", "enum": ["iqr", "zscore"], "default": "iqr"},
                "threshold": {"type": "number", "minimum": 0.1, "maximum": 10, "default": 1.5},
            },
            ["fields"],
        ),
        field_types=["integer", "number"],
        visualizations=["boxplot", "table"],
    ),
    descriptor(
        "time.trend",
        "time-series",
        object_schema(
            {
                "timeField": FIELD,
                "valueField": FIELD,
                "interval": {
                    "type": "string",
                    "enum": ["hour", "day", "week", "month"],
                    "default": "day",
                },
                "aggregation": {
                    "type": "string",
                    "enum": ["count", "sum", "mean", "min", "max"],
                    "default": "count",
                },
                "movingAverage": {"type": "integer", "minimum": 1, "maximum": 365, "default": 7},
            },
            ["timeField"],
        ),
        field_types=["datetime", "integer", "number"],
        visualizations=["line", "table"],
    ),
    descriptor(
        "text.profile",
        "text",
        object_schema(
            {
                "fields": FIELDS,
                "topN": {"type": "integer", "minimum": 1, "maximum": 500, "default": 50},
            },
            ["fields"],
        ),
        field_types=["string"],
        visualizations=["bar", "histogram", "table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "data.quality_report",
        "data-quality",
        object_schema({}),
        field_types=["any"],
        visualizations=["gauge", "bar", "table"],
    ),
    descriptor(
        "stats.hypothesis_test",
        "advanced-statistics",
        object_schema(
            {
                "test": {"type": "string", "enum": ["ttest", "mannwhitney", "chi_square", "anova"]},
                "valueField": FIELD,
                "groupField": FIELD,
                "categoryField": FIELD,
                "outcomeField": FIELD,
                "alpha": {"type": "number", "minimum": 0.0001, "maximum": 0.5, "default": 0.05},
            },
            ["test"],
        ),
        field_types=["string", "integer", "number"],
        visualizations=["table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "stats.regression",
        "advanced-statistics",
        object_schema(
            {
                "targetField": FIELD,
                "featureFields": FIELDS,
                "model": {"type": "string", "enum": ["ols", "glm"], "default": "ols"},
                "family": {
                    "type": "string",
                    "enum": ["gaussian", "binomial", "poisson"],
                    "default": "gaussian",
                },
            },
            ["targetField", "featureFields"],
        ),
        field_types=["integer", "number"],
        visualizations=["table", "scatter"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "time.arima",
        "time-series",
        object_schema(
            {
                "timeField": FIELD,
                "valueField": FIELD,
                "order": {
                    "type": "array",
                    "items": {"type": "integer", "minimum": 0, "maximum": 10},
                    "minItems": 3,
                    "maxItems": 3,
                    "default": [1, 1, 1],
                },
                "forecastSteps": {"type": "integer", "minimum": 1, "maximum": 365, "default": 30},
            },
            ["timeField", "valueField"],
        ),
        field_types=["datetime", "integer", "number"],
        visualizations=["line", "table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "ml.clustering",
        "machine-learning",
        object_schema(
            {
                "featureFields": FIELDS,
                "algorithm": {"type": "string", "enum": ["kmeans", "dbscan"], "default": "kmeans"},
                "clusters": {"type": "integer", "minimum": 2, "maximum": 50, "default": 3},
                "eps": {"type": "number", "exclusiveMinimum": 0, "maximum": 1000, "default": 0.5},
                "minSamples": {"type": "integer", "minimum": 2, "maximum": 1000, "default": 5},
                "seed": {"type": "integer", "default": 42},
            },
            ["featureFields"],
        ),
        field_types=["integer", "number"],
        visualizations=["scatter", "table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "ml.pca",
        "machine-learning",
        object_schema(
            {
                "featureFields": FIELDS,
                "components": {"type": "integer", "minimum": 2, "maximum": 20, "default": 2},
                "seed": {"type": "integer", "default": 42},
            },
            ["featureFields"],
        ),
        field_types=["integer", "number"],
        visualizations=["scatter", "bar", "table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "ml.isolation_forest",
        "machine-learning",
        object_schema(
            {
                "featureFields": FIELDS,
                "contamination": {
                    "type": "number",
                    "exclusiveMinimum": 0,
                    "maximum": 0.5,
                    "default": 0.05,
                },
                "seed": {"type": "integer", "default": 42},
            },
            ["featureFields"],
        ),
        field_types=["integer", "number"],
        visualizations=["scatter", "table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "text.tfidf",
        "text",
        object_schema(
            {
                "textFields": FIELDS,
                "maxFeatures": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 50_000,
                    "default": 5000,
                },
                "topN": {"type": "integer", "minimum": 1, "maximum": 500, "default": 50},
            },
            ["textFields"],
        ),
        field_types=["string"],
        visualizations=["bar", "table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
    descriptor(
        "text.classification",
        "machine-learning",
        object_schema(
            {
                "textFields": FIELDS,
                "targetField": FIELD,
                "algorithm": {
                    "type": "string",
                    "enum": ["logistic_regression", "linear_svm"],
                    "default": "logistic_regression",
                },
                "testSize": {"type": "number", "minimum": 0.1, "maximum": 0.5, "default": 0.2},
                "maxFeatures": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 50_000,
                    "default": 5000,
                },
                "seed": {"type": "integer", "default": 42},
            },
            ["textFields", "targetField"],
        ),
        field_types=["string"],
        visualizations=["bar", "table"],
        sampling=True,
        max_rows=MAX_ML_ROWS,
    ),
]

ANALYSIS_METHODS_BY_ID = {item.id: item for item in ANALYSIS_METHODS}


def empty_result(*, row_count: int, warnings: list[str] | None = None) -> dict[str, Any]:
    return {
        "summary": {"rowCount": row_count},
        "metrics": {},
        "tables": [],
        "series": [],
        "artifacts": [],
        "warnings": warnings or [],
        "sampling": {
            "applied": False,
            "inputRows": row_count,
            "sampleRows": row_count,
            "seed": None,
        },
    }


def require_input(context: AnalysisMethodContext) -> Path:
    if context.input_path is None:
        raise AnalysisValidationError("Analysis requires a Dataset Snapshot Parquet Artifact")
    if context.input_path.stat().st_size > MAX_INPUT_BYTES:
        raise AnalysisResourceError("Dataset Snapshot exceeds the 5GiB input limit")
    return context.input_path


def require_fields(frame: Any, names: list[str], *, numeric: bool = False) -> None:
    missing = [name for name in names if name not in frame.columns]
    if missing:
        raise AnalysisValidationError(f"Unknown fields: {', '.join(missing)}")
    if numeric:
        import pandas as pd

        invalid = [name for name in names if not pd.api.types.is_numeric_dtype(frame[name])]
        if invalid:
            raise AnalysisValidationError(f"Fields must be numeric: {', '.join(invalid)}")


def string_list(
    parameters: dict[str, Any],
    key: str,
    *,
    required: bool = True,
    max_items: int = 50,
) -> list[str]:
    value = parameters.get(key)
    if value is None and not required:
        return []
    if not isinstance(value, list) or not value or len(value) > max_items:
        raise AnalysisValidationError(f"{key} must be a non-empty field list")
    if any(not isinstance(item, str) or not item or len(item) > 255 for item in value):
        raise AnalysisValidationError(f"{key} contains an invalid field")
    if len(set(value)) != len(value):
        raise AnalysisValidationError(f"{key} must not contain duplicate fields")
    return value


def string_value(parameters: dict[str, Any], key: str, *, required: bool = True) -> str | None:
    value = parameters.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value or len(value) > 255:
        raise AnalysisValidationError(f"{key} must be a field name")
    return value


def bounded_int(
    parameters: dict[str, Any], key: str, default: int, minimum: int, maximum: int
) -> int:
    value = parameters.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise AnalysisValidationError(f"{key} must be an integer between {minimum} and {maximum}")
    return value


def bounded_float(
    parameters: dict[str, Any], key: str, default: float, minimum: float, maximum: float
) -> float:
    value = parameters.get(key, default)
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not minimum <= float(value) <= maximum
    ):
        raise AnalysisValidationError(f"{key} must be between {minimum} and {maximum}")
    return float(value)


def enum_value(parameters: dict[str, Any], key: str, default: str, allowed: set[str]) -> str:
    value = parameters.get(key, default)
    if value not in allowed:
        raise AnalysisValidationError(f"{key} must be one of: {', '.join(sorted(allowed))}")
    return str(value)


def json_scalar(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def json_records(frame: Any, limit: int = MAX_SERIES_POINTS) -> list[dict[str, Any]]:
    return [
        {str(key): json_scalar(value) for key, value in record.items()}
        for record in frame.head(limit).to_dict(orient="records")
    ]


def load_pandas(
    context: AnalysisMethodContext,
    fields: list[str] | None = None,
    *,
    max_rows: int | None = None,
    seed: int = 42,
) -> tuple[Any, dict[str, Any]]:
    import polars as pl

    path = require_input(context)
    scan = pl.scan_parquet(path)
    available = scan.collect_schema().names()
    selected = list(dict.fromkeys(["__zhiyun_record_key", *(fields or available)]))
    missing = [name for name in selected if name not in available]
    if missing:
        raise AnalysisValidationError(f"Unknown fields: {', '.join(missing)}")
    row_count = int(scan.select(pl.len().alias("rows")).collect().item())
    sampled = max_rows is not None and row_count > max_rows
    if sampled:
        scan = (
            scan.select(selected)
            .with_columns(pl.col("__zhiyun_record_key").hash(seed=seed).alias("__sample_hash"))
            .sort("__sample_hash")
            .head(max_rows)
            .drop("__sample_hash")
        )
    else:
        scan = scan.select(selected)
    frame = scan.collect(engine="streaming").to_pandas()
    return frame, {
        "applied": sampled,
        "inputRows": row_count,
        "sampleRows": len(frame),
        "seed": seed if sampled else None,
        "strategy": "record-key-hash" if sampled else "none",
    }


async def execute_analysis(context: AnalysisMethodContext, method_id: str) -> dict[str, Any]:
    await context.report("preparing", 0.05)
    if context.cancelled():
        raise asyncio.CancelledError
    handler = ANALYSIS_HANDLERS.get(method_id)
    if handler is None:
        raise AnalysisValidationError(f"Unsupported analysis method: {method_id}")
    descriptor = ANALYSIS_METHODS_BY_ID[method_id]
    allowed = set(descriptor.parameterSchema.get("properties", {}))
    unknown = sorted(set(context.parameters) - allowed)
    if unknown:
        raise AnalysisValidationError(f"Unknown analysis parameters: {', '.join(unknown)}")
    if len(orjson.dumps(context.parameters)) > 1_000_000:
        raise AnalysisResourceError("Analysis parameters exceed the 1MiB limit")
    result = handler(context)
    if context.cancelled():
        raise asyncio.CancelledError
    await context.report("running", 0.85)
    return result


def data_profile(context: AnalysisMethodContext) -> dict[str, Any]:
    import polars as pl

    scan = pl.scan_parquet(require_input(context))
    schema = scan.collect_schema()
    row_count = int(scan.select(pl.len()).collect().item())
    statistics = (
        scan.select(
            [
                expression
                for name in schema.names()
                for expression in (
                    pl.col(name).null_count().alias(f"null:{name}"),
                    pl.col(name).n_unique().alias(f"unique:{name}"),
                )
            ]
        )
        .collect()
        .row(0, named=True)
    )
    columns = []
    for name, dtype in schema.items():
        columns.append(
            {
                "field": name,
                "type": str(dtype),
                "nullCount": int(statistics[f"null:{name}"]),
                "nullRate": int(statistics[f"null:{name}"]) / max(row_count, 1),
                "cardinality": int(statistics[f"unique:{name}"]),
            }
        )
    result = empty_result(row_count=row_count)
    result["summary"].update(
        {"columnCount": len(columns), "sizeBytes": require_input(context).stat().st_size}
    )
    result["tables"].append({"id": "columns", "rows": columns})
    return result


def missing_duplicates(context: AnalysisMethodContext) -> dict[str, Any]:
    frame, sampling = load_pandas(context)
    keys = context.parameters.get("keyFields", [])
    if keys:
        keys = string_list(context.parameters, "keyFields")
        require_fields(frame, keys)
    missing = [
        {
            "field": str(name),
            "count": int(frame[name].isna().sum()),
            "rate": float(frame[name].isna().mean()),
        }
        for name in frame.columns
    ]
    duplicate_count = int(frame.duplicated().sum())
    key_duplicates = int(frame.duplicated(subset=keys).sum()) if keys else 0
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {"duplicateRows": duplicate_count, "keyDuplicateRows": key_duplicates}
    result["tables"] = [
        {"id": "missing", "rows": missing},
        {"id": "duplicateSamples", "rows": json_records(frame[frame.duplicated(keep=False)], 100)},
    ]
    return result


def descriptive(context: AnalysisMethodContext) -> dict[str, Any]:
    fields = string_list(context.parameters, "fields")
    frame, sampling = load_pandas(context, fields)
    require_fields(frame, fields, numeric=True)
    rows = []
    for field in fields:
        series = frame[field].dropna()
        rows.append(
            {
                "field": field,
                "count": int(series.count()),
                "mean": json_scalar(series.mean()),
                "std": json_scalar(series.std()),
                "min": json_scalar(series.min()),
                "max": json_scalar(series.max()),
                "median": json_scalar(series.median()),
                "q25": json_scalar(series.quantile(0.25)),
                "q75": json_scalar(series.quantile(0.75)),
            }
        )
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["tables"] = [{"id": "descriptive", "rows": rows}]
    return result


def category_frequency(context: AnalysisMethodContext) -> dict[str, Any]:
    field = string_value(context.parameters, "field")
    top_n = bounded_int(context.parameters, "topN", 20, 1, 1000)
    frame, sampling = load_pandas(context, [field])
    counts = frame[field].value_counts(dropna=False)
    total = len(frame)
    rows = [
        {"value": json_scalar(value), "count": int(count), "share": int(count) / max(total, 1)}
        for value, count in counts.head(top_n).items()
    ]
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {
        "uniqueValues": int(counts.size),
        "longTailValues": max(int(counts.size) - top_n, 0),
    }
    result["tables"] = [{"id": "frequency", "rows": rows}]
    result["series"] = [{"id": "frequency", "type": "bar", "data": rows}]
    return result


def group_aggregate(context: AnalysisMethodContext) -> dict[str, Any]:
    groups = string_list(context.parameters, "groupFields")
    values = string_list(context.parameters, "valueFields")
    aggregations = string_list(context.parameters, "aggregations")
    allowed = {"count", "sum", "mean", "min", "max", "median"}
    if any(item not in allowed for item in aggregations):
        raise AnalysisValidationError("Unsupported aggregation")
    frame, sampling = load_pandas(context, groups + values)
    require_fields(frame, groups + values)
    require_fields(frame, values, numeric=True)
    operations = [item for item in aggregations if item != "count"]
    grouped = frame.groupby(groups, dropna=False)
    output = grouped[values].agg(operations) if operations else grouped.size().to_frame("count")
    output.columns = [
        "_".join(item) if isinstance(item, tuple) else str(item) for item in output.columns
    ]
    if "count" in aggregations:
        output["count"] = grouped.size()
    output = output.reset_index().head(MAX_SERIES_POINTS)
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["tables"] = [{"id": "groups", "rows": json_records(output)}]
    result["series"] = [{"id": "groups", "type": "bar", "data": json_records(output)}]
    return result


def correlation(context: AnalysisMethodContext) -> dict[str, Any]:
    from scipy import stats

    fields = string_list(context.parameters, "fields", max_items=10_000)
    if len(fields) > MAX_CORRELATION_COLUMNS:
        raise AnalysisResourceError("Correlation accepts at most 50 numeric fields")
    method = enum_value(context.parameters, "method", "pearson", {"pearson", "spearman"})
    frame, sampling = load_pandas(context, fields, max_rows=MAX_CORRELATION_ROWS, seed=42)
    require_fields(frame, fields, numeric=True)
    matrix = frame[fields].corr(method=method)
    rows = []
    for left in fields:
        for right in fields:
            paired = frame[[left, right]].dropna()
            if len(paired) < 3 or left == right:
                p_value = 0.0 if left == right else None
            else:
                test = stats.pearsonr if method == "pearson" else stats.spearmanr
                p_value = json_scalar(test(paired[left], paired[right]).pvalue)
            rows.append(
                {
                    "x": left,
                    "y": right,
                    "correlation": json_scalar(matrix.loc[left, right]),
                    "pValue": p_value,
                }
            )
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["tables"] = [{"id": "correlation", "rows": rows}]
    result["series"] = [{"id": "correlation", "type": "heatmap", "data": rows}]
    return result


def outliers(context: AnalysisMethodContext) -> dict[str, Any]:
    fields = string_list(context.parameters, "fields")
    method = enum_value(context.parameters, "method", "iqr", {"iqr", "zscore"})
    threshold = bounded_float(
        context.parameters, "threshold", 1.5 if method == "iqr" else 3.0, 0.1, 10
    )
    frame, sampling = load_pandas(context, fields)
    require_fields(frame, fields, numeric=True)
    masks = {}
    rows = []
    for field in fields:
        series = frame[field]
        if method == "iqr":
            q1, q3 = series.quantile(0.25), series.quantile(0.75)
            spread = q3 - q1
            mask = (series < q1 - threshold * spread) | (series > q3 + threshold * spread)
        else:
            std = series.std()
            mask = (
                ((series - series.mean()).abs() / std > threshold)
                if std and math.isfinite(std)
                else series.notna() & False
            )
        masks[field] = mask
        rows.append(
            {"field": field, "outlierCount": int(mask.sum()), "outlierRate": float(mask.mean())}
        )
    any_mask = next(iter(masks.values())).copy()
    for mask in list(masks.values())[1:]:
        any_mask |= mask
    samples = frame.loc[any_mask, ["__zhiyun_record_key", *fields]].head(100)
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["tables"] = [
        {"id": "outlierSummary", "rows": rows},
        {"id": "outlierSamples", "rows": json_records(samples)},
    ]
    return result


def time_trend(context: AnalysisMethodContext) -> dict[str, Any]:
    import pandas as pd

    time_field = string_value(context.parameters, "timeField")
    value_field = string_value(context.parameters, "valueField", required=False)
    interval = enum_value(context.parameters, "interval", "day", {"hour", "day", "week", "month"})
    aggregation = enum_value(
        context.parameters, "aggregation", "count", {"count", "sum", "mean", "min", "max"}
    )
    window = bounded_int(context.parameters, "movingAverage", 7, 1, 365)
    fields = [time_field, *([value_field] if value_field else [])]
    frame, sampling = load_pandas(context, fields)
    frame[time_field] = pd.to_datetime(frame[time_field], errors="coerce", utc=True)
    frame = frame.dropna(subset=[time_field]).set_index(time_field).sort_index()
    rule = {"hour": "h", "day": "D", "week": "W", "month": "MS"}[interval]
    if aggregation == "count":
        aggregated = frame.resample(rule).size().rename("value")
    else:
        if value_field is None:
            raise AnalysisValidationError("valueField is required for this aggregation")
        require_fields(frame, [value_field], numeric=True)
        aggregated = getattr(frame[value_field].resample(rule), aggregation)().rename("value")
    output = aggregated.to_frame().reset_index()
    output["movingAverage"] = output["value"].rolling(window, min_periods=1).mean()
    if len(output) > MAX_SERIES_POINTS:
        step = math.ceil(len(output) / MAX_SERIES_POINTS)
        output = output.iloc[::step]
    rows = json_records(output)
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["tables"] = [{"id": "trend", "rows": rows}]
    result["series"] = [{"id": "trend", "type": "line", "data": rows}]
    return result


def text_profile(context: AnalysisMethodContext) -> dict[str, Any]:
    import jieba

    fields = string_list(context.parameters, "fields")
    top_n = bounded_int(context.parameters, "topN", 50, 1, 500)
    frame, sampling = load_pandas(context, fields, max_rows=MAX_ML_ROWS, seed=42)
    texts = frame[fields].fillna("").astype(str).agg("\n".join, axis=1)
    counter: Counter[str] = Counter()
    lengths = []
    english = re.compile(r"[A-Za-z][A-Za-z0-9_'-]*")
    for text in texts:
        lengths.append(len(text))
        counter.update(token.lower() for token in english.findall(text))
        counter.update(
            token.strip()
            for token in jieba.cut(text)
            if token.strip() and re.search(r"[\u3400-\u9fff]", token)
        )
    frequency = [{"token": token, "count": count} for token, count in counter.most_common(top_n)]
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {
        "characterCount": int(sum(lengths)),
        "meanLength": float(sum(lengths) / max(len(lengths), 1)),
        "maxLength": max(lengths, default=0),
    }
    result["tables"] = [{"id": "keywords", "rows": frequency}]
    result["series"] = [{"id": "keywords", "type": "bar", "data": frequency}]
    return result


def quality_report(context: AnalysisMethodContext) -> dict[str, Any]:
    frame, sampling = load_pandas(context)
    cells = max(frame.shape[0] * frame.shape[1], 1)
    missing = int(frame.isna().sum().sum())
    duplicates = int(frame.duplicated().sum())
    missing_rate = missing / cells
    duplicate_rate = duplicates / max(len(frame), 1)
    score = max(0.0, round(100 * (1 - min(1.0, 0.7 * missing_rate + 0.3 * duplicate_rate)), 2))
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["summary"].update({"qualityScore": score})
    result["metrics"] = {
        "missingCells": missing,
        "missingRate": missing_rate,
        "duplicateRows": duplicates,
        "duplicateRate": duplicate_rate,
        "qualityScore": score,
    }
    return result


def hypothesis_test(context: AnalysisMethodContext) -> dict[str, Any]:
    from scipy import stats

    test = enum_value(
        context.parameters, "test", "ttest", {"ttest", "mannwhitney", "chi_square", "anova"}
    )
    alpha = bounded_float(context.parameters, "alpha", 0.05, 0.0001, 0.5)
    if test == "chi_square":
        left = string_value(context.parameters, "categoryField")
        right = string_value(context.parameters, "outcomeField")
        frame, sampling = load_pandas(context, [left, right], max_rows=MAX_ML_ROWS)
        table = __import__("pandas").crosstab(frame[left], frame[right])
        statistic, p_value, degrees, _expected = stats.chi2_contingency(table)
    else:
        value = string_value(context.parameters, "valueField")
        group = string_value(context.parameters, "groupField")
        frame, sampling = load_pandas(context, [value, group], max_rows=MAX_ML_ROWS)
        require_fields(frame, [value], numeric=True)
        samples = [item[value].dropna().to_numpy() for _, item in frame.groupby(group)]
        if test in {"ttest", "mannwhitney"} and len(samples) != 2:
            raise AnalysisValidationError(f"{test} requires exactly two groups")
        if test == "ttest":
            evaluated = stats.ttest_ind(samples[0], samples[1], equal_var=False)
        elif test == "mannwhitney":
            evaluated = stats.mannwhitneyu(samples[0], samples[1], alternative="two-sided")
        else:
            if len(samples) < 2:
                raise AnalysisValidationError("ANOVA requires at least two groups")
            evaluated = stats.f_oneway(*samples)
        statistic, p_value, degrees = evaluated.statistic, evaluated.pvalue, None
    row = {
        "test": test,
        "statistic": json_scalar(statistic),
        "pValue": json_scalar(p_value),
        "degreesOfFreedom": json_scalar(degrees),
        "alpha": alpha,
        "significant": bool(p_value < alpha),
    }
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = row
    result["tables"] = [{"id": "test", "rows": [row]}]
    return result


def regression(context: AnalysisMethodContext) -> dict[str, Any]:
    import statsmodels.api as sm

    target = string_value(context.parameters, "targetField")
    features = string_list(context.parameters, "featureFields")
    model = enum_value(context.parameters, "model", "ols", {"ols", "glm"})
    family_name = enum_value(
        context.parameters, "family", "gaussian", {"gaussian", "binomial", "poisson"}
    )
    frame, sampling = load_pandas(context, [target, *features], max_rows=MAX_ML_ROWS)
    require_fields(frame, [target, *features], numeric=True)
    clean = frame[[target, *features]].dropna()
    if len(clean) <= len(features) + 1:
        raise AnalysisValidationError("Regression requires more complete rows than features")
    design = sm.add_constant(clean[features], has_constant="add")
    if model == "ols":
        fitted = sm.OLS(clean[target], design).fit()
    else:
        family = {
            "gaussian": sm.families.Gaussian(),
            "binomial": sm.families.Binomial(),
            "poisson": sm.families.Poisson(),
        }[family_name]
        fitted = sm.GLM(clean[target], design, family=family).fit()
    intervals = fitted.conf_int()
    coefficients = [
        {
            "field": str(name),
            "coefficient": json_scalar(fitted.params[name]),
            "stdError": json_scalar(fitted.bse[name]),
            "pValue": json_scalar(fitted.pvalues[name]),
            "ciLow": json_scalar(intervals.loc[name, 0]),
            "ciHigh": json_scalar(intervals.loc[name, 1]),
        }
        for name in fitted.params.index
    ]
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {
        "observations": int(fitted.nobs),
        "aic": json_scalar(fitted.aic),
        "bic": json_scalar(getattr(fitted, "bic", None)),
        "rSquared": json_scalar(getattr(fitted, "rsquared", None)),
        "adjustedRSquared": json_scalar(getattr(fitted, "rsquared_adj", None)),
    }
    result["tables"] = [{"id": "coefficients", "rows": coefficients}]
    return result


def arima(context: AnalysisMethodContext) -> dict[str, Any]:
    import pandas as pd
    from statsmodels.tsa.arima.model import ARIMA

    time_field = string_value(context.parameters, "timeField")
    value_field = string_value(context.parameters, "valueField")
    order = context.parameters.get("order", [1, 1, 1])
    if (
        not isinstance(order, list)
        or len(order) != 3
        or any(not isinstance(item, int) or not 0 <= item <= 10 for item in order)
    ):
        raise AnalysisValidationError("order must contain three integers between 0 and 10")
    steps = bounded_int(context.parameters, "forecastSteps", 30, 1, 365)
    frame, sampling = load_pandas(context, [time_field, value_field], max_rows=MAX_ML_ROWS)
    require_fields(frame, [value_field], numeric=True)
    frame[time_field] = pd.to_datetime(frame[time_field], errors="coerce", utc=True)
    series = (
        frame.dropna(subset=[time_field, value_field])
        .sort_values(time_field)
        .set_index(time_field)[value_field]
    )
    if len(series) < max(10, sum(order) + 3):
        raise AnalysisValidationError("ARIMA requires more observations")
    fitted = ARIMA(series, order=tuple(order)).fit()
    forecast = fitted.get_forecast(steps=steps)
    interval = forecast.conf_int()
    rows = [
        {
            "step": index + 1,
            "forecast": json_scalar(value),
            "lower": json_scalar(interval.iloc[index, 0]),
            "upper": json_scalar(interval.iloc[index, 1]),
        }
        for index, value in enumerate(forecast.predicted_mean)
    ]
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {
        "aic": json_scalar(fitted.aic),
        "bic": json_scalar(fitted.bic),
        "residualMean": json_scalar(fitted.resid.mean()),
    }
    result["tables"] = [{"id": "forecast", "rows": rows}]
    result["series"] = [{"id": "forecast", "type": "line", "data": rows}]
    return result


def numeric_ml_frame(
    context: AnalysisMethodContext, fields: list[str]
) -> tuple[Any, Any, dict[str, Any]]:
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import StandardScaler

    frame, sampling = load_pandas(
        context, fields, max_rows=MAX_ML_ROWS, seed=int(context.parameters.get("seed", 42))
    )
    require_fields(frame, fields, numeric=True)
    values = SimpleImputer(strategy="median").fit_transform(frame[fields])
    values = StandardScaler().fit_transform(values)
    return frame, values, sampling


def clustering(context: AnalysisMethodContext) -> dict[str, Any]:
    from sklearn.cluster import DBSCAN, KMeans

    features = string_list(context.parameters, "featureFields")
    algorithm = enum_value(context.parameters, "algorithm", "kmeans", {"kmeans", "dbscan"})
    seed = bounded_int(context.parameters, "seed", 42, -(2**31), 2**31 - 1)
    frame, values, sampling = numeric_ml_frame(context, features)
    if len(frame) < 2:
        raise AnalysisValidationError("Clustering requires at least two rows")
    if algorithm == "kmeans":
        clusters = bounded_int(context.parameters, "clusters", 3, 2, min(50, len(frame)))
        labels = KMeans(n_clusters=clusters, random_state=seed, n_init=10).fit_predict(values)
    else:
        eps = bounded_float(context.parameters, "eps", 0.5, 0.000001, 1000)
        min_samples = bounded_int(context.parameters, "minSamples", 5, 2, 1000)
        labels = DBSCAN(eps=eps, min_samples=min_samples).fit_predict(values)
    frame = frame[["__zhiyun_record_key"]].copy()
    frame["cluster"] = labels
    counts = frame["cluster"].value_counts().sort_index()
    rows = [{"cluster": int(label), "count": int(count)} for label, count in counts.items()]
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["tables"] = [
        {"id": "clusters", "rows": rows},
        {"id": "assignments", "rows": json_records(frame, 1000)},
    ]
    return result


def pca(context: AnalysisMethodContext) -> dict[str, Any]:
    from sklearn.decomposition import PCA

    features = string_list(context.parameters, "featureFields")
    components = bounded_int(context.parameters, "components", 2, 2, min(20, len(features)))
    frame, values, sampling = numeric_ml_frame(context, features)
    if len(frame) < components:
        raise AnalysisValidationError("PCA requires at least as many rows as components")
    fitted = PCA(n_components=components, random_state=int(context.parameters.get("seed", 42)))
    projection = fitted.fit_transform(values)
    projected = frame[["__zhiyun_record_key"]].copy()
    for index in range(min(components, 2)):
        projected[f"component{index + 1}"] = projection[:, index]
    variance = [
        {"component": index + 1, "explainedVariance": json_scalar(value)}
        for index, value in enumerate(fitted.explained_variance_ratio_)
    ]
    loadings = [
        {
            "field": field,
            **{
                f"component{index + 1}": json_scalar(fitted.components_[index, field_index])
                for index in range(components)
            },
        }
        for field_index, field in enumerate(features)
    ]
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["tables"] = [{"id": "variance", "rows": variance}, {"id": "loadings", "rows": loadings}]
    result["series"] = [{"id": "projection", "type": "scatter", "data": json_records(projected)}]
    return result


def isolation_forest(context: AnalysisMethodContext) -> dict[str, Any]:
    from sklearn.ensemble import IsolationForest

    features = string_list(context.parameters, "featureFields")
    contamination = bounded_float(context.parameters, "contamination", 0.05, 0.000001, 0.5)
    seed = bounded_int(context.parameters, "seed", 42, -(2**31), 2**31 - 1)
    frame, values, sampling = numeric_ml_frame(context, features)
    model = IsolationForest(contamination=contamination, random_state=seed)
    labels = model.fit_predict(values)
    scores = -model.score_samples(values)
    output = frame[["__zhiyun_record_key"]].copy()
    output["score"] = scores
    output["outlier"] = labels == -1
    output = output.sort_values("score", ascending=False)
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {"outlierCount": int((labels == -1).sum())}
    result["tables"] = [{"id": "outliers", "rows": json_records(output, 1000)}]
    return result


def joined_text(frame: Any, fields: list[str]) -> Any:
    return frame[fields].fillna("").astype(str).agg("\n".join, axis=1)


def tfidf(context: AnalysisMethodContext) -> dict[str, Any]:
    from scipy.sparse import save_npz
    from sklearn.feature_extraction.text import TfidfVectorizer

    fields = string_list(context.parameters, "textFields")
    max_features = bounded_int(context.parameters, "maxFeatures", 5000, 10, 50_000)
    top_n = bounded_int(context.parameters, "topN", 50, 1, 500)
    frame, sampling = load_pandas(context, fields, max_rows=MAX_ML_ROWS)
    texts = joined_text(frame, fields)
    vectorizer = TfidfVectorizer(max_features=max_features, token_pattern=r"(?u)\b\w+\b")
    matrix = vectorizer.fit_transform(texts)
    terms = vectorizer.get_feature_names_out()
    means = matrix.mean(axis=0).A1
    ranking = means.argsort()[::-1][:top_n]
    rows = [{"term": str(terms[index]), "score": json_scalar(means[index])} for index in ranking]
    artifact_ref = "tfidf-document-matrix.npz"
    save_npz(context.workspace / artifact_ref, matrix, compressed=True)
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {"documents": int(matrix.shape[0]), "features": int(matrix.shape[1])}
    result["tables"] = [{"id": "keywords", "rows": rows}]
    result["series"] = [{"id": "keywords", "type": "bar", "data": rows}]
    result["artifacts"] = [
        {
            "kind": "analysis.tfidf.matrix",
            "artifactRef": artifact_ref,
            "contentType": "application/octet-stream",
        }
    ]
    return result


def text_classification(context: AnalysisMethodContext) -> dict[str, Any]:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    from sklearn.svm import LinearSVC

    fields = string_list(context.parameters, "textFields")
    target = string_value(context.parameters, "targetField")
    algorithm = enum_value(
        context.parameters,
        "algorithm",
        "logistic_regression",
        {"logistic_regression", "linear_svm"},
    )
    test_size = bounded_float(context.parameters, "testSize", 0.2, 0.1, 0.5)
    max_features = bounded_int(context.parameters, "maxFeatures", 5000, 10, 50_000)
    seed = bounded_int(context.parameters, "seed", 42, -(2**31), 2**31 - 1)
    frame, sampling = load_pandas(context, [*fields, target], max_rows=MAX_ML_ROWS, seed=seed)
    clean = frame.dropna(subset=[target]).copy()
    labels = clean[target].astype(str)
    if labels.nunique() < 2:
        raise AnalysisValidationError("Classification target requires at least two classes")
    if labels.value_counts().min() < 2:
        raise AnalysisValidationError("Each classification class requires at least two rows")
    train_text, test_text, train_labels, test_labels = train_test_split(
        joined_text(clean, fields), labels, test_size=test_size, random_state=seed, stratify=labels
    )
    classifier = (
        LogisticRegression(max_iter=1000, random_state=seed)
        if algorithm == "logistic_regression"
        else LinearSVC(random_state=seed)
    )
    model = Pipeline(
        [
            ("tfidf", TfidfVectorizer(max_features=max_features, token_pattern=r"(?u)\b\w+\b")),
            ("classifier", classifier),
        ]
    )
    model.fit(train_text, train_labels)
    predictions = model.predict(test_text)
    report = classification_report(test_labels, predictions, output_dict=True, zero_division=0)
    labels_order = sorted(labels.unique())
    matrix = confusion_matrix(test_labels, predictions, labels=labels_order)
    rows = [
        {"actual": actual, "predicted": predicted, "count": int(matrix[left, right])}
        for left, actual in enumerate(labels_order)
        for right, predicted in enumerate(labels_order)
    ]
    result = empty_result(row_count=sampling["inputRows"])
    result["sampling"] = sampling
    result["metrics"] = {
        "accuracy": float(accuracy_score(test_labels, predictions)),
        "macroF1": float(f1_score(test_labels, predictions, average="macro")),
        "trainRows": len(train_text),
        "validationRows": len(test_text),
        "report": report,
    }
    result["tables"] = [{"id": "confusionMatrix", "rows": rows}]
    return result


ANALYSIS_HANDLERS: dict[str, Callable[[AnalysisMethodContext], dict[str, Any]]] = {
    "data.profile": data_profile,
    "data.missing_duplicates": missing_duplicates,
    "stats.descriptive": descriptive,
    "category.frequency": category_frequency,
    "group.aggregate": group_aggregate,
    "stats.correlation": correlation,
    "stats.outliers": outliers,
    "time.trend": time_trend,
    "text.profile": text_profile,
    "data.quality_report": quality_report,
    "stats.hypothesis_test": hypothesis_test,
    "stats.regression": regression,
    "time.arima": arima,
    "ml.clustering": clustering,
    "ml.pca": pca,
    "ml.isolation_forest": isolation_forest,
    "text.tfidf": tfidf,
    "text.classification": text_classification,
}
