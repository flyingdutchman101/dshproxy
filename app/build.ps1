# Builds DSHProxy.exe with the C# compiler that ships with Windows (.NET
# Framework 4.8). Nothing needs to be installed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "The .NET Framework 4 compiler was not found at $csc." }

# The app icon (16-256 px). Personal use only: see app\icon\NOTICE.md.
$icon = Join-Path $app 'icon\DSHProxy.ico'
if (-not (Test-Path $icon)) { throw "The app icon was not found at $icon." }

# Provider logos are embedded in the program as resources named logo.<name>.png.
$resources = @()
foreach ($logo in Get-ChildItem (Join-Path $app 'logos') -Filter '*.png') {
    $resources += "/resource:$($logo.FullName),logo.$($logo.Name)"
}

$out = Join-Path $root 'DSHProxy.exe'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
    "/out:$out" "/win32icon:$icon" `
    /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.Net.dll `
    @resources "/resource:$icon,app.ico" `
    (Join-Path $app 'DSHProxyApp.cs')
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
Write-Host "Built $out"
