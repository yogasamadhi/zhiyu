from __future__ import annotations

import asyncio
import hashlib
import math
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import orjson
import pyarrow as pa
import pyarrow.parquet as pq

from .models import MethodDescriptor

MAX_INPUT_BYTES = 5 * 1024**3
MAX_LINE_BYTES = 64 * 1024**2
MAX_COLUMNS = 10_000
BATCH_ROWS = 10_000
RESERVED_COLUMNS = {"__zhiyun_record_key", "__zhiyun_source_url"}

NORMALIZE_SNAPSHOT_METHOD = MethodDescriptor(
    id="dataset.normalize_snapshot",
    version="1.0.0",
    category="internal",
    titleKey="worker.methods.normalizeSnapshot.title",
    descriptionKey="worker.methods.normalizeSnapshot.description",
    parameterSchema={
        "type": "object",
        "additionalProperties": False,
        "required": ["fingerprint"],
        "properties": {
            "fingerprint": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
        },
    },
    outputSchema={
        "type": "object",
        "required": ["parquetArtifactRef", "manifestArtifactRef", "rowCount", "warnings"],
        "properties": {
            "parquetArtifactRef": {"type": "string"},
            "manifestArtifactRef": {"type": "string"},
            "rowCount": {"type": "integer"},
            "warnings": {"type": "array", "items": {"type": "string"}},
        },
    },
    internal=True,
)

ColumnKind = Literal["bool", "int", "float", "datetime", "string"]
ProgressReporter = Callable[[str, float], Awaitable[None]]
CancellationProbe = Callable[[], bool]


class NormalizationError(ValueError):
    pass


class NormalizationResourceError(NormalizationError):
    pass


@dataclass
class ColumnProfile:
    source_name: str
    physical_name: str
    observed: set[str] = field(default_factory=set)
    null_count: int = 0
    string_count: int = 0
    iso_datetime_count: int = 0
    json_count: int = 0
    kind: ColumnKind = "string"

    def observe(self, value: Any) -> None:
        if value is None:
            self.null_count += 1
            return
        if isinstance(value, bool):
            self.observed.add("bool")
        elif isinstance(value, int):
            self.observed.add("int")
        elif isinstance(value, float):
            self.observed.add("float")
        elif isinstance(value, str):
            self.observed.add("string")
            self.string_count += 1
            if parse_datetime(value) is not None:
                self.iso_datetime_count += 1
        elif isinstance(value, (dict, list)):
            self.observed.add("json")
            self.json_count += 1
        else:
            self.observed.add("string")

    def finalize(self, warnings: list[str]) -> None:
        observed = self.observed
        if not observed:
            self.kind = "string"
        elif observed <= {"int"}:
            self.kind = "int"
        elif observed <= {"int", "float"}:
            self.kind = "float" if "float" in observed else "int"
        elif observed <= {"bool"}:
            self.kind = "bool"
        elif observed <= {"string"} and self.string_count == self.iso_datetime_count:
            self.kind = "datetime"
        elif observed <= {"json"}:
            self.kind = "string"
        else:
            self.kind = "string"
            warnings.append(
                f"Field {self.source_name!r} had conflicting scalar types and was promoted to string"
            )


def parse_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.fromisoformat(f"{value}T00:00:00+00:00")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def physical_name(source_name: str, occupied: set[str]) -> str:
    encoded = source_name.encode("utf-8", errors="replace")
    if source_name in RESERVED_COLUMNS or len(encoded) > 255 or "\x00" in source_name:
        base = f"field_{hashlib.sha256(encoded).hexdigest()[:16]}"
    else:
        base = source_name
    candidate = base
    suffix = 1
    while candidate in occupied:
        suffix += 1
        candidate = f"{base}_{suffix}"
    occupied.add(candidate)
    return candidate


def arrow_type(kind: ColumnKind) -> pa.DataType:
    if kind == "bool":
        return pa.bool_()
    if kind == "int":
        return pa.int64()
    if kind == "float":
        return pa.float64()
    if kind == "datetime":
        return pa.timestamp("ms", tz="UTC")
    return pa.large_string()


def coerce(value: Any, kind: ColumnKind) -> Any:
    if value is None:
        return None
    if kind == "bool":
        return value if isinstance(value, bool) else None
    if kind == "int":
        return value if isinstance(value, int) and not isinstance(value, bool) else None
    if kind == "float":
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            numeric = float(value)
            return numeric if math.isfinite(numeric) else None
        return None
    if kind == "datetime":
        return parse_datetime(value) if isinstance(value, str) else None
    if isinstance(value, (dict, list)):
        return orjson.dumps(value, option=orjson.OPT_SORT_KEYS).decode("utf-8")
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def parse_line(raw: bytes, line_number: int) -> dict[str, Any]:
    if len(raw) > MAX_LINE_BYTES:
        raise NormalizationError(f"Record at line {line_number} exceeds the 64MiB limit")
    try:
        item = orjson.loads(raw)
    except orjson.JSONDecodeError as error:
        raise NormalizationError(f"Invalid NDJSON at line {line_number}") from error
    if not isinstance(item, dict) or not isinstance(item.get("data"), dict):
        raise NormalizationError(f"Invalid Snapshot record at line {line_number}")
    return item


async def normalize_snapshot(
    input_path: Path,
    workspace: Path,
    parameters: dict[str, Any],
    report: ProgressReporter,
    cancelled: CancellationProbe = lambda: False,
) -> dict[str, Any]:
    fingerprint = parameters.get("fingerprint")
    if not isinstance(fingerprint, str) or len(fingerprint) != 64:
        raise NormalizationError("Snapshot fingerprint must be a SHA-256 hex digest")
    input_size = input_path.stat().st_size
    if input_size > MAX_INPUT_BYTES:
        raise NormalizationResourceError("Snapshot input exceeds the 5GiB limit")
    required_disk = min(max(input_size * 2, 64 * 1024**2), 10 * 1024**3)
    if shutil.disk_usage(workspace).free < required_disk:
        raise OSError(28, "Insufficient temporary disk")

    warnings: list[str] = []
    occupied = set(RESERVED_COLUMNS)
    profiles: dict[str, ColumnProfile] = {}
    input_rows = 0
    active_rows = 0
    processed_bytes = 0
    await report("preparing", 0.02)
    with input_path.open("rb") as source:
        for line_number, raw in enumerate(source, start=1):
            if cancelled():
                raise asyncio.CancelledError
            processed_bytes += len(raw)
            item = parse_line(raw, line_number)
            input_rows += 1
            if not bool(item.get("removed", False)):
                active_rows += 1
                for source_name, value in item["data"].items():
                    name = str(source_name)
                    profile = profiles.get(name)
                    if profile is None:
                        if len(profiles) >= MAX_COLUMNS:
                            raise NormalizationResourceError(
                                "Snapshot exceeds the 10,000 column limit"
                            )
                        profile = ColumnProfile(name, physical_name(name, occupied))
                        profiles[name] = profile
                    profile.observe(value)
            if line_number % 10_000 == 0:
                progress = 0.02 + 0.33 * (processed_bytes / max(input_size, 1))
                await report("preparing", progress)
                await asyncio.sleep(0)

    for profile in profiles.values():
        profile.finalize(warnings)
    ordered_profiles = sorted(profiles.values(), key=lambda item: item.physical_name)
    schema = pa.schema(
        [
            pa.field("__zhiyun_record_key", pa.large_string(), nullable=False),
            pa.field("__zhiyun_source_url", pa.large_string(), nullable=False),
            *(pa.field(item.physical_name, arrow_type(item.kind)) for item in ordered_profiles),
        ]
    )
    parquet_path = workspace / "snapshot.parquet"
    partial_parquet = workspace / ".snapshot.parquet.partial"
    writer = pq.ParquetWriter(partial_parquet, schema, compression="zstd")
    batch: list[dict[str, Any]] = []
    processed_bytes = 0
    try:
        with input_path.open("rb") as source:
            for line_number, raw in enumerate(source, start=1):
                if cancelled():
                    raise asyncio.CancelledError
                processed_bytes += len(raw)
                item = parse_line(raw, line_number)
                if bool(item.get("removed", False)):
                    continue
                row: dict[str, Any] = {
                    "__zhiyun_record_key": str(item.get("recordKey", "")),
                    "__zhiyun_source_url": str(item.get("sourceUrl", "")),
                }
                data = item["data"]
                for profile in ordered_profiles:
                    row[profile.physical_name] = coerce(data.get(profile.source_name), profile.kind)
                batch.append(row)
                if len(batch) >= BATCH_ROWS:
                    writer.write_table(pa.Table.from_pylist(batch, schema=schema))
                    batch.clear()
                    progress = 0.35 + 0.55 * (processed_bytes / max(input_size, 1))
                    await report("normalizing", progress)
                    await asyncio.sleep(0)
            if batch:
                writer.write_table(pa.Table.from_pylist(batch, schema=schema))
            if cancelled():
                raise asyncio.CancelledError
        writer.close()
    except BaseException:
        writer.close()
        partial_parquet.unlink(missing_ok=True)
        raise
    partial_parquet.replace(parquet_path)
    if cancelled():
        parquet_path.unlink(missing_ok=True)
        raise asyncio.CancelledError

    parquet_checksum = hashlib.sha256()
    with parquet_path.open("rb") as parquet_file:
        for chunk in iter(lambda: parquet_file.read(1024 * 1024), b""):
            parquet_checksum.update(chunk)
    manifest = {
        "version": "1.0.0",
        "fingerprint": fingerprint,
        "inputRowCount": input_rows,
        "rowCount": active_rows,
        "columns": [
            {
                "sourceField": item.source_name,
                "physicalName": item.physical_name,
                "type": item.kind,
                "nullCount": item.null_count,
                "originalStringCount": item.string_count,
                "jsonValueCount": item.json_count,
            }
            for item in ordered_profiles
        ],
        "warnings": warnings,
        "parquet": {
            "artifactRef": "snapshot.parquet",
            "size": parquet_path.stat().st_size,
            "checksum": parquet_checksum.hexdigest(),
        },
    }
    manifest_path = workspace / "schema-manifest.json"
    partial_manifest = workspace / ".schema-manifest.json.partial"
    partial_manifest.write_bytes(orjson.dumps(manifest, option=orjson.OPT_SORT_KEYS))
    partial_manifest.replace(manifest_path)
    await report("persisting", 0.95)
    return {
        "parquetArtifactRef": "snapshot.parquet",
        "manifestArtifactRef": "schema-manifest.json",
        "rowCount": active_rows,
        "warnings": warnings,
    }
