# install_host.ps1
# Run as Administrator after loading the extension and getting its ID.
# Usage: .\install_host.ps1 -ExtensionId "abcdefghijklmnopabcdefghijklmnop"

param(
    [Parameter(Mandatory=$true)]
    [string]$ExtensionId,

    [string]$InstallDir = "C:\taboutliner"
)

$manifestSrc = Join-Path $PSScriptRoot "com.taboutliner.host.json"
$manifestDst = Join-Path $InstallDir "com.taboutliner.host.json"
$wrapperSrc  = Join-Path $PSScriptRoot "host_wrapper.bat"
$wrapperDst  = Join-Path $InstallDir "daemon\host_wrapper.bat"

# Update allowed_origins in manifest
$manifest = Get-Content $manifestSrc | ConvertFrom-Json
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest.path = $wrapperDst

# Write manifest
$manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestDst -Encoding UTF8
Write-Host "Manifest written to $manifestDst"

# Copy wrapper
Copy-Item $wrapperSrc $wrapperDst -Force
Write-Host "Wrapper copied to $wrapperDst"

# Register in Windows registry (HKCU - no admin needed for user install)
$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.taboutliner.host"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestDst
Write-Host "Registry key set: $regPath -> $manifestDst"

Write-Host ""
Write-Host "Done. Restart Chrome, then enable the extension."
