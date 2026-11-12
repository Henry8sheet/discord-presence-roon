@echo off
set "APPDIR=%~dp0src\index.js"
powershell -NoProfile -Command "$p = $env:APPDIR; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped PID ' + $_.ProcessId) }"
pause
