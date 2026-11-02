# Genera miniaturas JPEG (240 px de ancho) de las portadas del catálogo.
#   powershell -File tools/make-thumbs.ps1 <carpeta de portadas> <carpeta de salida>
# Las llama tools/make-catalog.mjs en Windows; en otros sistemas el catálogo usa la portada completa.
param(
  [Parameter(Mandatory = $true)][string]$CoversDir,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Width = 240
)

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

$jpeg = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), 78L

Get-ChildItem $CoversDir -File | ForEach-Object {
  $src = [Drawing.Image]::FromFile($_.FullName)
  try {
    $height = [int][math]::Round($src.Height * $Width / $src.Width)
    $bmp = New-Object Drawing.Bitmap $Width, $height
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $Width, $height)
    $g.Dispose()
    $bmp.Save((Join-Path $OutDir ($_.BaseName + '.jpg')), $jpeg, $params)
    $bmp.Dispose()
  } finally {
    $src.Dispose()
  }
}
