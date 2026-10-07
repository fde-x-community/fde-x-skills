param(
    [Parameter(Mandatory=$true)][string]$PythonPath,
    [string]$TaskName = 'Vooglam-Local-Price-Monitor'
)
$ErrorActionPreference = 'Stop'
$monitorRoot = $PSScriptRoot
$pythonResolved = (Resolve-Path -LiteralPath $PythonPath).Path
$pythonWindowless = Join-Path (Split-Path -Parent $pythonResolved) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonWindowless)) { throw 'pythonw.exe is required for hidden execution' }
$configPath = Join-Path $monitorRoot 'config.json'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) { throw "Task already exists: $TaskName. Inspect it before updating." }
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$scriptPath = Join-Path $monitorRoot 'monitor.py'
$action = New-ScheduledTaskAction -Execute $pythonWindowless -Argument ('"' + $scriptPath + '" --config "' + $configPath + '"') -WorkingDirectory $monitorRoot
$nextStart = (Get-Date).Date.Add([TimeSpan]::Parse($config.daily_time))
if ($nextStart -le (Get-Date)) { $nextStart = $nextStart.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $nextStart
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount $config.retry_count -RestartInterval (New-TimeSpan -Minutes $config.retry_minutes) -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'User-enabled Vooglam eyeglasses monitor. Daily 11:00; missed start catch-up; retry 30m x3; history and failure popup; no checkout.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $monitorRoot 'registered_task.xml') -Encoding Unicode
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, NextRunTime, LastTaskResult
