"""Build the standalone index.html from index.template.html.

Steps:
  1. Inline engine.js into the page (replaces <script src="engine.js">).
  2. Inject the real OPENROUTER_API_KEY (from .env) in place of the
     __OPENROUTER_API_KEY__ placeholder.

The resulting index.html opens directly in a browser (file://) with no
server and no separate files. Because it embeds the API key, index.html is
gitignored — re-run `python build.py` after editing the template/engine.

Run:  python build.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).parent
TEMPLATE = ROOT / "index.template.html"
ENGINE = ROOT / "engine.js"
OUT = ROOT / "index.html"
ENV = ROOT / ".env"

PLACEHOLDER = "__OPENROUTER_API_KEY__"
SB_URL_PLACEHOLDER = "__SUPABASE_URL__"
SB_KEY_PLACEHOLDER = "__SUPABASE_ANON_KEY__"
SCRIPT_TAG = '<script src="engine.js"></script>'


def read_env(name: str, *, required: bool = True, default: str = "") -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    if required:
        sys.exit(f"ERROR: {name} not found in .env")
    return default


def read_key() -> str:
    return read_env("OPENROUTER_API_KEY")


def main() -> None:
    html = TEMPLATE.read_text(encoding="utf-8")
    engine = ENGINE.read_text(encoding="utf-8")
    key = read_key()
    # Supabase values are public (RLS-protected); optional so file:// builds
    # without a database still work (engine falls back to IndexedDB).
    sb_url = read_env("SUPABASE_URL", required=False)
    sb_key = read_env("SUPABASE_ANON_KEY", required=False)

    if SCRIPT_TAG not in html:
        sys.exit(f"ERROR: expected {SCRIPT_TAG!r} in template")
    if PLACEHOLDER not in html:
        sys.exit(f"ERROR: expected {PLACEHOLDER!r} placeholder in template")
    if "</script>" in engine:
        sys.exit("ERROR: engine.js contains a literal </script>; cannot inline safely")

    # Inline the engine in place of the external script tag.
    html = html.replace(SCRIPT_TAG, f"<script>\n{engine}\n</script>")
    # Inject the real key and Supabase config.
    html = html.replace(PLACEHOLDER, key)
    html = html.replace(SB_URL_PLACEHOLDER, sb_url)
    html = html.replace(SB_KEY_PLACEHOLDER, sb_key)

    if PLACEHOLDER in html:
        sys.exit("ERROR: placeholder still present after injection")

    OUT.write_text(html, encoding="utf-8")
    masked = f"{key[:10]}...{key[-4:]}"
    print(f"Wrote {OUT.name}  ({len(html):,} bytes)  key={masked}")


if __name__ == "__main__":
    main()
