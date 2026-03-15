@echo off
:: Launcher for build_portable.ps1
:: Double-click to run, or pass arguments: -SkipBuild, -Verify, -Clean
powershell.exe -ExecutionPolicy Bypass -File "%~dp0build_portable.ps1" %*
pause
