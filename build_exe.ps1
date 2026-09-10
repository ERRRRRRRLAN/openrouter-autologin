# Build launcher.exe via Node SEA (single executable application)
# Jalankan:  powershell -ExecutionPolicy Bypass -File build_exe.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

Write-Host "== 1/6 siapkan sea-config.json ==" -ForegroundColor Cyan
@'
{
  "main": "launcher.js",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true,
  "assets": {}
}
'@ | Out-File -Encoding ascii sea-config.json

Write-Host "== 2/6 bundle launcher.js -> sea-prep.blob ==" -ForegroundColor Cyan
# Node >= 22: npx node --experimental-sea-config
& node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { throw "gagal generate blob" }
Write-Host ("blob OK: {0} bytes" -f (Get-Item sea-prep.blob).Length)

Write-Host "== 3/6 copy node.exe -> launcher.exe ==" -ForegroundColor Cyan
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe -Destination "launcher.exe" -Force

Write-Host "== 4/6 hapus signature lama (postject butuh itu) ==" -ForegroundColor Cyan
$sigtool = Get-Command signtool -ErrorAction SilentlyContinue
if ($sigtool) { & $sigtool.Source remove /s launcher.exe } else { Write-Host "signtool tidak ada - biasanya aman untuk node.exe resmi" }

Write-Host "== 5/6 inject blob (postject) ==" -ForegroundColor Cyan
& npx --yes postject@latest launcher.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw "postject gagal" }

Write-Host "== 6/6 selesai ==" -ForegroundColor Green
Write-Host ("launcher.exe: {0:N1} MB" -f ((Get-Item launcher.exe).Length / 1MB))
Write-Host "Test: .\launcher.exe --status"
