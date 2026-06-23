"""Find FREE OpenRouter models that support image (vision) input.

Queries the OpenRouter /models catalog, filters to models that are free and
accept the 'image' input modality, and prints them sorted by context length.
"""
import json
import urllib.request

from config import OPENROUTER_API_KEY

req = urllib.request.Request(
    "https://openrouter.ai/api/v1/models",
    headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
)
with urllib.request.urlopen(req, timeout=60) as r:
    data = json.load(r)

models = data.get("data", [])
vision_free = []
for m in models:
    mid = m.get("id", "")
    arch = m.get("architecture", {}) or {}
    inputs = arch.get("input_modalities") or []
    pricing = m.get("pricing", {}) or {}
    prompt_price = float(pricing.get("prompt", "0") or 0)
    completion_price = float(pricing.get("completion", "0") or 0)
    is_free = mid.endswith(":free") or (prompt_price == 0 and completion_price == 0)
    if "image" in inputs and is_free:
        vision_free.append((m.get("context_length") or 0, mid))

vision_free.sort(reverse=True)
print(f"Total models: {len(models)} | free + vision: {len(vision_free)}\n")
for ctx, mid in vision_free:
    print(f"  {ctx:>8}  {mid}")
