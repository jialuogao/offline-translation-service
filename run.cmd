@echo off
REM One-click launcher for the offline translation service.
REM Keep this file ASCII-only: cmd.exe parses .cmd in the OEM code page, so UTF-8
REM text here turns into garbage commands. All Chinese prompts live in run.ps1.
REM Arguments are forwarded, e.g.:  run.cmd -Port 5175 -NoBrowser
setlocal
set "SCRIPT=%~dp0run.ps1"
set "PSEXE=powershell"
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 set "PSEXE=pwsh"
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
if errorlevel 1 (
  echo.
  echo Startup failed. See the messages above.
  pause
)
endlocal
