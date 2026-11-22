param([string]$Root, [string]$Out, [string]$Only = '', [switch]$NoBuild, [string]$Source = '', [string]$Skin = '', [string]$Info = '')
# Builds the layout check against the app's sources and runs it.
$ErrorActionPreference = 'Stop'
$rig = $PSScriptRoot
if (-not $NoBuild) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $icon = Join-Path $Root 'app\icon\DSHProxy.ico'
    $refs = '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Net.dll'
    $res = @(Get-ChildItem (Join-Path $Root 'app\logos') -Filter *.png | ForEach-Object { "/resource:$($_.FullName),logo.$($_.Name)" }) + "/resource:$icon,app.ico"
    if (-not $Source) { $Source = Join-Path $Root 'app\DSHProxyApp.cs' }
    if (-not $Skin) { $Skin = Join-Path $Root 'app\Skin.cs' }
    # -Info: a copy of BuildInfo.cs with the build stamp of an earlier set of captures, so the two sets can be compared pixel for pixel.
    if (-not $Info) { $Info = Join-Path $Root 'app\BuildInfo.cs' }
    $src = $Source, $Skin, $Info
    & $csc /nologo /target:exe /optimize+ /platform:anycpu /main:DSHProxy.LayoutCheck "/out:$rig\root\LayoutCheck.exe" @refs @res @src (Join-Path $rig 'LayoutCheck.cs')
    if ($LASTEXITCODE -ne 0) { "csc exit=$LASTEXITCODE"; exit 1 }
}
$r = Get-Content (Join-Path $rig 'rig-seam\rig.json') -Raw | ConvertFrom-Json
if ($r.port -eq 8417 -or $r.port -eq 8418) { throw 'not a spare port' }
$started = Get-Date
$log = Join-Path $rig ('layout-' + (Split-Path $Out -Leaf) + '.txt')
cmd /c "`"$rig\root\LayoutCheck.exe`" `"$Root`" `"$($r.dir)`" `"$Out`" $($r.port) $Only < nul > `"$log`" 2>&1"
"layout check exit=$LASTEXITCODE ($([int]((Get-Date) - $started).TotalSeconds) s), $(@(Get-ChildItem $Out -Filter *.png).Count) png files in $Out"
Get-Content $log | Select-Object -Last 9
