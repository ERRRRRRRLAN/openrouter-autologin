# Stop semua proses bot openrouter-autologin:
# - node openrouter_bot.js (bot itu sendiri)
# - chrome.exe yang memakai profil chrome_profiles bot (user-data-dir openrouter-autologin)
# Chrome utama / browser lain TIDAK disentuh.
$ErrorActionPreference = "SilentlyContinue"

$botNode = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*openrouter_bot.js*' }
foreach ($p in $botNode) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Host ("Stopped node bot PID " + $p.ProcessId)
}

$botChrome = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*openrouter-autologin*' })
foreach ($p in $botChrome) {
  Stop-Process -Id $p.ProcessId -Force
}
Write-Host ("Stopped " + $botChrome.Count + " chrome process (profil bot)")

if (-not $botNode -and $botChrome.Count -eq 0) {
  Write-Host "Tidak ada proses bot yang jalan."
}
Write-Host ""
Write-Host "Selesai. Bot sudah berhenti total."
