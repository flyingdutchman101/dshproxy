# Builds dshgate.exe with the C# compiler that ships with Windows (.NET
# Framework 4.8). Nothing needs to be installed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "The .NET Framework 4 compiler was not found at $csc." }

# The icon is drawn here, so the repository holds no binary artwork.
$icon = Join-Path $app 'dshgate.ico'
if (-not (Test-Path $icon)) {
    Add-Type -AssemblyName System.Drawing
    $size = 64
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(37, 99, 235))
    $g.FillEllipse($brush, 2, 2, $size - 4, $size - 4)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 6
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    # A gate: two posts and a bar.
    $g.DrawLine($pen, 20, 18, 20, 46)
    $g.DrawLine($pen, 44, 18, 44, 46)
    $g.DrawLine($pen, 20, 30, 44, 30)
    $g.Dispose()
    $handle = $bitmap.GetHicon()
    $ico = [System.Drawing.Icon]::FromHandle($handle)
    $stream = [System.IO.File]::Create($icon)
    $ico.Save($stream)
    $stream.Close()
}

$out = Join-Path $root 'dshgate.exe'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
    "/out:$out" "/win32icon:$icon" `
    /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.Net.dll `
    (Join-Path $app 'DshgateApp.cs')
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
Write-Host "Built $out"
