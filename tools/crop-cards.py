"""Crop the marketplace card images out of the raw screenshots.

The raw frames contain the operator's own conversation, so only the plugin
region is published.

Usage: python tools/crop-cards.py
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
assets = root / "assets"

jobs = [
    # (raw source, box, published name)
    ("raw-panel.png", (912, 300, 1372, 742), "screenshot-panel.png"),
    ("raw-worklog.png", (912, 556, 1352, 742), "screenshot-worklog.png"),
    ("raw-panel.png", (545, 728, 1180, 770), "screenshot-dock.png"),
]

for source, box, target in jobs:
    image = Image.open(assets / source).convert("RGB")
    cropped = image.crop(box)
    cropped.save(assets / target, optimize=True)
    print(target, cropped.size, (assets / target).stat().st_size, "bytes")
