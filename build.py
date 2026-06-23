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
SCRIPT_TAG = '<script src="engine.js"></script>'


def read_key() -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("ERROR: OPENROUTER_API_KEY not found in .env")


def main() -> None:
    html = TEMPLATE.read_text(encoding="utf-8")
    engine = ENGINE.read_text(encoding="utf-8")
    key = read_key()

    if SCRIPT_TAG not in html:
        sys.exit(f"ERROR: expected {SCRIPT_TAG!r} in template")
    if PLACEHOLDER not in html:
        sys.exit(f"ERROR: expected {PLACEHOLDER!r} placeholder in template")
    if "</script>" in engine:
        sys.exit("ERROR: engine.js contains a literal </script>; cannot inline safely")

    # Inline the engine in place of the external script tag.
    html = html.replace(SCRIPT_TAG, f"<script>\n{engine}\n</script>")
    # Inject the real key.
    html = html.replace(PLACEHOLDER, key)

    if PLACEHOLDER in html:
        sys.exit("ERROR: placeholder still present after injection")

    OUT.write_text(html, encoding="utf-8")
    masked = f"{key[:10]}...{key[-4:]}"
    print(f"Wrote {OUT.name}  ({len(html):,} bytes)  key={masked}")


if __name__ == "__main__":
    main()
