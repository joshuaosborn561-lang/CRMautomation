@echo off
setlocal
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\AppData\Roaming\npm;%PATH%"
cd /d "%~dp0"

echo Clearing any broken Railway CLI session...
call railway logout 2>nul

echo.
echo === Browserless login ===
echo Keep this window open. Open the URL the CLI prints, approve access,
echo then return here and wait until the CLI says you are logged in.
echo.
call railway login --browserless
if errorlevel 1 (
  echo.
  echo If this still fails, use a token instead:
  echo   Railway Dashboard -^> Account Settings -^> Tokens -^> New token
  echo   Then in PowerShell:
  echo   $env:RAILWAY_API_TOKEN = "your-token-here"
  echo   railway whoami
  exit /b 1
)

echo.
call railway whoami
endlocal
