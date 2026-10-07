#Requires -Version 5.1
<#
.SYNOPSIS
Recoverably uninstall the per-user Windows Cluster Watcher application.
#>
[CmdletBinding()]
param(
    [string]$BinDir = (Join-Path $env:LOCALAPPDATA "Programs\ClusterWatcher"),
    [switch]$PurgeConfig,
    [switch]$KeepPath,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    @"
Usage: .\uninstall.ps1 [-BinDir DIR] [-PurgeConfig] [-KeepPath]

Removes only files recorded by install.ps1. Files are moved into a timestamped
recovery directory. Configuration is preserved unless -PurgeConfig is set.
"@
    exit 0
}

$BinDir = [IO.Path]::GetFullPath($BinDir)
$Marker = Join-Path $BinDir ".cluster-watcher-install.json"
if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
    throw "no installation manifest found at $Marker"
}
$manifest = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
if ($manifest.version -ne 3) { throw "installation manifest is not recognized; no files were changed" }

$binary = [IO.Path]::GetFullPath([string]$manifest.binary)
$command = [IO.Path]::GetFullPath([string]$manifest.command)
$configPointer = [IO.Path]::GetFullPath([string]$manifest.config_pointer)
$manifestBinDir = [IO.Path]::GetFullPath([string]$manifest.bin_dir)
if ($manifestBinDir.TrimEnd('\') -ine $BinDir.TrimEnd('\')) {
    throw "installation manifest does not belong to $BinDir"
}
foreach ($target in @($binary, $command, $configPointer, $Marker)) {
    if ([IO.Path]::GetDirectoryName($target).TrimEnd('\') -ine $BinDir.TrimEnd('\')) {
        throw "installation manifest contains a path outside $BinDir"
    }
}

$StateDir = [IO.Path]::GetFullPath([string]$manifest.state)
$stateRoot = [IO.Path]::GetPathRoot($StateDir)
if ($StateDir.TrimEnd('\') -eq $stateRoot.TrimEnd('\') -or $StateDir.TrimEnd('\') -eq $HOME.TrimEnd('\')) {
    throw "installation manifest contains an unsafe state directory"
}
$ConfigDir = [IO.Path]::GetFullPath([string]$manifest.config_dir)
$config = [IO.Path]::GetFullPath([string]$manifest.config)
$profiles = [IO.Path]::GetFullPath([string]$manifest.profiles)
foreach ($target in @($config, $profiles)) {
    if ([IO.Path]::GetDirectoryName($target).TrimEnd('\') -ine $ConfigDir.TrimEnd('\')) {
        throw "installation manifest contains a configuration path outside $ConfigDir"
    }
}
$backup = Join-Path $StateDir ("uninstall-backup-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + ".$PID")
New-Item -ItemType Directory -Force -Path $backup | Out-Null

if (-not $KeepPath -and $manifest.path_added) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $segments = @($userPath -split ';' | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and $_.TrimEnd('\') -ine $BinDir.TrimEnd('\')
    })
    [Environment]::SetEnvironmentVariable("Path", ($segments -join ';'), "User")
    Write-Host "Removed $BinDir from the user PATH."
}

$targets = @($binary, $command, $configPointer)
if ($PurgeConfig) {
    $targets += $config
    $targets += $profiles
} else {
    Write-Host "Preserved configuration: $($manifest.config)"
}
$targets += $Marker

foreach ($target in $targets | Select-Object -Unique) {
    if (-not $target -or -not (Test-Path -LiteralPath $target)) { continue }
    $item = Get-Item -LiteralPath $target -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "refusing to remove non-file or reparse-point path: $target"
    }
    Move-Item -LiteralPath $target -Destination (Join-Path $backup $item.Name)
    Write-Host "Removed $target"
}

Write-Host "Recovery backup: $backup"
