"""Generate the existing orange B brand as PNG and multi-size Windows ICO using Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parents[2] / "apps" / "desktop" / "assets"
SIZES = [(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)]


def brand_image() -> Image.Image:
    image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((48, 48, 976, 976), radius=232, fill="#d96c2f")
    font = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", 768)
    left, top, right, bottom = draw.textbbox((0, 0), "B", font=font)
    position = ((1024 - (right - left)) / 2 - left, (1024 - (bottom - top)) / 2 - top)
    draw.text(position, "B", font=font, fill="#ffffff")
    return image.resize((512, 512), Image.Resampling.LANCZOS)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    image = brand_image()
    image.save(ASSETS / "icon.png", optimize=True)
    image.save(ASSETS / "icon.ico", format="ICO", sizes=SIZES)
    with Image.open(ASSETS / "icon.ico") as icon:
        assert icon.ico.sizes() == set(SIZES), icon.ico.sizes()
    print("Created PNG 512x512 and ICO with 10 Windows sizes (16 through 256).")


if __name__ == "__main__":
    main()
