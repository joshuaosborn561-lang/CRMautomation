$base = "https://crm-autopilotwebhook-server-production-38eb.up.railway.app"

Write-Host "`n=== CRM FULL REBUILD ===" -ForegroundColor Cyan
Write-Host "This will: nuke Attio, re-enrich with Apollo, reprocess all events`n"

# Step 1: Kick off rebuild
Write-Host "[1/3] Starting full rebuild..." -ForegroundColor Yellow
try {
    $r = Invoke-RestMethod -Uri "$base/api/full-rebuild" -Method POST -TimeoutSec 30
    Write-Host "  -> $($r.message)" -ForegroundColor Green
} catch {
    Write-Host "  -> Request sent (may have started in background)" -ForegroundColor Yellow
}

# Step 2: Poll rebuild status every 15 seconds
Write-Host "`n[2/3] Waiting for rebuild to complete..." -ForegroundColor Yellow
$maxWait = 20  # max 20 polls = 5 minutes
for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 15
    try {
        $status = Invoke-RestMethod -Uri "$base/api/rebuild-status" -Method GET -TimeoutSec 15
        $stepsDone = ($status.rebuild.steps | Where-Object { $_.status -eq "done" }).Count
        $processed = $status.events.processed
        $unprocessed = $status.events.unprocessed

        Write-Host "  Steps done: $stepsDone | Events: $processed processed, $unprocessed remaining" -ForegroundColor Gray

        # Check if rebuild background work is done
        $isComplete = $status.rebuild.steps | Where-Object { $_.step -eq "complete" }
        if ($isComplete -and $unprocessed -eq 0) {
            Write-Host "  -> Rebuild complete! All events processed." -ForegroundColor Green
            break
        }
        if ($isComplete -and $unprocessed -gt 0) {
            Write-Host "  -> Rebuild done, waiting for cron to process remaining $unprocessed events..." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  (waiting...)" -ForegroundColor Gray
    }
}

# Step 3: Final check
Write-Host "`n[3/3] Checking Attio..." -ForegroundColor Yellow
Start-Sleep -Seconds 5
try {
    $check = Invoke-RestMethod -Uri "$base/api/debug/attio-check" -Method GET -TimeoutSec 30
    Write-Host "`n=== RESULTS ===" -ForegroundColor Cyan
    Write-Host "  People in Attio: $($check.people_count)" -ForegroundColor White
    Write-Host "  Deals in Attio:  $($check.deals_count)" -ForegroundColor White

    if ($check.valid_interactions) {
        Write-Host "`n  Recent contacts with emails:" -ForegroundColor White
        $check.valid_interactions | Select-Object -First 10 | ForEach-Object {
            Write-Host "    $($_.contact_email) [$($_.source)] - $($_.sentiment)" -ForegroundColor Gray
        }
    }

    Write-Host "`n  Interaction stats:" -ForegroundColor White
    Write-Host "    Total: $($check.interaction_stats.total)" -ForegroundColor Gray
    Write-Host "    With email: $($check.interaction_stats.valid_email)" -ForegroundColor Gray
    Write-Host "    Unknown email: $($check.interaction_stats.unknown_email)" -ForegroundColor Gray
} catch {
    Write-Host "  Could not check Attio: $_" -ForegroundColor Red
}

Write-Host "`nDone! Check Attio to verify contacts and deals look right." -ForegroundColor Cyan
