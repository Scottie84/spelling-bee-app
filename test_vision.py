"""Robust vision test: generate a local image containing a known word,
send it as a base64 data URI (no external fetch), and check OCR/recognition.

Retries each model a couple times to ride out transient 429/502 errors.
"""
import base64
import io

from PIL import Image, ImageDraw, ImageFont

from openrouter_client import get_client

client = get_client()

WORD = "APPLE"
CANDIDATES = [
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "nex-agi/nex-n2-pro:free",
    "google/gemma-4-26b-a4b-it:free",
]


def make_image_data_uri(word: str) -> str:
    img = Image.new("RGB", (320, 120), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 64)
    except OSError:
        font = ImageFont.load_default()
    d.text((30, 25), word, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{b64}"


DATA_URI = make_image_data_uri(WORD)
print(f"Test image: white PNG with the word {WORD!r} (sent as base64 data URI)\n")


def call_image(model, retries=3):
    last = ""
    for _ in range(retries):
        try:
            r = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": "What single word is written in this image? Reply with only that word."},
                    {"type": "image_url", "image_url": {"url": DATA_URI}},
                ]}],
                max_tokens=32,
                timeout=60,
            )
            if r.choices is None:
                last = f"ERR {getattr(r, 'error', None)}"
                continue
            return "OK -> " + (r.choices[0].message.content or "").strip().replace("\n", " ")[:60]
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {str(e)[:80]}"
    return "FAIL " + last


for m in CANDIDATES:
    print(f"{m}\n  image: {call_image(m)}")
