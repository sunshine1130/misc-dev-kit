@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Google插件 更新工具
echo ============================================
echo.
echo 当前目录: %CD%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 git，请先安装 Git for Windows
  echo        下载: https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo [1/2] 正在拉取最新代码...
echo.
git pull
if errorlevel 1 (
  echo.
  echo [失败] git pull 出错，常见原因：
  echo        1. 网络不通 / 被代理拦了（仓库是公开的，不需要 GitHub 账号）
  echo           - 挂上代理后重试：git config --global http.proxy http://127.0.0.1:7890
  echo             （用完记得 git config --global --unset http.proxy）
  echo        2. 本机证书栈异常：报 schannel / SEC_E_NO_CREDENTIALS
  echo           - 先试着重启电脑
  echo           - 应急办法：把 PAT 写进 remote URL（见 README 第四节）
  echo        3. 本地有未提交的改动导致冲突
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] 更新完成
echo.
echo  接下来请手动做一步（Chrome 不允许脚本重载扩展）：
echo    1. 打开 chrome://extensions
echo    2. 找到对应的扩展卡片
echo    3. 点击卡片上的「重新加载」按钮（圆形箭头图标）
echo.
echo  不点「重新加载」的话，扩展不会生效。
echo.
pause
