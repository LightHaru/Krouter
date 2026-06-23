@echo off
setlocal
cd /d "%~dp0"
node scripts\krouter-cli.cjs stop
endlocal
