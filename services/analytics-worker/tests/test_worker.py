from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from hypothesis import given, strategies as st
from httpx import ASGITransport, AsyncClient

from zhiyun_analytics_worker.app import create_app
from zhiyun_analytics_worker.security import WorkspaceViolation, validate_artifact_ref

TOKEN = "test-token-" + "x" * 40


@pytest.fixture
async def client(tmp_path: Path):
    app = create_app(TOKEN, 7, tmp_path)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://worker"
    ) as http:
        yield http
    await app.state.worker.jobs.close()


def auth() -> dict[str, str]:
    return {"authorization": f"Bearer {TOKEN}"}


@pytest.mark.asyncio
async def test_requires_private_token(client: AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_reports_version_and_safe_capabilities(client: AsyncClient) -> None:
    response = await client.get("/worker/v1/version", headers=auth())
    assert response.status_code == 200
    assert response.json()["generation"] == 7
    capabilities = (await client.get("/worker/v1/capabilities", headers=auth())).json()
    assert capabilities["externalNetwork"] is False
    assert capabilities["arbitraryCodeExecution"] is False
    methods = await client.get("/worker/v1/methods", headers=auth())
    assert methods.json() == []


@pytest.mark.parametrize(
    "reference",
    ["../secret", "/etc/passwd", "a/../../secret", r"C:\\secret", r"a\\b"],
)
def test_rejects_artifact_path_traversal(reference: str) -> None:
    with pytest.raises(WorkspaceViolation):
        validate_artifact_ref(reference)


@given(st.text(min_size=0, max_size=128))
def test_parent_prefixed_artifact_refs_are_always_rejected(suffix: str) -> None:
    with pytest.raises(WorkspaceViolation):
        validate_artifact_ref(f"../{suffix}")


@pytest.mark.asyncio
async def test_runs_idempotent_internal_self_test(client: AsyncClient) -> None:
    submission = {
        "jobId": "job-1",
        "methodId": "worker.self_test",
        "methodVersion": "1.0.0",
        "outputArtifactRef": "results/result.json",
        "parameters": {"echo": "hello"},
    }
    first = await client.post("/worker/v1/jobs", headers=auth(), json=submission)
    duplicate = await client.post("/worker/v1/jobs", headers=auth(), json=submission)
    assert first.status_code == 202
    assert duplicate.status_code == 202
    for _attempt in range(100):
        job = (await client.get("/worker/v1/jobs/job-1", headers=auth())).json()
        if job["state"] == "succeeded":
            break
        await asyncio.sleep(0.01)
    assert job["state"] == "succeeded"
    assert duplicate.json()["id"] == job["id"]


@pytest.mark.asyncio
async def test_rejects_reused_job_id_with_different_payload(client: AsyncClient) -> None:
    original = {
        "jobId": "job-conflict",
        "methodId": "worker.self_test",
        "methodVersion": "1.0.0",
        "parameters": {"echo": "first"},
    }
    assert (await client.post("/worker/v1/jobs", headers=auth(), json=original)).status_code == 202
    response = await client.post(
        "/worker/v1/jobs",
        headers=auth(),
        json={**original, "parameters": {"echo": "second"}},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "ANALYSIS_JOB_CONFLICT"


@pytest.mark.asyncio
async def test_cancel_becomes_visible_within_two_seconds(client: AsyncClient) -> None:
    submission = {
        "jobId": "job-cancel",
        "methodId": "worker.self_test",
        "methodVersion": "1.0.0",
        "parameters": {"delayMs": 5000},
    }
    assert (await client.post("/worker/v1/jobs", headers=auth(), json=submission)).status_code == 202
    await asyncio.sleep(0)
    started = asyncio.get_running_loop().time()
    response = await client.post("/worker/v1/jobs/job-cancel/cancel", headers=auth())
    assert response.status_code == 202
    assert response.json()["state"] == "canceling"
    while asyncio.get_running_loop().time() - started < 2:
        job = (await client.get("/worker/v1/jobs/job-cancel", headers=auth())).json()
        if job["state"] == "canceled":
            break
        await asyncio.sleep(0.01)
    assert job["state"] == "canceled"
