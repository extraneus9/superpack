# Draws the app icon -> assets/app-v3.ico + app.png
# v3: the original white folder + red status dot, but full-bleed with NO dark tile, so it fills the
# taskbar slot like the Windows Explorer icon. New file name on purpose: Windows caches icons by path.
from PIL import Image, ImageDraw
from pathlib import Path

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# folder back + tab
d.rounded_rectangle([24, 150, 1000, 900], radius=90, fill=(190, 188, 182, 255))
d.rounded_rectangle([24, 96, 420, 260], radius=72, fill=(190, 188, 182, 255))
# folder front
d.rounded_rectangle([24, 290, 1000, 928], radius=90, fill=(242, 241, 236, 255))
# red status dot with a dark ring so it reads on the white folder
d.ellipse([600, 560, 1010, 970], fill=(14, 14, 14, 255))
d.ellipse([640, 600, 970, 930], fill=(227, 21, 15, 255))

out = Path(__file__).resolve().parent.parent / "assets"
out.mkdir(exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save(out / "app.png")
img.save(out / "app-v3.ico", sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out / "app-v3.ico")
