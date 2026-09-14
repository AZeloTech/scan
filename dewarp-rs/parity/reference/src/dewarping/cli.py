"""Command-line interface with positional arguments and quality options:

    dewarping (input image) (rectified image) [flag1] [flag2] [options]

- flag1: 1 = use the line-segment term, 0 = text lines only
- flag2: 1 = write a debug image (<output>_debug.png), 0 = do not write one

Quality options:
- --quality {fast,default,high}: preset for processing resolution,
  initial-value search, and rendering quality
- --proc-size/--render-grid/--interp/--max-nfev/--outlier-iter:
  individual overrides
- --no-exif: ignore the EXIF focal length
- --f-scan: try three initial focal lengths corresponding to FOVs of
  71°/53°/37°
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dewarping",
        usage="dewarping (input image) (rectified image) (flag1) (flag2) [options]",
        description="Document image dewarping using classical optimization",
    )
    p.add_argument("input", help="input image")
    p.add_argument("output", help="output path for the rectified image")
    p.add_argument("flag1", nargs="?", type=int, default=1,
                   help="1=include the line-segment term (default) / 0=text lines only")
    p.add_argument("flag2", nargs="?", type=int, default=0,
                   help="1=write a debug image / 0=do not write one (default)")
    p.add_argument("--quality", choices=["fast", "default", "high"],
                   default="default", help="quality preset (default: default)")
    p.add_argument("--proc-size", type=int, default=None,
                   help="maximum side of the resized image used for feature extraction and optimization (default: preset value)")
    p.add_argument("--render-grid", type=int, default=None,
                   help="inverse-map grid resolution (default: preset value)")
    p.add_argument("--interp", choices=["linear", "cubic", "lanczos"], default=None,
                   help="output interpolation (default: preset value)")
    p.add_argument("--max-nfev", type=int, default=None,
                   help="maximum number of residual evaluations during optimization (default: preset value)")
    p.add_argument("--outlier-iter", type=int, default=None,
                   help="number of outlier-removal iterations (default: preset value)")
    p.add_argument("--scene", action="store_true",
                   help="curved-object mode for real-world scenes such as bottles and cans: "
                        "detect a salient object and restrict feature extraction to it")
    p.add_argument("--no-exif", action="store_true",
                   help="ignore the EXIF focal length")
    p.add_argument("--f-scan", action="store_true", default=None,
                   help="try multiple initial focal lengths (used only without EXIF)")
    p.add_argument("--no-page-boundary", action="store_true",
                   help="disable automatic refinement using a trusted paper boundary")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    input_path = Path(args.input)
    output_path = Path(args.output)

    img = cv2.imread(str(input_path), cv2.IMREAD_COLOR)
    if img is None:
        print(f"There is no input image : ({input_path})")
        return 1

    from .dewarp import dewarp_image  # Lazy import to reduce startup time
    from .options import make_options, read_exif_focal_px

    f_exif = (
        None
        if args.no_exif
        else read_exif_focal_px(str(input_path), img.shape[1], img.shape[0])
    )
    opts = make_options(
        args.quality,
        proc_max_side=args.proc_size,
        render_grid=args.render_grid,
        interp=args.interp,
        max_nfev=args.max_nfev,
        n_outlier_iter=args.outlier_iter,
        f_scan=args.f_scan,
        f_exif_px=f_exif,
        use_page_boundary=not args.no_page_boundary,
    )

    t0 = time.perf_counter()
    print(f"Run - Parameter Estimation & Dewarping : {input_path}")
    out = dewarp_image(
        img,
        use_line_term=(args.flag1 != 0),
        debug=(args.flag2 != 0),
        verbose=True,
        opts=opts,
        scene=args.scene,
    )
    elapsed = time.perf_counter() - t0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    ok = cv2.imwrite(str(output_path), out.rectified)
    if not ok:
        print(f"failed to write : ({output_path})")
        return 1
    if out.debug_image is not None:
        debug_path = output_path.with_name(output_path.stem + "_debug.png")
        cv2.imwrite(str(debug_path), out.debug_image)
    print(f"done in {elapsed:.1f}s -> {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
