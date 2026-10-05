from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from zhiyun_analytics_worker.corpus import (
    CorpusValidationError,
    build_corpus,
    normalize_document,
    split_chunks,
)
from zhiyun_analytics_worker.methods import MethodRegistry


async def report(_phase: str, _progress: float) -> None:
    return None


@pytest.fixture
def snapshot(tmp_path: Path) -> Path:
    common = " ".join(f"token-{index}" for index in range(120))
    rows = [
        {
            "__zhiyun_record_key": "one",
            "__zhiyun_source_url": "https://example.test/1",
            "title": "<h1>知云 数据</h1>",
            "body": "中文语料。" * 80,
            "category": "zh",
        },
        {
            "__zhiyun_record_key": "two",
            "__zhiyun_source_url": "https://example.test/2",
            "title": "<h1>知云 数据</h1>",
            "body": "中文语料。" * 80,
            "category": "duplicate",
        },
        {
            "__zhiyun_record_key": "three",
            "__zhiyun_source_url": "https://example.test/3",
            "title": "English corpus",
            "body": common,
            "category": "en",
        },
        {
            "__zhiyun_record_key": "four",
            "__zhiyun_source_url": "https://example.test/4",
            "title": "English corpus changed",
            "body": f"{common} one-extra-token",
            "category": "near-duplicate",
        },
        {
            "__zhiyun_record_key": "five",
            "__zhiyun_source_url": "https://example.test/5",
            "title": "12345",
            "body": "😀 مرحبا بالعالم",
            "category": "other",
        },
    ]
    path = tmp_path / "snapshot.parquet"
    pq.write_table(pa.Table.from_pylist(rows), path)
    return path


def parameters() -> dict[str, Any]:
    return {
        "datasetId": "11111111-1111-4111-8111-111111111111",
        "snapshotId": "22222222-2222-4222-8222-222222222222",
        "snapshotFingerprint": "a" * 64,
        "sourceRunId": None,
        "recipeId": "33333333-3333-4333-8333-333333333333",
        "recipeRevision": 2,
        "selectedTextFields": ["title", "body"],
        "metadataFields": ["category"],
        "stripHtml": True,
        "unicodeNormalization": "NFKC",
        "deduplication": "exact-and-near",
        "nearDuplicateThreshold": 0.9,
        "chunkSize": 200,
        "chunkOverlap": 20,
        "languagePolicy": "zh-en-first",
        "outputFormats": ["parquet", "jsonl", "markdown"],
    }


@pytest.mark.asyncio
async def test_builds_deterministic_bilingual_artifacts(snapshot: Path, tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    result = await build_corpus(
        input_path=snapshot,
        workspace=first,
        parameters=parameters(),
        report=report,
        cancelled=lambda: False,
    )
    repeated = await build_corpus(
        input_path=snapshot,
        workspace=second,
        parameters=parameters(),
        report=report,
        cancelled=lambda: False,
    )

    assert result["manifest"]["corpusFingerprint"] == repeated["manifest"]["corpusFingerprint"]
    assert result["manifest"]["documentCount"] == 3
    assert result["manifest"]["deduplication"] == {
        "exactDuplicates": 1,
        "nearDuplicates": 1,
        "threshold": 0.9,
    }
    assert result["manifest"]["languages"] == {"en": 1, "other": 1, "zh": 1}
    assert {item["artifactRef"] for item in result["artifacts"]} == {
        "documents.parquet",
        "chunks.parquet",
        "corpus.jsonl",
        "corpus.md",
        "manifest.json",
    }
    assert pq.read_table(first / "documents.parquet").num_rows == 3
    chunks = pq.read_table(first / "chunks.parquet").to_pylist()
    assert len(chunks) == result["manifest"]["chunkCount"]
    assert all(len(item["text"]) <= 200 for item in chunks)
    assert (first / "corpus.jsonl").read_text().count("\n") == len(chunks)
    assert (first / "corpus.md").read_text().startswith("## ")
    assert [item["checksum"] for item in result["artifacts"][:-1]] == [
        item["checksum"] for item in repeated["artifacts"][:-1]
    ]


@pytest.mark.asyncio
async def test_rejects_unknown_fields_and_honors_cancellation(
    snapshot: Path, tmp_path: Path
) -> None:
    workspace = tmp_path / "invalid"
    workspace.mkdir()
    with pytest.raises(CorpusValidationError, match="not found"):
        await build_corpus(
            input_path=snapshot,
            workspace=workspace,
            parameters={**parameters(), "selectedTextFields": ["missing"]},
            report=report,
            cancelled=lambda: False,
        )
    with pytest.raises(asyncio.CancelledError):
        await build_corpus(
            input_path=snapshot,
            workspace=workspace,
            parameters=parameters(),
            report=report,
            cancelled=lambda: True,
        )


def test_normalization_chunking_and_catalog_visibility() -> None:
    assert normalize_document("Ａ\x00  B\r\n\r\n\r\nC", strip_html=False, normalization="NFKC") == (
        "A B\n\nC"
    )
    chunks = split_chunks("这是第一句。" * 60, "zh", 100, 10)
    assert len(chunks) > 1
    assert all(len(item) <= 100 for item in chunks)
    registry = MethodRegistry()
    assert "corpus.build" not in {item.id for item in registry.list()}
    assert registry.descriptor("corpus.build") is not None


@pytest.mark.asyncio
async def test_preview_uses_version_rows_and_production_cleaning(
    snapshot: Path, tmp_path: Path
) -> None:
    from zhiyun_analytics_worker.corpus import preview_corpus

    preview_dir = tmp_path / "preview"
    preview_dir.mkdir()
    result = await preview_corpus(
        input_path=snapshot,
        workspace=preview_dir,
        parameters=parameters(),
        report=report,
        cancelled=lambda: False,
    )
    assert result["sampled"] is True
    assert result["sampleSize"] == result["totalRows"] == pq.read_table(snapshot).num_rows
    assert result["stats"]["documentCount"] == 3
    assert result["stats"]["deduplication"]["exactDuplicates"] == 1
    assert all("<h1>" not in doc["text"] for doc in result["documents"])
    assert result["chunks"] == pq.read_table(preview_dir / "chunks.parquet").to_pylist()[:20]
    large = tmp_path / "large.parquet"
    pq.write_table(pa.concat_tables([pq.read_table(snapshot)] * 10), large)
    second = tmp_path / "second-preview"
    second.mkdir()
    limited = await preview_corpus(
        input_path=large,
        workspace=second,
        parameters=parameters(),
        report=report,
        cancelled=lambda: False,
    )
    assert limited["sampleSize"] == 20
    assert limited["totalRows"] > 20
