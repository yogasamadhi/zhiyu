from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any

import orjson
import pyarrow.parquet as pq
import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from zhiyun_analytics_worker import cleaning
from zhiyun_analytics_worker.app import create_app
from zhiyun_analytics_worker.cleaning import (
    CleaningResourceError,
    CleaningValidationError,
    clean_snapshot,
    json_value,
)
from zhiyun_analytics_worker.models import CleaningParameters
from zhiyun_analytics_worker.normalization import normalize_snapshot

FIXTURES = orjson.loads(
    (Path(__file__).parents[2] / "tooling/evaluations/cleaning-fixtures.json").read_bytes()
)
FINGERPRINT = "a" * 64
TOKEN = "cleaning-fixture-" + "x" * 40


async def report(_phase: str, _progress: float) -> None:
    pass


async def snapshot(
    workspace: Path, rows: list[dict[str, Any]], fingerprint: str = FINGERPRINT
) -> Path:
    await asyncio.to_thread(workspace.mkdir, exist_ok=True)
    source = workspace / "input.ndjson"
    source.write_bytes(
        b"".join(
            orjson.dumps(
                {
                    "recordKey": str(index),
                    "sourceUrl": f"http://127.0.0.1/fixture/{index}",
                    "data": row,
                    "removed": False,
                }
            )
            + b"\n"
            for index, row in enumerate(rows)
        )
    )
    await normalize_snapshot(source, workspace, {"fingerprint": fingerprint}, report)
    return workspace / "snapshot.parquet"


def parameters(steps: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "fingerprint": FINGERPRINT,
        "manifestArtifactRef": "schema-manifest.json",
        "steps": steps,
        **extra,
    }


def records(workspace: Path, result: dict[str, Any]) -> list[dict[str, Any]]:
    manifest = orjson.loads((workspace / result["manifestArtifactRef"]).read_bytes())
    return [
        {
            column["sourceField"]: json_value(row[column["physicalName"]])
            for column in manifest["columns"]
        }
        for row in pq.read_table(workspace / result["parquetArtifactRef"]).to_pylist()
    ]


def owned_paths(workspace: Path, pattern: str = "cleaning-*") -> list[Path]:
    return list(workspace.glob(pattern))


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["id"])
async def test_cleaning_golden_preserves_source(tmp_path: Path, case: dict[str, Any]) -> None:
    source = await snapshot(tmp_path, case["rows"])
    original = source.read_bytes(), (tmp_path / "schema-manifest.json").read_bytes()
    result = await clean_snapshot(source, tmp_path, parameters(case["steps"]), report)
    assert records(tmp_path, result) == case["expected"]
    assert result["inputFingerprint"] == FINGERPRINT
    assert result["fingerprint"] != FINGERPRINT
    assert result["inputRowCount"] == len(case["rows"])
    assert result["rowCount"] == len(case["expected"])
    assert result["steps"][0]["errorRowCount"] == case["errorRows"]
    assert result["steps"][0]["removedRowCount"] == case["removedRows"]
    assert result["steps"][0]["inputFingerprint"] == FINGERPRINT
    assert (source.read_bytes(), (tmp_path / "schema-manifest.json").read_bytes()) == original


@pytest.mark.parametrize("step", FIXTURES["invalidSteps"])
def test_arbitrary_execution_and_invalid_steps_are_rejected(step: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        CleaningParameters.model_validate(parameters([step]))


async def test_ordered_pipeline_reuse_and_immutable_intermediates(tmp_path: Path) -> None:
    steps = [
        {"type": "trim", "fields": ["value"]},
        {"type": "normalize_null", "fields": ["value"]},
        {"type": "convert", "fields": ["value"], "targetType": "number"},
        {"type": "dedupe", "fields": ["value"]},
    ]
    first = tmp_path / "first"
    source = await snapshot(first, [{"value": v} for v in [" 1 ", "1", "N/A", "bad"]])
    recipe = parameters(steps, expectedFields={"value": "string"})
    result = await clean_snapshot(source, first, recipe, report)
    assert records(first, result) == [{"value": 1}, {"value": None}]
    assert [step["rowCount"] for step in result["steps"]] == [4, 4, 4, 2]
    assert result["steps"][2]["errorRowCount"] == 1
    assert result["steps"][1]["outputQuality"]["fields"]["value"]["nullCount"] == 1
    parent = FINGERPRINT
    preserved = {}
    for step in result["steps"]:
        assert step["inputFingerprint"] == parent
        parent = step["fingerprint"]
        for key in ["parquetArtifactRef", "manifestArtifactRef"]:
            path = first / step[key]
            preserved[path] = hashlib.sha256(path.read_bytes()).hexdigest()
    # Earlier artifacts remain readable; dataset-level undo/redo is tested at its API boundary.
    assert len(records(first, result["steps"][2])) == 4
    assert len(records(first, result["steps"][3])) == 2
    second = tmp_path / "second"
    other_source = await snapshot(second, [{"value": v} for v in [" 9 ", "9", "10"]], "b" * 64)
    other = await clean_snapshot(other_source, second, {**recipe, "fingerprint": "b" * 64}, report)
    assert records(second, other) == [{"value": 9}, {"value": 10}]
    assert other["inputFingerprint"] == "b" * 64
    assert other["fingerprint"] != result["fingerprint"]
    repeated = await clean_snapshot(source, first, recipe, report)
    assert [step["fingerprint"] for step in repeated["steps"]] == [
        step["fingerprint"] for step in result["steps"]
    ]
    assert all(
        hashlib.sha256(path.read_bytes()).hexdigest() == digest
        for path, digest in preserved.items()
    )


@pytest.mark.parametrize(
    "steps,expected",
    [
        ([{"type": "trim", "fields": ["missing"]}], {}),
        ([{"type": "trim", "fields": ["value"]}], {"value": "string"}),
        ([{"type": "split", "field": "value", "delimiter": ",", "targets": ["a", "b"]}], {}),
    ],
)
async def test_incompatible_recipe_rejected_before_outputs(
    tmp_path: Path, steps: list[dict[str, Any]], expected: dict[str, str]
) -> None:
    source = await snapshot(tmp_path, [{"value": 1}])
    with pytest.raises(CleaningValidationError):
        await clean_snapshot(source, tmp_path, parameters(steps, expectedFields=expected), report)
    assert not owned_paths(tmp_path)


async def test_numeric_family_reuse_and_zero_step_quality(tmp_path: Path) -> None:
    source = await snapshot(tmp_path, [{"value": 1.5}, {"value": None}])
    result = await clean_snapshot(
        source, tmp_path, parameters([], expectedFields={"value": "int"}), report
    )
    assert result["steps"] == []
    assert result["fingerprint"] == FINGERPRINT
    assert result["parquetArtifactRef"] == "snapshot.parquet"
    assert result["outputQuality"]["fields"]["value"]["nullCount"] == 1
    assert not owned_paths(tmp_path)


async def test_failure_and_cancellation_clean_only_owned_outputs(tmp_path: Path) -> None:
    source = await snapshot(tmp_path, [{"value": "bad"}])
    original = source.read_bytes()
    keep = tmp_path / "keep.json"
    keep.write_bytes(b"unrelated")
    with pytest.raises(CleaningValidationError):
        await clean_snapshot(
            source,
            tmp_path,
            parameters(
                [
                    {
                        "type": "convert",
                        "fields": ["value"],
                        "targetType": "number",
                        "onError": "fail",
                    }
                ]
            ),
            report,
        )

    async def cancel(phase: str, _progress: float) -> None:
        if phase == "cleaning":
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await clean_snapshot(
            source, tmp_path, parameters([{"type": "trim", "fields": ["value"]}]), cancel
        )
    assert source.read_bytes() == original
    assert keep.read_bytes() == b"unrelated"
    assert not owned_paths(tmp_path)


async def test_facets_and_previews_expose_bounds(tmp_path: Path) -> None:
    source = await snapshot(tmp_path, [{"value": f"{i}:" + "x" * 600} for i in range(60)])
    result = await clean_snapshot(
        source,
        tmp_path,
        parameters([{"type": "trim", "fields": ["value"]}], facetLimit=3, previewLimit=2),
        report,
    )
    profile = result["outputQuality"]["fields"]["value"]
    assert profile["trackedDistinctCount"] == 50
    assert profile["otherCount"] == 10
    assert profile["omittedTrackedCount"] == 47
    assert profile["facetScope"] == "first-50-distinct-values"
    assert len(profile["facets"]) == 3
    assert all(facet["valueTruncated"] for facet in profile["facets"])
    preview = result["steps"][0]["preview"]
    assert len(preview) == 2
    assert preview[0]["afterTruncatedFields"] == ["value"]
    assert len(preview[0]["after"]["value"]) == 500


async def test_dedupe_across_batches_preserves_first_provenance(tmp_path: Path) -> None:
    source = await snapshot(tmp_path, [{"key": i % 7} for i in range(4100)])
    result = await clean_snapshot(
        source, tmp_path, parameters([{"type": "dedupe", "fields": ["key"]}]), report
    )
    assert records(tmp_path, result) == [{"key": i} for i in range(7)]
    assert pq.read_table(tmp_path / result["parquetArtifactRef"]).column(
        "__zhiyun_record_key"
    ).to_pylist() == [str(i) for i in range(7)]
    assert result["steps"][0]["removedRowCount"] == 4093
    assert not owned_paths(tmp_path, "cleaning-*/.seen.sqlite")


async def test_output_resource_limit_cleans_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = await snapshot(tmp_path, [{"value": " data "}])
    original = source.read_bytes()
    monkeypatch.setattr(cleaning, "MAX_OUTPUT_BYTES", 1)
    with pytest.raises(CleaningResourceError):
        await clean_snapshot(
            source, tmp_path, parameters([{"type": "trim", "fields": ["value"]}]), report
        )
    assert source.read_bytes() == original
    assert not owned_paths(tmp_path)


async def test_manifest_checksum_is_verified(tmp_path: Path) -> None:
    source = await snapshot(tmp_path, [{"value": "data"}])
    manifest_path = tmp_path / "schema-manifest.json"
    manifest = orjson.loads(manifest_path.read_bytes())
    manifest["parquet"]["checksum"] = "0" * 64
    manifest_path.write_bytes(orjson.dumps(manifest))
    with pytest.raises(CleaningValidationError, match="checksum"):
        await clean_snapshot(source, tmp_path, parameters([]), report)


async def test_zero_step_report_bound_and_initialization_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = await snapshot(tmp_path, [{"value": " data "}])
    original = source.read_bytes()
    with monkeypatch.context() as patch:
        patch.setattr(cleaning, "MAX_REPORT_BYTES", 1)
        with pytest.raises(CleaningResourceError, match="report"):
            await clean_snapshot(source, tmp_path, parameters([]), report)

    def fail_connection(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("fixture SQLite initialization failure")

    monkeypatch.setattr(cleaning.sqlite3, "connect", fail_connection)
    with pytest.raises(OSError, match="initialization failure"):
        await clean_snapshot(
            source, tmp_path, parameters([{"type": "trim", "fields": ["value"]}]), report
        )
    assert not owned_paths(tmp_path)
    assert source.read_bytes() == original


async def test_malformed_manifest_and_normalized_json_provenance(tmp_path: Path) -> None:
    source = await snapshot(tmp_path, [{"value": " text ", "nested": {"a": 1}}])
    result = await clean_snapshot(
        source, tmp_path, parameters([{"type": "trim", "fields": ["value"]}]), report
    )
    assert records(tmp_path, result) == [{"value": "text", "nested": '{"a":1}'}]
    manifest = orjson.loads((tmp_path / result["manifestArtifactRef"]).read_bytes())
    nested = next(column for column in manifest["columns"] if column["sourceField"] == "nested")
    assert nested["originalStringCount"] is None
    assert nested["jsonValueCount"] is None
    assert nested["stringCount"] == 1
    original_path = tmp_path / "schema-manifest.json"
    malformed = orjson.loads(original_path.read_bytes())
    malformed["parquet"] = []
    original_path.write_bytes(orjson.dumps(malformed))
    with pytest.raises(CleaningValidationError, match="checksum"):
        await clean_snapshot(source, tmp_path, parameters([]), report)


async def test_http_validation_execution_and_symlink_overwrite_guard(tmp_path: Path) -> None:
    for job_id, alias in [("cleaning-http", False), ("cleaning-alias", True)]:
        workspace = tmp_path / job_id
        source = await snapshot(workspace, [{"value": " 10 "}, {"value": "bad"}])
        original = source.read_bytes()
        if alias:
            (workspace / "alias.json").symlink_to(source)
        app = create_app(TOKEN, 1, tmp_path)
        auth = {"authorization": f"Bearer {TOKEN}"}
        submission = {
            "jobId": job_id,
            "methodId": "dataset.clean_snapshot",
            "methodVersion": "1.0.0",
            "inputArtifactRef": "snapshot.parquet",
            "outputArtifactRef": "alias.json" if alias else "result.json",
            "parameters": parameters(
                [
                    {"type": "trim", "fields": ["value"]},
                    {"type": "convert", "fields": ["value"], "targetType": "number"},
                ]
            ),
        }
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://worker"
            ) as client:
                invalid = await client.post(
                    "/worker/v1/jobs",
                    headers=auth,
                    json={
                        **submission,
                        "parameters": parameters([{"type": "python", "code": "print(1)"}]),
                    },
                )
                assert invalid.status_code == 422
                response = await client.post("/worker/v1/jobs", headers=auth, json=submission)
                assert response.status_code == 202, response.text
                for _attempt in range(200):
                    job = (await client.get(f"/worker/v1/jobs/{job_id}", headers=auth)).json()
                    if job["state"] in {"succeeded", "failed", "canceled"}:
                        break
                    await asyncio.sleep(0.01)
                assert job["state"] == ("failed" if alias else "succeeded"), job
                if alias:
                    assert job["error"]["code"] == "INVALID_INPUT"
                    assert not list(workspace.glob("cleaning-*"))
                else:
                    assert records(
                        workspace, orjson.loads((workspace / "result.json").read_bytes())
                    ) == [{"value": 10}, {"value": None}]
                assert source.read_bytes() == original
        finally:
            await app.state.worker.jobs.close()
