@echo off
rem dxkjailbreak - AI-friendly installer: no pause, exits with a real code.
rem 供自动化/AI 助手调用：不等待按键，输出可直接解析。
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22 or 24 first.
  exit /b 127
)

node install.mjs
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [RESULT] OK - installed. Restart DSH to take effect.
) else (
  echo [RESULT] FAILED exit=%RC% - see output above.
)
exit /b %RC%
