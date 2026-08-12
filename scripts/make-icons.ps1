$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root "build"
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

function New-RoundedPath {
  param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $R * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

$master = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($master)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$dark = [System.Drawing.Color]::FromArgb(255, 15, 20, 14)
$phosphor = [System.Drawing.Color]::FromArgb(255, 198, 232, 138)
$amber = [System.Drawing.Color]::FromArgb(255, 226, 161, 59)
$line = [System.Drawing.Color]::FromArgb(110, 198, 232, 138)

$bgPath = New-RoundedPath -X 8 -Y 8 -W 240 -H 240 -R 48
$bgBrush = New-Object System.Drawing.SolidBrush $dark
$g.FillPath($bgBrush, $bgPath)
$borderPen = New-Object System.Drawing.Pen($line, 5)
$g.DrawPath($borderPen, $bgPath)

# 品牌记号：左侧 ▚（左上+右下），右侧 ▞（右上+左下）
$cell = 34
$gap = 4
$leftX = 58
$rightX = 58 + ($cell * 2 + $gap) + 18
$y = 70
$quadrant = $cell - 2

$fillBrush = New-Object System.Drawing.SolidBrush $phosphor
# 左侧 ▚
$g.FillRectangle($fillBrush, $leftX, $y, $quadrant, $quadrant)
$g.FillRectangle($fillBrush, $leftX + $cell, $y + $cell, $quadrant, $quadrant)
# 右侧 ▞
$g.FillRectangle($fillBrush, $rightX + $cell, $y, $quadrant, $quadrant)
$g.FillRectangle($fillBrush, $rightX, $y + $cell, $quadrant, $quadrant)

# 底部琥珀细条
$amberBrush = New-Object System.Drawing.SolidBrush $amber
$g.FillRectangle($amberBrush, 58, 186, 140, 8)

$g.Dispose()

$sizes = @(16, 24, 32, 48, 64, 128, 256)
foreach ($size in $sizes) {
  $target = New-Object System.Drawing.Bitmap $size, $size
  $tg = [System.Drawing.Graphics]::FromImage($target)
  $tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $tg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $tg.Clear([System.Drawing.Color]::Transparent)
  $tg.DrawImage($master, 0, 0, $size, $size)
  $tg.Dispose()
  $target.Save((Join-Path $buildDir "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $target.Dispose()
}

$master.Dispose()
Write-Host "icon PNGs written to $buildDir"
