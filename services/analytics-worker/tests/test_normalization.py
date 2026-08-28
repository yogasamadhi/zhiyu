from __future__ import annotations

import asyncio
from pathlib import Path

import orjson
import pyarrow.parquet as pq
import pytest
from httpx import ASGITransport, AsyncClient

from zhiyun_analytics_worker import normalization
from zhiyun_analytics_worker.app import create_app
from zhiyun_analytics_worker.normalization import normalize_snapshot

TOKEN = "normalization-token-" + "x" * 40


def headers() -> dict[str, str]:
    return {"authorization": f"Bearer {TOKEN}"}


@pytest.mark.asyncio
async def test_streaming_normalizer_promotes_types_and_writes_parquet(tmp_path: Path) -> None:
    job_id = "normalize-1"
    workspace = tmp_path / job_id
    workspace.mkdir()
    records = [
        {
            "recordKey": "a",
            "sourceUrl": "https://example.test/a",
            "contentHash": "1" * 64,
            "removed": False,
            "data": {
                "number": 1,
                "date": "2026-01-01",
                "nested": {"z": 1},
                "conflict": 3,
            },
        },
        {
            "recordKey": "b",
            "sourceUrl": "https://example.test/b",
            "contentHash": "2" * 64,
            "removed": False,
            "data": {
                "number": 2.5,
                "date": "2026-01-02T03:04:05Z",
                "nested": [1, 2],
                "conflict": "three",
            },
        },
        {
            "recordKey": "removed",
            "sourceUrl": "https://example.test/removed",
            "contentHash": "3" * 64,
            "removed": True,
            "data": {"number": 99},
        },
    ]
    (workspace / "input.ndjson").write_bytes(
        b"".join(orjson.dumps(record) + b"\n" for record in records)
    )
    app = create_app(TOKEN, 1, tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://worker") as client:
        response = await client.post(
            "/worker/v1/jobs",
            headers=headers(),
            json={
                "jobId": job_id,
                "methodId": "dataset.normalize_snapshot",
                "methodVersion": "1.0.0",
                "inputArtifactRef": "input.ndjson",
                "outputArtifactRef": "normalize-result.json",
                "parameters": {"fingerprint": "a" * 64},
            },
        )
        assert response.status_code == 202
        for _attempt in range(200):
            job = (await client.get(f"/worker/v1/jobs/{job_id}", headers=headers())).json()
            if job["state"] in {"succeeded", "failed"}:
                break
            await asyncio.sleep(0.01)
    await app.state.worker.jobs.close()
    assert job["state"] == "succeeded", job
    table = pq.read_table(workspace / "snapshot.parquet")
    assert table.num_rows == 2
    assert str(table.schema.field("number").type) == "double"
    assert str(table.schema.field("date").type) == "timestamp[ms, tz=UTC]"
    manifest = orjson.loads((workspace / "schema-manifest.json").read_bytes())
    columns = {item["sourceField"]: item for item in manifest["columns"]}
    assert columns["nested"]["type"] == "string"
    assert columns["nested"]["jsonValueCount"] == 2
    assert columns["conflict"]["type"] == "string"
    assert manifest["rowCount"] == 2
    assert manifest["warnings"]


@pytest.mark.asyncio
async def test_snapshot_size_limit_uses_resource_error_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = "normalize-too-large"
    workspace = tmp_path / job_id
    workspace.mkdir()
    input_path = workspace / "input.ndjson"
    input_path.write_text("", encoding="utf-8")
    monkeypatch.setattr(normalization, "MAX_INPUT_BYTES", -1)
    app = create_app(TOKEN, 1, tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://worker") as client:
        response = await client.post(
            "/worker/v1/jobs",
            headers=headers(),
            json={
                "jobId": job_id,
                "methodId": "dataset.normalize_snapshot",
                "methodVersion": "1.0.0",
                "inputArtifactRef": "input.ndjson",
                "outputArtifactRef": "normalize-result.json",
                "parameters": {"fingerprint": "a" * 64},
            },
        )
        assert response.status_code == 202
        for _attempt in range(200):
            job = (await client.get(f"/worker/v1/jobs/{job_id}", headers=headers())).json()
            if job["state"] in {"succeeded", "failed"}:
                break
            await asyncio.sleep(0.01)
    await app.state.worker.jobs.close()
    assert job["state"] == "failed"
    assert job["error"]["code"] == "RESOURCE_LIMIT_EXCEEDED"


@pytest.mark.asyncio
async def test_canceled_normalization_removes_partial_parquet(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    input_path = tmp_path / "input.ndjson"
    input_path.write_bytes(
        orjson.dumps(
            {
                "recordKey": "cancel-me",
                "sourceUrl": "https://example.test/cancel",
                "contentHash": "c" * 64,
                "removed": False,
                "data": {"value": 1},
            }
        )
        + b"\n"
    )
    monkeypatch.setattr(normalization, "BATCH_ROWS", 1)

    async def cancel_during_write(phase: str, _progress: float) -> None:
        if phase == "normalizing":
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await normalize_snapshot(
            input_path,
            tmp_path,
            {"fingerprint": "d" * 64},
            cancel_during_write,
        )
    assert not (tmp_path / ".snapshot.parquet.partial").exists()
    assert not (tmp_path / "snapshot.parquet").exists()
