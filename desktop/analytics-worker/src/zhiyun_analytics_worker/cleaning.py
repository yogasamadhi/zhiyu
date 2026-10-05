from __future__ import annotations

import asyncio
import hashlib
import math
import shutil
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, time
from pathlib import Path
from typing import Any
from uuid import uuid4

import orjson
import pyarrow as pa
import pyarrow.parquet as pq

from .models import CleaningParameters, CleaningStep, MethodDescriptor
from .normalization import RESERVED_COLUMNS, parse_datetime, physical_name
from .security import resolve_input

MAX_INPUT_BYTES = 5 * 1024**3
MAX_ROW_GROUP_BYTES = 256 * 1024**2
MAX_OUTPUT_BYTES = 10 * 1024**3
MAX_ROWS = 1_000_000
MAX_COLUMNS = 1000
MAX_CELL_BYTES = 1024**2
MAX_KEY_BYTES = 1024**2
MAX_MANIFEST_BYTES = 4 * 1024**2
MAX_FACET_VALUES = 50
MAX_REPORT_BYTES = 16 * 1024**2
MAX_PREVIEW_FIELDS = 25
ProgressReporter = Callable[[str, float], Awaitable[None]]


class CleaningValidationError(ValueError):
    pass


class CleaningResourceError(CleaningValidationError):
    pass


CLEAN_SNAPSHOT_METHOD = MethodDescriptor(
    id="dataset.clean_snapshot",
    version="1.0.0",
    category="internal",
    titleKey="worker.methods.cleanSnapshot.title",
    descriptionKey="worker.methods.cleanSnapshot.description",
    parameterSchema=CleaningParameters.model_json_schema(),
    outputSchema={"type": "object", "required": ["version", "steps", "inputRowCount", "rowCount"]},
    resourceLimits={
        "maxInputBytes": MAX_INPUT_BYTES,
        "maxRows": MAX_ROWS,
        "maxColumns": MAX_COLUMNS,
        "maxSteps": 20,
        "maxOutputBytes": MAX_OUTPUT_BYTES,
        "maxReportBytes": MAX_REPORT_BYTES,
    },
    internal=True,
)


def json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return (
            (value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC))
            .isoformat()
            .replace("+00:00", "Z")
        )
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def column_type(field: pa.Field) -> str:
    kind = field.type
    if pa.types.is_string(kind) or pa.types.is_large_string(kind):
        return "string"
    if pa.types.is_integer(kind):
        return "int"
    if pa.types.is_floating(kind):
        return "float"
    if pa.types.is_boolean(kind):
        return "bool"
    if pa.types.is_timestamp(kind) or pa.types.is_date(kind):
        return "datetime"
    raise CleaningValidationError(f"Unsupported cleaning field type: {kind}")


class Quality:
    def __init__(self, fields: dict[str, str], limit: int):
        self.limit = limit
        self.rows = 0
        self.fields = {
            field: {
                "type": kind,
                "nullCount": 0,
                "blankCount": 0,
                "invalidCount": 0,
                "stringCount": 0,
                "otherCount": 0,
                "values": {},
            }
            for field, kind in fields.items()
        }

    def observe(self, data: dict[str, Any]) -> None:
        self.rows += 1
        for field, profile in self.fields.items():
            value = data[field]
            if isinstance(value, str):
                profile["stringCount"] += 1
            if value is None or isinstance(value, float) and math.isnan(value):
                profile["nullCount"] += 1
            if isinstance(value, str) and not value.strip():
                profile["blankCount"] += 1
            if isinstance(value, float) and not math.isfinite(value):
                profile["invalidCount"] += 1
            display = json_value(value)
            encoded = orjson.dumps(display, option=orjson.OPT_SORT_KEYS)
            if len(encoded) > MAX_CELL_BYTES:
                raise CleaningResourceError("Cleaning cell exceeds the 1MiB limit")
            key = hashlib.sha256(encoded).hexdigest()
            values = profile["values"]
            if key in values:
                values[key]["count"] += 1
            elif len(values) < MAX_FACET_VALUES:
                values[key] = {
                    "value": display[:200] if isinstance(display, str) else display,
                    "valueTruncated": isinstance(display, str) and len(display) > 200,
                    "count": 1,
                }
            else:
                profile["otherCount"] += 1

    def result(self) -> dict[str, Any]:
        fields = {}
        for field, profile in self.fields.items():
            values = sorted(profile["values"].values(), key=lambda item: -item["count"])
            fields[field] = {
                **{k: v for k, v in profile.items() if k != "values"},
                "trackedDistinctCount": len(profile["values"]),
                "facets": values[: self.limit],
                "facetScope": "first-50-distinct-values",
                "omittedTrackedCount": sum(item["count"] for item in values[self.limit :]),
            }
        return {"rowCount": self.rows, "fields": fields}


def inspect_input(
    input_path: Path, manifest: dict[str, Any]
) -> tuple[pq.ParquetFile, dict[str, str], dict[str, str]]:
    if input_path.stat().st_size > MAX_INPUT_BYTES:
        raise CleaningResourceError("Cleaning input exceeds the 5GiB limit")
    parquet = pq.ParquetFile(input_path)
    if parquet.metadata.num_rows > MAX_ROWS:
        raise CleaningResourceError("Cleaning input exceeds the 1,000,000 row limit")
    if any(
        parquet.metadata.row_group(index).total_byte_size > MAX_ROW_GROUP_BYTES
        for index in range(parquet.num_row_groups)
    ):
        raise CleaningResourceError("Cleaning row group exceeds the 256MiB limit")
    schema = parquet.schema_arrow
    if not RESERVED_COLUMNS <= set(schema.names):
        raise CleaningValidationError("Snapshot provenance columns are missing")
    if any(column_type(schema.field(name)) != "string" for name in RESERVED_COLUMNS):
        raise CleaningValidationError("Snapshot provenance must contain strings")
    fields = {}
    kinds = {}
    columns = manifest.get("columns")
    if not isinstance(columns, list) or len(columns) > MAX_COLUMNS:
        raise CleaningResourceError("Cleaning manifest exceeds the column limit")
    for column in columns:
        if not isinstance(column, dict):
            raise CleaningValidationError("Snapshot manifest fields are invalid")
        name, physical = column.get("sourceField"), column.get("physicalName")
        if (
            not isinstance(name, str)
            or not name
            or not isinstance(physical, str)
            or name in fields
            or physical in fields.values()
            or physical in RESERVED_COLUMNS
            or physical not in schema.names
        ):
            raise CleaningValidationError("Snapshot manifest fields are invalid")
        fields[name] = physical
        kinds[name] = column_type(schema.field(physical))
        if column.get("type") != kinds[name]:
            raise CleaningValidationError("Snapshot manifest field type does not match Parquet")
    if set(fields.values()) | RESERVED_COLUMNS != set(schema.names):
        raise CleaningValidationError("Snapshot manifest does not describe its Parquet fields")
    if manifest.get("rowCount") != parquet.metadata.num_rows:
        raise CleaningValidationError("Snapshot manifest row count does not match Parquet")
    return parquet, fields, kinds


def validate_steps(parameters: CleaningParameters, initial: dict[str, str]) -> list[dict[str, str]]:
    for name, expected in parameters.expectedFields.items():
        actual = initial.get(name)
        numeric = actual in {"int", "float"} and expected in {"int", "float"}
        if actual != expected and not numeric:
            raise CleaningValidationError(
                f"Recipe field {name!r} is missing or has a different type"
            )
    fields = dict(initial)
    schemas = []
    for index, step in enumerate(parameters.steps):
        required = [step.field] if step.type == "split" else step.fields
        for name in required:
            kind = fields.get(name)
            if kind is None:
                raise CleaningValidationError(f"Step {index + 1}: field {name!r} is missing")
            accepted = (
                {"string"}
                if step.type in {"trim", "split"}
                else {"string", "int", "float"}
                if step.type == "convert" and step.targetType == "number"
                else {"string", "datetime"}
                if step.type == "convert"
                else None
            )
            if accepted is not None and kind not in accepted:
                raise CleaningValidationError(f"Step {index + 1}: incompatible field {name!r}")
        if step.type == "convert":
            for name in step.fields:
                fields[name] = "float" if step.targetType == "number" else "datetime"
        if step.type in {"split", "merge"}:
            targets = step.targets if step.type == "split" else [step.target]
            if any(name in fields for name in targets):
                raise CleaningValidationError("Cleaning target fields must be new")
            fields.update(dict.fromkeys(targets, "string"))
        if len(fields) > MAX_COLUMNS:
            raise CleaningResourceError("Cleaning output exceeds the column limit")
        schemas.append(dict(fields))
    return schemas


def transform(
    data: dict[str, Any], step: CleaningStep, seen: sqlite3.Connection, index: int
) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    output = dict(data)
    errors = []
    if step.type == "trim":
        for name in step.fields:
            if output[name] is not None:
                output[name] = output[name].strip()
    elif step.type == "normalize_null":
        for name in step.fields:
            value = output[name]
            if (
                value is None
                or isinstance(value, str)
                and value in step.tokens
                or isinstance(value, float)
                and math.isnan(value)
            ):
                output[name] = None
    elif step.type == "convert":
        for name in step.fields:
            value = output[name]
            if value is None:
                continue
            try:
                if step.targetType == "number":
                    if isinstance(value, bool):
                        raise ValueError
                    if isinstance(value, str):
                        value = value.strip()
                        if not value:
                            raise ValueError
                    converted = float(value)
                    if not math.isfinite(converted) or (
                        converted.is_integer() and abs(converted) > 2**53 - 1
                    ):
                        raise ValueError
                else:
                    converted = value if isinstance(value, datetime) else parse_datetime(value)
                    if converted is None:
                        raise ValueError
                output[name] = converted
            except (ValueError, TypeError, OverflowError):
                if step.onError == "fail":
                    raise CleaningValidationError(
                        f"Step {index + 1}: cannot convert field {name!r} to {step.targetType}"
                    ) from None
                output[name] = None
                errors.append({"field": name, "reason": f"invalid_{step.targetType}"})
    elif step.type == "split":
        value = output[step.field]
        parts = [] if value is None else value.split(step.delimiter, len(step.targets) - 1)
        for part, name in enumerate(step.targets):
            output[name] = parts[part] if part < len(parts) else None
    elif step.type == "merge":
        parts = []
        for name in step.fields:
            value = json_value(output[name])
            if value is not None:
                parts.append(
                    value if isinstance(value, str) else orjson.dumps(value).decode("utf-8")
                )
        output[step.target] = step.separator.join(parts) if parts else None
    elif step.type == "dedupe":
        key = orjson.dumps([json_value(output[name]) for name in step.fields])
        if len(key) > MAX_KEY_BYTES:
            raise CleaningResourceError("Cleaning dedupe key exceeds the 1MiB limit")
        if (
            seen.execute(
                "INSERT OR IGNORE INTO seen(step, value) VALUES (?, ?)", (index, key)
            ).rowcount
            == 0
        ):
            return None, errors
    return output, errors


def preview_values(
    data: dict[str, Any] | None, selected: list[str]
) -> tuple[dict[str, Any] | None, list[str], int]:
    if data is None:
        return None, [], 0
    names = [name for name in selected if name in data]
    truncated = [name for name in names if isinstance(data[name], str) and len(data[name]) > 500]
    return (
        {name: data[name][:500] if name in truncated else json_value(data[name]) for name in names},
        truncated,
        len(data) - len(names),
    )


def snapshot_schema(source: pa.Schema, fields: dict[str, str], kinds: dict[str, str]) -> pa.Schema:
    types = {
        "string": pa.large_string(),
        "float": pa.float64(),
        "int": pa.int64(),
        "bool": pa.bool_(),
        "datetime": pa.timestamp("ms", tz="UTC"),
    }
    return pa.schema(
        [
            *(source.field(name) for name in sorted(RESERVED_COLUMNS)),
            *(pa.field(physical, types[kinds[name]]) for name, physical in fields.items()),
        ]
    )


async def clean_snapshot(
    input_path: Path,
    workspace: Path,
    parameters: dict[str, Any],
    report: ProgressReporter,
    cancelled: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    config = CleaningParameters.model_validate(parameters)
    manifest_path = resolve_input(workspace, config.manifestArtifactRef)
    if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        raise CleaningResourceError("Snapshot manifest exceeds the 4MiB limit")
    manifest = orjson.loads(manifest_path.read_bytes())
    if not isinstance(manifest, dict) or manifest.get("fingerprint") != config.fingerprint:
        raise CleaningValidationError("Snapshot manifest fingerprint does not match the input")
    parquet, fields, kinds = inspect_input(input_path, manifest)
    schemas = validate_steps(config, kinds)
    checksum = hashlib.sha256()
    with input_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024**2), b""):
            if cancelled():
                raise asyncio.CancelledError
            checksum.update(chunk)
    parquet_manifest = manifest.get("parquet")
    if not isinstance(parquet_manifest, dict) or checksum.hexdigest() != parquet_manifest.get(
        "checksum"
    ):
        raise CleaningValidationError("Snapshot Parquet checksum does not match its manifest")
    input_rows = parquet.metadata.num_rows
    if cancelled():
        raise asyncio.CancelledError
    await report("preparing", 0.02)
    if not config.steps:
        quality = Quality(kinds, config.facetLimit)
        for batch in parquet.iter_batches(batch_size=max(1, 100_000 // max(len(fields), 1))):
            if cancelled():
                raise asyncio.CancelledError
            for row in batch.to_pylist():
                quality.observe({name: row[physical] for name, physical in fields.items()})
            await asyncio.sleep(0)
        result = {
            "version": "1.0.0",
            "inputFingerprint": config.fingerprint,
            "fingerprint": config.fingerprint,
            "inputRowCount": input_rows,
            "rowCount": input_rows,
            "parquetArtifactRef": input_path.relative_to(workspace).as_posix(),
            "manifestArtifactRef": config.manifestArtifactRef,
            "inputQuality": quality.result(),
            "outputQuality": quality.result(),
            "steps": [],
        }
        if len(orjson.dumps(result)) > MAX_REPORT_BYTES:
            raise CleaningResourceError("Cleaning report exceeds the 16MiB limit")
        return result
    input_size = input_path.stat().st_size  # noqa: ASYNC240 -- handler runs in a Worker thread
    if shutil.disk_usage(workspace).free < max(input_size * 2, 64 * 1024**2):
        raise CleaningResourceError("Insufficient temporary disk for cleaning")
    output_dir = workspace / f"cleaning-{uuid4().hex}"
    output_dir.mkdir(mode=0o700)
    seen = None
    results = []
    total_bytes = 0
    report_bytes = 0
    initial_quality = None
    parent_fingerprint = config.fingerprint
    try:
        seen = sqlite3.connect(output_dir / ".seen.sqlite")
        seen.execute("CREATE TABLE seen(step INTEGER, value BLOB, PRIMARY KEY(step,value))")
        for index, step in enumerate(config.steps):
            if cancelled():
                raise asyncio.CancelledError
            current_kinds = kinds
            kinds = schemas[index]
            occupied = set(fields.values()) | RESERVED_COLUMNS
            for name in kinds:
                if name not in fields:
                    fields[name] = physical_name(name, occupied)
                    occupied.add(fields[name])
            schema = snapshot_schema(parquet.schema_arrow, fields, kinds)
            target = output_dir / f"step-{index + 1}.parquet"
            writer = pq.ParquetWriter(target, schema, compression="zstd")
            before = Quality(current_kinds, config.facetLimit)
            after = Quality(kinds, config.facetLimit)
            samples = []
            error_samples = []
            error_rows = error_count = changed_rows = removed_rows = 0
            row_index = 0
            preferred = [step.field, *step.targets] if step.type == "split" else step.fields
            if step.type == "merge":
                preferred = [*preferred, step.target]
            preview_fields = list(dict.fromkeys([*preferred, *kinds]))[:MAX_PREVIEW_FIELDS]
            try:
                for batch in parquet.iter_batches(
                    batch_size=max(1, min(2000, 100_000 // max(len(schema), 1)))
                ):
                    if cancelled():
                        raise asyncio.CancelledError
                    rows = []
                    for row in batch.to_pylist():
                        if any(
                            not isinstance(row[key], str) or len(row[key]) > 8192
                            for key in RESERVED_COLUMNS
                        ):
                            raise CleaningResourceError("Cleaning provenance exceeds its bound")
                        data = {}
                        for name in current_kinds:
                            value = row[fields[name]]
                            if isinstance(value, date) and not isinstance(value, datetime):
                                value = datetime.combine(value, time(), UTC)
                            data[name] = value
                        before.observe(data)
                        transformed, errors = transform(data, step, seen, index)
                        error_rows += bool(errors)
                        error_count += len(errors)
                        if errors and len(error_samples) < 20:
                            error_samples.append(
                                {
                                    "rowIndex": row_index,
                                    "recordKey": row["__zhiyun_record_key"],
                                    "errors": errors,
                                }
                            )
                        removed_rows += transformed is None
                        changed_rows += transformed is not None and transformed != data
                        if len(samples) < config.previewLimit:
                            before_values, before_truncated, before_omitted = preview_values(
                                data, preview_fields
                            )
                            after_values, after_truncated, after_omitted = preview_values(
                                transformed, preview_fields
                            )
                            samples.append(
                                {
                                    "rowIndex": row_index,
                                    "recordKey": row["__zhiyun_record_key"],
                                    "sourceUrl": row["__zhiyun_source_url"],
                                    "before": before_values,
                                    "after": after_values,
                                    "beforeTruncatedFields": before_truncated,
                                    "afterTruncatedFields": after_truncated,
                                    "beforeOmittedFieldCount": before_omitted,
                                    "afterOmittedFieldCount": after_omitted,
                                    "errors": errors,
                                }
                            )
                        if transformed is not None:
                            after.observe(transformed)
                            rows.append(
                                {
                                    **{key: row[key] for key in RESERVED_COLUMNS},
                                    **{fields[name]: value for name, value in transformed.items()},
                                }
                            )
                        row_index += 1
                    if rows:
                        writer.write_table(pa.Table.from_pylist(rows, schema=schema))
                    seen.commit()
                    if total_bytes + target.stat().st_size > MAX_OUTPUT_BYTES:
                        raise CleaningResourceError("Cleaning output exceeds the 10GiB limit")
                    await report(
                        "cleaning",
                        0.05
                        + 0.85
                        * (index + row_index / max(parquet.metadata.num_rows, 1))
                        / len(config.steps),
                    )
                    await asyncio.sleep(0)
            finally:
                writer.close()
            total_bytes += target.stat().st_size
            if total_bytes > MAX_OUTPUT_BYTES:
                raise CleaningResourceError("Cleaning output exceeds the 10GiB limit")
            checksum = hashlib.sha256()
            with target.open("rb") as source:
                for chunk in iter(lambda: source.read(1024**2), b""):
                    if cancelled():
                        raise asyncio.CancelledError
                    checksum.update(chunk)
            current_manifest = {
                "version": "1.0.0",
                "fingerprint": hashlib.sha256(
                    parent_fingerprint.encode()
                    + b"dataset.clean_snapshot@1.0.0"
                    + orjson.dumps(step.model_dump(mode="json"), option=orjson.OPT_SORT_KEYS)
                ).hexdigest(),
                "inputRowCount": before.rows,
                "rowCount": after.rows,
                "columns": [
                    {
                        "sourceField": name,
                        "physicalName": fields[name],
                        "type": kinds[name],
                        "nullCount": profile["nullCount"],
                        "stringCount": profile["stringCount"],
                        # Normalized Parquet strings no longer identify their raw JSON origin.
                        "originalStringCount": None,
                        "jsonValueCount": None,
                    }
                    for name, profile in after.fields.items()
                ],
                "warnings": [],
                "parquet": {
                    "artifactRef": target.relative_to(workspace).as_posix(),
                    "size": target.stat().st_size,
                    "checksum": checksum.hexdigest(),
                },
            }
            output_manifest = output_dir / f"step-{index + 1}-manifest.json"
            output_manifest.write_bytes(orjson.dumps(current_manifest))
            result = {
                "index": index,
                "inputFingerprint": parent_fingerprint,
                "fingerprint": current_manifest["fingerprint"],
                "operation": step.model_dump(mode="json"),
                "inputRowCount": before.rows,
                "rowCount": after.rows,
                "changedRowCount": changed_rows,
                "removedRowCount": removed_rows,
                "errorRowCount": error_rows,
                "errorCount": error_count,
                "errorSamples": error_samples,
                "preview": samples,
                "parquetArtifactRef": target.relative_to(workspace).as_posix(),
                "manifestArtifactRef": output_manifest.relative_to(workspace).as_posix(),
                "inputQuality": before.result(),
                "outputQuality": after.result(),
            }
            report_bytes += len(orjson.dumps(result))
            if report_bytes > MAX_REPORT_BYTES:
                raise CleaningResourceError("Cleaning report exceeds the 16MiB limit")
            results.append(result)
            if initial_quality is None:
                initial_quality = before.result()
            parent_fingerprint = current_manifest["fingerprint"]
            parquet = pq.ParquetFile(target)
        if cancelled():
            raise asyncio.CancelledError
        await report("persisting", 0.95)
        result = {
            "version": "1.0.0",
            "inputFingerprint": config.fingerprint,
            "fingerprint": parent_fingerprint,
            "inputRowCount": input_rows,
            "rowCount": results[-1]["rowCount"],
            "parquetArtifactRef": results[-1]["parquetArtifactRef"],
            "manifestArtifactRef": results[-1]["manifestArtifactRef"],
            "inputQuality": initial_quality,
            "outputQuality": results[-1]["outputQuality"],
            "steps": results,
        }
        if len(orjson.dumps(result)) > MAX_REPORT_BYTES:
            raise CleaningResourceError("Cleaning report exceeds the 16MiB limit")
        return result
    except BaseException:
        if seen is not None:
            seen.close()
        shutil.rmtree(output_dir)
        raise
    finally:
        if seen is not None:
            seen.close()
        if output_dir.exists():
            (output_dir / ".seen.sqlite").unlink(missing_ok=True)
