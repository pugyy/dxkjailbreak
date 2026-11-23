@echo off
setlocal
chcp 65001 >nul 2>nul
title dxkjailbreak installer
cd /d "%~dp0"

echo ============================================================
echo   dxkjailbreak  -  one-click installer
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo.
  echo   Please install Node.js 22 or 24 first:
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
echo [OK] Node.js %NODEVER%
echo.
echo Installing, please wait...
echo ------------------------------------------------------------
node install.mjs
set "RC=%ERRORLEVEL%"
echo ------------------------------------------------------------
echo.

if "%RC%"=="0" (
  echo [DONE] Installed successfully. Please restart DSH.
) else (
  echo [STOPPED] Installation did not finish. Exit code: %RC%
  echo.
  echo Copy the text above and send it to the developer.
)

echo.
pause
exit /b %RC%
