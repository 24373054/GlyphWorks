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

# 版画工坊 1.4 图标:黑木台 + 黄铜细边 + 朱砂方印(纸白"工"字)
$master = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($master)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$bench  = [System.Drawing.Color]::FromArgb(255, 22, 19, 16)
$brass  = [System.Drawing.Color]::FromArgb(255, 180, 145, 79)
$cinnabar = [System.Drawing.Color]::FromArgb(255, 194, 63, 38)
$paper  = [System.Drawing.Color]::FromArgb(255, 244, 238, 218)

# 台底
$bgPath = New-RoundedPath -X 8 -Y 8 -W 240 -H 240 -R 48
$bgBrush = New-Object System.Drawing.SolidBrush $bench
$g.FillPath($bgBrush, $bgPath)
$borderPen = New-Object System.Drawing.Pen($brass, 6)
$g.DrawPath($borderPen, $bgPath)

# 朱砂方印(直角,真实印章)
$sealX = 64
$sealY = 64
$sealW = 128
$sealBrush = New-Object System.Drawing.SolidBrush $cinnabar
$g.FillRectangle($sealBrush, $sealX, $sealY, $sealW, $sealW)
$innerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 244, 238, 218), 4)
$g.DrawRectangle($innerPen, $sealX + 8, $sealY + 8, $sealW - 16, $sealW - 16)

# 纸白"工"字(几何笔画:上横短、下横长、竖中贯)
$paperBrush = New-Object System.Drawing.SolidBrush $paper
$cx = $sealX + $sealW / 2
$topY = $sealY + 34
$bottomY = $sealY + $sealW - 34 - 22
$g.FillRectangle($paperBrush, $cx - 18, $topY, 36, 22)        # 上横
$g.FillRectangle($paperBrush, $cx - 10, $topY, 20, 60)        # 竖(与上横相连)
$g.FillRectangle($paperBrush, $cx - 26, $bottomY, 52, 22)     # 下横
$g.FillRectangle($paperBrush, $cx - 10, $bottomY - 8, 20, 30) # 竖延伸

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
