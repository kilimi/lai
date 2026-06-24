# Download mmcv prebuilt wheel for mmyolo Docker build (offline / flaky network).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Dest = Join-Path $Root "dockers\backend\wheels"
$Version = if ($env:MMCV_VERSION) { $env:MMCV_VERSION } else { "2.0.1" }
$Wheel = "mmcv-$Version-cp38-cp38-manylinux1_x86_64.whl"
$Url = "https://download.openmmlab.com/mmcv/dist/cu113/torch1.10.0/$Wheel"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile (Join-Path $Dest $Wheel)
Write-Host "Saved $Dest\$Wheel"
Write-Host "Rebuild: lai build"
