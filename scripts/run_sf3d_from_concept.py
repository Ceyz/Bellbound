from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


DEFAULT_COMFY_ROOT = Path(r"Z:\AI_TOOLS\ComfyUI")
DEFAULT_PYTHON = Path(r"Z:\AI_TOOLS\venv310\Scripts\python.exe")
DEFAULT_OUTPUT_DIR = Path(r"Z:\Bellbound\assets\generated_3d\sf3d")
DEFAULT_VCVARS64 = Path(r"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat")


def request_json(url: str, payload: dict | None = None, timeout: int = 30) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc


def server_ready(server: str) -> bool:
    try:
        request_json(f"{server}/system_stats", timeout=3)
        return True
    except Exception:
        return False


def start_comfy(comfy_root: Path, python_exe: Path, server: str, offline: bool, vcvars64: Path | None) -> subprocess.Popen:
    host_port = server.replace("http://", "").replace("https://", "")
    host, port = host_port.split(":", 1)
    env = os.environ.copy()
    if offline:
        env.update(
            {
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "DIFFUSERS_OFFLINE": "1",
            }
        )
    env.setdefault("SPARSE_ATTN_BACKEND", "sdpa")
    env.setdefault("ATTN_BACKEND", "sdpa")
    if os.name == "nt" and vcvars64 and vcvars64.exists():
        command = f'call "{vcvars64}" && "{python_exe}" main.py --listen {host} --port {port}'
        args = ["cmd.exe", "/d", "/c", command]
    else:
        args = [str(python_exe), "main.py", "--listen", host, "--port", port]

    return subprocess.Popen(
        args,
        cwd=str(comfy_root),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )


def wait_for_server(server: str, timeout_s: int) -> None:
    start = time.time()
    while time.time() - start < timeout_s:
        if server_ready(server):
            return
        time.sleep(2)
    raise TimeoutError(f"ComfyUI did not become ready at {server} within {timeout_s}s")


def copy_input_image(image: Path, comfy_root: Path) -> str:
    input_dir = comfy_root / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    safe_name = f"bellbound_{image.stem}_{uuid.uuid4().hex[:8]}{image.suffix.lower()}"
    shutil.copy2(image, input_dir / safe_name)
    return safe_name


def build_sf3d_prompt(
    image_name: str,
    save_path: str,
    texture_resolution: int,
    target_tris: int,
    foreground_ratio: float,
) -> dict:
    save_mesh_input = ["8", 0] if target_tris > 0 else ["43", 0]
    prompt = {
        "1": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "20": {
            "class_type": "ImageResize+",
            "inputs": {
                "image": ["1", 0],
                "width": 512,
                "height": 512,
                "interpolation": "nearest",
                "method": "stretch",
                "condition": "always",
                "multiple_of": 0,
            },
        },
        "4": {
            "class_type": "RemBGSession+",
            "inputs": {
                "model": "u2net: general purpose",
                "providers": "CPU",
            },
        },
        "11": {
            "class_type": "ImageRemoveBackground+",
            "inputs": {
                "rembg_session": ["4", 0],
                "image": ["20", 0],
            },
        },
        "36": {
            "class_type": "[Comfy3D] Load SF3D Model",
            "inputs": {"model_name": "model.safetensors"},
        },
        "40": {
            "class_type": "[Comfy3D] Resize Image Foreground",
            "inputs": {
                "images": ["11", 0],
                "masks": ["11", 1],
                "foreground_ratio": foreground_ratio,
            },
        },
        "37": {
            "class_type": "[Comfy3D] StableFast3D",
            "inputs": {
                "sf3d_model": ["36", 0],
                "reference_image": ["40", 0],
                "reference_mask": ["40", 1],
                "texture_resolution": texture_resolution,
                "remesh_option": "None",
            },
        },
        "43": {
            "class_type": "[Comfy3D] Switch Mesh Axis",
            "inputs": {
                "mesh": ["37", 0],
                "axis_x_to": "-x",
                "axis_y_to": "+y",
                "axis_z_to": "-z",
                "flip_normal": False,
                "scale": 1,
            },
        },
        "8": {
            "class_type": "[Comfy3D] Decimate Mesh",
            "inputs": {
                "mesh": ["43", 0],
                "target": target_tris,
                "remesh": True,
                "optimalplacement": True,
            },
        },
        "9": {
            "class_type": "[Comfy3D] Save 3D Mesh",
            "inputs": {
                "mesh": save_mesh_input,
                "save_path": save_path,
            },
        },
    }
    if target_tris <= 0:
        prompt.pop("8")
    return prompt


def newest_glb_since(output_root: Path, since: float) -> Path | None:
    candidates = [
        p
        for p in output_root.rglob("*.glb")
        if p.is_file() and p.stat().st_mtime >= since - 1
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def wait_for_prompt(server: str, prompt_id: str, timeout_s: int) -> dict:
    start = time.time()
    while time.time() - start < timeout_s:
        history = request_json(f"{server}/history/{prompt_id}", timeout=15)
        if prompt_id in history:
            return history[prompt_id]
        time.sleep(3)
    raise TimeoutError(f"Prompt {prompt_id} did not finish within {timeout_s}s")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Bellbound concept image through local ComfyUI StableFast3D.")
    parser.add_argument("--image", required=True, type=Path, help="Source concept image.")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Final folder for copied GLB.")
    parser.add_argument("--name", default=None, help="Output base name, defaults to the image stem.")
    parser.add_argument("--server", default="http://127.0.0.1:8188", help="ComfyUI server URL.")
    parser.add_argument("--comfy-root", type=Path, default=DEFAULT_COMFY_ROOT)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--vcvars64", type=Path, default=DEFAULT_VCVARS64, help="Optional MSVC environment batch file for slangtorch.")
    parser.add_argument("--texture-resolution", type=int, default=1024)
    parser.add_argument("--target-tris", type=int, default=0, help="Decimate target tris. Use 0 to skip the fragile Comfy3D decimate step.")
    parser.add_argument("--foreground-ratio", type=float, default=0.85)
    parser.add_argument("--timeout", type=int, default=1200)
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
    comfy_save_path = f"bellbound\\{run_name}_sf3d_%Y-%m-%d-%H-%M-%S.glb"
    prompt = build_sf3d_prompt(
        copied_name,
        comfy_save_path,
        texture_resolution=args.texture_resolution,
        target_tris=args.target_tris,
        foreground_ratio=args.foreground_ratio,
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
    final_path = args.out_dir / f"{run_name}_sf3d.glb"
    shutil.copy2(glb, final_path)

    manifest = {
        "sourceImage": str(image),
        "comfyInputImage": copied_name,
        "comfyOutput": str(glb),
        "finalGlb": str(final_path),
        "workflow": "StableFast3D via ComfyUI-3D-Pack",
        "textureResolution": args.texture_resolution,
        "targetTris": args.target_tris,
        "foregroundRatio": args.foreground_ratio,
        "offlineMode": not args.allow_downloads,
        "promptId": prompt_id,
    }
    (args.out_dir / f"{run_name}_sf3d_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(final_path)

    if proc is not None and not args.keep_server:
        proc.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
