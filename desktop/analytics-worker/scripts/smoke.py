from __future__ import annotations

import json
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[1]
system = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}.get(
    platform.system(), platform.system().lower()
)
architecture = "arm64" if platform.machine().lower() in {"arm64", "aarch64"} else "x64"
executable_name = "analytics-worker.exe" if system == "windows" else "analytics-worker"
default_executable = (
    root / "dist" / f"{system}-{architecture}" / "analytics-worker" / executable_name
)
executable = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else default_executable
if not executable.is_file():
    raise SystemExit(f"Packaged Worker executable not found: {executable}")

token = "smoke-token-" + "x" * 48


def request_json(url: str, headers: dict[str, str], body: dict[str, object] | None = None):
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    request_headers = {**headers, **({"Content-Type": "application/json"} if payload else {})}
    request = Request(
        url, headers=request_headers, data=payload, method="POST" if payload else "GET"
    )
    with urlopen(request, timeout=10) as response:
        return response.status, json.load(response)


with tempfile.TemporaryDirectory(prefix="zhiyun-worker-smoke-") as workspace:
    process = subprocess.Popen(
        [str(executable)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(
        json.dumps({"token": token, "generation": 1, "workspaceRoot": workspace}) + "\n"
    )
    process.stdin.close()
    ready = json.loads(process.stdout.readline())
    headers = {"Authorization": f"Bearer {token}"}
    status, health = request_json(f"{ready['baseUrl']}/health", headers)
    if status != 200 or health != {"status": "ok"}:
        raise RuntimeError("Packaged Worker health response was invalid")

    job_id = "packaged-normalize-smoke"
    job_workspace = Path(workspace) / job_id
    job_workspace.mkdir()
    (job_workspace / "input.ndjson").write_text(
        "\n".join(
            json.dumps(
                {
                    "recordKey": f"smoke-record-{index}",
                    "sourceUrl": f"https://example.test/smoke/{index}",
                    "contentHash": f"{index:064x}",
                    "removed": False,
                    "data": {
                        "value": value,
                        "capturedAt": f"2026-08-2{index}T00:00:00Z",
                        "title": "知云语料" if index < 3 else "ZhiYun corpus",
                        "body": (
                            "中文数据清洗。" * 40
                            if index < 3
                            else "A packaged bilingual corpus sentence. " * 20
                        ),
                    },
                }
            )
            for index, value in enumerate((10, 20, 30, 40), start=1)
        )
        + "\n",
        encoding="utf-8",
    )
    status, job = request_json(
        f"{ready['baseUrl']}/worker/v1/jobs",
        headers,
        {
            "jobId": job_id,
            "methodId": "dataset.normalize_snapshot",
            "methodVersion": "1.0.0",
            "inputArtifactRef": "input.ndjson",
            "outputArtifactRef": "normalize-result.json",
            "parameters": {"fingerprint": "b" * 64},
        },
    )
    if status != 202:
        raise RuntimeError("Packaged Worker rejected Snapshot normalization")
    deadline = time.monotonic() + 30
    while job["state"] not in {"succeeded", "failed", "canceled"}:
        if time.monotonic() >= deadline:
            raise RuntimeError("Packaged Worker Snapshot smoke exceeded its budget")
        time.sleep(0.05)
        _, job = request_json(f"{ready['baseUrl']}/worker/v1/jobs/{job_id}", headers)
    if job["state"] != "succeeded":
        raise RuntimeError(f"Packaged Worker Snapshot smoke failed: {job}")
    if not (job_workspace / "snapshot.parquet").read_bytes().startswith(b"PAR1"):
        raise RuntimeError("Packaged Worker did not create a valid Parquet Artifact")
    if not (job_workspace / "schema-manifest.json").is_file():
        raise RuntimeError("Packaged Worker did not create a Snapshot manifest")

    analysis_job_id = "packaged-analysis-smoke"
    analysis_workspace = Path(workspace) / analysis_job_id
    analysis_workspace.mkdir()
    shutil.copyfile(job_workspace / "snapshot.parquet", analysis_workspace / "snapshot.parquet")
    status, analysis_job = request_json(
        f"{ready['baseUrl']}/worker/v1/jobs",
        headers,
        {
            "jobId": analysis_job_id,
            "methodId": "stats.descriptive",
            "methodVersion": "1.0.0",
            "inputArtifactRef": "snapshot.parquet",
            "outputArtifactRef": "analysis-result.json",
            "parameters": {"fields": ["value"]},
        },
    )
    if status != 202:
        raise RuntimeError("Packaged Worker rejected descriptive analysis")
    deadline = time.monotonic() + 30
    while analysis_job["state"] not in {"succeeded", "failed", "canceled"}:
        if time.monotonic() >= deadline:
            raise RuntimeError("Packaged Worker analysis smoke exceeded its budget")
        time.sleep(0.05)
        _, analysis_job = request_json(
            f"{ready['baseUrl']}/worker/v1/jobs/{analysis_job_id}", headers
        )
    if analysis_job["state"] != "succeeded":
        raise RuntimeError(f"Packaged Worker analysis smoke failed: {analysis_job}")
    analysis_result = json.loads(
        (analysis_workspace / "analysis-result.json").read_text(encoding="utf-8")
    )
    descriptive_rows = analysis_result.get("tables", [{}])[0].get("rows", [])
    if not descriptive_rows or descriptive_rows[0].get("mean") != 25:
        raise RuntimeError("Packaged Worker returned an invalid descriptive result")

    corpus_job_id = "packaged-corpus-smoke"
    corpus_workspace = Path(workspace) / corpus_job_id
    corpus_workspace.mkdir()
    shutil.copyfile(job_workspace / "snapshot.parquet", corpus_workspace / "snapshot.parquet")
    status, corpus_job = request_json(
        f"{ready['baseUrl']}/worker/v1/jobs",
        headers,
        {
            "jobId": corpus_job_id,
            "methodId": "corpus.build",
            "methodVersion": "1.0.0",
            "inputArtifactRef": "snapshot.parquet",
            "outputArtifactRef": "corpus-result.json",
            "parameters": {
                "datasetId": "11111111-1111-4111-8111-111111111111",
                "snapshotId": "22222222-2222-4222-8222-222222222222",
                "snapshotFingerprint": "b" * 64,
                "sourceRunId": None,
                "recipeId": "33333333-3333-4333-8333-333333333333",
                "recipeRevision": 1,
                "selectedTextFields": ["title", "body"],
                "metadataFields": ["value"],
                "stripHtml": True,
                "unicodeNormalization": "NFKC",
                "deduplication": "exact-and-near",
                "nearDuplicateThreshold": 0.9,
                "chunkSize": 200,
                "chunkOverlap": 20,
                "languagePolicy": "zh-en-first",
                "outputFormats": ["parquet", "jsonl"],
            },
        },
    )
    if status != 202:
        raise RuntimeError("Packaged Worker rejected Corpus build")
    deadline = time.monotonic() + 30
    while corpus_job["state"] not in {"succeeded", "failed", "canceled"}:
        if time.monotonic() >= deadline:
            raise RuntimeError("Packaged Worker Corpus smoke exceeded its budget")
        time.sleep(0.05)
        _, corpus_job = request_json(f"{ready['baseUrl']}/worker/v1/jobs/{corpus_job_id}", headers)
    if corpus_job["state"] != "succeeded":
        raise RuntimeError(f"Packaged Worker Corpus smoke failed: {corpus_job}")
    corpus_result = json.loads(
        (corpus_workspace / "corpus-result.json").read_text(encoding="utf-8")
    )
    if corpus_result.get("manifest", {}).get("documentCount") != 2:
        raise RuntimeError("Packaged Worker returned invalid Corpus deduplication statistics")
    for filename in ("documents.parquet", "chunks.parquet"):
        if not (corpus_workspace / filename).read_bytes().startswith(b"PAR1"):
            raise RuntimeError(f"Packaged Worker did not create valid {filename}")
    for filename in ("corpus.jsonl", "manifest.json"):
        if not (corpus_workspace / filename).is_file():
            raise RuntimeError(f"Packaged Worker did not create {filename}")

    with urlopen(
        Request(f"{ready['baseUrl']}/worker/v1/shutdown", headers=headers, method="POST"),
        timeout=5,
    ) as response:
        if response.status != 202:
            raise RuntimeError("Packaged Worker rejected shutdown")
    deadline = time.monotonic() + 10
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if process.poll() is None:
        process.kill()
        raise RuntimeError("Packaged Worker exceeded shutdown budget")
    if process.returncode != 0:
        assert process.stderr is not None
        raise RuntimeError(process.stderr.read())

print(json.dumps({"status": "ok", "executable": str(executable)}))
