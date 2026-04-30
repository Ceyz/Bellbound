# Bellbound -- overnight Hunyuan batch launcher.
#
# Starts ComfyUI in background, waits for it to be ready, runs the batch_submit
# script against the overnight queue, then keeps ComfyUI running so you can
# inspect results before killing it.
#
# Run this from PowerShell once you're done playing:
#   powershell -ExecutionPolicy Bypass -File Z:\Bellbound\scripts\run_hunyuan_overnight.ps1
#
# Logs go to Z:\Bellbound\scripts\overnight_logs\

$ErrorActionPreference = "Stop"

$LogDir = "Z:\Bellbound\scripts\overnight_logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$comfyOut = Join-Path $LogDir "comfy_$ts.out.log"
$comfyErr = Join-Path $LogDir "comfy_$ts.err.log"
$batchOut = Join-Path $LogDir "batch_$ts.out.log"

Write-Host "Bellbound overnight Hunyuan batch starting at $ts"
Write-Host "ComfyUI logs: $comfyOut / $comfyErr"
Write-Host "Batch log:    $batchOut"
Write-Host ""

# Start ComfyUI in background.
Write-Host "[1/3] Starting ComfyUI..."
$comfy = Start-Process -PassThru -WindowStyle Hidden -FilePath "powershell.exe" `
    -ArgumentList "-ExecutionPolicy", "Bypass", "-File", "Z:\Bellbound\scripts\start_comfyui_3d.ps1" `
    -RedirectStandardOutput $comfyOut `
    -RedirectStandardError $comfyErr
Write-Host "    ComfyUI launcher PID: $($comfy.Id)"

# Wait for ComfyUI to respond on /system_stats. Up to 5 minutes.
Write-Host "[2/3] Waiting for ComfyUI to be ready (max 5 min)..."
$ready = $false
for ($i = 0; $i -lt 100; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8188/system_stats" `
            -TimeoutSec 3 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 3
}
if (-not $ready) {
    Write-Host "    ERROR: ComfyUI failed to start within 5 min."
    Write-Host "    Check $comfyErr for details."
    exit 2
}
Write-Host "    ComfyUI ready."

# Run the batch.
Write-Host "[3/3] Launching batch_submit.py..."
& "Z:\AI_Tools\venv310\Scripts\python.exe" `
    "Z:\Bellbound\scripts\hunyuan_batch_submit.py" `
    "Z:\Bellbound\scripts\hunyuan_overnight_queue.json" `
    *>&1 | Tee-Object -FilePath $batchOut

Write-Host ""
Write-Host "Batch complete. ComfyUI still running so you can inspect."
Write-Host "Kill it later with: Stop-Process -Id $($comfy.Id) -Force"
Write-Host "Outputs:"
Write-Host "  Shape GLBs: Z:\AI_Tools\ComfyUI\output\chibi_shape\batch_*_shape_*.glb"
Write-Host "  Paint GLBs: Z:\AI_Tools\ComfyUI\output\chibi_textured\batch_*.glb"
Write-Host "  Batch log:  $batchOut"
