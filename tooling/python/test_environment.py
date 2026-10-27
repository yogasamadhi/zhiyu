"""Isolated test environment rules for the ZhiYun development launchers.

The TypeScript twin lives in ``tooling/scripts/test-environment.ts`` and is
still used by the test infrastructure; keep both implementations in sync.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import urlsplit

# Copy only OS/runtime settings. Provider, signing and message credentials from
# the caller are deliberately absent, including arbitrarily named model keys.
PASSTHROUGH_NAMES = (
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
    "TERM",
    "CI",
    "FORCE_COLOR",
)

TEST_DATABASE_NAME = re.compile(r"^/[a-z][a-z0-9_]*_test$")
LOCAL_DATABASE_HOSTS = ("localhost", "127.0.0.1", "::1")


def test_environment(source: Mapping[str, str]) -> dict[str, str]:
    """Return the minimal environment for isolated test runs."""
    environment = {name: source[name] for name in PASSTHROUGH_NAMES if name in source}
    environment.update(
        {
            "NODE_ENV": "test",
            "CLOUD_MOCK_PAYMENTS": "true",
            "CLOUD_REAL_MESSAGES": "false",
            "CLOUD_MODEL_ORIGINS": "",
            "CLOUD_MFA_KEY": "development-isolated-test-mfa-key-32",
            "AI_BASE_URL": "",
            "AI_MODEL": "",
            "AI_API_KEY": "",
            "NEXT_TELEMETRY_DISABLED": "1",
        }
    )
    return environment


def assert_test_database(value: str, kind: str = "unit") -> str:
    """Validate that the database URL points at a local disposable database."""
    suffix = "_e2e_test" if kind == "e2e" else "_test"
    parsed = urlsplit(value)
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError("Test database must be a local PostgreSQL *_test database")
    if parsed.scheme not in ("postgres", "postgresql"):
        raise RuntimeError(f"Test database must be a local PostgreSQL *{suffix} database")
    if parsed.hostname not in LOCAL_DATABASE_HOSTS:
        raise RuntimeError(f"Test database must be a local PostgreSQL *{suffix} database")
    if not TEST_DATABASE_NAME.match(parsed.path) or not parsed.path.endswith(suffix):
        raise RuntimeError(f"Test database must be a local PostgreSQL *{suffix} database")
    if parsed.query or parsed.fragment:
        raise RuntimeError(f"Test database must be a local PostgreSQL *{suffix} database")
    return value
