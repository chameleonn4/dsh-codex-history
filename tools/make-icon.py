"""Render the marketplace storefront tile (assets/icon-180.png) from icon.svg's geometry.

The SVG is a 64x64 stroke drawing: a rounded rectangle plus three text lines in
brand blue. Pillow cannot rasterise SVG, so the same primitives are drawn here at
4x and downsampled with LANCZOS for clean edges.
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw

BLUE = (36, 123, 191, 255)
SS = 4          # supersampling factor
SIZE = 180      # final tile size
SCALE = SIZE / 64 * SS


def px(v: float) -> float:
    return v * SCALE


def stroke_round(draw: ImageDraw.ImageDraw, p0, p1, width: float) -> None:
    """A line with round caps (Pillow has no cap style)."""
    r = width / 2
    draw.line([p0, p1], fill=BLUE, width=int(round(width)))
    for x, y in (p0, p1):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=BLUE)


def main() -> None:
    canvas = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # rounded rectangle outline: rect x=4 y=10 w=56 h=40 rx=8, stroke 4
    draw.rounded_rectangle(
        [px(4), px(10), px(60), px(50)],
        radius=px(8),
        outline=BLUE,
        width=int(round(px(4))),
    )

    # three text lines: (14,24)-(34,24) (14,32)-(40,32) (14,40)-(26,40)
    stroke_round(draw, (px(14), px(24)), (px(34), px(24)), px(4))
    stroke_round(draw, (px(14), px(32)), (px(40), px(32)), px(4))
    stroke_round(draw, (px(14), px(40)), (px(26), px(40)), px(4))

    canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(out_dir, exist_ok=True)
    for name in ("icon-180.png", "icon-96.png"):
        target = canvas if name == "icon-180.png" else canvas.resize((96, 96), Image.LANCZOS)
        target.save(os.path.join(out_dir, name))
        print("wrote", os.path.join(out_dir, name))


if __name__ == "__main__":
    main()
