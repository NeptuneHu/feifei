#!/usr/bin/env python3
"""Rebuild transparent pig sprites from the original reference art.

Keeps the painted pig, including the uncertain pose's cigarette and smoke.
Removes the stage, lettering, and the detached broken heart. Outputs three
sprites on one canvas with the body centered and the feet on the same line.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "assets" / "reference"
OUTPUT = ROOT / "assets" / "pig"
CANVAS = (1280, 1020)
BODY_HEIGHT = 640
BASELINE = 930
SOURCES = {
    "good": "pig-market-good-original.png",
    "bad": "pig-market-bad-original.png",
    "uncertain": "pig-market-uncertain-original.png",
}


def background_mask(rgb: np.ndarray) -> np.ndarray:
    red, green, blue = [rgb[:, :, index].astype(np.int16) for index in range(3)]
    # Spotlight and curtain only. Peach fails these: its green sits well below 240
    # and its red stays above its blue.
    white = (red >= 246) & (green >= 246) & (blue >= 242)
    purple = (blue > red + 8) & (blue > green + 4) & (red < 170) & (green < 160) & (blue < 190)
    return white | purple


def extract(path: Path) -> Image.Image:
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)
    red, green, blue = [rgb[:, :, index].astype(np.int16) for index in range(3)]
    passable = background_mask(rgb)
    labels, _ = ndimage.label(passable)
    border = np.zeros(passable.shape, dtype=bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    touched = np.unique(labels[border])
    touched = touched[touched != 0]
    backdrop = np.isin(labels, touched) if len(touched) else np.zeros(passable.shape, dtype=bool)
    halo = ndimage.binary_dilation(backdrop, iterations=1) & (rgb.min(axis=2) > 240)
    backdrop = backdrop | halo
    foreground = ~backdrop

    # Flat peach is the body. Features sit on it; curtain lines and stars do not.
    core = foreground & (red > 220) & (green > 155) & (green < 236) & (blue > 130) & (blue < 215)
    core &= ((red - green) > 22) & ((red - blue) > 36)
    core = ndimage.binary_opening(core, iterations=1)
    labels, count = ndimage.label(core)
    if count == 0:
        raise SystemExit(f"No pig body found in {path.name}")
    sizes = [(index, int((labels == index).sum())) for index in range(1, count + 1)]
    body_index = max(sizes, key=lambda item: item[1])[0]
    body = labels == body_index
    near_body = ndimage.binary_dilation(body, iterations=14)

    pink = foreground & (red > 175) & (green < 165) & (blue < 190) & ((red - green) > 28)
    dark = foreground & (red < 110) & (green < 100) & (blue < 110)
    tear = foreground & (blue > 150) & (blue > green + 10) & (green > red + 20) & (red < 140)
    smoke = foreground & ((np.maximum(np.maximum(red, green), blue) - np.minimum(np.minimum(red, green), blue)) < 22)
    smoke &= (red > 145) & (red < 230) & (green > 145) & (blue > 145)
    cigarette = foreground & (red > 150) & (green > 70) & (blue < 160) & ((red - blue) > 35) & (green < 210)
    body_ys, body_xs = np.where(body)
    left, right = int(body_xs.min()), int(body_xs.max())
    top, bottom = int(body_ys.min()), int(body_ys.max())
    width, height = right - left, bottom - top
    yy, xx = np.ogrid[: rgb.shape[0], : rgb.shape[1]]
    # Cigarette and smoke stay in front of the snout, on the left. The broken heart sits above the back.
    snout_zone = (xx < left + width * 0.48) & (yy > top - 30) & (yy < top + height * 0.72)
    features = (pink | dark | tear) & ndimage.binary_dilation(body, iterations=18)
    lavender = (blue > red + 8) & (blue > green + 4) & (red > 150) & (blue > 175) & ((red - green) < 40)
    # Everything still in front of the snout belongs to the cigarette or the smoke.
    # Keeping that connected shape preserves the white paper and the dark outline.
    snout_fg = foreground & snout_zone & ~lavender
    snout_labels, snout_count = ndimage.label(snout_fg | (body & snout_zone))
    snout_keep = np.zeros(snout_count + 1, dtype=bool)
    body_labels = np.unique(snout_labels[body & snout_zone])
    body_labels = body_labels[body_labels != 0]
    snout_keep[body_labels] = True
    for index in range(1, snout_count + 1):
        part = snout_labels == index
        colored = (smoke | cigarette | dark) & part
        if int(colored.sum()) > 40:
            snout_keep[index] = True
    paper = snout_fg & snout_keep[snout_labels]
    kept = body | (foreground & near_body) | features | paper
    white_speck = (red > 242) & (green > 240) & (blue > 232) & ((red - green) < 14) & ~paper
    kept &= ~lavender & ~white_speck
    labels, count = ndimage.label(kept)
    if count:
        keep_index = 1 + int(np.argmax([(labels == i).sum() for i in range(1, count + 1)]))
        main = labels == keep_index
        dist = ndimage.distance_transform_edt(~main)
        # Keep the smoke if the opening separated it, and drop curtain crumbs.
        for index in range(1, count + 1):
            if index == keep_index:
                continue
            part = labels == index
            if int(part.sum()) > 80 and float(dist[part].min()) < 36 and bool(snout_zone[part].mean() > 0.5):
                main |= part
        kept = main

    alpha = np.where(kept, 255, 0).astype(np.uint8)
    edge = kept & ~ndimage.binary_erosion(kept, border_value=0, iterations=1)
    alpha[edge & (rgb.min(axis=2) > 234)] = 0
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


def body_box(image: Image.Image):
    pixels = np.asarray(image)
    rgb, alpha = pixels[:, :, :3].astype(np.int16), pixels[:, :, 3]
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    body = (alpha > 180) & (red > 215) & (green > 155) & (green < 236) & (blue > 130) & ((red - green) > 20)
    labels, count = ndimage.label(body)
    if count == 0:
        ys, xs = np.where(alpha > 40)
    else:
        index = 1 + np.argmax([(labels == i).sum() for i in range(1, count + 1)])
        ys, xs = np.where(labels == index)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def normalize(image: Image.Image) -> Image.Image:
    left, top, right, bottom = body_box(image)
    body_height = max(1, bottom - top)
    scale = BODY_HEIGHT / body_height
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    left, top, right, bottom = [round(value * scale) for value in (left, top, right, bottom)]
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    origin_x = round(CANVAS[0] / 2 - (left + right) / 2)
    origin_y = BASELINE - bottom
    canvas.alpha_composite(resized, (origin_x, origin_y))
    return canvas


def app_icon(sprite: Image.Image, destination: Path) -> None:
    icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle((40, 40, 984, 984), radius=224, fill=(248, 236, 226, 255))
    fitted = sprite.copy()
    fitted.thumbnail((760, 760), Image.Resampling.LANCZOS)
    icon.alpha_composite(fitted, ((1024 - fitted.width) // 2, (1024 - fitted.height) // 2 + 20))
    iconset = destination / "AppIcon.iconset"
    iconset.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    names = {
        16: ["icon_16x16.png"],
        32: ["icon_16x16@2x.png", "icon_32x32.png"],
        64: ["icon_32x32@2x.png"],
        128: ["icon_128x128.png"],
        256: ["icon_128x128@2x.png", "icon_256x256.png"],
        512: ["icon_256x256@2x.png", "icon_512x512.png"],
        1024: ["icon_512x512@2x.png"],
    }
    for size in sizes:
        frame = icon.resize((size, size), Image.Resampling.LANCZOS)
        for name in names[size]:
            frame.save(iconset / name)
    master = destination / "AppIcon-1024.png"
    icon.save(master)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    good = None
    for name, filename in SOURCES.items():
        sprite = normalize(extract(REFERENCE / filename))
        sprite.save(OUTPUT / f"{name}.png", optimize=True)
        if name == "good":
            good = sprite
        print(name, sprite.size)
    app_icon(good, ROOT / "assets")


if __name__ == "__main__":
    main()
