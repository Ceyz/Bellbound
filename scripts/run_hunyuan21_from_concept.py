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


DEFAULT_OUTPUT_DIR = Path(r"Z:\Bellbound\assets\generated_3d\hunyuan21")


def build_hunyuan21_prompt(
    image_name: str,
    filename_prefix: str,
    ckpt_name: str,
    image_size: int,
    latent_resolution: int,
    seed: int,
    steps: int,
    cfg: float,
    shift: float,
    sampler_name: str,
    scheduler: str,
    denoise: float,
    num_chunks: int,
    octree_resolution: int,
    mesh_algorithm: str,
    mesh_threshold: float,
    crop: str,
) -> dict:
    return {
        "1": {
            "class_type": "ImageOnlyCheckpointLoader",
            "inputs": {"ckpt_name": ckpt_name},
        },
        "2": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "3": {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {
                "model": ["1", 0],
                "shift": shift,
            },
        },
        "4": {
            "class_type": "EmptyLatentHunyuan3Dv2",
            "inputs": {
                "resolution": latent_resolution,
                "batch_size": 1,
            },
        },
        "6": {
            "class_type": "Hunyuan3Dv2Conditioning",
            "inputs": {"clip_vision_output": ["13", 0]},
        },
        "7": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["3", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "positive": ["6", 0],
                "negative": ["6", 1],
                "latent_image": ["4", 0],
                "denoise": denoise,
            },
        },
        "8": {
            "class_type": "VAEDecodeHunyuan3D",
            "inputs": {
                "samples": ["7", 0],
                "vae": ["1", 2],
                "num_chunks": num_chunks,
                "octree_resolution": octree_resolution,
            },
        },
        "9": {
            "class_type": "VoxelToMesh",
            "inputs": {
                "voxel": ["8", 0],
                "algorithm": mesh_algorithm,
                "threshold": mesh_threshold,
            },
        },
        "10": {
            "class_type": "SaveGLB",
            "inputs": {
                "mesh": ["9", 0],
                "filename_prefix": filename_prefix,
            },
        },
        "13": {
            "class_type": "CLIPVisionEncode",
            "inputs": {
                "clip_vision": ["1", 1],
                "image": ["20", 0],
                "crop": crop,
            },
        },
        "20": {
            "class_type": "ImageResize+",
            "inputs": {
                "image": ["2", 0],
                "width": image_size,
                "height": image_size,
                "interpolation": "nearest",
                "method": "stretch",
                "condition": "always",
                "multiple_of": 0,
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Bellbound concept image through ComfyUI native Hunyuan3D 2.1.")
    parser.add_argument("--image", required=True, type=Path, help="Source concept image.")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Final folder for copied GLB.")
    parser.add_argument("--name", default=None, help="Output base name, defaults to the image stem.")
    parser.add_argument("--server", default="http://127.0.0.1:8188", help="ComfyUI server URL.")
    parser.add_argument("--comfy-root", type=Path, default=DEFAULT_COMFY_ROOT)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--vcvars64", type=Path, default=DEFAULT_VCVARS64, help="Optional MSVC environment batch file for native extensions.")
    parser.add_argument("--ckpt-name", default="hunyuan_3d_v2.1.safetensors")
    parser.add_argument("--image-size", type=int, default=512)
    parser.add_argument("--latent-resolution", type=int, default=3072)
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--cfg", type=float, default=8.0)
    parser.add_argument("--shift", type=float, default=1.0)
    parser.add_argument("--sampler-name", default="euler")
    parser.add_argument("--scheduler", default="normal")
    parser.add_argument("--denoise", type=float, default=1.0)
    parser.add_argument("--num-chunks", type=int, default=8000)
    parser.add_argument("--octree-resolution", type=int, default=256)
    parser.add_argument("--mesh-algorithm", default="surface net", choices=["surface net", "basic"])
    parser.add_argument("--mesh-threshold", type=float, default=0.6)
    parser.add_argument("--crop", default="none", choices=["center", "none"])
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
    prefix = f"bellbound/{run_name}_hunyuan21"
    prompt = build_hunyuan21_prompt(
        copied_name,
        prefix,
        args.ckpt_name,
        args.image_size,
        args.latent_resolution,
        args.seed,
        args.steps,
        args.cfg,
        args.shift,
        args.sampler_name,
        args.scheduler,
        args.denoise,
        args.num_chunks,
        args.octree_resolution,
        args.mesh_algorithm,
        args.mesh_threshold,
        args.crop,
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

    args.out_dir.mkdir(parents=True, exist_ok=True)
    final_path = args.out_dir / f"{run_name}_hunyuan21.glb"
    shutil.copy2(glb, final_path)

    manifest = {
        "sourceImage": str(image),
        "comfyInputImage": copied_name,
        "comfyOutput": str(glb),
        "finalGlb": str(final_path),
        "workflow": "ComfyUI native Hunyuan3D 2.1",
        "ckptName": args.ckpt_name,
        "imageSize": args.image_size,
        "latentResolution": args.latent_resolution,
        "seed": args.seed,
        "steps": args.steps,
        "cfg": args.cfg,
        "shift": args.shift,
        "samplerName": args.sampler_name,
        "scheduler": args.scheduler,
        "denoise": args.denoise,
        "numChunks": args.num_chunks,
        "octreeResolution": args.octree_resolution,
        "meshAlgorithm": args.mesh_algorithm,
        "meshThreshold": args.mesh_threshold,
        "crop": args.crop,
        "offlineMode": not args.allow_downloads,
        "promptId": prompt_id,
    }
    (args.out_dir / f"{run_name}_hunyuan21_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(final_path)

    if proc is not None and not args.keep_server:
        proc.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
