$ErrorActionPreference = 'Stop'
$runtimePaths = @(
    "${env:ProgramFiles(x86)}/Microsoft/EdgeWebView/Application/*/msedgewebview2.exe",
    "$env:LOCALAPPDATA/Microsoft/EdgeWebView/Application/*/msedgewebview2.exe"
)
if (Get-Item -Path $runtimePaths -ErrorAction SilentlyContinue) { exit 0 }

$installer = Join-Path $env:RUNNER_TEMP 'webview-runtime.exe'
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
$process = Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Browser runtime installation failed: $($process.ExitCode)" }
if (-not (Get-Item -Path $runtimePaths -ErrorAction SilentlyContinue)) { throw 'Browser runtime was not installed' }
