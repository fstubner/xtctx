[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [Parameter(Mandatory)][string]$ProjectRoot,
  [ValidatePattern('^[a-zA-Z0-9_-]{1,64}$')][string]$Account = 'personal',
  [string]$NodePath = "$env:ProgramFiles\nodejs\node.exe",
  [ValidateSet("brave", "chrome")][string]$Browser = "brave",
  [switch]$Sync
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$cliPath = Join-Path $repoRoot 'dist\src\cli\index.js'
$archivePath = [IO.Path]::GetFullPath($ProjectRoot)
$runtimePath = [IO.Path]::GetFullPath($NodePath)
foreach ($path in @($cliPath,$archivePath,$runtimePath)) {
  if ($path -match '[%"!\r\n]') { throw 'Launcher paths cannot contain shell expansion characters.' }
}
if (!(Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw 'Build xtctx before installing the native host.' }
if (!(Test-Path -LiteralPath $runtimePath -PathType Leaf)) { throw 'Node runtime not found.' }
if (!(Test-Path -LiteralPath (Join-Path $archivePath '.xtctx\config.yaml'))) { throw 'Set up the dedicated archive project first.' }
$nativeRoot = Join-Path $env:LOCALAPPDATA 'xtctx\native-web'
$manifestPath = Join-Path $nativeRoot 'io.xtctx.web_history.json'
$launcherPath = Join-Path $nativeRoot 'web-history.cmd'
$registryBase = if ($Browser -eq 'brave') { 'HKCU:\Software\BraveSoftware\Brave-Browser' } else { 'HKCU:\Software\Google\Chrome' }
$registryPath = Join-Path $registryBase 'NativeMessagingHosts\io.xtctx.web_history' 
if (Test-Path $registryPath) {
  $registered=(Get-Item -LiteralPath $registryPath).GetValue('')
  if ($registered -ne $manifestPath) { throw 'A different native host registration already exists; nothing changed.' }
}
if ($PSCmdlet.ShouldProcess("$manifestPath and $registryPath", 'Register the user-owned xtctx native bridge for this extension only')) {
  New-Item -ItemType Directory -Path $nativeRoot -Force | Out-Null
  $syncArg = if ($Sync) { ' --sync' } else { '' }
  $launcher = "@echo off`r`nset XTCTX_DISABLE_EMBEDDINGS=1`r`n`"$runtimePath`" `"$cliPath`" web-native-host --account $Account --archive `"$archivePath`"$syncArg`r`n"
  [IO.File]::WriteAllText($launcherPath,$launcher,[Text.UTF8Encoding]::new($false))
  $manifest = @{ name='io.xtctx.web_history';description='Private xtctx web capture';path=$launcherPath;type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/") }
  [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -LiteralPath $registryPath -Value $manifestPath
  Write-Output "Registered only chrome-extension://$ExtensionId/. Site capture still requires browser opt-in."
}
