# Compatible with Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param(
    [string]$Version = $env:RIO_VERSION,
    [string]$InstallDir = $env:RIO_INSTALL_DIR,
    [switch]$NoModifyPath = ($env:RIO_NO_MODIFY_PATH -eq '1'),
    [switch]$Uninstall = ($env:RIO_UNINSTALL -eq '1'),
    [switch]$Purge = ($env:RIO_PURGE -eq '1')
)
function Install-Rio {
    [CmdletBinding()]
    param(
        [string]$Version,
        [string]$InstallDir,
        [switch]$NoModifyPath,
        [switch]$Uninstall,
        [switch]$Purge
    )
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $rioTemp = $null
    $rioStage = $null
    if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\rio\bin' }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $rioBinary = Join-Path $InstallDir 'rio.exe'
    $rioOld = Join-Path $InstallDir 'rio.exe.old'
    if ($env:RIO_CONFIG_DIR) { $rioConfig = $env:RIO_CONFIG_DIR }
    elseif ($env:XDG_CONFIG_HOME) { $rioConfig = Join-Path $env:XDG_CONFIG_HOME 'rio' }
    else { $rioConfig = Join-Path $env:APPDATA 'rio' }
    try {
        if ($Uninstall) {
            foreach ($rioFile in @($rioBinary, $rioOld, (Join-Path $InstallDir 'rio.exe.new'))) {
                if (Test-Path -LiteralPath $rioFile) { Remove-Item -LiteralPath $rioFile -Force }
            }
            $rioUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            if ($null -ne $rioUserPath) {
                $rioEntries = @($rioUserPath.Split(';') | Where-Object { -not [StringComparer]::OrdinalIgnoreCase.Equals($_, $InstallDir) })
                [Environment]::SetEnvironmentVariable('Path', ($rioEntries -join ';'), 'User')
            }
            if ($Purge) {
                $rioConfig = [IO.Path]::GetFullPath($rioConfig)
                if ($rioConfig -eq [IO.Path]::GetPathRoot($rioConfig) -or $rioConfig -eq $env:USERPROFILE) { throw 'Refusing to purge an unsafe configuration directory' }
                if (Test-Path -LiteralPath $rioConfig) { Remove-Item -LiteralPath $rioConfig -Recurse -Force }
                Write-Output "Removed configuration: $rioConfig"
            } else { Write-Output "Configuration kept: $rioConfig" }
            Write-Output 'Rio uninstalled (or was already absent). Remove repository caches manually: <repository>\.rio\cache, or your configured cache.dir. Open a new terminal to refresh PATH.'
            return
        }
        if ($Purge) { throw '-Purge requires -Uninstall' }
        $rioOS = $env:OS
        if ($env:RIO_INSTALL_OS) { $rioOS = $env:RIO_INSTALL_OS }
        $rioArch = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $rioArch = $env:PROCESSOR_ARCHITEW6432 }
        if ($env:RIO_INSTALL_ARCH) { $rioArch = $env:RIO_INSTALL_ARCH }
        if ($rioOS -ne 'Windows_NT') { throw 'Unsupported platform. Supported: Windows x64 and Windows arm64' }
        switch -Regex ($rioArch) {
            '^(AMD64|x86_64|x64)$' { $rioTarget = 'x86_64-pc-windows-msvc'; break }
            '^(ARM64|aarch64)$' { $rioTarget = 'aarch64-pc-windows-msvc'; break }
            default { throw "Unsupported architecture $rioArch. Supported: Windows x64 and Windows arm64" }
        }
        if ($PSVersionTable.PSVersion.Major -le 5) { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }
        $rioBase = $env:RIO_DOWNLOAD_BASE
        if ($rioBase -and $rioBase -notmatch '^https://' -and $rioBase -match '^[A-Za-z][A-Za-z0-9+.-]*://' ) { throw 'Only HTTPS URLs or local paths are accepted' }
        if (-not $Version) { $Version = 'latest' }
        if ($Version -eq 'latest') {
            if ($rioBase -and $rioBase -notmatch '^https://') {
                $rioMatches = @(Get-ChildItem -LiteralPath $rioBase -Filter "rio-*-$rioTarget.zip" -File)
                if ($rioMatches.Count -ne 1) { throw 'Local source needs -Version when zero or multiple matching archives exist' }
                $Version = $rioMatches[0].Name.Substring(4).Replace("-$rioTarget.zip", '')
            } else {
                $rioUri = [Uri]'https://github.com/pixelinfinito/rio/releases/latest'
                for ($rioRedirect = 0; $rioRedirect -le 10; $rioRedirect++) {
                    if ($rioUri.Scheme -ne 'https') { throw 'Latest-version redirects must use HTTPS' }
                    $rioRequest = [Net.HttpWebRequest]::Create($rioUri)
                    $rioRequest.AllowAutoRedirect = $false
                    $rioRequest.Timeout = 120000
                    $rioWebResponse = $rioRequest.GetResponse()
                    try {
                        $rioStatus = [int]$rioWebResponse.StatusCode
                        if ($rioStatus -ge 300 -and $rioStatus -lt 400) {
                            $rioUri = [Uri]::new($rioUri, $rioWebResponse.Headers['Location'])
                            if ($rioRedirect -eq 10) { throw 'Too many latest-version redirects' }
                        } else { break }
                    } finally { $rioWebResponse.Dispose() }
                }
                $rioResolved = $rioUri.AbsoluteUri
                if ($rioResolved -notmatch '^https://github.com/pixelinfinito/rio/releases/tag/(v[^/]+)$') { throw 'Latest version resolution failed' }
                $Version = $Matches[1]
            }
        }
        if ($Version -notmatch '^v') { $Version = 'v' + $Version }
        if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw "Invalid version: $Version" }
        if (-not $rioBase) { $rioBase = "https://github.com/pixelinfinito/rio/releases/download/$Version" }
        $rioArchive = "rio-$($Version.Substring(1))-$rioTarget.zip"
        $rioTemp = Join-Path ([IO.Path]::GetTempPath()) ('rio-' + [Guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $rioTemp
        foreach ($rioName in @($rioArchive, 'SHA256SUMS')) {
            $rioDestination = Join-Path $rioTemp $rioName
            if ($rioBase -match '^https://') {
                # Do not permit HTTPS redirects to a plaintext or arbitrary scheme.
                $rioUri = [Uri]($rioBase.TrimEnd('/') + '/' + $rioName)
                for ($rioRedirect = 0; $rioRedirect -le 10; $rioRedirect++) {
                    if ($rioUri.Scheme -ne 'https') { throw 'Download redirects must use HTTPS' }
                    $rioRequest = [Net.HttpWebRequest]::Create($rioUri)
                    $rioRequest.AllowAutoRedirect = $false
                    $rioRequest.Timeout = 120000
                    $rioWebResponse = $rioRequest.GetResponse()
                    try {
                        $rioStatus = [int]$rioWebResponse.StatusCode
                        if ($rioStatus -ge 300 -and $rioStatus -lt 400) {
                            $rioUri = [Uri]::new($rioUri, $rioWebResponse.Headers['Location'])
                            if ($rioRedirect -eq 10) { throw 'Too many download redirects' }
                        } else {
                            $rioStream = [IO.File]::Create($rioDestination)
                            try { $rioWebResponse.GetResponseStream().CopyTo($rioStream) } finally { $rioStream.Dispose() }
                            break
                        }
                    } finally { $rioWebResponse.Dispose() }
                }
            } else { Copy-Item -LiteralPath (Join-Path $rioBase $rioName) -Destination $rioDestination }
        }
        $rioChecks = @(Get-Content -LiteralPath (Join-Path $rioTemp 'SHA256SUMS') | ForEach-Object {
            $rioFields = $_ -split '\s+', 2
            if ($rioFields.Count -eq 2 -and $rioFields[1].TrimStart('*') -ceq $rioArchive) { $rioFields[0] }
        })
        if ($rioChecks.Count -ne 1 -or $rioChecks[0] -notmatch '^[a-fA-F0-9]{64}$') { throw "Checksum entry missing or ambiguous for $rioArchive" }
        $rioHash = (Get-FileHash -LiteralPath (Join-Path $rioTemp $rioArchive) -Algorithm SHA256).Hash
        if ($rioHash -ine $rioChecks[0]) { throw "Checksum mismatch for $rioArchive" }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $rioZip = [IO.Compression.ZipFile]::OpenRead((Join-Path $rioTemp $rioArchive))
        try { foreach ($rioEntry in $rioZip.Entries) { if ($rioEntry.FullName -cnotin @('rio.exe', 'LICENSE', 'README.md')) { throw "Unexpected archive member: $($rioEntry.FullName)" } } } finally { $rioZip.Dispose() }
        $rioExtract = Join-Path $rioTemp 'extract'
        Expand-Archive -LiteralPath (Join-Path $rioTemp $rioArchive) -DestinationPath $rioExtract
        if (-not (Test-Path -LiteralPath (Join-Path $rioExtract 'rio.exe') -PathType Leaf)) { throw 'Archive has no rio.exe binary' }
        $null = New-Item -ItemType Directory -Path $InstallDir -Force
        $rioStage = Join-Path $InstallDir 'rio.exe.new'
        Copy-Item -LiteralPath (Join-Path $rioExtract 'rio.exe') -Destination $rioStage -Force
        try {
            # CreateProcess executes the staged PE even with its .exe.new suffix.
            $rioStart = New-Object Diagnostics.ProcessStartInfo
            $rioStart.FileName = $rioStage
            $rioStart.Arguments = '--version'
            $rioStart.UseShellExecute = $false
            $rioStart.CreateNoWindow = $true
            $rioStart.RedirectStandardOutput = $true
            $rioStart.RedirectStandardError = $true
            $rioProcess = [Diagnostics.Process]::Start($rioStart)
            try {
                $rioOutput = $rioProcess.StandardOutput.ReadToEndAsync()
                $rioError = $rioProcess.StandardError.ReadToEndAsync()
                if (-not $rioProcess.WaitForExit(30000)) { $rioProcess.Kill(); throw 'Binary smoke test timed out' }
                $rioSmoke = $rioOutput.GetAwaiter().GetResult().Trim()
                $null = $rioError.GetAwaiter().GetResult()
                if ($rioProcess.ExitCode -ne 0) { throw 'Binary returned failure' }
            } finally { $rioProcess.Dispose() }
        } catch { throw "Staged binary smoke test failed; existing rio was kept: $_" }
        if (Test-Path -LiteralPath $rioBinary) {
            try { Move-Item -LiteralPath $rioBinary -Destination $rioOld -Force } catch { throw "Cannot replace rio.exe. Close running rio processes and retry: $_" }
        }
        try { Move-Item -LiteralPath $rioStage -Destination $rioBinary -Force }
        catch { if (Test-Path -LiteralPath $rioOld) { Move-Item -LiteralPath $rioOld -Destination $rioBinary -Force }; throw "Binary publication failed; previous rio restored: $_" }
        if (Test-Path -LiteralPath $rioOld) { Remove-Item -LiteralPath $rioOld -Force }
        $rioStage = $null
        if (-not $NoModifyPath) {
            $rioUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $rioFound = @($rioUserPath -split ';' | Where-Object { [StringComparer]::OrdinalIgnoreCase.Equals($_, $InstallDir) }).Count -gt 0
            if (-not $rioFound) {
                if ([string]::IsNullOrEmpty($rioUserPath)) { $rioUserPath = $InstallDir } else { $rioUserPath += ';' + $InstallDir }
                [Environment]::SetEnvironmentVariable('Path', $rioUserPath, 'User')
            }
            Write-Output 'Open a new terminal to use the updated user PATH.'
        } else { Write-Output "PATH unchanged. Add $InstallDir to PATH to use Rio." }
        Write-Output "Installed $rioSmoke in $InstallDir"
    } catch { throw "Rio installation failed: $_" }
    finally {
        if ($rioStage -and (Test-Path -LiteralPath $rioStage)) { Remove-Item -LiteralPath $rioStage -Force }
        if ($rioTemp -and (Test-Path -LiteralPath $rioTemp)) { Remove-Item -LiteralPath $rioTemp -Recurse -Force }
    }
}
Install-Rio -Version $Version -InstallDir $InstallDir -NoModifyPath:$NoModifyPath -Uninstall:$Uninstall -Purge:$Purge
