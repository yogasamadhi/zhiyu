from __future__ import annotations

import json
import sys
from pathlib import Path

from zhiyun_analytics_worker.app import create_app

root = Path(__file__).resolve().parents[1]
target = root / "openapi.json"
document = create_app("x" * 64, 1, root).openapi()
content = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

if "--check" in sys.argv:
    current = target.read_text(encoding="utf-8") if target.exists() else ""
    if current != content:
        raise SystemExit("Worker OpenAPI is out of date. Run: uv run python scripts/export_openapi.py")
else:
    target.write_text(content, encoding="utf-8")

