"""Overnight Hunyuan batch processor for Bellbound trait generation.

Reads queue.json, runs Pass 1 (shape) on all items first, then Pass 2 (paint) on
all items. Resilient to ComfyUI hangs via long timeouts. Resumable: skips
already-completed items based on output GLB presence.

Usage:
    python hunyuan_batch_submit.py [queue.json]

ComfyUI must already be running on http://127.0.0.1:8188.
Output shapes go to ComfyUI/output/chibi_shape/batch_<name>_shape_NNNNN_.glb
Output paints go to ComfyUI/output/chibi_textured/batch_<name>.glb

Each item in queue.json must have:
- name: short asset id used in filenames (e.g. "jacket_plain")
- source_path: absolute Z:/ path of the input PNG
- decimate: int, paint-pass decimate target (50000 chars / 80000 props)
- paint_mode: "Turbo" or "Standard"
- category: optional grouping label
"""
import json
import os
import shutil
import sys
import time
import urllib.request
import urllib.error


SERVER = "http://127.0.0.1:8188"
COMFY_INPUT_DIR = r"Z:/AI_Tools/ComfyUI/input"
OUTPUT_DIR_SHAPE = r"Z:/AI_Tools/ComfyUI/output/chibi_shape"
OUTPUT_DIR_PAINT = r"Z:/AI_Tools/ComfyUI/output/chibi_textured"
LOG_FILE = r"Z:/Islebound/scripts/hunyuan_overnight.log"
INPUT_PREFIX = "batch_"  # prefix for staged input filenames

# Per-pass safety budgets
SHAPE_MAX_WAIT = 3600       # 60 min per shape pass (typical 3-15 min, bumped for VRAM-pressure tolerance)
PAINT_TURBO_MAX_WAIT = 5400 # 90 min per Turbo paint (offload patch makes it slower, allow up to 90 min for decimate=80K outfits)
PAINT_STANDARD_MAX_WAIT = 14400  # 4h per Standard paint (we observed 2h on 3070)
POLL_INTERVAL = 15
POLL_TIMEOUT = 300  # /history can stall when GPU heavy; 5 min per request


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def build_shape_workflow(image_filename, save_prefix):
    return {
        "1": {"class_type": "LoadImage",
              "inputs": {"image": image_filename, "channel": "image"}},
        "2": {"class_type": "ImageOnlyCheckpointLoader",
              "inputs": {"ckpt_name": "hunyuan_3d_v2.1.safetensors"}},
        "3": {"class_type": "CLIPVisionEncode",
              "inputs": {"clip_vision": ["2", 1], "image": ["1", 0],
                         "crop": "center"}},
        "4": {"class_type": "Hunyuan3Dv2Conditioning",
              "inputs": {"clip_vision_output": ["3", 0]}},
        "5": {"class_type": "EmptyLatentHunyuan3Dv2",
              "inputs": {"resolution": 3072, "batch_size": 1}},
        "6": {"class_type": "KSampler",
              "inputs": {"model": ["2", 0], "seed": 12345, "steps": 30,
                         "cfg": 5.0, "sampler_name": "euler",
                         "scheduler": "simple",
                         "positive": ["4", 0], "negative": ["4", 1],
                         "latent_image": ["5", 0], "denoise": 1.0}},
        "7": {"class_type": "VAEDecodeHunyuan3D",
              "inputs": {"samples": ["6", 0], "vae": ["2", 2],
                         "num_chunks": 8000, "octree_resolution": 320}},
        "8": {"class_type": "VoxelToMesh",
              "inputs": {"voxel": ["7", 0], "algorithm": "surface net",
                         "threshold": 0.6}},
        "9": {"class_type": "SaveGLB",
              "inputs": {"mesh": ["8", 0], "filename_prefix": save_prefix}},
    }


def build_paint_workflow(image_filename, save_prefix, input_glb_path,
                         decimate=80000, paint_mode="Turbo"):
    if paint_mode not in ("Turbo", "Standard"):
        raise ValueError(f"paint_mode must be Turbo or Standard, got {paint_mode!r}")
    # Decimate node REMOVED: shapes are pre-decimated to 50K via predec_shapes.py
    # The [Comfy3D] Decimate Mesh node was the bottleneck on 8GB VRAM (hung on 1M+ tri inputs).
    return {
        "1": {"class_type": "[Comfy3D] Load 3D Mesh",
              "inputs": {"mesh_file_path": input_glb_path, "resize": False,
                         "renormal": True, "retex": False,
                         "optimizable": False, "clean": False,
                         "resize_bound": 0.5}},
        "2": {"class_type": "LoadImage",
              "inputs": {"image": image_filename, "channel": "image"}},
        "3": {"class_type": "[Comfy3D] Multi Background Remover",
              "inputs": {"image_front": ["2", 0]}},
        "4": {"class_type": "[Comfy3D] Load Hunyuan3D V2 TexGen Pipeline",
              "inputs": {"generation_mode": paint_mode}},
        "6": {"class_type": "[Comfy3D] Hunyuan3D V2 Paint Model Turbo MV",
              "inputs": {"hunyuan3d_v2_texgen_pipe": ["4", 0],
                         "mesh": ["1", 0], "images": ["3", 0]}},
        "7": {"class_type": "[Comfy3D] Save 3D Mesh",
              "inputs": {"mesh": ["6", 0], "save_path": save_prefix + ".glb"}},
    }


def post(path, data, timeout=60):
    req = urllib.request.Request(
        SERVER + path,
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get(path, timeout=POLL_TIMEOUT):
    with urllib.request.urlopen(SERVER + path, timeout=timeout) as r:
        return json.loads(r.read())


def submit_and_wait(workflow, label, max_wait_sec):
    """Submit a workflow and poll /history until done. Returns True on success."""
    try:
        res = post("/prompt", {"prompt": workflow,
                               "client_id": f"batch_{label}"}, timeout=60)
        pid = res["prompt_id"]
        log(f"  submitted {label}, prompt_id={pid}")
    except Exception as e:
        log(f"  SUBMIT FAILED {label}: {e}")
        return False

    t0 = time.time()
    consecutive_poll_errors = 0
    while True:
        elapsed = time.time() - t0
        if elapsed > max_wait_sec:
            log(f"  TIMEOUT {label} after {elapsed:.0f}s")
            return False
        try:
            hist = get(f"/history/{pid}")
            consecutive_poll_errors = 0
            if hist and pid in hist:
                entry = hist[pid]
                status = entry.get("status", {})
                if status.get("completed"):
                    log(f"  DONE {label} in {elapsed:.0f}s")
                    return True
                status_str = status.get("status_str", "")
                if status_str in ("error", "failed"):
                    log(f"  FAILED {label}: {status}")
                    return False
        except Exception as e:
            consecutive_poll_errors += 1
            if consecutive_poll_errors >= 8:
                log(f"  GIVING UP polling {label} after "
                    f"{consecutive_poll_errors} consecutive errors")
                return False
            log(f"  poll error #{consecutive_poll_errors} for {label}: "
                f"{type(e).__name__} (continuing)")
        time.sleep(POLL_INTERVAL)


def stage_inputs(queue):
    """Copy all source PNGs into ComfyUI/input/ with predictable names."""
    log(f"--- STAGING INPUTS into {COMFY_INPUT_DIR} ---")
    os.makedirs(COMFY_INPUT_DIR, exist_ok=True)
    for item in queue:
        src = item["source_path"]
        if not os.path.isfile(src):
            log(f"  MISSING source: {src} (item {item['name']} will fail)")
            item["_input_filename"] = None
            continue
        target_name = f"{INPUT_PREFIX}{item['name']}.png"
        target_path = os.path.join(COMFY_INPUT_DIR, target_name)
        try:
            if (not os.path.exists(target_path)
                    or os.path.getmtime(target_path) < os.path.getmtime(src)):
                shutil.copy2(src, target_path)
                log(f"  staged {item['name']} -> {target_name}")
            else:
                log(f"  staged {item['name']} (up-to-date)")
            item["_input_filename"] = target_name
        except Exception as e:
            log(f"  STAGE FAILED {item['name']}: {e}")
            item["_input_filename"] = None


def find_existing_shape(name):
    if not os.path.isdir(OUTPUT_DIR_SHAPE):
        return None
    prefix = f"batch_{name}_shape"
    for f in sorted(os.listdir(OUTPUT_DIR_SHAPE)):
        if f.startswith(prefix) and f.endswith(".glb"):
            return os.path.join(OUTPUT_DIR_SHAPE, f).replace("\\", "/")
    return None


def find_existing_paint(name):
    target = os.path.join(OUTPUT_DIR_PAINT, f"batch_{name}.glb")
    return target if os.path.exists(target) else None


def phase_shape(queue):
    log("--- PHASE 1: SHAPE GENERATION ---")
    for i, item in enumerate(queue):
        name = item["name"]
        if not item.get("_input_filename"):
            log(f"[{i+1}/{len(queue)}] SKIP (no staged input) {name}")
            continue
        existing = find_existing_shape(name)
        if existing:
            log(f"[{i+1}/{len(queue)}] SKIP shape exists: {name} -> {existing}")
            item["_shape_glb"] = existing
            continue
        log(f"[{i+1}/{len(queue)}] SHAPE {name}")
        wf = build_shape_workflow(item["_input_filename"],
                                  f"chibi_shape/batch_{name}_shape")
        ok = submit_and_wait(wf, f"shape_{name}", SHAPE_MAX_WAIT)
        if ok:
            item["_shape_glb"] = find_existing_shape(name)
            if not item["_shape_glb"]:
                log(f"  WARN: shape success but no GLB found for {name}")
        else:
            item["_shape_glb"] = None


def phase_paint(queue):
    log("--- PHASE 2: PAINT GENERATION ---")
    for i, item in enumerate(queue):
        name = item["name"]
        if not item.get("_shape_glb"):
            log(f"[{i+1}/{len(queue)}] SKIP (no shape) {name}")
            continue
        existing = find_existing_paint(name)
        if existing:
            log(f"[{i+1}/{len(queue)}] SKIP paint exists: {name}")
            continue
        paint_mode = item.get("paint_mode", "Turbo")
        decimate = item.get("decimate", 80000)
        log(f"[{i+1}/{len(queue)}] PAINT {name} ({paint_mode}, decimate={decimate})")
        wf = build_paint_workflow(item["_input_filename"],
                                  f"chibi_textured/batch_{name}",
                                  item["_shape_glb"], decimate, paint_mode)
        max_wait = (PAINT_STANDARD_MAX_WAIT if paint_mode == "Standard"
                    else PAINT_TURBO_MAX_WAIT)
        ok = submit_and_wait(wf, f"paint_{name}", max_wait)
        log(f"  {'SUCCESS' if ok else 'FAILED'}: {name}")


def main():
    queue_path = sys.argv[1] if len(sys.argv) > 1 else \
        r"Z:/Islebound/scripts/hunyuan_overnight_queue.json"
    with open(queue_path, "r", encoding="utf-8") as f:
        queue = json.load(f)
    log(f"=== BATCH START === {len(queue)} items in queue ({queue_path})")
    log(f"Output shape dir: {OUTPUT_DIR_SHAPE}")
    log(f"Output paint dir: {OUTPUT_DIR_PAINT}")

    # Verify ComfyUI is alive
    try:
        get("/system_stats", timeout=10)
        log("ComfyUI reachable.")
    except Exception as e:
        log(f"FATAL: ComfyUI not reachable at {SERVER}: {e}")
        sys.exit(2)

    stage_inputs(queue)
    phase_shape(queue)
    phase_paint(queue)

    # Summary
    n_shape = sum(1 for it in queue if it.get("_shape_glb"))
    n_paint = sum(1 for it in queue if find_existing_paint(it["name"]))
    log(f"=== BATCH END === shape:{n_shape}/{len(queue)} paint:{n_paint}/{len(queue)}")


if __name__ == "__main__":
    main()
