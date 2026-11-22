@echo off
rem dxkjailbreak - AI-friendly installer: no pause, real exit code.
rem For automated / AI-assisted invocation. See install.cmd for the
rem interactive double-click variant.
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22 or 24 first.
  exit /b 127
)

node install.mjs
set "RC=%ERRORLEVEL%"
echo.
echo ------------------------------------------------------------
if "%RC%"=="0" (
  echo [RESULT] OK - installed. Restart DSH to take effect.
) else (
  echo [RESULT] FAILED exit=%RC% - see output above.
)
exit /b %RC%
