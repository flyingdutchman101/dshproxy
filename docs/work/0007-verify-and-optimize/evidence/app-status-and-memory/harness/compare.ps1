param([string]$A, [string]$B, [switch]$Quiet)
# Compares two sets of captures picture by picture: how many pixels differ, and where.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class PictureDiff
{
    public static string Compare(string a, string b)
    {
        using (var x = new Bitmap(a)) using (var y = new Bitmap(b))
        {
            if (x.Size != y.Size) return "another size: " + x.Width + "x" + x.Height + " and " + y.Width + "x" + y.Height;
            var rect = new Rectangle(0, 0, x.Width, x.Height);
            var dx = x.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var dy = y.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var p = new byte[dx.Stride * dx.Height];
            var q = new byte[dy.Stride * dy.Height];
            Marshal.Copy(dx.Scan0, p, 0, p.Length);
            Marshal.Copy(dy.Scan0, q, 0, q.Length);
            x.UnlockBits(dx);
            y.UnlockBits(dy);
            int left = int.MaxValue, top = int.MaxValue, right = -1, bottom = -1, n = 0;
            for (var i = 0; i < p.Length; i += 4)
            {
                if (p[i] == q[i] && p[i + 1] == q[i + 1] && p[i + 2] == q[i + 2]) continue;
                var px = (i / 4) % rect.Width;
                var py = (i / 4) / rect.Width;
                if (px < left) left = px;
                if (px > right) right = px;
                if (py < top) top = py;
                if (py > bottom) bottom = py;
                n++;
            }
            return n == 0 ? "" : n + " of " + (rect.Width * rect.Height) + " pixels differ, in x " + left + ".." + right + ", y " + top + ".." + bottom;
        }
    }
}
'@
$names = Get-ChildItem $A -Filter *.png | ForEach-Object Name | Sort-Object
$same = 0; $differ = @(); $missing = @()
foreach ($n in $names) {
    $other = Join-Path $B $n
    if (-not (Test-Path $other)) { $missing += $n; continue }
    $d = [PictureDiff]::Compare((Join-Path $A $n), $other)
    if ($d -eq '') { $same++ } else { $differ += "$n : $d" }
}
$extra = @(Get-ChildItem $B -Filter *.png | Where-Object { $names -notcontains $_.Name } | ForEach-Object Name)
"pictures compared: $($names.Count - $missing.Count); the same pixel for pixel: $same; different: $($differ.Count); only in the first set: $($missing.Count); only in the second: $($extra.Count)"
if (-not $Quiet) { $differ; $missing | ForEach-Object { "only in the first set: $_" }; $extra | ForEach-Object { "only in the second set: $_" } }
