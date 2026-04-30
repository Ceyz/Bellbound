$ErrorActionPreference = "Stop"

$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:DIFFUSERS_OFFLINE = "1"
$env:SPARSE_ATTN_BACKEND = "sdpa"
$env:ATTN_BACKEND = "sdpa"

# 8GB VRAM optimization (2026-04-27, per Agent 3 research):
# - expandable_segments fixes fragmentation OOMs
# - max_split_size_mb avoids massive single allocations
$env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True,max_split_size_mb:256"

Set-Location "Z:\AI_TOOLS\ComfyUI"
# 8GB VRAM flags (2026-04-28, per Hunyuan paint debug agent):
# --reserve-vram 1.5: keep 1.5GB free for activation spikes (fixes mid-diffusion OOM)
# --disable-smart-memory: force unload between nodes (prevents SHAPE remnants leaking into PAINT)
# --use-pytorch-cross-attention: SDPA more memory-efficient than fallback
cmd /d /s /c '"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && "Z:\AI_TOOLS\venv310\Scripts\python.exe" "main.py" --listen 127.0.0.1 --port 8188 --reserve-vram 1.5 --disable-smart-memory --use-pytorch-cross-attention'
