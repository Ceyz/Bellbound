"""Pre-decimate Hunyuan shape GLBs to relieve paint pipeline of heavy decimation.

Original Hunyuan shapes can be 500K-1.2M tris which makes the [Comfy3D]
Decimate Mesh node hang on 8GB VRAM. Pre-decimating to 50K tris with trimesh
is a few seconds per file and removes that bottleneck entirely.

Backups should already be made externally. This OVERWRITES the GLBs in place.

Usage:
    python predec_shapes.py [--target 50000] [--skip-existing-paint]
"""
import argparse
import os
import sys
import time

import trimesh

INPUT_DIR = r"Z:/AI_Tools/ComfyUI/output/chibi_shape"
PAINT_DIR = r"Z:/AI_Tools/ComfyUI/output/chibi_textured"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=50000,
                    help="Target tri count (default 50000, paint-friendly)")
    ap.add_argument("--skip-existing-paint", action="store_true",
                    help="Skip pre-decimating shapes whose paint already exists")
    args = ap.parse_args()

    if not os.path.isdir(INPUT_DIR):
        print(f"ERROR: {INPUT_DIR} does not exist")
        sys.exit(1)

    shapes = sorted(f for f in os.listdir(INPUT_DIR)
                    if f.startswith("batch_") and f.endswith(".glb"))
    print(f"Found {len(shapes)} shape GLBs in {INPUT_DIR}")
    print(f"Target tri count: {args.target}")
    print()

    skipped_paint = 0
    skipped_small = 0
    decimated = 0
    failed = 0

    t_start = time.time()
    for f in shapes:
        in_path = os.path.join(INPUT_DIR, f)
        # Extract asset name: batch_<name>_shape_00001_.glb -> <name>
        if "_shape_" not in f:
            continue
        asset_name = f.split("_shape_")[0].replace("batch_", "")

        # Skip if paint already done
        if args.skip_existing_paint:
            paint_path = os.path.join(PAINT_DIR, f"batch_{asset_name}.glb")
            if os.path.exists(paint_path):
                skipped_paint += 1
                continue

        try:
            t0 = time.time()
            mesh = trimesh.load(in_path, force="mesh")
            n_faces = len(mesh.faces)

            if n_faces <= args.target:
                print(f"  {asset_name}: {n_faces} tris already <= target, "
                      f"skipping")
                skipped_small += 1
                continue

            # trimesh 4.x wants target_reduction (0-1 ratio), not absolute count
            target_reduction = max(0.01, min(0.99, 1.0 - (args.target / n_faces)))
            simplified = mesh.simplify_quadric_decimation(target_reduction)
            if simplified is None or len(simplified.faces) == 0:
                print(f"  {asset_name}: FAILED (simplify returned empty)")
                failed += 1
                continue

            # Overwrite in place
            simplified.export(in_path)
            elapsed = time.time() - t0
            print(f"  {asset_name}: {n_faces} -> {len(simplified.faces)} tris "
                  f"in {elapsed:.1f}s")
            decimated += 1
        except Exception as e:
            print(f"  {asset_name}: FAILED {type(e).__name__}: {e}")
            failed += 1

    total = time.time() - t_start
    print()
    print(f"=== Done in {total:.1f}s ===")
    print(f"  Decimated:           {decimated}")
    print(f"  Already small (skip): {skipped_small}")
    print(f"  Paint exists (skip): {skipped_paint}")
    print(f"  Failed:              {failed}")


if __name__ == "__main__":
    main()
