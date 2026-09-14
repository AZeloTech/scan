"""Quality options.

Collect the CLI ``--quality`` presets and individual options in one place to
control the quality/speed tradeoff for feature extraction (processing
resolution), optimization (initial-value search and iteration count), and
rendering (grid density and interpolation).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace


@dataclass
class QualityOptions:
    proc_max_side: int = 1600  # Maximum resized-image side for extraction/optimization
    render_grid: int = 129  # Inverse-map grid resolution per side
    interp: str = "linear"  # remap interpolation: linear | cubic | lanczos
    max_nfev: int = 600  # Maximum number of least_squares evaluations
    n_outlier_iter: int = 3  # Number of outlier-removal iterations
    full_pose_multistart: bool = True  # False reduces pose candidates to three
    f_scan: bool = False  # Try multiple initial f values without EXIF
    f_exif_px: float | None = None  # EXIF-derived focal length in full-size pixels
    use_page_boundary: bool = True  # Refine trusted rectangular paper boundaries


PRESETS: dict[str, QualityOptions] = {
    "fast": QualityOptions(
        proc_max_side=1200,
        render_grid=65,
        max_nfev=300,
        n_outlier_iter=2,
        full_pose_multistart=False,
    ),
    "default": QualityOptions(),
    "high": QualityOptions(
        proc_max_side=2200,
        render_grid=257,
        interp="cubic",
        max_nfev=1200,
        n_outlier_iter=4,
        f_scan=True,
    ),
}


def make_options(preset: str = "default", **overrides) -> QualityOptions:
    """Create ``QualityOptions`` by applying individual overrides to a preset."""
    opts = PRESETS[preset]
    kwargs = {k: v for k, v in overrides.items() if v is not None}
    return replace(opts, **kwargs) if kwargs else opts


def _exif_f35(image_path: str) -> float | None:
    """Read FocalLengthIn35mmFilm (0xA405) from a JPEG APP1 (Exif) segment.

    This pure-Python implementation keeps OpenCV as the only dependency.
    ``cv2.imread`` applies EXIF orientation but does not expose tags, so this
    function reads the one required tag directly. Non-JPEG files (such as PNG)
    are treated as having no EXIF data and return ``None``.
    """
    import struct

    try:
        with open(image_path, "rb") as fp:
            if fp.read(2) != b"\xff\xd8":
                return None  # Not a JPEG
            # Scan markers for APP1 (Exif); it cannot occur after SOS.
            while True:
                b = fp.read(2)
                if len(b) < 2 or b[0] != 0xFF:
                    return None
                marker = b[1]
                if marker == 0xFF or 0xD0 <= marker <= 0xD9:
                    continue  # Padding / standalone marker
                (size,) = struct.unpack(">H", fp.read(2))
                if marker == 0xDA:
                    return None  # Start of Scan
                seg = fp.read(size - 2)
                if marker != 0xE1 or seg[:6] != b"Exif\x00\x00":
                    continue
                t = seg[6:]  # TIFF structure
                e = {b"II": "<", b"MM": ">"}.get(t[:2])
                if e is None or struct.unpack(e + "H", t[2:4])[0] != 42:
                    return None

                def read_ifd(off: int) -> dict[int, tuple[int, bytes]]:
                    (n,) = struct.unpack(e + "H", t[off : off + 2])
                    out = {}
                    for i in range(n):
                        p = off + 2 + 12 * i
                        tag, typ, _cnt = struct.unpack(e + "HHI", t[p : p + 8])
                        out[tag] = (typ, t[p + 8 : p + 12])
                    return out

                (ifd0_off,) = struct.unpack(e + "I", t[4:8])
                ifd0 = read_ifd(ifd0_off)
                if 0x8769 not in ifd0:  # Exif IFD pointer
                    return None
                (exif_off,) = struct.unpack(e + "I", ifd0[0x8769][1])
                exif = read_ifd(exif_off)
                if 0xA405 not in exif:  # FocalLengthIn35mmFilm
                    return None
                typ, val = exif[0xA405]
                if typ == 3:  # SHORT
                    return float(struct.unpack(e + "H", val[:2])[0])
                if typ == 4:  # LONG
                    return float(struct.unpack(e + "I", val)[0])
                return None
    except Exception:
        return None


def read_exif_focal_px(
    image_path: str, img_w: int, img_h: int
) -> float | None:
    """Estimate ``f`` in pixels from the EXIF 35 mm-equivalent focal length.

    ``f_px = FocalLengthIn35mmFilm / 43.266`` (35 mm frame diagonal in mm)
    ``* image diagonal (px)``. ``img_w`` and ``img_h`` are the dimensions of
    the loaded image; the diagonal is invariant under EXIF orientation.
    """
    f35 = _exif_f35(image_path)
    if not f35:
        return None
    return f35 / 43.266 * math.hypot(img_w, img_h)
