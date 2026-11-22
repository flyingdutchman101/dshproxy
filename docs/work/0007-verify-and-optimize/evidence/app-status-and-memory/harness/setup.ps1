param([string]$Root, [string]$Name)
# A throwaway data folder with two spare loopback ports and one synthetic Chat API key.
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$dir = Join-Path $base "rig-$Name"
if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
$homeDir = Join-Path $dir 'home'
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
function Spare {
    while ($true) {
        $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
        $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop()
        if ($p -ne 8417 -and $p -ne 8418) { return $p }
    }
}
$port = Spare; $backendPort = Spare
while ($backendPort -eq $port) { $backendPort = Spare }
[IO.File]::WriteAllText((Join-Path $homeDir 'settings.json'), ('{"port":' + $port + ',"backendPort":' + $backendPort + '}'), (New-Object Text.UTF8Encoding $false))
$psi = New-Object System.Diagnostics.ProcessStartInfo 'node', ('"' + (Join-Path $Root 'bin\dshproxy.js') + '" key set deepseek')
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = $Root
$psi.EnvironmentVariables['DSHPROXY_HOME'] = $homeDir
$psi.EnvironmentVariables['DSH_HOME'] = (Join-Path $dir 'no-deepseek-harness')
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.WriteLine('sk-synthetic-' + [Guid]::NewGuid().ToString('N')); $p.StandardInput.Close()
$out = $p.StandardOutput.ReadToEnd(); $err = $p.StandardError.ReadToEnd(); $p.WaitForExit()
$settings = Get-Content (Join-Path $homeDir 'settings.json') -Raw | ConvertFrom-Json
if ($settings.port -ne $port -or $settings.backendPort -ne $backendPort) { throw 'the ports did not survive the key save' }
[IO.File]::WriteAllText((Join-Path $dir 'rig.json'), (@{ dir = $dir; home = $homeDir; port = $port; backendPort = $backendPort } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
"${Name}: port=$port backendPort=$backendPort; key set exit=$($p.ExitCode): $($out.Trim()) $($err.Trim())"
