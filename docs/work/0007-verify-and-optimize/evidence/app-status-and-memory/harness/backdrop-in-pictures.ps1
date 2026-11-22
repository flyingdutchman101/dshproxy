param([string]$Exe, [string]$Pictures)
# Is the backdrop in the captures the one drawn at the size of the window, or a stretched one?
# In the captures 1920 wide and wider the page is a column in the middle with nothing but the
# backdrop beside it. Those two strips (300 px wide, the whole height of the window's inside)
# are compared with a backdrop drawn by the app's own code at that size.
# -Exe: a copy of DSHProxy.exe (its Backdrop.Render is called; no window is made).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class Strips
{
    static byte[] Bytes(Bitmap b, out int stride)
    {
        var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var p = new byte[d.Stride * d.Height];
        Marshal.Copy(d.Scan0, p, 0, p.Length);
        stride = d.Stride;
        b.UnlockBits(d);
        return p;
    }
    // The picture is of the whole window; its inside starts at (left, top).
    public static int Differ(string picture, Bitmap backdrop, int left, int top, int strip)
    {
        using (var shot = new Bitmap(picture))
        {
            int s1, s2;
            var p = Bytes(shot, out s1);
            var q = Bytes(backdrop, out s2);
            var n = 0;
            for (var y = 0; y < backdrop.Height; y++)
                for (var x = 0; x < backdrop.Width; x++)
                {
                    if (x >= strip && x < backdrop.Width - strip) { x = backdrop.Width - strip - 1; continue; }
                    var i = (y + top) * s1 + (x + left) * 4;
                    var j = y * s2 + x * 4;
                    if (p[i] != q[j] || p[i + 1] != q[j + 1] || p[i + 2] != q[j + 2]) n++;
                }
            return n;
        }
    }
}
'@
$asm = [Reflection.Assembly]::LoadFile($Exe)
$render = $asm.GetType('DSHProxy.Backdrop').GetMethod('Render', [Reflection.BindingFlags]'Static, NonPublic')
$clean = 0; $bad = @(); $looked = 0
foreach ($size in '1920x1040', '2560x1392', '3440x1392', '5120x1392') {
    $w, $h = $size -split 'x' | ForEach-Object { [int]$_ }
    # the frame of the window in these captures: 8 px at the sides and below, 31 px above
    $inside = New-Object System.Drawing.Size ($w - 16), ($h - 39)
    $backdrop = $render.Invoke($null, [object[]]@([System.Drawing.Size]$inside))
    foreach ($f in Get-ChildItem $Pictures -Filter "*-$size.png" | Sort-Object Name) {
        $looked++
        $n = [Strips]::Differ($f.FullName, $backdrop, 8, 31, 300)
        if ($n -eq 0) { $clean++ } else { $bad += "$($f.Name): $n of $(600 * $inside.Height) pixels of the two strips differ" }
    }
    $backdrop.Dispose()
}
"pictures looked at (1920 wide and wider): $looked; both strips equal to a backdrop drawn at that size: $clean; not equal: $($bad.Count)"
$bad
