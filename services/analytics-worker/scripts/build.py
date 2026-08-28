from __future__ import annotations

import platform
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
system = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}.get(
    platform.system(), platform.system().lower()
)
machine = platform.machine().lower()
architecture = "arm64" if machine in {"arm64", "aarch64"} else "x64"
target = root / "dist" / f"{system}-{architecture}"
work = root / ".pyinstaller"
if target.exists():
    shutil.rmtree(target)
target.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(
    [
        "pyinstaller",
        "--noconfirm",
        "--clean",
        "--distpath",
        str(target),
        "--workpath",
        str(work),
        str(root / "packaging" / "analytics-worker.spec"),
    ],
    cwd=root,
    check=True,
)
