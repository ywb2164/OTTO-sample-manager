param(
  [string]$Zig = 'zig',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$project = Join-Path $root 'otto-drag-helper-zig'
$output = Join-Path $root 'otto-drag-helper.exe'

$zigCommand = Get-Command $Zig -ErrorAction SilentlyContinue
if (-not $zigCommand) {
  throw "Zig was not found. Install it from https://ziglang.org/download/ or pass -Zig <path-to-zig.exe>."
}

Push-Location $project
try {
  & $zigCommand.Source build
  if ($LASTEXITCODE -ne 0) {
    throw "zig build failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

$built = Join-Path $project 'zig-out\bin\otto-drag-helper.exe'
if (-not (Test-Path -LiteralPath $built)) {
  throw "zig build did not produce $built."
}

# The x86 machine type is the whole point of this binary: Melodyne 3.2.2 only
# accepts a drag source from a 32-bit process. Refuse to ship anything else.
$stream = [System.IO.File]::OpenRead($built)
try {
  $reader = New-Object System.IO.BinaryReader($stream)
  $stream.Position = 0x3C
  $peOffset = $reader.ReadInt32()
  $stream.Position = $peOffset
  $signature = $reader.ReadUInt32()
  $machine = $reader.ReadUInt16()
  $stream.Position = $peOffset + 24 + 68
  $subsystem = $reader.ReadUInt16()
} finally {
  $stream.Dispose()
}

if ($signature -ne 0x00004550) {
  throw "Built file is not a PE image."
}
if ($machine -ne 0x014C) {
  throw ("Built helper targets machine 0x{0:X4}; x86 (0x014C) is required." -f $machine)
}
if ($subsystem -ne 2) {
  throw ("Built helper uses subsystem {0}; a GUI subsystem (2) is required." -f $subsystem)
}

Copy-Item -LiteralPath $built -Destination $output -Force
$artifact = Get-Item -LiteralPath $output

if (-not $SkipTests) {
  $report = Join-Path ([System.IO.Path]::GetTempPath()) ("otto-drag-selftest-{0}.txt" -f [guid]::NewGuid())
  $sample = Join-Path $env:WINDIR 'Media\Alarm01.wav'
  if (Test-Path -LiteralPath $sample) {
    $selftest = Start-Process -FilePath $artifact.FullName -ArgumentList '--selftest', $sample, $report -Wait -PassThru
    $selftestReport = Get-Content -LiteralPath $report -Raw
    Remove-Item -LiteralPath $report -Force -ErrorAction SilentlyContinue
    if ($selftest.ExitCode -ne 0 -or $selftestReport -notmatch 'result=PASS') {
      throw "Data object self test failed:`n$selftestReport"
    }
    Write-Output ($selftestReport.Trim())
  } else {
    Write-Warning "No sample wav found at $sample; skipping the data object self test."
  }

  $windowReport = Join-Path ([System.IO.Path]::GetTempPath()) ("otto-drag-windowtest-{0}.txt" -f [guid]::NewGuid())
  $windowTest = Start-Process -FilePath $artifact.FullName -ArgumentList '--window-test', $windowReport -Wait -PassThru
  $windowResult = Get-Content -LiteralPath $windowReport -Raw
  Remove-Item -LiteralPath $windowReport -Force -ErrorAction SilentlyContinue
  if ($windowTest.ExitCode -ne 0 -or $windowResult -notmatch 'result=PASS') {
    throw "Source window test failed:`n$windowResult"
  }
  Write-Output ($windowResult.Trim())
}

$artifact | Select-Object FullName, Length, LastWriteTime
