@echo off
chcp 65001 >nul 2>nul
title dxkjailbreak installer
cd /d "%~dp0"

echo ============================================================
echo   dxkjailbreak  -  one-click installer / 一键安装
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found / 未找到 Node.js
  echo.
  echo   Install Node.js 22 or 24 first / 请先安装 Node.js 22 或 24:
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo [OK] Node.js %NODEVER%
echo.
echo Installing... / 正在安装...
echo ------------------------------------------------------------
node install.mjs
set RC=%ERRORLEVEL%
echo ------------------------------------------------------------
echo.

if "%RC%"=="0" (
  echo [DONE] Installed. Please restart DSH. / 安装完成，请重启 DSH。
) else (
  echo [STOPPED] exit code %RC% / 安装未完成，退出码 %RC%
  echo.
  echo Copy the output above to the developer. / 把上面的输出发给开发者。
)

echo.
pause
exit /b %RC%
