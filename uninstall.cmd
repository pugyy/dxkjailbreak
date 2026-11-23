@echo off
rem dxkjailbreak · by dxk — 卸载入口
setlocal
pushd "%~dp0" || exit /b 1
node install.mjs --uninstall
set "DXK_EXIT_CODE=%ERRORLEVEL%"
popd
pause
exit /b %DXK_EXIT_CODE%
