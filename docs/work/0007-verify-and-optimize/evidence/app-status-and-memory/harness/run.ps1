param([string]$Root, [string]$What, [string]$Out, [string]$Exe = '')
# Runs one check with its console output in a file; prints the summary lines.
$fix = $PSScriptRoot
$exe = if ($Exe) { $Exe } elseif ($What -in 'flow', 'follow', 'count', 'ticks', 'hidden') { 'FixCheck.exe' } else { 'PagesCheck.exe' }
$rigName = if ($What -eq 'tabs') { 'seam' } elseif ($What -eq 'ticks') { 'flow' } elseif ($What -eq 'hidden') { 'count' } else { $What }
$rig = Get-Content (Join-Path $fix "rig-$rigName\rig.json") -Raw | ConvertFrom-Json
$outFile = Join-Path $fix $Out
$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$arguments = if ($exe -like 'FixCheck*') { "$What `"$Root`" `"$($rig.dir)`" $($rig.port) `"$fix\root\bin\fakegw.js`"" } else { "$What `"$Root`" `"$($rig.dir)`" $($rig.port)" }
$started = Get-Date
cmd /c "`"$fix\root\$exe`" $arguments < nul > `"$outFile`" 2>&1"
"$What exit=$LASTEXITCODE  ($([int]((Get-Date) - $started).TotalSeconds) s; CPU load of the machine before the run: $load%)"
$lines = Get-Content $outFile
$lines | Where-Object { $_ -match '^(FAIL|ALL OK|\d+ FAILED)' }
"ok lines: $(@($lines | Where-Object { $_ -match '^ok ' }).Count), FAIL lines: $(@($lines | Where-Object { $_ -match '^FAIL' }).Count)"
if (Test-Path (Join-Path $rig.dir 'quit.txt')) { (Get-Content (Join-Path $rig.dir 'quit.txt')) -split ' ' | ForEach-Object { "after the check ended, process $_ alive: $([bool](Get-Process -Id $_ -ErrorAction SilentlyContinue))" } }
$left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ([string]$_.CommandLine).Contains((Split-Path $fix -Leaf)) })
"node processes of this rig left: $($left.Count)"
