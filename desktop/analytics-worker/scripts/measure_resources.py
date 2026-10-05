"""Measure only the owned Python Worker; keep this separate from HTTP Runtime RSS."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import queue
import secrets
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen

import pyarrow.parquet as pq


def fixture_row(index: int) -> dict:
    item = {
        "recordKey": f"record-{index}",
        "sourceUrl": f"http://127.0.0.1/fixture/{index}",
        "contentHash": hashlib.sha256(str(index).encode()).hexdigest(),
        "removed": False,
        "data": {"value": index, "payload": ""},
    }
    item["data"]["payload"] = "x" * (1023 - len(json.dumps(item, separators=(",", ":"))))
    return item


def rss(pid: int) -> int:
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "rss="], capture_output=True, text=True, check=True
    )
    return int(result.stdout.strip()) * 1024


class Sampler:
    def __init__(self, pid: int):
        self.pid = pid
        self.baseline = rss(pid)
        self.peak = self.baseline
        self.samples = 1
        self.errors: list[Exception] = []
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.done.wait(0.025):
            try:
                self.peak = max(self.peak, rss(self.pid))
                self.samples += 1
            except Exception as error:
                self.errors.append(error)
                return

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.done.set()
        self.thread.join(timeout=5)
        if self.thread.is_alive() or self.errors:
            raise RuntimeError("Owned Worker RSS sampling did not finish normally")
        self.peak = max(self.peak, rss(self.pid))
        self.samples += 1

    def result(self, elapsed: float) -> dict:
        return {
            "baselineRssBytes": self.baseline,
            "peakRssBytes": self.peak,
            "incrementalPeakRssBytes": self.peak - self.baseline,
            "samples": self.samples,
            "elapsedMs": elapsed * 1000,
        }


def environment() -> dict[str, str]:
    values = {}
    for name in (
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
    ):
        if name in os.environ:
            values[name] = os.environ[name]
    return {**values, "ZHIYUN_WORKER_EXTERNAL_NETWORK": "disabled", "PYTHONUNBUFFERED": "1"}


def request_json(base: str, token: str, path: str, body: dict | None = None):
    payload = json.dumps(body).encode() if body is not None else None
    request = Request(
        base + path,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        data=payload,
        method="POST" if body is not None else "GET",
    )
    with urlopen(request, timeout=10) as response:
        return response.status, json.load(response)


def run_job(base: str, token: str, body: dict) -> float:
    started = time.perf_counter()
    status, job = request_json(base, token, "/worker/v1/jobs", body)
    if status != 202:
        raise RuntimeError("Worker rejected local resource fixture")
    deadline = time.monotonic() + 120
    while job["state"] not in {"succeeded", "failed", "canceled"}:
        if time.monotonic() >= deadline:
            raise TimeoutError("Worker job exceeded 120 seconds")
        time.sleep(0.025)
        _, job = request_json(base, token, f"/worker/v1/jobs/{body['jobId']}")
    if job["state"] != "succeeded":
        raise RuntimeError(f"Local {body['methodId']} failed: {job.get('error')}")
    return time.perf_counter() - started


def verify_snapshot(path: Path, count: int):
    parquet = pq.ParquetFile(path)
    if parquet.metadata.num_rows != count:
        raise RuntimeError("Parquet record count differs from the complete fixture")
    seen = bytearray(count)
    visited = 0
    for batch in parquet.iter_batches(batch_size=500):
        for row in batch.to_pylist():
            index = row["value"]
            if not isinstance(index, int) or not 0 <= index < count or seen[index]:
                raise RuntimeError("Snapshot has missing, invalid or repeated final records")
            seen[index] = 1
            expected = fixture_row(index)
            if (
                row["__zhiyun_record_key"] != expected["recordKey"]
                or row["__zhiyun_source_url"] != expected["sourceUrl"]
                or row["payload"] != expected["data"]["payload"]
            ):
                raise RuntimeError("Snapshot record content differs from the input fixture")
            visited += 1
    if visited != count or 0 in seen:
        raise RuntimeError("Snapshot did not contain every expected record")


def measure(count: int, iteration: int) -> dict:
    worker_root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="zhiyun-python-resources-") as temporary:
        root = Path(temporary)
        normalize = root / "normalize"
        normalize.mkdir()
        input_path = normalize / "input.ndjson"
        with input_path.open("wb") as target:
            for index in range(count):
                raw = json.dumps(fixture_row(index), separators=(",", ":")).encode() + b"\n"
                if len(raw) != 1024:
                    raise RuntimeError("Each input record must be exactly 1024 bytes")
                target.write(raw)
        token = secrets.token_hex(32)
        process = subprocess.Popen(
            [sys.executable, "-m", "zhiyun_analytics_worker"],
            cwd=worker_root,
            env={**environment(), "TMPDIR": temporary, "TMP": temporary, "TEMP": temporary},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert process.stdin is not None and process.stdout is not None
        assert process.stderr is not None
        ready_lines: queue.Queue[str] = queue.Queue()
        reader = threading.Thread(
            target=lambda: ready_lines.put(process.stdout.readline()), daemon=True
        )
        reader.start()

        # Drain logs without retaining or printing private bootstrap/session material.
        def drain_stderr():
            for _line in process.stderr:
                pass

        stderr = threading.Thread(target=drain_stderr, daemon=True)
        stderr.start()
        try:
            process.stdin.write(
                json.dumps({"token": token, "generation": 1, "workspaceRoot": temporary}) + "\n"
            )
            process.stdin.close()
            ready = json.loads(ready_lines.get(timeout=30))
            if ready.get("pid") != process.pid or ready.get("type") != "ready":
                raise RuntimeError("Worker readiness does not identify the owned process")
            base = ready["baseUrl"]
            if not base.startswith("http://127.0.0.1:"):
                raise RuntimeError("Worker must bind the local fixture only")
            _, health = request_json(base, token, "/health")
            if health != {"status": "ok"}:
                raise RuntimeError("Worker health is not ready")
            with Sampler(process.pid) as normalize_memory:
                normalize_elapsed = run_job(
                    base,
                    token,
                    {
                        "jobId": "normalize",
                        "methodId": "dataset.normalize_snapshot",
                        "methodVersion": "1.0.0",
                        "inputArtifactRef": "input.ndjson",
                        "outputArtifactRef": "result.json",
                        "parameters": {"fingerprint": "b" * 64},
                    },
                )
            verify_snapshot(normalize / "snapshot.parquet", count)
            manifest = json.loads((normalize / "schema-manifest.json").read_text())
            if manifest["rowCount"] != count or manifest["warnings"]:
                raise RuntimeError("Snapshot manifest differs from the fixture")
            analysis = root / "analysis"
            analysis.mkdir()
            shutil.copyfile(normalize / "snapshot.parquet", analysis / "snapshot.parquet")
            with Sampler(process.pid) as analysis_memory:
                analysis_elapsed = run_job(
                    base,
                    token,
                    {
                        "jobId": "analysis",
                        "methodId": "stats.descriptive",
                        "methodVersion": "1.0.0",
                        "inputArtifactRef": "snapshot.parquet",
                        "outputArtifactRef": "result.json",
                        "parameters": {"fields": ["value"]},
                    },
                )
            result = json.loads((analysis / "result.json").read_text())
            stats = result["tables"][0]["rows"][0]
            for name, expected in {
                "count": count,
                "mean": (count - 1) / 2,
                "min": 0,
                "max": count - 1,
            }.items():
                if stats[name] != expected:
                    raise RuntimeError(f"Descriptive {name} differs from the complete fixture")
            request_json(base, token, "/worker/v1/shutdown", {})
            if process.wait(timeout=30) != 0:
                raise RuntimeError("Worker did not shut down normally")
            return {
                "count": count,
                "iteration": iteration,
                "recordBytes": 1024,
                "workerPid": process.pid,
                "inputBytes": input_path.stat().st_size,
                "normalize": normalize_memory.result(normalize_elapsed),
                "analysis": analysis_memory.result(analysis_elapsed),
                "allRecordsVerified": True,
                "analysisVerified": True,
                "exitCode": 0,
            }
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=30)
            reader.join(timeout=5)
            stderr.join(timeout=5)


def main():
    if len(sys.argv) != 2 or platform.system() == "Windows":
        raise SystemExit(
            "Usage (macOS/Linux): python scripts/measure_resources.py <run-artifact-dir>"
        )
    output = Path(sys.argv[1]).resolve()
    expected = Path(__file__).resolve().parents[3] / ".artifacts" / "no-credentials-optimization"
    if not output.is_relative_to(expected) or output == expected:
        raise SystemExit("Output must be inside the owned optimization artifact directory")
    output.mkdir(parents=True, exist_ok=True)
    results = []
    with (output / "samples.jsonl").open("x") as ledger:
        for count in (10_000, 100_000):
            for iteration in (1, 2, 3):
                sample = measure(count, iteration)
                results.append(sample)
                ledger.write(json.dumps(sample) + "\n")
                ledger.flush()
                print(f"Python {count} rows, iteration {iteration}: verified", flush=True)
    medians = {}
    for count in (10_000, 100_000):
        samples = [item for item in results if item["count"] == count]
        medians[str(count)] = {
            phase: {
                key: statistics.median(item[phase][key] for item in samples)
                for key in samples[0][phase]
            }
            for phase in ("normalize", "analysis")
        }
    report = {
        "hardware": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "sourceHashes": {
            str(path.relative_to(Path(__file__).resolve().parents[3])): hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
            for path in [
                Path(__file__).resolve(),
                *(
                    Path(__file__).resolve().parents[1] / "src" / "zhiyun_analytics_worker" / name
                    for name in (
                        "normalization.py",
                        "analytics.py",
                        "main.py",
                        "jobs.py",
                        "models.py",
                    )
                ),
            ]
        },
        "scope": (
            "Actual Python Worker normalization and descriptive analysis, "
            "separate from HTTP Runtime/Node/Electron/browser memory."
        ),
        "sampling": (
            "Owned Worker PID ps RSS every 25ms; baseline after ready/health for normalization, "
            "and after normalization for analysis. Sampled peaks are lower bounds; no forced GC. "
            "Fresh Worker per sample. Input generated one exact 1024-byte row at a time; "
            "complete Parquet verified in 500-row batches after measurement, parent excluded."
        ),
        "samples": results,
        "medians": medians,
        "allVerified": True,
        "httpTargetComparison": (
            "Not applicable: these are independent Python phases, not the HTTP throughput/RSS gate."
        ),
    }
    with (output / "report.json").open("x") as target:
        target.write(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
