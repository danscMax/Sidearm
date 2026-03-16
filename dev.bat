@echo off
:: Sidearm Dev Server — double-click to start
:: Pass -Clean to force full recompile
powershell.exe -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
pause
