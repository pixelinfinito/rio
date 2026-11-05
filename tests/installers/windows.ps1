[CmdletBinding()]
param([string]$Shell = 'pwsh', [string]$Binary = (Join-Path $PSScriptRoot '..\..\target\debug\rio.exe'))
$ErrorActionPreference = 'Stop'
$rioRoot = Join-Path ([IO.Path]::GetTempPath()) ('rio-tests-' + [Guid]::NewGuid().ToString('N'))
$rioInstaller = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\scripts\install.ps1'))
$rioOriginalPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$rioSavedEnv = @{}
foreach ($rioName in @('RIO_DOWNLOAD_BASE', 'RIO_VERSION', 'RIO_INSTALL_DIR', 'RIO_CONFIG_DIR', 'RIO_NO_MODIFY_PATH', 'RIO_UNINSTALL', 'RIO_PURGE', 'RIO_INSTALL_OS', 'RIO_INSTALL_ARCH')) { $rioSavedEnv[$rioName] = [Environment]::GetEnvironmentVariable($rioName) }
function Assert-Rio([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-RioInstaller([string[]]$Arguments = @(), [bool]$Success = $true) {
    & $Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $rioInstaller @Arguments | Out-Host
    Assert-Rio (($LASTEXITCODE -eq 0) -eq $Success) "Unexpected installer exit $LASTEXITCODE"
}
function Write-RioArchive([string]$Source, [string]$Archive) {
    Compress-Archive -Path (Join-Path $Source '*') -DestinationPath $Archive -Force
    $rioHash = (Get-FileHash $Archive -Algorithm SHA256).Hash
    Set-Content -LiteralPath (Join-Path (Split-Path $Archive) 'SHA256SUMS') -Value "$rioHash  $(Split-Path $Archive -Leaf)" -Encoding Ascii
}
try {
    $null = New-Item -ItemType Directory -Path $rioRoot
    $rioSource = Join-Path $rioRoot 'source'; $null = New-Item -ItemType Directory -Path $rioSource
    $rioPackage = Join-Path $rioRoot 'package'; $null = New-Item -ItemType Directory -Path $rioPackage
    Copy-Item -LiteralPath $Binary -Destination (Join-Path $rioPackage 'rio.exe')
    Set-Content -Path (Join-Path $rioPackage 'LICENSE') -Value 'Apache-2.0'
    Set-Content -Path (Join-Path $rioPackage 'README.md') -Value 'Rio'
    $rioArch = 'x86_64'; if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $rioArch = 'aarch64' }
    $rioArchive = Join-Path $rioSource "rio-0.1.0-$rioArch-pc-windows-msvc.zip"
    Write-RioArchive $rioPackage $rioArchive
    $env:RIO_DOWNLOAD_BASE = $rioSource; $env:RIO_VERSION = 'v0.1.0'; $env:RIO_INSTALL_DIR = Join-Path $rioRoot 'bin with spaces'; $env:RIO_CONFIG_DIR = Join-Path $rioRoot 'configuration'
    $env:RIO_UNINSTALL = '0'; $env:RIO_PURGE = '0'; $env:RIO_INSTALL_OS = 'Windows_NT'; $env:RIO_INSTALL_ARCH = $rioArch
    $null = New-Item -ItemType Directory -Path $env:RIO_CONFIG_DIR
    Set-Content -LiteralPath (Join-Path $env:RIO_CONFIG_DIR 'config.toml') -Value '# keep'
    $env:RIO_NO_MODIFY_PATH = '1'; Invoke-RioInstaller
    $env:RIO_VERSION = 'latest'; Invoke-RioInstaller; $env:RIO_VERSION = 'v0.1.0'
    Assert-Rio ([Environment]::GetEnvironmentVariable('Path', 'User') -ceq $rioOriginalPath) 'NoModifyPath modified PATH'
    $rioInstalled = Join-Path $env:RIO_INSTALL_DIR 'rio.exe'
    Assert-Rio (Test-Path $rioInstalled) 'Binary not installed'
    $rioExpected = (Get-FileHash $rioInstalled).Hash
    Set-Content -LiteralPath (Join-Path $env:RIO_INSTALL_DIR 'keep') -Value 'unrelated'
    $env:RIO_NO_MODIFY_PATH = '0'; Invoke-RioInstaller
    $rioPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    Assert-Rio ($rioPath.Split(';') -contains $env:RIO_INSTALL_DIR) 'Rio directory missing from user PATH'
    Invoke-RioInstaller
    Assert-Rio (@([Environment]::GetEnvironmentVariable('Path', 'User').Split(';') | Where-Object { $_ -eq $env:RIO_INSTALL_DIR }).Count -eq 1) 'Duplicate PATH entry'
    Add-Content -LiteralPath $rioArchive -Value 'corrupt'; Invoke-RioInstaller -Success $false
    Assert-Rio ((Get-FileHash $rioInstalled).Hash -eq $rioExpected) 'Checksum failure replaced binary'
    Write-RioArchive $rioPackage $rioArchive
    Set-Content -LiteralPath (Join-Path $rioSource 'SHA256SUMS') -Value ('0' * 64 + '  missing.zip'); Invoke-RioInstaller -Success $false
    Assert-Rio ((Get-FileHash $rioInstalled).Hash -eq $rioExpected) 'Missing checksum replaced binary'
    Set-Content -LiteralPath (Join-Path $rioPackage 'rio.exe') -Value 'not an executable'; Write-RioArchive $rioPackage $rioArchive
    Invoke-RioInstaller -Success $false
    Assert-Rio ((Get-FileHash $rioInstalled).Hash -eq $rioExpected) 'Smoke failure replaced binary'
    Assert-Rio (-not (Test-Path (Join-Path $env:RIO_INSTALL_DIR 'rio.exe.new'))) 'Staging file survived smoke failure'
    $env:RIO_DOWNLOAD_BASE = 'http://mirror.invalid/rio'; Invoke-RioInstaller -Success $false; $env:RIO_DOWNLOAD_BASE = $rioSource
    $env:RIO_INSTALL_ARCH = 'x86'; Invoke-RioInstaller -Success $false; $env:RIO_INSTALL_ARCH = $rioArch
    $rioBefore = 'C:\tools;' + $env:RIO_INSTALL_DIR + ';C:\other;' + $env:RIO_INSTALL_DIR + '-similar'
    [Environment]::SetEnvironmentVariable('Path', $rioBefore, 'User')
    Invoke-RioInstaller -Arguments @('-Uninstall')
    Assert-Rio ([Environment]::GetEnvironmentVariable('Path', 'User') -ceq ('C:\tools;C:\other;' + $env:RIO_INSTALL_DIR + '-similar')) 'Uninstall changed unrelated PATH entries'
    Assert-Rio (Test-Path (Join-Path $env:RIO_INSTALL_DIR 'keep')) 'Uninstall removed unrelated file'
    Assert-Rio (Test-Path $env:RIO_CONFIG_DIR) 'Uninstall removed kept configuration'
    Invoke-RioInstaller -Arguments @('-Uninstall', '-Purge')
    Assert-Rio (-not (Test-Path $env:RIO_CONFIG_DIR)) 'Purge kept configuration'
    Copy-Item -LiteralPath $Binary -Destination (Join-Path $rioPackage 'rio.exe') -Force
    Write-RioArchive $rioPackage $rioArchive
    $rioDisk = Join-Path $rioRoot 'cross-filesystem.vhd'
    $rioDiskScript = Join-Path $rioRoot 'diskpart.txt'
    $rioDrive = @('R', 'S', 'T', 'U', 'V') | Where-Object { -not (Test-Path ($_ + ':\')) } | Select-Object -First 1
    if (-not $rioDrive) { throw 'No free drive for cross-filesystem installer test' }
    @("create vdisk file=`"$rioDisk`" maximum=96 type=expandable", "select vdisk file=`"$rioDisk`"", 'attach vdisk', 'create partition primary', 'format fs=ntfs quick', "assign letter=$rioDrive") | Set-Content $rioDiskScript -Encoding Ascii
    try {
        & diskpart /s $rioDiskScript | Out-Host
        Assert-Rio (Test-Path ($rioDrive + ':\')) 'Could not create test filesystem'
        $env:RIO_INSTALL_DIR = $rioDrive + ':\rio'
        $env:RIO_NO_MODIFY_PATH = '1'
        Invoke-RioInstaller
        Assert-Rio (Test-Path (Join-Path $env:RIO_INSTALL_DIR 'rio.exe')) 'Cross-filesystem install failed'
        Invoke-RioInstaller -Arguments @('-Uninstall')
    } finally {
        @("select vdisk file=`"$rioDisk`"", 'detach vdisk') | Set-Content $rioDiskScript -Encoding Ascii
        & diskpart /s $rioDiskScript | Out-Host
    }
    Write-Output "Installer contract tests passed on $Shell"
} finally {
    [Environment]::SetEnvironmentVariable('Path', $rioOriginalPath, 'User')
    foreach ($rioName in $rioSavedEnv.Keys) { [Environment]::SetEnvironmentVariable($rioName, $rioSavedEnv[$rioName]) }
    if (Test-Path $rioRoot) { Remove-Item -LiteralPath $rioRoot -Recurse -Force }
}
