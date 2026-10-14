"""Generate icon.ico and icon.png (multiple sizes) for No More Writing.

Design: solid black disc + minimal sound-wave mark (3 ascending bars) + red dot accent.
Monochrome dark / cinematic — matches ALVA brand language.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

SIZES = [16, 24, 32, 48, 64, 128, 256]


def make(size: int) -> Image.Image:
    # Supersample for AA
    SS = 4
    W = size * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Solid disc
    d.ellipse([0, 0, W - 1, W - 1], fill=(10, 10, 10, 255))

    # Three ascending sound-wave bars centered
    cx, cy = W / 2, W / 2
    bar_w = W * 0.10
    gap = W * 0.07
    heights = (W * 0.22, W * 0.42, W * 0.30)
    total_w = bar_w * 3 + gap * 2
    start_x = cx - total_w / 2

    for i, h in enumerate(heights):
        x0 = start_x + i * (bar_w + gap)
        x1 = x0 + bar_w
        y0 = cy - h / 2
        y1 = cy + h / 2
        d.rounded_rectangle([x0, y0, x1, y1], radius=bar_w / 2, fill=(232, 232, 232, 255))

    # Subtle red dot top-right (recording accent)
    r = W * 0.05
    cx2 = W * 0.78
    cy2 = W * 0.22
    d.ellipse([cx2 - r, cy2 - r, cx2 + r, cy2 + r], fill=(230, 57, 70, 255))

    # Downsample to target with high-quality filter
    return img.resize((size, size), Image.LANCZOS)


def main():
    layers = [make(s) for s in SIZES]
    ico_path = OUT / "icon.ico"
    layers[-1].save(ico_path, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"wrote {ico_path}")
    for s, im in zip(SIZES, layers):
        p = OUT / f"icon_{s}.png"
        im.save(p)
    print(f"wrote {len(SIZES)} png sizes")


if __name__ == "__main__":
    main()
