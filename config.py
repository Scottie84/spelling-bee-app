"""Central place to load and validate environment configuration.

The API key is read ONLY from the environment (loaded from .env in local dev).
It is never hardcoded, logged, or printed. Import `OPENROUTER_API_KEY` from here
instead of calling os.getenv directly elsewhere.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

# Load .env into the environment if present. In production (CI, server, etc.)
# the variable is typically already set, so a missing .env file is fine.
load_dotenv()

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value or value.strip() in ("", "sk-or-v1-your-key-here"):
        raise RuntimeError(
            f"Missing required environment variable: {name}.\n"
            f"Copy .env.example to .env and set a real value, "
            f"or export {name} in your shell."
        )
    return value.strip()


# Resolved once at import. Raises immediately (fail fast) if the key is absent.
OPENROUTER_API_KEY = _require("OPENROUTER_API_KEY")


def masked_key() -> str:
    """Safe-to-log representation of the key (e.g. for debugging)."""
    k = OPENROUTER_API_KEY
    return f"{k[:10]}...{k[-4:]}" if len(k) > 14 else "***"
