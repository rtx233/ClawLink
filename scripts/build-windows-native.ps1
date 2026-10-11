param([switch]$Fixture)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll')
foreach ($assembly in @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll')) {
    $references += Join-Path $framework "WPF\$assembly"
}
$source = Join-Path $root 'native\windows\ClawLinkBridge.cs'
$output = Join-Path $root 'native\ClawLinkBridge.exe'
if ($Fixture) { $source = Join-Path $root 'tests\native\WindowsFixture.cs'; $output = Join-Path $root 'native\ClawLinkFixture.exe' }
if (!(Test-Path $compiler)) { throw '.NET Framework 4.8 编译器未找到；请在 Windows 10/11 x64 上构建' }
$arguments = @('/nologo', '/codepage:65001', '/optimize+', '/platform:x64', '/target:exe', "/out:$output")
foreach ($reference in $references) { $arguments += "/reference:$reference" }
& $compiler @arguments $source
if ($LASTEXITCODE -ne 0) { throw 'Windows 原生连接器编译失败' }
