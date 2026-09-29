param(
  [string]$Morning = '08:30',
  [string]$Evening = '18:30',
  [string]$TaskName = 'TexturaLab News Agent'
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$runner = Join-Path $scriptDir 'regular-run.js'
$logDir = Join-Path $projectDir 'output'
$stdoutLog = Join-Path $logDir 'regular-run.log'
$wrapper = Join-Path $scriptDir 'run-regular-task.cmd'

if (-not (Test-Path $runner)) {
  throw "Runner not found: $runner"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source

# Keep Task Scheduler simple: cmd.exe launches Node directly and redirects the
# process output to the log. This avoids piping a native process through a
# PowerShell pipeline, which adds an unnecessary termination/console layer.
$wrapperContent = @"
@echo off
chcp 65001 >nul
cd /d "%~dp0.."
"$node" "%~dp0regular-run.js" >> "%~dp0..\output\regular-run.log" 2>&1
exit /b %ERRORLEVEL%
"@
Set-Content -Path $wrapper -Value $wrapperContent -Encoding ASCII

$actionArgs = "/d /s /c `"`"$wrapper`"`""
$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\System32\cmd.exe" `
  -Argument $actionArgs `
  -WorkingDirectory $projectDir

$morningTime = [DateTime]::ParseExact($Morning, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$eveningTime = [DateTime]::ParseExact($Evening, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)

$triggers = @()
$triggers += New-ScheduledTaskTrigger -Daily -At $morningTime
$triggers += New-ScheduledTaskTrigger -Daily -At $eveningTime

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Description 'TexturaLab: import curated RSS feeds and create a digest when enough new articles accumulate.' `
  -Force | Out-Null

Write-Host ''
Write-Host "Installed scheduled task: $TaskName"
Write-Host "Schedule: every day at $Morning and $Evening"
Write-Host "Runner:   $runner"
Write-Host "Wrapper:  $wrapper"
Write-Host "Log:      $stdoutLog"
Write-Host ''
Write-Host 'The task imports RSS on every run.'
Write-Host 'A digest is generated only when at least 5 new filtered articles are queued.'
Write-Host 'Telegram delivery is handled by regular-run via the configured VPS relay.'
Write-Host ''
Write-Host 'Test now:'
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ''
Write-Host 'Check status:'
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host ''
Write-Host 'Remove:'
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
