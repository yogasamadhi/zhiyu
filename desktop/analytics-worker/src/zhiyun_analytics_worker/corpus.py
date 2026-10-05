from __future__ import annotations

import asyncio
import hashlib
import re
import unicodedata
from collections import Counter
from collections.abc import Awaitable, Callable
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import orjson
import pyarrow as pa
import pyarrow.parquet as pq
from datasketch import MinHash, MinHashLSH

from . import __version__
from .models import MethodDescriptor

ProgressReporter = Callable[[str, float], Awaitable[None]]
CancellationProbe = Callable[[], bool]
MAX_DOCUMENT_CHARS = 10_000_000
MAX_TEXT_FIELDS = 100
MAX_METADATA_FIELDS = 100
BATCH_SIZE = 1_000
CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
WHITESPACE = re.compile(r"[ \t\f\v]+")
NEWLINES = re.compile(r"\n{3,}")
ZH_CHARACTERS = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
LATIN_CHARACTERS = re.compile(r"[A-Za-z]")
TOKEN_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z0-9_]+", re.UNICODE)

CORPUS_BUILD_METHOD = MethodDescriptor(
    id="corpus.build",
    version="1.0.0",
    category="internal",
    titleKey="worker.methods.corpusBuild.title",
    descriptionKey="worker.methods.corpusBuild.description",
    parameterSchema={
        "type": "object",
        "additionalProperties": False,
        "required": [
            "datasetId",
            "snapshotId",
            "snapshotFingerprint",
            "recipeId",
            "recipeRevision",
            "selectedTextFields",
        ],
        "properties": {
            "datasetId": {"type": "string"},
            "snapshotId": {"type": "string"},
            "snapshotFingerprint": {"type": "string"},
            "sourceRunId": {"type": ["string", "null"]},
            "recipeId": {"type": "string"},
            "recipeRevision": {"type": "integer", "minimum": 1},
            "selectedTextFields": {"type": "array", "items": {"type": "string"}},
            "metadataFields": {"type": "array", "items": {"type": "string"}},
            "stripHtml": {"type": "boolean"},
            "unicodeNormalization": {"type": "string", "enum": ["NFC", "NFKC"]},
            "deduplication": {
                "type": "string",
                "enum": ["none", "exact", "exact-and-near"],
            },
            "nearDuplicateThreshold": {
                "type": "number",
                "minimum": 0.5,
                "maximum": 1.0,
            },
            "chunkSize": {"type": "integer", "minimum": 100, "maximum": 10000},
            "chunkOverlap": {"type": "integer", "minimum": 0, "maximum": 2000},
            "languagePolicy": {"type": "string", "enum": ["zh-en-first", "generic"]},
            "outputFormats": {
                "type": "array",
                "items": {"type": "string", "enum": ["parquet", "jsonl", "markdown"]},
            },
        },
    },
    outputSchema={
        "type": "object",
        "required": ["manifest", "artifacts"],
        "properties": {
            "manifest": {"type": "object"},
            "artifacts": {"type": "array"},
        },
    },
    internal=True,
)


class CorpusValidationError(ValueError):
    pass


class CorpusResourceError(CorpusValidationError):
    pass


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return " ".join(self.parts)


async def build_corpus(
    *,
    input_path: Path,
    workspace: Path,
    parameters: dict[str, Any],
    report: ProgressReporter,
    cancelled: CancellationProbe,
) -> dict[str, Any]:
    options = validate_parameters(parameters)
    parquet = pq.ParquetFile(input_path)
    fields = set(parquet.schema_arrow.names)
    missing = sorted(set(options["selectedTextFields"] + options["metadataFields"]) - fields)
    if missing:
        raise CorpusValidationError(f"Corpus fields were not found: {', '.join(missing)}")
    row_count = parquet.metadata.num_rows
    build_fingerprint = hashlib.sha256(
        orjson.dumps(options, option=orjson.OPT_SORT_KEYS)
    ).hexdigest()
    output_paths = {
        "documents": workspace / ".documents.parquet.partial",
        "chunks": workspace / ".chunks.parquet.partial",
        "jsonl": workspace / ".corpus.jsonl.partial",
        "markdown": workspace / ".corpus.md.partial",
        "manifest": workspace / ".manifest.json.partial",
    }
    document_schema = pa.schema(
        [
            pa.field("document_id", pa.string(), nullable=False),
            pa.field("record_key", pa.large_string(), nullable=False),
            pa.field("source_url", pa.large_string(), nullable=True),
            pa.field("text", pa.large_string(), nullable=False),
            pa.field("language", pa.string(), nullable=False),
            pa.field("content_hash", pa.string(), nullable=False),
            pa.field("metadata_json", pa.large_string(), nullable=False),
        ]
    )
    chunk_schema = pa.schema(
        [
            pa.field("chunk_id", pa.string(), nullable=False),
            pa.field("document_id", pa.string(), nullable=False),
            pa.field("chunk_index", pa.int32(), nullable=False),
            pa.field("text", pa.large_string(), nullable=False),
            pa.field("language", pa.string(), nullable=False),
            pa.field("character_count", pa.int32(), nullable=False),
        ]
    )
    documents_writer = pq.ParquetWriter(
        output_paths["documents"], document_schema, compression="zstd"
    )
    chunks_writer = pq.ParquetWriter(output_paths["chunks"], chunk_schema, compression="zstd")
    exact_hashes: set[str] = set()
    lsh = MinHashLSH(threshold=options["nearDuplicateThreshold"], num_perm=128)
    document_rows: list[dict[str, Any]] = []
    chunk_rows: list[dict[str, Any]] = []
    language_counts: Counter[str] = Counter()
    failures: list[str] = []
    exact_duplicates = 0
    near_duplicates = 0
    documents = 0
    chunks = 0
    characters = 0
    processed = 0
    jsonl_file = output_paths["jsonl"].open("wb")
    markdown_file = (
        output_paths["markdown"].open("w", encoding="utf-8")
        if "markdown" in options["outputFormats"]
        else None
    )
    await report("preparing", 0.02)
    try:
        columns = [
            "__zhiyun_record_key",
            "__zhiyun_source_url",
            *options["selectedTextFields"],
            *options["metadataFields"],
        ]
        columns = list(dict.fromkeys(columns))
        for batch in parquet.iter_batches(batch_size=BATCH_SIZE, columns=columns):
            for row in batch.to_pylist():
                if cancelled():
                    raise asyncio.CancelledError
                processed += 1
                try:
                    text = normalize_document(
                        "\n".join(
                            stringify(row.get(field)) for field in options["selectedTextFields"]
                        ),
                        strip_html=options["stripHtml"],
                        normalization=options["unicodeNormalization"],
                    )
                    if not text:
                        failures.append(f"{row.get('__zhiyun_record_key', processed)}:empty")
                        continue
                    if len(text) > MAX_DOCUMENT_CHARS:
                        failures.append(f"{row.get('__zhiyun_record_key', processed)}:oversized")
                        continue
                    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
                    if options["deduplication"] != "none" and content_hash in exact_hashes:
                        exact_duplicates += 1
                        continue
                    minhash = make_minhash(text)
                    if (
                        options["deduplication"] == "exact-and-near"
                        and minhash is not None
                        and lsh.query(minhash)
                    ):
                        near_duplicates += 1
                        continue
                    exact_hashes.add(content_hash)
                    record_key = str(row.get("__zhiyun_record_key") or processed)
                    document_id = hashlib.sha256(
                        f"{record_key}\0{content_hash}".encode()
                    ).hexdigest()
                    if options["deduplication"] == "exact-and-near" and minhash is not None:
                        lsh.insert(document_id, minhash)
                    language = detect_language(text, options["languagePolicy"])
                    metadata = {
                        field: json_value(row.get(field)) for field in options["metadataFields"]
                    }
                    document_rows.append(
                        {
                            "document_id": document_id,
                            "record_key": record_key,
                            "source_url": stringify(row.get("__zhiyun_source_url")) or None,
                            "text": text,
                            "language": language,
                            "content_hash": content_hash,
                            "metadata_json": orjson.dumps(
                                metadata, option=orjson.OPT_SORT_KEYS
                            ).decode(),
                        }
                    )
                    document_chunks = split_chunks(
                        text, language, options["chunkSize"], options["chunkOverlap"]
                    )
                    for index, chunk in enumerate(document_chunks):
                        chunk_id = hashlib.sha256(
                            f"{document_id}\0{index}\0{chunk}".encode()
                        ).hexdigest()
                        chunk_row = {
                            "chunk_id": chunk_id,
                            "document_id": document_id,
                            "chunk_index": index,
                            "text": chunk,
                            "language": language,
                            "character_count": len(chunk),
                        }
                        chunk_rows.append(chunk_row)
                        jsonl_file.write(
                            orjson.dumps(
                                {
                                    **chunk_row,
                                    "record_key": record_key,
                                    "source_url": row.get("__zhiyun_source_url"),
                                    "metadata": metadata,
                                },
                                option=orjson.OPT_APPEND_NEWLINE | orjson.OPT_SORT_KEYS,
                            )
                        )
                        if markdown_file:
                            markdown_file.write(f"## {chunk_id}\n\n{chunk}\n\n")
                    documents += 1
                    chunks += len(document_chunks)
                    characters += len(text)
                    language_counts[language] += 1
                    if len(document_rows) >= BATCH_SIZE:
                        documents_writer.write_table(
                            pa.Table.from_pylist(document_rows, schema=document_schema)
                        )
                        document_rows.clear()
                    if len(chunk_rows) >= BATCH_SIZE:
                        chunks_writer.write_table(
                            pa.Table.from_pylist(chunk_rows, schema=chunk_schema)
                        )
                        chunk_rows.clear()
                except (TypeError, ValueError) as error:
                    failures.append(
                        f"{row.get('__zhiyun_record_key', processed)}:{type(error).__name__}"
                    )
                if processed % BATCH_SIZE == 0:
                    await report("running", 0.05 + 0.8 * processed / max(row_count, 1))
            await asyncio.sleep(0)
        if document_rows:
            documents_writer.write_table(
                pa.Table.from_pylist(document_rows, schema=document_schema)
            )
        if chunk_rows:
            chunks_writer.write_table(pa.Table.from_pylist(chunk_rows, schema=chunk_schema))
    finally:
        documents_writer.close()
        chunks_writer.close()
        jsonl_file.close()
        if markdown_file:
            markdown_file.close()

    await report("persisting", 0.9)
    artifacts = [
        artifact("corpus.documents", "documents.parquet", output_paths["documents"]),
        artifact("corpus.chunks", "chunks.parquet", output_paths["chunks"]),
        artifact("corpus.jsonl", "corpus.jsonl", output_paths["jsonl"]),
    ]
    if markdown_file:
        artifacts.append(artifact("corpus.markdown", "corpus.md", output_paths["markdown"]))
    manifest = {
        "formatVersion": "1.0.0",
        "corpusFingerprint": build_fingerprint,
        "datasetId": options["datasetId"],
        "sourceRunId": options.get("sourceRunId"),
        "snapshotId": options["snapshotId"],
        "snapshotFingerprint": options["snapshotFingerprint"],
        "recipeId": options["recipeId"],
        "recipeRevision": options["recipeRevision"],
        "workerVersion": __version__,
        "deduplication": {
            "exactDuplicates": exact_duplicates,
            "nearDuplicates": near_duplicates,
            "threshold": options["nearDuplicateThreshold"],
        },
        "languages": dict(sorted(language_counts.items())),
        "documentCount": documents,
        "chunkCount": chunks,
        "characterCount": characters,
        "inputRowCount": row_count,
        "failureCount": len(failures),
        "failureSamples": failures[:100],
        "artifacts": artifacts,
    }
    output_paths["manifest"].write_bytes(
        orjson.dumps(manifest, option=orjson.OPT_INDENT_2 | orjson.OPT_SORT_KEYS)
    )
    artifacts.append(artifact("corpus.manifest", "manifest.json", output_paths["manifest"]))
    for key, final_name in (
        ("documents", "documents.parquet"),
        ("chunks", "chunks.parquet"),
        ("jsonl", "corpus.jsonl"),
        ("manifest", "manifest.json"),
    ):
        output_paths[key].replace(workspace / final_name)
    if markdown_file:
        output_paths["markdown"].replace(workspace / "corpus.md")
    return {"manifest": manifest, "artifacts": artifacts}


def validate_parameters(parameters: dict[str, Any]) -> dict[str, Any]:
    allowed = set(CORPUS_BUILD_METHOD.parameterSchema["properties"])
    unknown = sorted(set(parameters) - allowed)
    if unknown:
        raise CorpusValidationError(f"Unknown Corpus parameters: {', '.join(unknown)}")
    text_fields = string_list(parameters, "selectedTextFields", required=True)
    metadata_fields = string_list(parameters, "metadataFields", required=False)
    if len(text_fields) > MAX_TEXT_FIELDS or len(metadata_fields) > MAX_METADATA_FIELDS:
        raise CorpusResourceError("Corpus field selection exceeds the 100 field limit")
    chunk_size = integer(parameters, "chunkSize", 2000, 100, 10000)
    chunk_overlap = integer(parameters, "chunkOverlap", 200, 0, 2000)
    if chunk_overlap >= chunk_size:
        raise CorpusValidationError("chunkOverlap must be smaller than chunkSize")
    threshold = number(parameters, "nearDuplicateThreshold", 0.9, 0.5, 1.0)
    normalization = parameters.get("unicodeNormalization", "NFKC")
    deduplication = parameters.get("deduplication", "exact-and-near")
    language_policy = parameters.get("languagePolicy", "zh-en-first")
    formats = string_list(parameters, "outputFormats", required=False) or ["parquet", "jsonl"]
    if normalization not in {"NFC", "NFKC"}:
        raise CorpusValidationError("Unsupported Unicode normalization")
    if deduplication not in {"none", "exact", "exact-and-near"}:
        raise CorpusValidationError("Unsupported deduplication policy")
    if language_policy not in {"zh-en-first", "generic"}:
        raise CorpusValidationError("Unsupported language policy")
    if set(formats) - {"parquet", "jsonl", "markdown"}:
        raise CorpusValidationError("Unsupported Corpus output format")
    required_strings = ["datasetId", "snapshotId", "snapshotFingerprint", "recipeId"]
    for key in required_strings:
        if not isinstance(parameters.get(key), str) or not parameters[key]:
            raise CorpusValidationError(f"{key} is required")
    revision = parameters.get("recipeRevision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise CorpusValidationError("recipeRevision must be a positive integer")
    return {
        **parameters,
        "selectedTextFields": text_fields,
        "metadataFields": metadata_fields,
        "stripHtml": bool(parameters.get("stripHtml", True)),
        "unicodeNormalization": normalization,
        "deduplication": deduplication,
        "nearDuplicateThreshold": threshold,
        "chunkSize": chunk_size,
        "chunkOverlap": chunk_overlap,
        "languagePolicy": language_policy,
        "outputFormats": sorted(set(formats) | {"parquet", "jsonl"}),
    }


def normalize_document(text: str, *, strip_html: bool, normalization: str) -> str:
    text = unicodedata.normalize(normalization, text)
    text = CONTROL_CHARACTERS.sub("", text).replace("\r\n", "\n").replace("\r", "\n")
    if strip_html:
        parser = _TextExtractor()
        parser.feed(text)
        parser.close()
        text = parser.text()
    text = "\n".join(WHITESPACE.sub(" ", line).strip() for line in text.split("\n"))
    return NEWLINES.sub("\n\n", text).strip()


def detect_language(text: str, policy: str) -> str:
    if policy == "generic":
        return "other"
    zh = len(ZH_CHARACTERS.findall(text))
    en = len(LATIN_CHARACTERS.findall(text))
    total = zh + en
    if total == 0:
        return "other"
    if zh / total >= 0.35:
        return "zh"
    if en / total >= 0.6:
        return "en"
    return "other"


def split_chunks(text: str, language: str, size: int, overlap: int) -> list[str]:
    if len(text) <= size:
        return [text]
    delimiters = (
        "。！？；\n" if language == "zh" else ".!?\n" if language == "en" else ".!?。！？\n"
    )
    chunks: list[str] = []
    start = 0
    while start < len(text):
        hard_end = min(start + size, len(text))
        end = hard_end
        if hard_end < len(text):
            search_floor = start + max(size // 2, 1)
            candidates = [text.rfind(delimiter, search_floor, hard_end) for delimiter in delimiters]
            boundary = max(candidates, default=-1)
            if boundary >= search_floor:
                end = boundary + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return chunks


def make_minhash(text: str) -> MinHash | None:
    tokens = sorted(set(token.lower() for token in TOKEN_PATTERN.findall(text)))
    if not tokens:
        return None
    signature = MinHash(num_perm=128, seed=42)
    for token in tokens:
        signature.update(token.encode("utf-8"))
    return signature


def artifact(kind: str, reference: str, path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    content_type = {
        ".parquet": "application/vnd.apache.parquet",
        ".jsonl": "application/x-ndjson",
        ".json": "application/json",
        ".md": "text/markdown; charset=utf-8",
    }[Path(reference).suffix]
    return {
        "kind": kind,
        "artifactRef": reference,
        "contentType": content_type,
        "checksum": digest.hexdigest(),
        "size": path.stat().st_size,
    }


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return orjson.dumps(value, option=orjson.OPT_SORT_KEYS).decode()
    return str(value)


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, (list, dict)):
        return value
    return str(value)


def string_list(parameters: dict[str, Any], key: str, *, required: bool) -> list[str]:
    value = parameters.get(key)
    if value is None and not required:
        return []
    if not isinstance(value, list) or (required and not value):
        raise CorpusValidationError(f"{key} must be a non-empty string array")
    if any(not isinstance(item, str) or not item or len(item) > 255 for item in value):
        raise CorpusValidationError(f"{key} contains an invalid field")
    if len(set(value)) != len(value):
        raise CorpusValidationError(f"{key} fields must be unique")
    return value


def integer(parameters: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    value = parameters.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise CorpusValidationError(f"{key} must be between {minimum} and {maximum}")
    return value


def number(
    parameters: dict[str, Any], key: str, default: float, minimum: float, maximum: float
) -> float:
    value = parameters.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CorpusValidationError(f"{key} must be numeric")
    numeric = float(value)
    if not minimum <= numeric <= maximum:
        raise CorpusValidationError(f"{key} must be between {minimum} and {maximum}")
    return numeric


CORPUS_PREVIEW_METHOD = CORPUS_BUILD_METHOD.model_copy(
    update={"id": "corpus.preview", "outputSchema": {"type": "object"}}
)


async def preview_corpus(
    *,
    input_path: Path,
    workspace: Path,
    parameters: dict[str, Any],
    report: ProgressReporter,
    cancelled: CancellationProbe,
) -> dict[str, Any]:
    """Use the production pipeline on at most 20 rows of the immutable version."""
    source = pq.ParquetFile(input_path)
    batch = next(source.iter_batches(batch_size=20), None)
    sample_path = workspace / "preview-input.parquet"
    table = (
        pa.Table.from_batches([batch])
        if batch is not None
        else pa.Table.from_batches([], schema=source.schema_arrow)
    )
    pq.write_table(table, sample_path)
    result = await build_corpus(
        input_path=sample_path,
        workspace=workspace,
        parameters=parameters,
        report=report,
        cancelled=cancelled,
    )
    artifacts = {item["kind"]: item["artifactRef"] for item in result["artifacts"]}

    def rows(kind: str) -> list[dict[str, Any]]:
        parquet = pq.ParquetFile(workspace / artifacts[kind])
        first = next(parquet.iter_batches(batch_size=20), None)
        return first.to_pylist() if first is not None else []

    return {
        "sampled": True,
        "sampleSize": table.num_rows,
        "totalRows": source.metadata.num_rows,
        "documents": rows("corpus.documents"),
        "chunks": rows("corpus.chunks"),
        "stats": {
            key: result["manifest"][key]
            for key in ("documentCount", "chunkCount", "failureCount", "deduplication")
        },
    }
