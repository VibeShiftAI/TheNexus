#!/usr/bin/env python3
"""Generate the Nexus app icon: the living Praxis core on a dark squircle.

Matches the bridge dashboard's CoreCanvas visual language — glowing cyan
core, thin orbit rings, particle swarm — rendered at 2048px and downsampled
to a 1024px macOS icon (824px squircle centered per Apple's icon grid).

Run with a python that has numpy + Pillow:
    /Volumes/Projects/TheCortex/TheCortex/venv/bin/python icon-gen.py
Then regenerate the app icon set:
    npx tauri icon icon-source.png && npm run build
"""

import numpy as np
from PIL import Image

S = 2048            # supersample canvas
OUT = 1024          # final size
CX = CY = S / 2

y, x = np.mgrid[0:S, 0:S].astype(np.float64)
dx, dy = x - CX, y - CY
dist = np.sqrt(dx * dx + dy * dy)

rgb = np.zeros((S, S, 3), dtype=np.float64)
alpha = np.zeros((S, S), dtype=np.float64)


def add_glow(radius, color, intensity, falloff, center=None):
    """Additive radial glow: intensity * exp(-((d - radius)/falloff)^2)."""
    d = dist if center is None else np.sqrt((x - center[0]) ** 2 + (y - center[1]) ** 2)
    g = intensity * np.exp(-((d - radius) / falloff) ** 2)
    for i in range(3):
        rgb[..., i] += g * color[i]


# ── Squircle base (Apple grid: 824/1024 of canvas, radius ≈ 22.5%) ──
half = S * 824 / 1024 / 2
corner = half * 0.45
bx = np.maximum(np.abs(dx) - (half - corner), 0)
by = np.maximum(np.abs(dy) - (half - corner), 0)
sdf = np.sqrt(bx * bx + by * by) - corner          # <0 inside
mask = np.clip(0.5 - sdf / 2.0, 0, 1)              # anti-aliased edge

# Background: deep slate with a faint navy center glow
for i, c in enumerate((0.008, 0.024, 0.09)):       # ~#020617 slate-950
    rgb[..., i] = c
add_glow(0, (0.03, 0.10, 0.22), 0.9, S * 0.30)     # ambient navy center
alpha = mask.copy()

CYAN = (0.13, 0.83, 0.93)      # #22d3ee
DEEP = (0.05, 0.45, 0.56)      # #0e7490

# ── Orbit rings ──
rng = np.random.default_rng(7)
for r_frac, a in ((0.190, 0.30), (0.252, 0.24), (0.318, 0.18)):
    r = S * r_frac
    ring = a * np.exp(-((dist - r) / (S * 0.0022)) ** 2)
    for i in range(3):
        rgb[..., i] += ring * CYAN[i]

# ── Particle swarm on the rings ──
for r_frac, n in ((0.190, 6), (0.252, 7), (0.318, 8)):
    r = S * r_frac
    for _ in range(n):
        ang = rng.uniform(0, 2 * np.pi)
        px, py = CX + np.cos(ang) * r, CY + np.sin(ang) * r
        size = rng.uniform(S * 0.004, S * 0.009)
        bright = rng.uniform(0.5, 1.0)
        col = CYAN if rng.random() > 0.3 else (0.75, 0.95, 1.0)
        add_glow(0, col, bright, size, center=(px, py))

# ── The core ──
add_glow(0, CYAN, 0.55, S * 0.150)                     # wide outer aura
add_glow(0, DEEP, 1.0, S * 0.085)                      # deep body
add_glow(0, CYAN, 1.1, S * 0.052)                      # hot cyan
add_glow(0, (1.0, 1.0, 1.0), 1.0, S * 0.024)           # white-hot center
add_glow(S * 0.118, CYAN, 0.35, S * 0.004)             # rim ring

# Subtle inner border so the squircle edge reads on dark docks
edge = np.exp(-((sdf + S * 0.004) / (S * 0.0015)) ** 2) * 0.10
for i in range(3):
    rgb[..., i] += edge * (0.4, 0.75, 0.85)[i]

# ── Composite ──
rgb = np.clip(rgb, 0, 1)
img = np.dstack([rgb, alpha[..., None]])
img8 = (img * 255).astype(np.uint8)
out = Image.fromarray(img8, "RGBA").resize((OUT, OUT), Image.LANCZOS)
out.save("icon-source.png")
print(f"wrote icon-source.png ({OUT}x{OUT})")
