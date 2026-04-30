"""
Robust overnight batch wrapper for Hunyuan paint pipeline.

Monitors GPU utilization. If GPU stalls (<5% for >5 min), kills ComfyUI,
restarts, skips current item, continues queue. Retries failed items once at end.

Usage:
    python hunyuan_overnight_watchdog.py [queue.json]

Default queue: hunyuan_overnight_queue.json
"""
import json
import subprocess
import time
import os
import sys
import urllib.request

QUEUE_FILE = sys.argv[1] if len(sys.argv) > 1 else r"Z:\Bellbound\scripts\hunyuan_overnight_queue.json"
PAINT_DIR = r"Z:\AI_Tools\ComfyUI\output\chibi_textured"
LOG_DIR = r"Z:\Bellbound\scripts\overnight_logs"
PYTHON = r"Z:\AI_Tools\venv310\Scripts\python.exe"
BATCH_SCRIPT = r"Z:\Bellbound\scripts\hunyuan_batch_submit.py"
COMFYUI_START_PS1 = r"Z:\Bellbound\scripts\start_comfyui_3d.ps1"

GPU_STALL_THRESHOLD = 2      # %  (was 5 — bake step legitimately drops to 5-10%)
STALL_DURATION_SEC = 600     # 10 min stalled = restart (was 5 — bake takes long)
MAX_ITEM_DURATION = 60 * 90  # 90 min hard timeout per item
GPU_POLL_INTERVAL = 30       # sec
COMFYUI_RESTART_WAIT = 180   # 3 min for ComfyUI to come back up after restart

OVERALL_LOG = os.path.join(LOG_DIR, 'overnight_watchdog.log')


def log(msg):
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(OVERALL_LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def gpu_util():
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5
        )
        return int(result.stdout.strip().split('\n')[0])
    except Exception:
        return -1


def comfyui_alive():
    try:
        urllib.request.urlopen('http://127.0.0.1:8188/system_stats', timeout=3)
        return True
    except Exception:
        return False


def wait_for_comfyui(timeout=300):
    start = time.time()
    while time.time() - start < timeout:
        if comfyui_alive():
            return True
        time.sleep(5)
    return False


def kill_python_processes():
    """Kill all python except blender-mcp (PID 2932)"""
    subprocess.run(
        ['powershell', '-NoProfile', '-Command',
         "Get-Process python -ErrorAction SilentlyContinue | Where-Object {$_.Id -ne 2932} | Stop-Process -Force"],
        capture_output=True, timeout=30
    )


def start_comfyui():
    log_tag = time.strftime('%Y%m%d_%H%M%S')
    out_path = os.path.join(LOG_DIR, f'comfy_{log_tag}.out.log')
    err_path = os.path.join(LOG_DIR, f'comfy_{log_tag}.err.log')
    out_f = open(out_path, 'w')
    err_f = open(err_path, 'w')
    # DETACHED_PROCESS = 0x00000008 — fully detached so subprocess survives if parent dies
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen(
            ['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-File', COMFYUI_START_PS1],
            stdout=out_f, stderr=err_f,
            creationflags=flags,
            close_fds=True
        )
        log(f"  ComfyUI start_comfyui invoked (logs: comfy_{log_tag})")
    except Exception as e:
        log(f"  !! start_comfyui exception: {e}")


def find_existing_paint(name):
    target = os.path.join(PAINT_DIR, f'batch_{name}.glb')
    return os.path.exists(target)


def process_item(item):
    name = item['name']
    if find_existing_paint(name):
        log(f"  SKIP {name} (paint exists)")
        return 'skipped'

    # Write single-item queue
    single_queue = os.path.join(LOG_DIR, f'_single_{name}.json')
    with open(single_queue, 'w') as f:
        json.dump([item], f)

    # Launch batch submit
    log_tag = time.strftime('%Y%m%d_%H%M%S')
    batch_out = os.path.join(LOG_DIR, f'batch_{name}_{log_tag}.out.log')
    batch_err = os.path.join(LOG_DIR, f'batch_{name}_{log_tag}.err.log')
    proc = subprocess.Popen(
        [PYTHON, BATCH_SCRIPT, single_queue],
        stdout=open(batch_out, 'w'),
        stderr=open(batch_err, 'w')
    )

    start = time.time()
    stall_start = None
    while True:
        # Process exited?
        if proc.poll() is not None:
            elapsed = time.time() - start
            if find_existing_paint(name):
                log(f"  OK {name} in {elapsed:.0f}s")
                return 'success'
            else:
                log(f"  FAIL {name} after {elapsed:.0f}s (no GLB)")
                return 'failed'

        # Hard timeout
        elapsed = time.time() - start
        if elapsed > MAX_ITEM_DURATION:
            log(f"  TIMEOUT {name} after {elapsed:.0f}s")
            proc.terminate()
            time.sleep(5)
            proc.kill()
            return 'failed'

        # GPU stall detection
        util = gpu_util()
        if util != -1 and util < GPU_STALL_THRESHOLD:
            if stall_start is None:
                stall_start = time.time()
                log(f"  ! GPU drop detected (util={util}%) at {elapsed:.0f}s")
            elif time.time() - stall_start > STALL_DURATION_SEC:
                log(f"  STALL {name} GPU<{GPU_STALL_THRESHOLD}% for {STALL_DURATION_SEC}s, recovering")
                proc.terminate()
                time.sleep(5)
                proc.kill()
                kill_python_processes()
                time.sleep(15)  # let ports + GPU memory release fully
                start_comfyui()
                if not wait_for_comfyui(timeout=COMFYUI_RESTART_WAIT):
                    log(f"  ! ComfyUI restart failed after {COMFYUI_RESTART_WAIT}s")
                    # Try one more time
                    time.sleep(10)
                    start_comfyui()
                    if not wait_for_comfyui(timeout=COMFYUI_RESTART_WAIT):
                        log("  !! ComfyUI fully dead, aborting watchdog")
                        sys.exit(2)
                log("  ComfyUI restarted OK, continuing queue")
                return 'failed'
        else:
            if stall_start is not None:
                log(f"  GPU recovered (util={util}%)")
            stall_start = None

        time.sleep(GPU_POLL_INTERVAL)


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(QUEUE_FILE, encoding='utf-8') as f:
        queue = json.load(f)

    if not comfyui_alive():
        log("ComfyUI not running, starting...")
        start_comfyui()
        if not wait_for_comfyui():
            log("FATAL: ComfyUI failed to start initially")
            return

    log(f"=== START OVERNIGHT WATCHDOG ({len(queue)} items, queue={QUEUE_FILE}) ===")

    failed = []
    skipped = 0
    succeeded = 0
    for i, item in enumerate(queue):
        log(f"[{i+1}/{len(queue)}] {item['name']}")
        result = process_item(item)
        if result == 'failed':
            failed.append(item)
        elif result == 'skipped':
            skipped += 1
        elif result == 'success':
            succeeded += 1

    log(f"\n=== PHASE 1 DONE: succeeded={succeeded}, skipped={skipped}, failed={len(failed)} ===")

    if failed:
        log(f"\n=== RETRY PHASE ({len(failed)} items) ===")
        retry_succeeded = 0
        for i, item in enumerate(failed):
            log(f"[retry {i+1}/{len(failed)}] {item['name']}")
            result = process_item(item)
            if result == 'success':
                retry_succeeded += 1
        log(f"\n=== RETRY DONE: succeeded={retry_succeeded}, still_failed={len(failed)-retry_succeeded} ===")

    log("=== ALL DONE ===")


if __name__ == '__main__':
    main()
