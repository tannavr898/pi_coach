"""Regenerate the favicon / app-icon / social-card set from the brand mark.

Run from the repo root with any Python that has Pillow:

    backend/.venv/Scripts/python.exe brand/gen_icons.py

Everything lands in frontend/public/, which Vite copies to dist/ verbatim, so the
files are served from the site root (/favicon.ico, /icon-512.png, ...). The
outputs are committed — this script exists so the set can be rebuilt when the
mark changes, not as part of the build.

WHY THE FAVICON IS NOT THE LOGO. brand/logo-120.png is the mark as it appears in
the product: three light indigo rings on white. That design disappears in a
browser tab — a white tile on a white tab strip, with 2.5px strokes rendered at
16px. So the icon set inverts it: an opaque indigo tile with a two-element white
bullseye. Same idea (concentric target = hit the mark), sized for 16px. Anything
with a third ring turns to mush at tab size; that was measured, not guessed.

Drawing happens at SS x the target size and is downsampled with LANCZOS, because
Pillow's ellipse outlines are not antialiased.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "public"

SS = 8  # supersample factor

INDIGO = (79, 70, 229, 255)     # #4f46e5 — brand indigo-600, the tile ground
INDIGO_DEEP = (67, 56, 202, 255)  # #4338ca — indigo-700, for the social card
WHITE = (255, 255, 255, 255)
SLATE = (15, 23, 42, 255)       # #0f172a
SLATE_MID = (148, 163, 184, 255)  # #94a3b8
INDIGO_PALE = (165, 180, 252, 255)  # #a5b4fc

# Geometry as fractions of the icon's edge, so every size is the same drawing.
RADIUS_F = 0.22   # tile corner radius
RING_R_F = 0.344  # outer ring centerline radius (176/512)
RING_W_F = 0.078  # outer ring stroke (40/512)
DOT_R_F = 0.121   # center dot radius (62/512)


def _bullseye(size: int, rounded: bool) -> Image.Image:
    """The icon at `size` px: indigo tile, white ring, white dot."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=RADIUS_F * n, fill=INDIGO)
    else:
        d.rectangle([0, 0, n - 1, n - 1], fill=INDIGO)

    c = n / 2
    r = RING_R_F * n
    w = RING_W_F * n
    d.ellipse([c - r, c - r, c + r, c + r], outline=WHITE, width=int(round(w)))

    dot = DOT_R_F * n
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def _ring_only(size: int) -> Image.Image:
    """The bullseye alone, white on transparent — for use over a colored ground."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c, r, w = n / 2, RING_R_F * n * 1.28, RING_W_F * n * 1.28
    d.ellipse([c - r, c - r, c + r, c + r], outline=WHITE, width=int(round(w)))
    dot = DOT_R_F * n * 1.28
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def _font(*names: str, size: int) -> ImageFont.FreeTypeFont:
    """First system font that loads, else Pillow's bitmap default."""
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _og_card() -> Image.Image:
    """1200x630 social card — what Google, iMessage, Slack and X show for a link."""
    w, h = 1200, 630
    img = Image.new("RGB", (w, h), INDIGO_DEEP[:3])
    d = ImageDraw.Draw(img)

    # A soft indigo wash across the lower half so the card is not a flat block.
    for y in range(h):
        t = max(0.0, (y - h * 0.35) / (h * 0.65))
        d.line(
            [(0, y), (w, y)],
            fill=tuple(int(a + (b - a) * t * 0.55) for a, b in zip(INDIGO_DEEP[:3], INDIGO[:3])),
        )

    # The mark rides on the card WITHOUT its indigo tile: an indigo tile on an
    # indigo card is a rectangle you can only just make out. White-on-indigo is
    # the same bullseye with the contrast the card actually needs.
    mark = _ring_only(132)
    img.paste(mark, (88, 96), mark)

    title = _font("seguisb.ttf", "segoeuib.ttf", "arialbd.ttf", size=54)
    head = _font("segoeuib.ttf", "arialbd.ttf", size=82)
    body = _font("segoeui.ttf", "arial.ttf", size=38)
    small = _font("segoeui.ttf", "arial.ttf", size=30)

    d.text((248, 128), "PI Coach", font=title, fill=WHITE[:3])
    d.text((88, 288), "Practice DECA role-plays", font=head, fill=WHITE[:3])
    d.text((88, 386), "out loud.", font=head, fill=INDIGO_PALE[:3])
    d.text(
        (88, 494),
        "Original scenarios, per-criterion feedback, 830 study flashcards.",
        font=body,
        fill=(214, 220, 252),
    )
    d.text((88, 552), "trypicoach.com", font=small, fill=(180, 190, 245))
    return img


def _favicon_svg() -> str:
    """Vector favicon for browsers that prefer it (crisp at every zoom)."""
    c, r, wdt, dot = 32, RING_R_F * 64, RING_W_F * 64, DOT_R_F * 64
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" '
        'aria-label="PI Coach">'
        f'<rect width="64" height="64" rx="{RADIUS_F * 64:.1f}" fill="#4f46e5"/>'
        f'<circle cx="{c}" cy="{c}" r="{r:.2f}" fill="none" stroke="#fff" '
        f'stroke-width="{wdt:.2f}"/>'
        f'<circle cx="{c}" cy="{c}" r="{dot:.2f}" fill="#fff"/>'
        "</svg>\n"
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # .ico carries 16/32/48/64 so the tab strip, the bookmarks bar and Windows
    # each get a frame drawn AT that size. Passing one big image and letting
    # Pillow's `sizes=` downscale it is visibly softer at 16px, where a 1px ring
    # has no pixels to spare — so each frame is supersampled and resolved
    # independently, then stapled together with append_images.
    frames = [_bullseye(s, rounded=True) for s in (16, 32, 48, 64)]
    frames[0].save(
        OUT / "favicon.ico",
        format="ICO",
        sizes=[(f.width, f.height) for f in frames],
        append_images=frames[1:],
    )

    _bullseye(192, rounded=True).save(OUT / "icon-192.png")
    _bullseye(512, rounded=True).save(OUT / "icon-512.png")

    # Maskable: Android crops to a circle, so the mark has to sit inside the inner
    # 80% safe zone. Drawn small on a full-bleed indigo square.
    mask = Image.new("RGBA", (512, 512), INDIGO)
    inner = _bullseye(512, rounded=False)
    inner = inner.resize((372, 372), Image.LANCZOS)
    mask.paste(inner, (70, 70), inner)
    mask.save(OUT / "icon-maskable-512.png")

    # iOS composites the touch icon on an opaque tile and applies its own mask,
    # so this one ships square with no transparency.
    _bullseye(180, rounded=False).convert("RGB").save(OUT / "apple-touch-icon.png")

    (OUT / "favicon.svg").write_text(_favicon_svg(), encoding="utf-8")
    _og_card().save(OUT / "og-image.png", optimize=True)

    for p in sorted(OUT.iterdir()):
        if p.suffix in {".png", ".ico", ".svg"}:
            print(f"  {p.name:26} {p.stat().st_size / 1024:7.1f} KB")


if __name__ == "__main__":
    main()
