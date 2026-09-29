# Crew portrait pipeline for Solhustle.
#
# The landing page renders each portrait into a 4:5 frame (.crew-art) with
# object-fit: cover, which means whatever the source's aspect ratio happens to be
# gets cropped off-centre by the browser. Sources here ranged from 200x200 to
# 688x1529, so the cards were framed inconsistently.
#
# This bakes the framing into the asset instead: each source is cropped to a
# hand-placed 4:5 window around the subject, resized with a high quality bicubic
# filter, then enhanced (per-channel auto-levels, saturation, contrast, unsharp
# mask) and written as one uniform 800x1000 JPEG. Every card then frames the
# subject the same way, and the browser has nothing left to crop.
#
# The frame is portrait because every source is: cropping a portrait selfie into
# a landscape tile forces the head to roughly 80% of the tile height and, when
# the source is barely wider than the tile, leaves no room to centre it.
#
# The pixel work is compiled C# rather than PowerShell loops: a 1000x800 image is
# 800k pixels and interpreting that per pixel would take minutes.
#
# Sources live in .freebuff/crew-originals/ and are never written to, so the run
# is idempotent and can be repeated safely.
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File .freebuff/enhance-portraits.ps1
#       ... -Grid   # render the mock card grid too, writing no assets
param(
  # -Grid renders the mock card grid without touching the committed assets, so
  # the framing can be reviewed (and adjusted) before anything is overwritten.
  [switch]$Grid,
  # -Coords rules the grid at tenths and marks the 50%/33% target for the face,
  # which is what turns review-by-eye into numbers a crop can be corrected by.
  [switch]$Coords
)
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class CrewImg
{
    static double Clamp(double v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

    // Crop a source-pixel rectangle and resample it to the output frame. The
    // rectangle is clamped to the source, so a slightly-off crop never throws.
    public static Bitmap CropResize(Image src, Rectangle r, int tw, int th)
    {
        int x = Math.Max(0, Math.Min(r.X, src.Width - 1));
        int y = Math.Max(0, Math.Min(r.Y, src.Height - 1));
        int w = Math.Max(1, Math.Min(r.Width, src.Width - x));
        int h = Math.Max(1, Math.Min(r.Height, src.Height - y));

        Bitmap bmp = new Bitmap(tw, th, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            using (ImageAttributes ia = new ImageAttributes())
            {
                // TileFlipXY keeps the bicubic kernel from sampling past the edge
                // and leaving a bright rim along the border.
                ia.SetWrapMode(WrapMode.TileFlipXY);
                g.DrawImage(src, new Rectangle(0, 0, tw, th), x, y, w, h, GraphicsUnit.Pixel, ia);
            }
        }
        return bmp;
    }

    // Per-channel auto-levels (which also neutralises a colour cast), then
    // saturation, contrast and an unsharp mask.
    public static double[] Enhance(Bitmap b, double clip, double saturation, double contrast, double gamma, int sharpRadius, double sharpAmount)
    {
        int w = b.Width, h = b.Height;
        int stride = w * 3;

        int[][] hist = new int[3][];
        for (int c = 0; c < 3; c++) hist[c] = new int[256];

        byte[][] rows = new byte[h][];
        BitmapData bd = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format24bppRgb);
        try
        {
            for (int yy = 0; yy < h; yy++)
            {
                rows[yy] = new byte[stride];
                Marshal.Copy(bd.Scan0 + yy * bd.Stride, rows[yy], 0, stride);
                byte[] row = rows[yy];
                for (int xx = 0; xx < w; xx++)
                {
                    hist[0][row[xx * 3]]++;
                    hist[1][row[xx * 3 + 1]]++;
                    hist[2][row[xx * 3 + 2]]++;
                }
            }

            double loTarget = clip * w * h;
            double hiTarget = (1.0 - clip) * w * h;
            byte[] lut = new byte[768];
            for (int c = 0; c < 3; c++)
            {
                int lo = 0, hi = 255;
                double acc = 0;
                for (int v = 0; v < 256; v++) { acc += hist[c][v]; if (acc >= loTarget) { lo = v; break; } }
                acc = 0;
                for (int v = 0; v < 256; v++) { acc += hist[c][v]; if (acc >= hiTarget) { hi = v; break; } }
                // A flat channel carries no information; stretching it would only
                // amplify sensor noise.
                if (hi - lo < 24) { lo = 0; hi = 255; }
                double span = hi - lo;
                for (int v = 0; v < 256; v++)
                {
                    double t = (v - lo) / span;
                    t = t < 0 ? 0 : (t > 1 ? 1 : t);
                    double o = t * 255.0;
                    o = (o - 128.0) * contrast + 128.0;
                    o = 255.0 * Math.Pow(Math.Max(0.0, o) / 255.0, 1.0 / gamma);
                    lut[c * 256 + v] = (byte)Clamp(o);
                }
            }

            for (int yy = 0; yy < h; yy++)
            {
                byte[] row = rows[yy];
                for (int xx = 0; xx < stride; xx += 3)
                {
                    double bb = lut[row[xx]];
                    double gg = lut[256 + row[xx + 1]];
                    double rr = lut[512 + row[xx + 2]];
                    if (saturation != 1.0)
                    {
                        // Rec.709 luma, so skin tones keep their brightness when
                        // colour is pushed.
                        double lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
                        bb = lum + (bb - lum) * saturation;
                        gg = lum + (gg - lum) * saturation;
                        rr = lum + (rr - lum) * saturation;
                    }
                    row[xx] = (byte)Clamp(bb);
                    row[xx + 1] = (byte)Clamp(gg);
                    row[xx + 2] = (byte)Clamp(rr);
                }
            }

            if (sharpAmount > 0.0 && sharpRadius > 0)
            {
                byte[][] blur = BoxBlur(rows, w, h, sharpRadius);
                for (int yy = 0; yy < h; yy++)
                {
                    byte[] row = rows[yy];
                    byte[] bl = blur[yy];
                    for (int xx = 0; xx < stride; xx++)
                        row[xx] = (byte)Clamp(row[xx] + sharpAmount * (row[xx] - bl[xx]));
                }
            }

            for (int yy = 0; yy < h; yy++)
                Marshal.Copy(rows[yy], 0, bd.Scan0 + yy * bd.Stride, stride);
        }
        finally { b.UnlockBits(bd); }

        return Stats(b);
    }

    // Separable box blur; applied once at 3x3 it is the low-pass an unsharp mask
    // needs, and at larger radii it approximates a gaussian.
    static byte[][] BoxBlur(byte[][] src, int w, int h, int r)
    {
        int stride = w * 3;
        int win = 2 * r + 1;
        byte[][] tmp = new byte[h][];
        for (int yy = 0; yy < h; yy++) tmp[yy] = new byte[stride];

        for (int yy = 0; yy < h; yy++)
        {
            byte[] s = src[yy];
            byte[] t = tmp[yy];
            for (int c = 0; c < 3; c++)
            {
                int sum = 0;
                for (int i = -r; i <= r; i++)
                {
                    int xi = i < 0 ? 0 : (i >= w ? w - 1 : i);
                    sum += s[xi * 3 + c];
                }
                for (int xx = 0; xx < w; xx++)
                {
                    t[xx * 3 + c] = (byte)(sum / win);
                    int xo = xx - r; if (xo < 0) xo = 0;
                    int xn = xx + r + 1; if (xn >= w) xn = w - 1;
                    sum += s[xn * 3 + c] - s[xo * 3 + c];
                }
            }
        }

        byte[][] dst = new byte[h][];
        for (int yy = 0; yy < h; yy++) dst[yy] = new byte[stride];
        for (int xx = 0; xx < w; xx++)
        {
            for (int c = 0; c < 3; c++)
            {
                int sum = 0;
                for (int i = -r; i <= r; i++)
                {
                    int yi = i < 0 ? 0 : (i >= h ? h - 1 : i);
                    sum += tmp[yi][xx * 3 + c];
                }
                for (int yy = 0; yy < h; yy++)
                {
                    dst[yy][xx * 3 + c] = (byte)(sum / win);
                    int yo = yy - r; if (yo < 0) yo = 0;
                    int yn = yy + r + 1; if (yn >= h) yn = h - 1;
                    sum += tmp[yn][xx * 3 + c] - tmp[yo][xx * 3 + c];
                }
            }
        }
        return dst;
    }

    public static double[] Stats(Bitmap b)
    {
        int w = b.Width, h = b.Height;
        BitmapData bd = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        double r = 0, g = 0, bl = 0;
        try
        {
            byte[] row = new byte[w * 3];
            for (int yy = 0; yy < h; yy++)
            {
                Marshal.Copy(bd.Scan0 + yy * bd.Stride, row, 0, w * 3);
                for (int xx = 0; xx < w * 3; xx += 3)
                {
                    bl += row[xx];
                    g += row[xx + 1];
                    r += row[xx + 2];
                }
            }
        }
        finally { b.UnlockBits(bd); }
        double n = (double)w * h;
        double mr = r / n, mg = g / n, mb = bl / n;
        return new double[] { mr, mg, mb, 0.2126 * mr + 0.7152 * mg + 0.0722 * mb };
    }

    public static void SaveJpeg(Bitmap b, string path, long quality)
    {
        ImageCodecInfo jpg = null;
        foreach (ImageCodecInfo ci in ImageCodecInfo.GetImageEncoders())
            if (ci.FormatID == ImageFormat.Jpeg.Guid) jpg = ci;
        using (EncoderParameters ep = new EncoderParameters(1))
        {
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            b.Save(path, jpg, ep);
        }
    }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing -Language CSharp

$crewDir = 'D:/kaizo/.freebuff/client/assets/crew'
# The pristine, hand-collected sources. These are NOT the files this script
# writes: re-reading its own output would crop the crops, which is what happened
# before this folder existed and turned three cards into stripes.
$srcDir = 'D:/kaizo/.freebuff/.freebuff/crew-originals'

# crop = the source-pixel rectangle that becomes the 4:5 card frame. Hand placed
# off the measured head boxes: the frame is centred on the face with the eyes a
# little above centre, and sized so the head lands near 45% of the frame height
# on every card. Where a source cannot reach 45% the frame stops at the tightest
# crop the source allows and stays centred rather than overshooting.
$people = @(
  @{ name = 'adri-bhowmik';        src = "$srcDir/adri-bhowmik.jpg";        crop = @(186, 171, 250, 312) },
  @{ name = 'saswata-howladar';    src = "$srcDir/saswata-howladar.jpg";    crop = @(0, 0, 140, 175) },
  @{ name = 'souradip-ghosh';      src = "$srcDir/souradip-ghosh.jpg";      crop = @(262, 176, 155, 194) },
  @{ name = 'suryya-sekhar-maiti'; src = "$srcDir/suryya-sekhar-maiti.jpg"; crop = @(0, 215, 540, 675) },
  @{ name = 'sumita-das';          src = "$srcDir/sumita-das.jpg";          crop = @(195, 135, 706, 882) },
  @{ name = 'tapo-pal';            src = "$srcDir/tapo-pal.png";            crop = @(0, 47, 300, 375) }
)

# Fail loudly rather than silently cropping an already-cropped asset.
$outRoot = [System.IO.Path]::GetFullPath($crewDir)
foreach ($p in $people) {
  $full = [System.IO.Path]::GetFullPath($p.src)
  if ($full.StartsWith($outRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "source '$full' sits inside the output folder; point it at a pristine copy"
  }
}

$outW = 800
$outH = 1000

Write-Output ('{0,-22} {1,-11} {2,-22} {3,-7} {4,-9} {5}' -f 'person', 'source', 'crop', 'upscale', 'sharpen', 'mean before -> after')

foreach ($p in $people) {
  $img = [System.Drawing.Image]::FromFile($p.src)
  $sw = $img.Width
  $sh = $img.Height
  $r = [System.Drawing.Rectangle]::new($p.crop[0], $p.crop[1], $p.crop[2], $p.crop[3])
  if ($r.X + $r.Width -gt $sw) { $r.Width = $sw - $r.X }
  if ($r.Y + $r.Height -gt $sh) { $r.Height = $sh - $r.Y }

  $bmp = [CrewImg]::CropResize($img, $r, $outW, $outH)
  $img.Dispose()

  # A 200px source blown up to 1000 needs a much harder sharpen than a 1:1 crop,
  # otherwise the bicubic upscale reads as mush next to its neighbours.
  $scale = [Math]::Max($outW / $r.Width, $outH / $r.Height)
  if ($scale -le 1.3)      { $amt = 0.45; $rad = 1 }
  elseif ($scale -le 2.0)  { $amt = 0.55; $rad = 2 }
  elseif ($scale -le 3.2)  { $amt = 0.70; $rad = 2 }
  else                     { $amt = 0.85; $rad = 3 }

  # Report the mean either side of the enhancement: an auto-levels pass should
  # brighten a dark frame, and this is how a regression in it gets noticed.
  $before = [CrewImg]::Stats($bmp)
  $st = [CrewImg]::Enhance($bmp, 0.004, 1.10, 1.06, 1.0, $rad, $amt)

  Write-Output ('{0,-22} {1,-11} {2,-22} {3,-7} {4,-9} {5}/{6}/{7} -> {8}/{9}/{10}' -f `
      $p.name, "${sw}x${sh}", ($p.crop -join ','), ('{0:N2}x' -f $scale), "$rad/$amt", `
      [int]$before[0], [int]$before[1], [int]$before[2], `
      [int]$st[0], [int]$st[1], [int]$st[2])

  if (-not $Grid) { [CrewImg]::SaveJpeg($bmp, "$crewDir/$($p.name).jpg", 88) }
  $p.bmp = $bmp
}

# Mock the landing grid at roughly the real card width, which is the only
# reliable way to judge whether six frames look like a set.
$cardW = 380
$cardH = [int]($cardW * 5 / 4)
$gap = 16
$pad = 18
$labelH = 30
$cols = 3
$rows = [Math]::Ceiling($people.Count / $cols)
$gw = $pad * 2 + $cols * $cardW + ($cols - 1) * $gap
$gh = $pad * 2 + $rows * ($cardH + $labelH) + ($rows - 1) * $gap

$gb = [System.Drawing.Bitmap]::new($gw, $gh)
$g = [System.Drawing.Graphics]::FromImage($gb)
$g.Clear([System.Drawing.Color]::FromArgb(244, 245, 247))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$font = [System.Drawing.Font]::new('Segoe UI', 12)
$gBrush = [System.Drawing.Brushes]::Black

for ($i = 0; $i -lt $people.Count; $i++) {
  $cx = $pad + ($i % $cols) * ($cardW + $gap)
  $cy = $pad + [Math]::Floor($i / $cols) * ($cardH + $labelH + $gap)
  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(210, 214, 220), 1)
  $g.DrawRectangle($pen, $cx, $cy, $cardW, $cardH)
  $g.DrawImage($people[$i].bmp, $cx + 1, $cy + 1, $cardW - 1, $cardH - 1)
  $g.DrawString($people[$i].name, $font, $gBrush, $cx, $cy + $cardH + 6)
  $pen.Dispose()

  if ($Coords) {
    $thin = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(130, 255, 60, 60), 1)
    $key  = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 0, 255, 0), 1)
    $tiny = [System.Drawing.Font]::new('Segoe UI', 8)
    foreach ($t in 10, 20, 30, 40, 50, 60, 70, 80, 90) {
      $lx = $cx + [int]($cardW * $t / 100)
      $ly = $cy + [int]($cardH * $t / 100)
      $g.DrawLine($thin, $lx, $cy, $lx, $cy + $cardH)
      $g.DrawLine($thin, $cx, $ly, $cx + $cardW, $ly)
      $g.DrawString([string]$t, $tiny, [System.Drawing.Brushes]::Yellow, $lx + 1, $cy + 1)
      $g.DrawString([string]$t, $tiny, [System.Drawing.Brushes]::Yellow, $cx + 1, $ly + 1)
    }
    $g.DrawLine($key, $cx + [int]($cardW * 0.5), $cy, $cx + [int]($cardW * 0.5), $cy + $cardH)
    $g.DrawLine($key, $cx, $cy + [int]($cardH * 0.33), $cx + $cardW, $cy + [int]($cardH * 0.33))
    $thin.Dispose(); $key.Dispose(); $tiny.Dispose()
  }
}

$gridPath = "$crewDir/_grid.png"
$gb.Save($gridPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$gb.Dispose()
foreach ($p in $people) { $p.bmp.Dispose() }
Write-Output "grid -> $gridPath ($gw x $gh)"
