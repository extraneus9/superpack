"""
Overlay settings — one description of what the floating recorder can look like and
where it can sit. Shared by app.py (Settings → Overlay tab) and overlay_qt.py (the
renderer) so both sides validate against the same rules.

Pure Python, no third-party imports: overlay_qt runs as its own light subprocess.

Placement model
---------------
The pill is pinned by a *reference point* P on screen and an *alignment* (ax, ay),
each 0 / 0.5 / 1. (ax, ay) says which point of the pill sits on P — left / centre /
right, top / middle / bottom — and it is also the direction the pill grows when it
expands from idle to recording. So a pill anchored top-left keeps its corner on the
screen edge and grows right/down; top-centre grows both ways sideways.

Presets (`overlay_anchor` = "top-left" … "bottom-right") derive P from the chosen
monitor and `overlay_margin`. "custom" uses the stored P/alignment (set by dragging).
"""

from __future__ import annotations

import re

# v1–v8 stored overlay_x/overlay_y as the top-left of a fixed 760×180 window whose
# centre was the pill's centre. Old configs are migrated to a custom centre-aligned pin.
LEGACY_WIN_W, LEGACY_WIN_H = 760, 180

SCALE_RANGE = (0.6, 1.6)     # overall size
WIDTH_RANGE = (0.5, 1.4)     # length of the expanded pill
GLOW_RANGE = (0.0, 2.0)      # halo strength (1.0 = the classic look)
MARGIN_RANGE = (0, 200)      # px between a preset anchor and the screen edge

# name -> (ax, ay)
ANCHORS = {
    "top-left": (0.0, 0.0),      "top-center": (0.5, 0.0),     "top-right": (1.0, 0.0),
    "middle-left": (0.0, 0.5),   "center": (0.5, 0.5),         "middle-right": (1.0, 0.5),
    "bottom-left": (0.0, 1.0),   "bottom-center": (0.5, 1.0),  "bottom-right": (1.0, 1.0),
}
ANCHOR_LABELS = {
    "top-left": "Top left", "top-center": "Top center", "top-right": "Top right",
    "middle-left": "Middle left", "center": "Center", "middle-right": "Middle right",
    "bottom-left": "Bottom left", "bottom-center": "Bottom center", "bottom-right": "Bottom right",
}

THEMES = ("dark", "light")
WAVES = ("bars", "fine", "wave")
SHAPES = ("pill", "rounded", "sharp")
IDLE_MODES = ("pill", "hidden")

DEFAULT_ACCENT = "#E63946"
ACCENT_SWATCHES = [
    ("Red", "#E63946"), ("Orange", "#F4A261"), ("Yellow", "#FFD23F"),
    ("Green", "#5EE07A"), ("Cyan", "#22D3EE"), ("Blue", "#4F7CFF"),
    ("Violet", "#A78BFA"), ("Pink", "#FF5C9E"), ("White", "#FFFFFF"),
]

DEFAULTS = {
    "show_overlay": True,
    "overlay_scale": 1.0,
    "overlay_width": 1.0,
    "overlay_theme": "dark",
    "overlay_accent": DEFAULT_ACCENT,
    "overlay_glow": 1.0,
    "overlay_wave": "bars",
    "overlay_wave_tint": False,
    "overlay_shape": "pill",
    "overlay_idle": "pill",
    "overlay_anchor": "top-center",
    "overlay_margin": 20,
    "overlay_monitor": -1,        # -1 = primary, else index into the screen list
    "overlay_px": None,           # custom pin (screen coords) — used when anchor == "custom"
    "overlay_py": None,
    "overlay_ax": 0.5,
    "overlay_ay": 0.5,
}
KEYS = tuple(DEFAULTS)

# One-click looks. They only touch appearance — never size, position or visibility.
STYLE_PRESETS = {
    "Classic": dict(overlay_theme="dark", overlay_accent="#E63946", overlay_glow=1.0,
                    overlay_wave="bars", overlay_wave_tint=False, overlay_shape="pill"),
    "Minimal": dict(overlay_theme="dark", overlay_accent="#E63946", overlay_glow=0.0,
                    overlay_wave="fine", overlay_wave_tint=False, overlay_shape="pill"),
    "Neon":    dict(overlay_theme="dark", overlay_accent="#22D3EE", overlay_glow=1.7,
                    overlay_wave="wave", overlay_wave_tint=True, overlay_shape="pill"),
    "Light":   dict(overlay_theme="light", overlay_accent="#E63946", overlay_glow=0.6,
                    overlay_wave="bars", overlay_wave_tint=False, overlay_shape="pill"),
    "Mono":    dict(overlay_theme="dark", overlay_accent="#FFFFFF", overlay_glow=0.7,
                    overlay_wave="bars", overlay_wave_tint=False, overlay_shape="rounded"),
}

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def is_hex(value) -> bool:
    return isinstance(value, str) and bool(_HEX.match(value))


def _num(value, lo, hi, default):
    try:
        x = float(value)
    except (TypeError, ValueError):
        return default
    if x != x:  # NaN
        return default
    return max(lo, min(hi, x))


def _pick(value, allowed, default):
    return value if value in allowed else default


def _align(value, default=0.5):
    """Snap to 0 / 0.5 / 1."""
    try:
        x = float(value)
    except (TypeError, ValueError):
        return default
    return min((0.0, 0.5, 1.0), key=lambda a: abs(a - x))


def _coord(value):
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return None if x != x else x


def resolve(cfg: dict | None) -> dict:
    """Merge `cfg` over the defaults and validate every value. Never raises."""
    cfg = cfg or {}
    s = dict(DEFAULTS)
    for k in KEYS:
        if k in cfg and cfg[k] is not None:
            s[k] = cfg[k]

    s["show_overlay"] = bool(s["show_overlay"])
    s["overlay_scale"] = _num(s["overlay_scale"], *SCALE_RANGE, DEFAULTS["overlay_scale"])
    s["overlay_width"] = _num(s["overlay_width"], *WIDTH_RANGE, DEFAULTS["overlay_width"])
    s["overlay_glow"] = _num(s["overlay_glow"], *GLOW_RANGE, DEFAULTS["overlay_glow"])
    s["overlay_theme"] = _pick(s["overlay_theme"], THEMES, "dark")
    s["overlay_accent"] = s["overlay_accent"].upper() if is_hex(s["overlay_accent"]) else DEFAULT_ACCENT
    s["overlay_wave"] = _pick(s["overlay_wave"], WAVES, "bars")
    s["overlay_wave_tint"] = bool(s["overlay_wave_tint"])
    s["overlay_shape"] = _pick(s["overlay_shape"], SHAPES, "pill")
    s["overlay_idle"] = _pick(s["overlay_idle"], IDLE_MODES, "pill")
    s["overlay_margin"] = int(round(_num(s["overlay_margin"], *MARGIN_RANGE, DEFAULTS["overlay_margin"])))
    try:
        s["overlay_monitor"] = max(-1, int(s["overlay_monitor"]))
    except (TypeError, ValueError):
        s["overlay_monitor"] = -1

    s["overlay_ax"] = _align(s["overlay_ax"])
    s["overlay_ay"] = _align(s["overlay_ay"])
    s["overlay_px"] = _coord(s["overlay_px"])
    s["overlay_py"] = _coord(s["overlay_py"])

    # v1–v8 config: a dragged position but no anchor key → keep the pill exactly where it was.
    if "overlay_anchor" not in cfg:
        lx, ly = _coord(cfg.get("overlay_x")), _coord(cfg.get("overlay_y"))
        if lx is not None and ly is not None:
            s.update(overlay_anchor="custom", overlay_px=lx + LEGACY_WIN_W / 2,
                     overlay_py=ly + LEGACY_WIN_H / 2, overlay_ax=0.5, overlay_ay=0.5)

    if s["overlay_anchor"] != "custom" and s["overlay_anchor"] not in ANCHORS:
        s["overlay_anchor"] = DEFAULTS["overlay_anchor"]
    if s["overlay_anchor"] == "custom" and (s["overlay_px"] is None or s["overlay_py"] is None):
        s["overlay_anchor"] = DEFAULTS["overlay_anchor"]   # custom with no pin stored
    return s


def current_style_preset(settings: dict) -> str | None:
    """Name of the style preset the (resolved) settings match exactly, else None."""
    for name, preset in STYLE_PRESETS.items():
        if all(
            (abs(settings.get(k, 0) - v) < 0.02) if isinstance(v, float) else settings.get(k) == v
            for k, v in preset.items()
        ):
            return name
    return None


def anchor_at(ax: float, ay: float) -> str | None:
    """Preset name for an alignment pair, if there is one."""
    for name, (a, b) in ANCHORS.items():
        if a == ax and b == ay:
            return name
    return None
