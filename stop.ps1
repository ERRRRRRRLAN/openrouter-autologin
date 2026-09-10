# Stop all openrouter-autologin bot processes:
# - node openrouter_bot.js (the bot itself)
# - chrome.exe using the bot's chrome_profiles (user-data-dir openrouter-autologin)
# The main Chrome / other browsers are NOT touched.
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
Write-Host ("Stopped " + $botChrome.Count + " chrome process (bot profile)")

if (-not $botNode -and $botChrome.Count -eq 0) {
  Write-Host "No bot processes running."
}
Write-Host ""
Write-Host "Done. Bot fully stopped."
