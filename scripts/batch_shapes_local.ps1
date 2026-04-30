# Batch SHAPES locally via standalone Hunyuan script.
# Iterates all concept PNGs, skips items that already have a .glb output.
# Uses validated 8GB-friendly params (latent 3072, steps 20, cfg 5, scheduler simple, octree 320).
# 2026-04-28

$ErrorActionPreference = 'Continue'
$concepts_dir = 'Z:\Bellbound\assets\concepts\image_to_cad_sources'
$out_dir = 'Z:\Bellbound\assets\generated_3d\hunyuan21'
$python = 'Z:\AI_Tools\venv310\Scripts\python.exe'
$script = 'Z:\Bellbound\scripts\run_hunyuan21_from_concept.py'
$log = "Z:\Bellbound\scripts\overnight_logs\batch_shapes_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

New-Item -ItemType Directory -Path $out_dir -Force | Out-Null
"=== BATCH SHAPES START $(Get-Date) ===" | Out-File $log

# Filter: only _concept.png files, skip variants (var01/02/03)
$concepts = Get-ChildItem $concepts_dir -Filter '*_concept.png' |
    Where-Object { $_.Name -notmatch '_var\d+_concept\.png$' -and $_.Name -notmatch '^ig_' }

"Found $($concepts.Count) concept candidates" | Tee-Object -FilePath $log -Append

$total = $concepts.Count
$idx = 0
$first = $true
$skipped = 0
$succeeded = 0
$failed = 0

foreach ($c in $concepts) {
    $idx++
    $name = $c.BaseName -replace '_concept$', ''
    $expected_glb = Join-Path $out_dir "${name}_hunyuan21.glb"

    if (Test-Path $expected_glb) {
        "[$idx/$total] SKIP $name (already done)" | Tee-Object -FilePath $log -Append
        $skipped++
        continue
    }

    "[$idx/$total] SHAPE $name (started $(Get-Date -Format 'HH:mm:ss'))" | Tee-Object -FilePath $log -Append

    $args = @(
        $script,
        '--image', $c.FullName,
        '--name', $name,
        '--latent-resolution', '3072',
        '--steps', '20',
        '--octree-resolution', '320',
        '--cfg', '5.0',
        '--scheduler', 'simple',
        '--keep-server',
        '--timeout', '1800'
    )
    # ComfyUI must already be running before launching this wrapper
    # (start manually via Z:\Bellbound\scripts\start_comfyui_3d.ps1)

    $start = Get-Date
    & $python @args 2>&1 | Tee-Object -FilePath $log -Append | Out-Null
    $duration = (Get-Date) - $start

    if (Test-Path $expected_glb) {
        $size_kb = [math]::Round((Get-Item $expected_glb).Length / 1KB, 0)
        "[$idx/$total] OK $name ($([math]::Round($duration.TotalSeconds, 0))s, ${size_kb}KB)" | Tee-Object -FilePath $log -Append
        $succeeded++
    } else {
        "[$idx/$total] FAIL $name (no GLB produced after $([math]::Round($duration.TotalSeconds, 0))s)" | Tee-Object -FilePath $log -Append
        $failed++
    }
}

"=== BATCH SHAPES END $(Get-Date) ===" | Tee-Object -FilePath $log -Append
"Summary: $succeeded succeeded, $skipped skipped, $failed failed (of $total total)" | Tee-Object -FilePath $log -Append
