<#
  Run in Cursor Terminal (PowerShell), from this folder:
    .\railway-setup.ps1
  If blocked: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
#>
$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\nodejs;C:\Users\joshu\AppData\Roaming\npm;" + $env:Path
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "=== 1/3: Railway login (complete in browser when prompted) ===" -ForegroundColor Cyan
Write-Host ""
railway login
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "=== 2/3: Link this folder to a Railway project ===" -ForegroundColor Cyan
Write-Host ""
railway link
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "=== 3/3: Status ===" -ForegroundColor Cyan
Write-Host ""
railway status

Write-Host ""
Write-Host "Done. Deploy from dashboard or run: railway up" -ForegroundColor Green
Write-Host ""
