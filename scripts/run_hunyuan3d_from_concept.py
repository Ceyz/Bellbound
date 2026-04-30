from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import uuid
from pathlib import Path

from run_sf3d_from_concept import (
    DEFAULT_COMFY_ROOT,
    DEFAULT_PYTHON,
    DEFAULT_VCVARS64,
    copy_input_image,
    newest_glb_since,
    request_json,
    server_ready,
    start_comfy,
    wait_for_prompt,
    wait_for_server,
)


DEFAULT_OUTPUT_DIR = Path(r"Z:\Bellbound\assets\generated_3d\hunyuan3d")


def build_hunyuan_prompt(
    image_name: str,
    shape_save_path: str,
    tex_save_path: str | None,
    generation_mode: str,
    weights_format: str,
    flash_vdm: bool,
    seed: int,
    guidance_scale: float,
    num_inference_steps: int,
    octree_resolution: int,
    texgen_mode: str,
) -> dict:
    prompt = {
        "1": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "2": {
            "class_type": "[Comfy3D] Multi Background Remover",
            "inputs": {"image_front": ["1", 0]},
        },
        "3": {
            "class_type": "[Comfy3D] Load Hunyuan3D V2 ShapeGen Pipeline",
            "inputs": {
                "generation_mode": generation_mode,
                "weights_format": weights_format,
                "flash_vdm": flash_vdm,
            },
        },
        "4": {
            "class_type": "[Comfy3D] Hunyuan3D V2 ShapeGen MV",
            "inputs": {
                "shapegen_pipe": ["3", 0],
                "images": ["2", 0],
                "seed": seed,
                "guidance_scale": guidance_scale,
                "num_inference_steps": num_inference_steps,
                "octree_resolution": octree_resolution,
            },
        },
        "5": {
            "class_type": "[Comfy3D] Save 3D Mesh",
            "inputs": {
                "mesh": ["4", 0],
                "save_path": shape_save_path,
            },
        },
    }

    if tex_save_path:
        prompt.update(
            {
                "6": {
                    "class_type": "[Comfy3D] Load Hunyuan3D V2 TexGen Pipeline",
                    "inputs": {"generation_mode": texgen_mode},
                },
                "7": {
                    "class_type": "[Comfy3D] Hunyuan3D V2 Paint Model Turbo MV",
                    "inputs": {
                        "hunyuan3d_v2_texgen_pipe": ["6", 0],
                        "mesh": ["4", 0],
                        "images": ["2", 0],
                    },
                },
                "8": {
                    "class_type": "[Comfy3D] Save 3D Mesh",
                    "inputs": {
                        "mesh": ["7", 0],
                        "save_path": tex_save_path,
                    },
                },
            }
        )

    return prompt


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Bellbound concept image through local ComfyUI Hunyuan3D V2.")
    parser.add_argument("--image", required=True, type=Path, help="Source concept image.")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Final folder for copied GLB.")
    parser.add_argument("--name", default=None, help="Output base name, defaults to the image stem.")
    parser.add_argument("--server", default="http://127.0.0.1:8188", help="ComfyUI server URL.")
    parser.add_argument("--comfy-root", type=Path, default=DEFAULT_COMFY_ROOT)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--vcvars64", type=Path, default=DEFAULT_VCVARS64, help="Optional MSVC environment batch file for slangtorch.")
    parser.add_argument("--mode", default="Hunyuan3D-2mini-Turbo", help="ShapeGen generation mode.")
    parser.add_argument("--weights-format", default="safetensors", choices=["safetensors", "ckpt"])
    parser.add_argument("--disable-flash-vdm", action="store_true")
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--guidance-scale", type=float, default=5.0)
    parser.add_argument("--steps", type=int, default=5, help="Turbo: 5; Fast/Standard: 30-40.")
    parser.add_argument("--octree-resolution", type=int, default=256)
    parser.add_argument("--texture", action="store_true", help="Also run Hunyuan TexGen/Paint and save a textured GLB.")
    parser.add_argument("--texgen-mode", default="Turbo", choices=["Standard", "Turbo"])
    parser.add_argument("--timeout", type=int, default=2400)
    parser.add_argument("--start-server", action="store_true", help="Start ComfyUI if it is not already running.")
    parser.add_argument("--keep-server", action="store_true", help="Do not terminate a ComfyUI process started by this script.")
    parser.add_argument("--allow-downloads", action="store_true", help="Do not force Hugging Face / diffusers offline mode.")
    args = parser.parse_args()

    image = args.image.resolve()
    if not image.exists():
        raise FileNotFoundError(image)
    if not args.comfy_root.exists():
        raise FileNotFoundError(args.comfy_root)
    if not args.python.exists():
        raise FileNotFoundError(args.python)

    proc = None
    if not server_ready(args.server):
        if not args.start_server:
            print(f"ComfyUI is not running at {args.server}. Re-run with --start-server.", file=sys.stderr)
            return 2
        proc = start_comfy(args.comfy_root, args.python, args.server, offline=not args.allow_downloads, vcvars64=args.vcvars64)
        wait_for_server(args.server, timeout_s=420)

    copied_name = copy_input_image(image, args.comfy_root)
    output_root = args.comfy_root / "output"
    run_name = args.name or image.stem
    shape_save_path = f"bellbound\\{run_name}_hunyuan_shape_%Y-%m-%d-%H-%M-%S.glb"
    tex_save_path = f"bellbound\\{run_name}_hunyuan_tex_%Y-%m-%d-%H-%M-%S.glb" if args.texture else None
    prompt = build_hunyuan_prompt(
        copied_name,
        shape_save_path,
        tex_save_path,
        args.mode,
        args.weights_format,
        not args.disable_flash_vdm,
        args.seed,
        args.guidance_scale,
        args.steps,
        args.octree_resolution,
        args.texgen_mode,
    )

    started_at = time.time()
    client_id = uuid.uuid4().hex
    result = request_json(args.server + "/prompt", {"prompt": prompt, "client_id": client_id}, timeout=30)
    prompt_id = result.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI did not return a prompt_id: {result}")

    print(f"Queued {prompt_id} for {image.name}")
    history = wait_for_prompt(args.server, prompt_id, args.timeout)
    if history.get("status", {}).get("status_str") != "success":
        raise RuntimeError(json.dumps(history.get("status", history), indent=2))

    glb = newest_glb_since(output_root, started_at)
    if not glb:
        raise RuntimeError("Prompt finished but no new GLB was found in ComfyUI output.")

    suffix = "hunyuan_tex" if args.texture else "hunyuan_shape"
    args.out_dir.mkdir(parents=True, exist_ok=True)
    final_path = args.out_dir / f"{run_name}_{suffix}.glb"
    shutil.copy2(glb, final_path)

    manifest = {
        "sourceImage": str(image),
        "comfyInputImage": copied_name,
        "comfyOutput": str(glb),
        "finalGlb": str(final_path),
        "workflow": "Hunyuan3D V2 via ComfyUI-3D-Pack",
        "mode": args.mode,
        "weightsFormat": args.weights_format,
        "flashVdm": not args.disable_flash_vdm,
        "seed": args.seed,
        "guidanceScale": args.guidance_scale,
        "steps": args.steps,
        "octreeResolution": args.octree_resolution,
        "texture": args.texture,
        "texgenMode": args.texgen_mode if args.texture else None,
        "offlineMode": not args.allow_downloads,
        "promptId": prompt_id,
    }
    (args.out_dir / f"{run_name}_{suffix}_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(final_path)

    if proc is not None and not args.keep_server:
        proc.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
