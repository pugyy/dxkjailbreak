#!/usr/bin/env bash
# dxkjailbreak installer / 一键安装（macOS / Linux）
set -u
cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "  dxkjailbreak  -  one-click installer / 一键安装"
echo "============================================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found / 未找到 Node.js"
  echo
  echo "  Install Node.js 22 or 24 first / 请先安装 Node.js 22 或 24:"
  echo "  https://nodejs.org/"
  echo
  exit 1
fi

echo "[OK] Node.js $(node --version)"
echo
echo "Installing... / 正在安装..."
echo "------------------------------------------------------------"
node install.mjs
RC=$?
echo "------------------------------------------------------------"
echo

if [ "$RC" -eq 0 ]; then
  echo "[DONE] Installed. Please restart DSH. / 安装完成，请重启 DSH。"
else
  echo "[STOPPED] exit code $RC / 安装未完成，退出码 $RC"
  echo
  echo "Copy the output above to the developer. / 把上面的输出发给开发者。"
fi

exit "$RC"
