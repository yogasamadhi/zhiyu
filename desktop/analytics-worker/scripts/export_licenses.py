from __future__ import annotations

import hashlib
import json
import re
import sys
from importlib import metadata
from pathlib import Path
from typing import Any


def license_names(distribution: metadata.Distribution) -> list[str]:
    values: set[str] = set()
    for key in ("License-Expression", "License"):
        value = distribution.metadata.get(key, "").strip()
        if value and "\n" not in value and len(value) < 200:
            values.add(value)
    for classifier in distribution.metadata.get_all("Classifier", []):
        if classifier.startswith("License ::"):
            values.add(classifier)
    return sorted(values)


def license_files(distribution: metadata.Distribution) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for relative_path in sorted(distribution.files or [], key=str):
        if not re.search(r"(^|/)(license|licence|copying|notice)(\.|$)", str(relative_path), re.I):
            continue
        path = Path(distribution.locate_file(relative_path))
        try:
            if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        result.append(
            {
                "filename": str(relative_path),
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "text": text,
            }
        )
    return result


def main() -> None:
    output_path = Path(
        sys.argv[1] if len(sys.argv) > 1 else ".artifacts/compliance/python.json"
    ).resolve()
    packages: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for distribution in metadata.distributions():
        name = distribution.metadata.get("Name", "").strip()
        version = distribution.version
        key = (name.casefold(), version)
        if not name or key in seen or name == "zhiyun-analytics-worker":
            continue
        seen.add(key)
        packages.append(
            {
                "name": name,
                "version": version,
                "declaredLicenses": license_names(distribution),
                "licenseFiles": license_files(distribution),
            }
        )
    packages.sort(key=lambda item: (item["name"].casefold(), item["version"]))
    report = {
        "formatVersion": 1,
        "generatedFor": "ZhiYun 1.0.0",
        "ecosystem": "Python",
        "packageCount": len(packages),
        "packages": packages,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Collected {len(packages)} Python package license records in {output_path}")


if __name__ == "__main__":
    main()
