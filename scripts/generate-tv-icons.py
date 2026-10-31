"""Render Nova's existing four-point mark. Requires Python + Pillow.

Run from any directory: python scripts/generate-tv-icons.py
The adaptive foreground stays inside Android's central safe area.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
BLUE = '#2F6BEA'  # colors.accentFill in src/theme.ts
NIGHT = '#07080B'  # colors.bg
WHITE = '#FFFFFF'  # colors.onAccent
SCALE = 3


def canvas(width, height, background):
    return Image.new('RGBA', (width * SCALE, height * SCALE), background)


def star(image, cx, cy, size):
    # MaterialCommunityIcons star-four-points, as used by NovaMark.tsx.
    points = [(12, 2), (14.81, 9.19), (22, 12), (14.81, 14.81),
              (12, 22), (9.19, 14.81), (2, 12), (9.19, 9.19)]
    ImageDraw.Draw(image).polygon([
        ((cx + (x - 12) * size / 24) * SCALE,
         (cy + (y - 12) * size / 24) * SCALE) for x, y in points
    ], fill=WHITE)


def save(image, name, width, height):
    image.resize((width, height), Image.Resampling.LANCZOS).save(ASSETS / name)


icon = canvas(1024, 1024, BLUE)
star(icon, 512, 512, 594)
save(icon, 'nova-android-icon.png', 1024, 1024)

foreground = canvas(1024, 1024, (0, 0, 0, 0))
star(foreground, 512, 512, 520)
save(foreground, 'nova-android-foreground.png', 1024, 1024)
save(foreground, 'nova-android-monochrome.png', 1024, 1024)

tile = canvas(1280, 720, NIGHT)
draw = ImageDraw.Draw(tile)
draw.rounded_rectangle(tuple(v * SCALE for v in (200, 220, 480, 500)),
                       radius=84 * SCALE, fill=BLUE)
star(tile, 340, 360, 280 * .58)
font_paths = [Path('C:/Windows/Fonts/segoeuib.ttf'),
              Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')]
font_path = next((p for p in font_paths if p.exists()), None)
if font_path is None:
    raise SystemExit('Install Segoe UI Bold or DejaVu Sans Bold to render the tile.')
font = ImageFont.truetype(str(font_path), 172 * SCALE)
draw.text((540 * SCALE, 360 * SCALE), 'Nova', font=font, fill=WHITE, anchor='lm')
save(tile, 'tv/nova-appstore.png', 1280, 720)
save(tile, 'tv/nova-banner.png', 320, 180)
