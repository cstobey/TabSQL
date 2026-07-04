# install_host.ps1
# Usage: .\install_host.ps1 -ExtensionId "abcdefghijklmnopabcdefghijklmnop"
# -InstallDir defaults to the folder this script lives in (the project root).

param(
    [Parameter(Mandatory=$true)]
    [string]$ExtensionId,

    [string]$InstallDir = $PSScriptRoot
)

$manifestSrc = Join-Path $PSScriptRoot "com.tabsql.host.json"
$manifestDst = Join-Path $InstallDir "com.tabsql.host.json"
$wrapperSrc  = Join-Path $PSScriptRoot "host_wrapper.bat"
$wrapperDst  = Join-Path $InstallDir "host_wrapper.bat"

# Patch host_wrapper.bat with the actual install dir and write to destination
$wrapperContent = Get-Content $wrapperSrc -Raw
$wrapperContent = $wrapperContent -replace 'set DAEMON_DIR=.*', "set DAEMON_DIR=$InstallDir"
if ($manifestSrc -ne $wrapperDst) {
    Set-Content $wrapperDst $wrapperContent -Encoding ASCII
    Write-Host "Wrapper written to $wrapperDst"
} else {
    Set-Content $wrapperDst $wrapperContent -Encoding ASCII
    Write-Host "Wrapper patched at $wrapperDst"
}

# Update allowed_origins and path in manifest
$manifest = Get-Content $manifestSrc | ConvertFrom-Json
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest.path = $wrapperDst

# Write manifest (in-place if src == dst, which is the common case)
$manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestDst -Encoding UTF8
Write-Host "Manifest written to $manifestDst"

# Register in Windows registry (HKCU - no admin needed)
$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tabsql.host"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestDst
Write-Host "Registry key set: $regPath -> $manifestDst"

Write-Host ""
Write-Host "Done. Restart Chrome, then enable the extension."
