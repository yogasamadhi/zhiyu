"""Produce real Worker results for the shared TypeScript contract regression."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import orjson
from pydantic import ValidationError
from test_cleaning import FIXTURES, parameters, records, report, snapshot

from zhiyun_analytics_worker.cleaning import clean_snapshot
from zhiyun_analytics_worker.models import CleaningParameters


async def main() -> None:
    output = {"version": FIXTURES["version"], "cases": [], "vectors": []}
    with TemporaryDirectory(prefix="zhiyun-cleaning-contract-") as root:
        for case in FIXTURES["cases"]:
            workspace = Path(root) / case["id"]
            source = await snapshot(workspace, case["rows"])
            before = source.read_bytes(), (workspace / "schema-manifest.json").read_bytes()
            params = parameters(case["steps"])
            result = await clean_snapshot(source, workspace, params, report)
            output["cases"].append(
                {
                    "id": case["id"],
                    "parameters": CleaningParameters.model_validate(params).model_dump(mode="json"),
                    "result": result,
                    "records": records(workspace, result),
                    "sourceUnchanged": before
                    == (source.read_bytes(), (workspace / "schema-manifest.json").read_bytes()),
                }
            )
    for vector in orjson.loads(sys.stdin.buffer.read()):
        try:
            normalized = CleaningParameters.model_validate(vector).model_dump(mode="json")
            output["vectors"].append({"accepted": True, "parameters": normalized})
        except ValidationError:
            output["vectors"].append({"accepted": False})
    sys.stdout.buffer.write(orjson.dumps(output))


asyncio.run(main())
