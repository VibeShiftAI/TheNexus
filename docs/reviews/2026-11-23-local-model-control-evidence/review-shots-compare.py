"""Task fa032fc0: compare the three registered review screenshots (made by the
round-1 browser run) with the same three subjects from the browser check rerun
on the final tree (a scratch copy, so the registered files stay untouched).
Usage: python3 -I review-shots-compare.py <registered dir> <rerun dir> <bands png out>
Prints sha256, size, differing pixels and where they are; for the waiting shot
it also saves the differing text bands from both images, registered above rerun.
"""
import hashlib
import sys
from PIL import Image, ImageChops

REG, RERUN, BANDS_OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SUBJECTS = [
    "desktop-model-in-effect-and-list.png",
    "phone-model-in-effect-and-list.png",
    "desktop-switch-waiting-behind-local-job.png",
]


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def nonzero_mask(a, b):
    """255 where any channel differs, else 0."""
    return ImageChops.difference(a, b).point(lambda p: 255 if p else 0).convert("L")


def differing(a, b):
    d = nonzero_mask(a, b)
    return sum(1 for p in d.tobytes() if p), d.getbbox()


def row_bands(a, b):
    """Row ranges (inclusive) where the two images differ, gaps of 3 rows merged."""
    d = nonzero_mask(a, b)
    w, h = d.size
    data = d.tobytes()
    rows = [y for y in range(h) if any(data[y * w:(y + 1) * w])]
    bands = []
    for y in rows:
        if bands and y - bands[-1][1] <= 3:
            bands[-1][1] = y
        else:
            bands.append([y, y])
    return bands


def best_shift(a, b, y0, y1):
    """The vertical shift of the rerun (-3..3 device px) that best matches rows y0..y1."""
    w = a.size[0]

    def count(dy):
        ca = a.crop((0, y0, w, y1)).convert("L")
        cb = b.crop((0, y0 + dy, w, y1 + dy)).convert("L")
        d = ImageChops.difference(ca, cb).point(lambda p: 255 if p > 24 else 0)
        return sum(1 for p in d.tobytes() if p)

    best = min(range(-3, 4), key=count)
    return best, count(0), count(best)


for name in SUBJECTS:
    ra, rb = f"{REG}/{name}", f"{RERUN}/{name}"
    a, b = Image.open(ra).convert("RGB"), Image.open(rb).convert("RGB")
    print(f"== {name}")
    print(f"   registered sha256 {sha(ra)}  {a.size[0]}x{a.size[1]}")
    print(f"   rerun      sha256 {sha(rb)}  {b.size[0]}x{b.size[1]}")
    if a.size != b.size:
        print("   sizes differ")
        continue
    n, box = differing(a, b)
    total = a.size[0] * a.size[1]
    print(f"   differing pixels {n} of {total} ({100 * n / total:.3f}%), bounding box {box}")
    if n == 0:
        print("   identical pixels")
        continue
    bands = row_bands(a, b)
    if len(bands) <= 6:
        print(f"   differing row bands (device px): {bands}")
        if name.startswith("desktop-switch-waiting"):
            w = a.size[0]
            x0 = max(0, box[0] - 8)
            parts = []
            for y0, y1 in bands:
                for im in (a, b):
                    parts.append(im.crop((x0, max(0, y0 - 6), w, min(a.size[1], y1 + 7))))
            out = Image.new("RGB", (w - x0, sum(p.size[1] + 6 for p in parts)), (255, 0, 0))
            y = 0
            for p in parts:
                out.paste(p, (0, y))
                y += p.size[1] + 6
            out.save(BANDS_OUT)
            print(f"   saved the differing bands, registered above rerun, to {BANDS_OUT.split('/')[-1]}")
    else:
        zero = 0
        largest = 0
        lines = []
        for y0 in range(20, a.size[1] - 120, 100):
            best, at0, atbest = best_shift(a, b, y0, y0 + 100)
            zero += atbest == 0
            largest = max(largest, abs(best))
            lines.append(f"   rows {y0:4d}-{y0 + 100:4d}: best shift {best:+d} px, differing px {at0} unshifted, {atbest} shifted")
        print(f"   {len(bands)} differing row bands; per 100-row band, the vertical shift of the rerun that best matches:")
        print("\n".join(lines))
        print(f"   largest best shift: {largest} device px; a single shift leaves no differing pixel in {zero} of {len(lines)} bands")
        print("   (the shift search compares grey values at a threshold of 24 of 255; the differing-pixel count above counts any channel difference)")
