# Downloads the voice toolchain into vendor/: the Piper TTS engine, the
# en_GB-alan-medium British male voice, and a static ffmpeg used to deepen and
# warm the voice toward the cinematic JARVIS timbre. These are large binaries
# kept out of git; run this once after cloning. Re-running is safe — it skips
# files that already exist.
$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $PSScriptRoot
$dir   = Join-Path $root "vendor\piper"
$models = Join-Path $dir "models"

$piperZip = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip"
$modelUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx"
$jsonUrl  = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json"

if (-not (Test-Path (Join-Path $dir "piper.exe"))) {
  Write-Host "Downloading Piper engine (~22 MB)..."
  New-Item -ItemType Directory -Force (Join-Path $root "vendor") | Out-Null
  $zip = Join-Path $root "vendor\piper.zip"
  Invoke-WebRequest -Uri $piperZip -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath (Join-Path $root "vendor") -Force
  Remove-Item $zip
} else { Write-Host "Piper engine already present." }

New-Item -ItemType Directory -Force $models | Out-Null
$onnx = Join-Path $models "en_GB-alan-medium.onnx"
if (-not (Test-Path $onnx)) {
  Write-Host "Downloading voice model (~63 MB)..."
  Invoke-WebRequest -Uri $modelUrl -OutFile $onnx -UseBasicParsing
  Invoke-WebRequest -Uri $jsonUrl  -OutFile "$onnx.json" -UseBasicParsing
} else { Write-Host "Voice model already present." }

# Static ffmpeg for the deepen/warm post-processing chain.
$ffDir = Join-Path $root "vendor\ffmpeg"
$ffExe = Join-Path $ffDir "ffmpeg.exe"
New-Item -ItemType Directory -Force $ffDir | Out-Null
if (-not (Test-Path $ffExe)) {
  Write-Host "Downloading ffmpeg (~30 MB)..."
  $ffZip = Join-Path $root "vendor\ffmpeg.zip"
  Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile $ffZip -UseBasicParsing
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [System.IO.Compression.ZipFile]::OpenRead($ffZip)
  $entry = $z.Entries | Where-Object { $_.FullName -match 'bin/ffmpeg\.exe$' } | Select-Object -First 1
  if ($entry) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $ffExe, $true) }
  $z.Dispose()
  Remove-Item $ffZip
} else { Write-Host "ffmpeg already present." }

if ((Test-Path (Join-Path $dir "piper.exe")) -and (Test-Path $onnx) -and (Test-Path $ffExe)) {
  Write-Host "Voice ready. Launch with 'npm start'."
} else {
  Write-Error "Voice setup incomplete - check the downloads above."
}
