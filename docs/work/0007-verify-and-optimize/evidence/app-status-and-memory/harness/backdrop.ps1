param([string]$Root, [string]$What, [string]$Out, [string]$Exe = 'BackdropCheck.exe')
# Runs one mode of the backdrop check (sizes, resizes, idle) with its output in a file.
# Build it first: build.ps1 -Root <worktree> -Name BackdropCheck [-Source ... -Skin ... -As ...]
$rig = $PSScriptRoot
$r = Get-Content (Join-Path $rig 'rig-seam\rig.json') -Raw | ConvertFrom-Json
if ($r.port -eq 8417 -or $r.port -eq 8418) { throw 'not a spare port' }
$outFile = Join-Path $rig $Out
$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$started = Get-Date
cmd /c "`"$rig\root\$Exe`" $What `"$Root`" `"$($r.dir)`" $($r.port) < nul > `"$outFile`" 2>&1"
"$What ($Exe) exit=$LASTEXITCODE  ($([int]((Get-Date) - $started).TotalSeconds) s; CPU load of the machine before the run: $load%)"
$lines = Get-Content $outFile
"ok lines: $(@($lines | Where-Object { $_ -match '^ok ' }).Count), FAIL lines: $(@($lines | Where-Object { $_ -match '^FAIL' }).Count)"
