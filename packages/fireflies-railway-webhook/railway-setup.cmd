@echo off
setlocal
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\AppData\Roaming\npm;%PATH%"
cd /d "%~dp0"

echo.
echo === 1/3: Railway login (complete in browser when prompted) ===
echo.
call railway login
if errorlevel 1 exit /b 1

echo.
echo === 2/3: Link this folder to a Railway project ===
echo.
call railway link
if errorlevel 1 exit /b 1

echo.
echo === 3/3: Status ===
echo.
call railway status

echo.
echo Done. Deploy from dashboard or run: railway up
echo.
endlocal
