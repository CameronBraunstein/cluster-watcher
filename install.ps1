#Requires -Version 5.1
<#
.SYNOPSIS
Install Cluster Watcher for the current Windows user.

.DESCRIPTION
Downloads the native Windows executable from a GitHub Release, verifies it
against SHA256SUMS, and installs a stable cluster-watcher.exe command. Existing
configuration is preserved. Native Windows supports SSH key/agent
authentication; use WSL for reusable password/OTP sessions.
#>
[CmdletBinding()]
param(
    [string]$Version = "latest",
    [string]$BinDir = (Join-Path $env:LOCALAPPDATA "Programs\ClusterWatcher"),
    [string]$ConfigDir = (Join-Path $env:APPDATA "ClusterWatcher"),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA "ClusterWatcher"),
    [switch]$AddToPath,
    [switch]$Force,
    [switch]$FromSource,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$Repository = if ($env:CLUSTER_WATCHER_REPO) { $env:CLUSTER_WATCHER_REPO } else { "CameronBraunstein/cluster-watcher" }
$ProjectRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "cluster-watcher.spec") -PathType Leaf) {
    $PSScriptRoot
} else {
    $null
}

function Show-Usage {
    @"
Usage: .\install.ps1 [-Version TAG] [-AddToPath] [-FromSource] [-Force]

Installs Cluster Watcher for the current Windows user.

  -Version TAG       Install TAG (for example v0.1.2); default: latest.
  -FromSource        Build this checkout with Python 3.11+ and PyInstaller.
  -AddToPath         Add the installation directory to the user PATH.
  -BinDir DIR        Executable directory (default: $BinDir).
  -ConfigDir DIR     Configuration directory (default: $ConfigDir).
  -StateDir DIR      Backups/state directory (default: $StateDir).
  -Force             Back up and replace unrelated command files.

Environment variables CLUSTER_WATCHER_REPO and CLUSTER_WATCHER_RELEASE_URL
select another repository or release download base.
"@
}

function Get-NormalizedArchitecture {
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    switch ($architecture) {
        "x64" { return "x86_64" }
        "amd64" { return "x86_64" }
        "arm64" { return "aarch64" }
        default { return $architecture }
    }
}

function Assert-SafeDirectory([string]$Label, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Label cannot be empty" }
    $full = [IO.Path]::GetFullPath($Value)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.TrimEnd('\') -eq $root.TrimEnd('\')) { throw "unsafe ${Label}: $full" }
    if ($full.TrimEnd('\') -eq $HOME.TrimEnd('\')) { throw "unsafe ${Label}: $full" }
    return $full
}

function Get-ReleaseBase {
    if ($env:CLUSTER_WATCHER_RELEASE_URL) { return $env:CLUSTER_WATCHER_RELEASE_URL.TrimEnd('/') }
    if ($Version -eq "latest") { return "https://github.com/$Repository/releases/latest/download" }
    if ($Version -notmatch '^[A-Za-z0-9._-]+$') { throw "invalid release tag: $Version" }
    return "https://github.com/$Repository/releases/download/$Version"
}

function Save-Url([string]$Url, [string]$Destination) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

if ($Help) {
    Show-Usage
    exit 0
}

$BinDir = Assert-SafeDirectory "binary directory" $BinDir
$ConfigDir = Assert-SafeDirectory "configuration directory" $ConfigDir
$StateDir = Assert-SafeDirectory "state directory" $StateDir

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw "OpenSSH Client is required; install the Windows optional feature 'OpenSSH Client'"
}

$Architecture = Get-NormalizedArchitecture
if ($Architecture -notin @("x86_64", "aarch64")) {
    throw "no Windows release is published for architecture '$Architecture'; use a supported x64 or ARM64 host"
}
$WindowsVersion = [Environment]::OSVersion.Version
if ($WindowsVersion.Major -lt 10 -or ($WindowsVersion.Major -eq 10 -and $WindowsVersion.Build -lt 17763)) {
    throw "Windows 10 build 1809 or newer is required"
}
if ($Architecture -eq "aarch64" -and $WindowsVersion.Build -lt 22000) {
    throw "native ARM64 installation requires Windows 11 or newer"
}
$Artifact = "cluster-watcher-windows-$Architecture.exe"
$PrivateBinary = Join-Path $BinDir $Artifact
$Command = Join-Path $BinDir "cluster-watcher.exe"
$Marker = Join-Path $BinDir ".cluster-watcher-install.json"
$ConfigPointer = Join-Path $BinDir ".cluster-watcher-config"
$Config = Join-Path $ConfigDir "clusters.toml"
$Profiles = Join-Path $ConfigDir "gpu_profiles.toml"
$Temporary = Join-Path ([IO.Path]::GetTempPath()) ("cluster-watcher-install." + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Force -Path $BinDir, $ConfigDir, $StateDir, $Temporary | Out-Null

try {
    $OwnedInstall = $false
    $PriorPathAdded = $false
    if (Test-Path -LiteralPath $Marker -PathType Leaf) {
        $prior = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
        $OwnedInstall = $prior.version -eq 3 -and $prior.binary -eq $PrivateBinary -and `
            $prior.command -eq $Command -and $prior.config_pointer -eq $ConfigPointer
        if ($OwnedInstall) { $PriorPathAdded = [bool]$prior.path_added }
        if (-not $OwnedInstall -and -not $Force) {
            throw "installation manifest is not recognized; use -Force to back it up"
        }
    }
    foreach ($target in @($PrivateBinary, $Command, $ConfigPointer)) {
        if ((Test-Path -LiteralPath $target) -and -not $OwnedInstall -and -not $Force) {
            throw "command path already exists: $target (use -Force to back it up)"
        }
    }

    if ($Force -and -not $OwnedInstall) {
        $backup = Join-Path $StateDir ("install-backup-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + ".$PID")
        New-Item -ItemType Directory -Path $backup | Out-Null
        foreach ($target in @($PrivateBinary, $Command, $ConfigPointer, $Marker)) {
            if (Test-Path -LiteralPath $target) {
                Move-Item -LiteralPath $target -Destination (Join-Path $backup ([IO.Path]::GetFileName($target)))
            }
        }
    }

    $BuiltBinary = Join-Path $Temporary $Artifact
    if ($FromSource) {
        if (-not $ProjectRoot) {
            throw "-FromSource must be run from a Cluster Watcher checkout"
        }
        $specification = Join-Path $ProjectRoot "cluster-watcher.spec"
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $python) { throw "Python 3.11 or newer is required for -FromSource" }
        & $python.Source -c "import sys; raise SystemExit(sys.version_info < (3, 11))"
        if ($LASTEXITCODE -ne 0) { throw "Python 3.11 or newer is required for -FromSource" }
        $venv = Join-Path $Temporary "venv"
        & $python.Source -m venv $venv
        $venvPython = Join-Path $venv "Scripts\python.exe"
        & $venvPython -m pip --disable-pip-version-check install "pyinstaller>=6.0,<7"
        & $venvPython -m PyInstaller --noconfirm --clean --distpath (Join-Path $Temporary "dist") --workpath (Join-Path $Temporary "build") $specification
        $BuiltBinary = Join-Path $Temporary "dist\$Artifact"
    } else {
        $base = Get-ReleaseBase
        $checksums = Join-Path $Temporary "SHA256SUMS"
        Save-Url "$base/SHA256SUMS" $checksums
        Save-Url "$base/$Artifact" $BuiltBinary
        $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match ("\s\*?" + [regex]::Escape($Artifact) + '$') } | Select-Object -First 1
        if (-not $line -or $line -notmatch '^([0-9a-fA-F]{64})\s') { throw "SHA256SUMS has no valid entry for $Artifact" }
        $expected = $Matches[1].ToLowerInvariant()
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $BuiltBinary).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "checksum mismatch for $Artifact (expected $expected, got $actual)" }
        Write-Host "Verified SHA-256 checksum."
    }

    if (-not (Test-Path -LiteralPath $BuiltBinary -PathType Leaf)) { throw "build did not produce $Artifact" }
    & $BuiltBinary --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "the executable failed its startup check" }

    # Copy-Item reliably replaces an owned file on Windows PowerShell 5.1;
    # Move-Item -Force does not consistently overwrite an existing target.
    Copy-Item -LiteralPath $BuiltBinary -Destination $PrivateBinary -Force
    Copy-Item -LiteralPath $BuiltBinary -Destination $Command -Force
    [IO.File]::WriteAllText($ConfigPointer, $Config, (New-Object Text.UTF8Encoding($false)))

    $NeedsSetup = -not (Test-Path -LiteralPath $Config)
    $checkoutConfig = if ($ProjectRoot) { Join-Path $ProjectRoot "clusters.toml" } else { $null }
    if ($NeedsSetup -and $checkoutConfig -and (Test-Path -LiteralPath $checkoutConfig -PathType Leaf)) {
        Copy-Item -LiteralPath $checkoutConfig -Destination $Config
        $NeedsSetup = $false
        Write-Host "Installed configuration: $Config"
    } elseif ($NeedsSetup) {
        Write-Host "No configuration yet; it will be created at $Config"
    } else {
        Write-Host "Preserved existing configuration: $Config"
    }
    $checkoutProfiles = if ($ProjectRoot) { Join-Path $ProjectRoot "gpu_profiles.toml" } else { $null }
    if (-not (Test-Path -LiteralPath $Profiles) -and $checkoutProfiles -and (Test-Path -LiteralPath $checkoutProfiles -PathType Leaf)) {
        Copy-Item -LiteralPath $checkoutProfiles -Destination $Profiles
    }

    $PathAdded = $PriorPathAdded
    if ($AddToPath) {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $segments = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if (-not ($segments | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') })) {
            $newPath = (@($segments) + $BinDir) -join ';'
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            $env:Path = "$BinDir;$env:Path"
            $PathAdded = $true
            Write-Host "Added $BinDir to the user PATH. Open a new terminal to use it."
        }
    }

    $manifest = [ordered]@{
        version = 3
        binary = $PrivateBinary
        command = $Command
        config_pointer = $ConfigPointer
        bin_dir = $BinDir
        config = $Config
        profiles = $Profiles
        config_dir = $ConfigDir
        state = $StateDir
        path_added = $PathAdded
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath $Marker -Encoding UTF8

    Write-Host "`nInstalled command: $Command"
    if ($NeedsSetup) { Write-Host "Next, describe your clusters with: cluster-watcher setup" }
    Write-Host "Native Windows supports SSH keys and ssh-agent. Use WSL for password/OTP clusters."
} finally {
    if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Recurse -Force }
}
