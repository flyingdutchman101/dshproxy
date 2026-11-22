param([string]$Exe)
# Is the backdrop of a resized window drawn again at the new size, or does the stretched one stay?
# No window is shown: a form that is never made visible, and the app's own Backdrop class.
# Since the backdrop change this still reports differing pixels, and is meant to: a window nobody sees is not
# drawn again. BackdropCheck.cs looks at a window that is shown.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$asm = [Reflection.Assembly]::LoadFile($Exe)
$type = $asm.GetType('DSHProxy.Backdrop')
$flags = [Reflection.BindingFlags]'Static, Public, NonPublic'
$for = $type.GetMethod('For', $flags)
$render = $type.GetMethod('Render', $flags)
$pending = $type.GetField('Pending', $flags).GetValue($null)
function Same($a, $b) {
    if ($a.Size -ne $b.Size) { return "sizes $($a.Size) and $($b.Size)" }
    $n = 0
    for ($y = 0; $y -lt $a.Height; $y += 3) { for ($x = 0; $x -lt $a.Width; $x += 3) { if ($a.GetPixel($x, $y).ToArgb() -ne $b.GetPixel($x, $y).ToArgb()) { $n++ } } }
    return "$n of $([int]($a.Width / 3 + 1) * [int]($a.Height / 3 + 1)) sampled pixels differ"
}
$form = New-Object System.Windows.Forms.Form
$form.ClientSize = New-Object System.Drawing.Size 800, 600
$first = $for.Invoke($null, [object[]]@($form.PSObject.BaseObject))
"at 800x600, first use: against a fresh drawing at that size: $(Same $first ($render.Invoke($null, [object[]]@([System.Drawing.Size]$form.ClientSize))))"
$form.ClientSize = New-Object System.Drawing.Size 1000, 700
$null = $for.Invoke($null, [object[]]@($form.PSObject.BaseObject))
"resized to 1000x700 and asked for once: a redraw is pending: $($pending.ContainsKey($form.PSObject.BaseObject))"
$clock = [Diagnostics.Stopwatch]::StartNew()
while ($clock.ElapsedMilliseconds -lt 1500) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
"1.5 s later: a redraw is pending: $($pending.ContainsKey($form.PSObject.BaseObject))"
$after = $for.Invoke($null, [object[]]@($form.PSObject.BaseObject))
"the backdrop the window has now, against a fresh drawing at 1000x700: $(Same $after ($render.Invoke($null, [object[]]@([System.Drawing.Size]$form.ClientSize))))"
$form.Dispose()
