"""Generate a vocab-book-style PNG for testing image extraction.

Writes test_vocab.png — a white page with a few English words + Korean
meanings + example sentences, mimicking a kids' wordbook page.
"""
from PIL import Image, ImageDraw, ImageFont

ENTRIES = [
    ("apple", "n.", "사과", "I eat an apple every morning."),
    ("brave", "adj.", "용감한", "The brave boy helped his friend."),
    ("garden", "n.", "정원", "We planted flowers in the garden."),
    ("quickly", "adv.", "빠르게", "She ran quickly to school."),
    ("happy", "adj.", "행복한", "The happy dog wagged its tail."),
]


def font(size):
    for name in ("arial.ttf", "DejaVuSans.ttf", "malgun.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


img = Image.new("RGB", (760, 520), "white")
d = ImageDraw.Draw(img)
d.text((40, 24), "Chapter 11  Word List", fill="black", font=font(34))
y = 90
for word, pos, meaning, example in ENTRIES:
    d.text((40, y), f"{word}  ({pos})", fill="black", font=font(30))
    d.text((360, y), meaning, fill="black", font=font(30))
    d.text((60, y + 36), example, fill=(70, 70, 70), font=font(22))
    y += 84

img.save("test_vocab.png")
print("wrote test_vocab.png", img.size)
