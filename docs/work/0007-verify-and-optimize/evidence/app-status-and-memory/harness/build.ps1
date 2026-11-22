param([string]$Root, [string]$Name = 'FixCheck', [string]$Source = '', [string]$Skin = '', [string]$As = '')
# Builds one check program against the app's sources (or against other copies of them).
$rig = $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$icon = Join-Path $Root 'app\icon\DSHProxy.ico'
$refs = '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Net.dll'
$res = @(Get-ChildItem (Join-Path $Root 'app\logos') -Filter *.png | ForEach-Object { "/resource:$($_.FullName),logo.$($_.Name)" }) + "/resource:$icon,app.ico"
if (-not $As) { $As = $Name }
if (-not $Source) { $Source = Join-Path $Root 'app\DSHProxyApp.cs' }
if (-not $Skin) { $Skin = Join-Path $Root 'app\Skin.cs' }
& $csc /nologo /target:exe /optimize+ /platform:anycpu "/main:DSHProxy.$Name" "/out:$rig\root\$As.exe" @refs @res $Source $Skin (Join-Path $Root 'app\BuildInfo.cs') (Join-Path $rig "$Name.cs")
"${As}: csc exit=$LASTEXITCODE"
