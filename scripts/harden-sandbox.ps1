<#
.SYNOPSIS
  让官方 Windows 沙箱账户 srt-sandbox（sandbox-runtime-users 组）无法改写 Windows 默认对所有用户开放写入的文件夹。

.DESCRIPTION
  srt-sandbox 是普通 Windows 用户。非系统盘根目录（如 D:\）和直接建在 C:\ 下的文件夹，
  默认允许 Authenticated Users 修改，沙箱里的检查命令因此能改写别的项目和工具链。
  本脚本在这些文件夹上为 srt-sandbox 加一条可继承的“拒绝写入”。每次检查时 Bit Agent
  授予工作区的显式写权限排在继承来的拒绝之前，工作区仍然可写。

  默认只列出目标和当前状态，不做修改。-Apply 加上拒绝，-Remove 撤销。
  修改盘符根目录需要以管理员身份运行；Windows 会把权限传播到整棵目录树，大盘可能需要几分钟。
  读权限不变：这些位置对沙箱仍然可读。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\harden-sandbox.ps1
  powershell -ExecutionPolicy Bypass -File scripts\harden-sandbox.ps1 -Apply
  powershell -ExecutionPolicy Bypass -File scripts\harden-sandbox.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string[]]$Path,
  [switch]$Apply,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
if ($Apply -and $Remove) { throw '-Apply 和 -Remove 只能选一个' }

# 写数据/建文件、追加/建子目录、写扩展属性、写属性、删除、删除子项、改权限、改所有者。
# 必须不含 SYNCHRONIZE：打开目录也要这个权限，拒绝它会让沙箱连目录都列不出来
# （pytest 向上查找配置时失败）。icacls /deny 会自动加上它，所以这里用 .NET 写入。
$DenyRights = [System.Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
$WriteMask = [int]$DenyRights
$Synchronize = 0x100000
$SidType = [System.Security.Principal.SecurityIdentifier]
$BroadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4')
$GenericWrite = 0x40000000
$GenericAll = 0x10000000
$SystemFolders = @(
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users', 'Recovery',
  'PerfLogs', '$Recycle.Bin', 'System Volume Information', 'Config.Msi', '$WinREAgent',
  'Documents and Settings', 'OneDriveTemp'
)

function Get-SandboxSid {
  # 拒绝挂在官方安装器创建的 sandbox-runtime-users 组上，而不是 srt-sandbox 用户本身：
  # srt-win 每次运行都会改写并清理“沙箱用户”的权限项，挂在用户上会被它抹掉。
  # 官方 SDK 自己也用这个组的显式拒绝保护它的状态目录。
  try {
    $account = New-Object System.Security.Principal.NTAccount('sandbox-runtime-users')
    return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    throw '找不到 sandbox-runtime-users 组：请先在 Bit Agent 里运行一次检查，完成官方沙箱安装。'
  }
}

# 直接用 .NET 读写权限，不依赖 Get-Acl / Set-Acl 模块，Windows PowerShell 5.1 和 PowerShell 7 都能用。
function Read-Acl([string]$Target) {
  $sections = [System.Security.AccessControl.AccessControlSections]::Access
  return New-Object System.Security.AccessControl.DirectorySecurity -ArgumentList $Target, $sections
}

function Save-Acl([string]$Target, $Acl) {
  $directory = New-Object System.IO.DirectoryInfo -ArgumentList $Target
  $extensions = 'System.IO.FileSystemAclExtensions' -as [type]
  if ($extensions) { $extensions::SetAccessControl($directory, $Acl) } else { $directory.SetAccessControl($Acl) }
}

function Test-BroadWrite([string]$Target) {
  # 读不到权限的系统文件夹本来也不对普通用户开放，跳过。
  try { $rules = (Read-Acl $Target).GetAccessRules($true, $true, $SidType) } catch { return $false }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne 'Allow' -or $BroadSids -notcontains $rule.IdentityReference.Value) { continue }
    $rights = [int]$rule.FileSystemRights
    if (($rights -band $WriteMask) -or ($rights -band $GenericWrite) -or ($rights -band $GenericAll)) { return $true }
  }
  return $false
}

function Get-ExplicitDenies($Acl, [string]$Sid) {
  return $Acl.GetAccessRules($true, $false, $SidType) |
    Where-Object { $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -eq $Sid }
}

function Test-Hardened([string]$Target, [string]$Sid) {
  foreach ($rule in Get-ExplicitDenies (Read-Acl $Target) $Sid) {
    $rights = [int]$rule.FileSystemRights
    $inherits = $rule.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    if ($inherits -and ($rights -band $WriteMask) -eq $WriteMask -and -not ($rights -band $Synchronize)) { return $true }
  }
  return $false
}

function Set-Hardening([string]$Target, [string]$Sid, [bool]$Enabled) {
  # 先去掉这个组已有的显式拒绝（包括旧版本可能留下的错误掩码），再按需写入正确的一条。
  $acl = Read-Acl $Target
  foreach ($rule in @(Get-ExplicitDenies $acl $Sid)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  if ($Enabled) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier -ArgumentList $Sid
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList $identity, $DenyRights, $inherit, ([System.Security.AccessControl.PropagationFlags]::None), ([System.Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
  }
  Save-Acl $Target $acl
}

function Get-DefaultTargets {
  $systemDrive = $env:SystemDrive.TrimEnd('\') + '\'
  $targets = @()
  foreach ($disk in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3') {
    $root = $disk.DeviceID + '\'
    if ($root -ieq $systemDrive) {
      $targets += Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $SystemFolders -notcontains $_.Name -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
        ForEach-Object { $_.FullName }
    } else {
      $targets += $root
    }
  }
  return $targets | Where-Object { Test-BroadWrite $_ }
}

$sid = Get-SandboxSid
$targets = if ($Path) { $Path | ForEach-Object { (Resolve-Path -LiteralPath $_).ProviderPath } } else { Get-DefaultTargets }
if (-not $targets) { Write-Output '没有发现对所有用户开放写入的文件夹，无需加固。'; exit 0 }

$failed = 0
foreach ($target in $targets) {
  $hardened = Test-Hardened $target $sid
  $hasDeny = @(Get-ExplicitDenies (Read-Acl $target) $sid).Count -gt 0
  if (-not (($Apply -and -not $hardened) -or ($Remove -and $hasDeny))) {
    Write-Output ("{0}  {1}" -f $(if ($hardened) { '[已加固]' } else { '[未加固]' }), $target)
    continue
  }
  $started = Get-Date
  Write-Output ("{0}：{1}" -f $(if ($Apply) { '加固中（大目录需要等待权限传播）' } else { '撤销中' }), $target)
  $message = ''
  try { Set-Hardening $target $sid ([bool]$Apply) } catch { $message = $_.Exception.Message }
  $done = (Test-Hardened $target $sid) -eq [bool]$Apply
  if (-not $done) { $failed++ }
  Write-Output ("  {0}，用时 {1:N0} 秒" -f $(if ($done) { '完成' } else { "失败：$message" }), ((Get-Date) - $started).TotalSeconds)
}
if (-not $Apply -and -not $Remove) { Write-Output '这是预览；加上 -Apply 执行加固（需要管理员），-Remove 撤销。' }
if ($failed) { Write-Output "有 $failed 个目录处理失败，请用管理员身份重新运行。"; exit 1 }
