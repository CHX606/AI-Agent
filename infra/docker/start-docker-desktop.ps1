[CmdletBinding()]
param(
    [ValidateRange(10, 300)]
    [int]$WaitSeconds = 120
)

$ErrorActionPreference = "Stop"

$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$localAppDataPath = [Environment]::GetFolderPath("LocalApplicationData")
$dockerLocalPath = [IO.Path]::GetFullPath((Join-Path $localAppDataPath "Docker"))
$secretsLocalPath = [IO.Path]::GetFullPath((Join-Path $localAppDataPath "docker-secrets-engine"))

function Get-DockerEngineVersion {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "docker.exe"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @("info", "--format", "{{.ServerVersion}}")) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            return $null
        }

        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(5000)) {
            $process.Kill($true)
            $process.WaitForExit()
            return $null
        }

        $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        $null = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($stdout)) {
            return $null
        }
        return $stdout
    }
    catch {
        return $null
    }
    finally {
        $process.Dispose()
    }
}

function Get-DockerDesktopProcesses {
    return Get-Process -Name @(
        "Docker Desktop",
        "com.docker.backend",
        "com.docker.build",
        "com.docker.proxy"
    ) -ErrorAction SilentlyContinue
}

function Stop-UnhealthyDockerDesktop {
    Write-Host "Docker 进程存在但 Engine 不可用，正在请求 Docker Desktop 正常停止……"

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "docker.exe"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @("desktop", "stop", "--timeout", "15")) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if ($process.Start()) {
            $stdoutTask = $process.StandardOutput.ReadToEndAsync()
            $stderrTask = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(20000)) {
                $process.Kill($true)
                $process.WaitForExit()
            }
            $null = $stdoutTask.GetAwaiter().GetResult()
            $null = $stderrTask.GetAwaiter().GetResult()
        }
    }
    catch {
        Write-Warning "Docker Desktop CLI 未能完成停止请求：$($_.Exception.Message)"
    }
    finally {
        $process.Dispose()
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if (-not (Get-DockerDesktopProcesses)) {
            return $true
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)

    return $false
}

function Move-StaleRuntimeDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$DirectoryPath,
        [Parameter(Mandatory)]
        [string[]]$SocketNames
    )

    if (-not (Test-Path -LiteralPath $DirectoryPath -PathType Container)) {
        return
    }

    $hasSocket = $false
    foreach ($socketName in $SocketNames) {
        if (Test-Path -LiteralPath (Join-Path $DirectoryPath $socketName)) {
            $hasSocket = $true
            break
        }
    }
    if (-not $hasSocket) {
        return
    }

    $resolvedSource = (Resolve-Path -LiteralPath $DirectoryPath).Path
    $allowedParent = [IO.Path]::GetFullPath((Split-Path -Parent $DirectoryPath))
    if (-not $resolvedSource.StartsWith(
        $allowedParent + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "拒绝移动预期目录外的路径：$resolvedSource"
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = [IO.Path]::GetFullPath("$DirectoryPath.stale-$timestamp")
    if (-not $backupPath.StartsWith(
        $allowedParent + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "备份路径越界：$backupPath"
    }
    if (Test-Path -LiteralPath $backupPath) {
        $backupPath = "$backupPath-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    }

    Move-Item -LiteralPath $resolvedSource -Destination $backupPath
    if (-not (Test-Path -LiteralPath $DirectoryPath -PathType Container)) {
        try {
            New-Item -ItemType Directory -Path $DirectoryPath -ErrorAction Stop | Out-Null
        }
        catch {
            # Docker 的辅助组件可能在移动完成后立即重建空目录。这种竞态是安全的；
            # 只有目标仍不是目录时才保留原始错误。
            if (-not (Test-Path -LiteralPath $DirectoryPath -PathType Container)) {
                throw
            }
        }
    }
    Write-Host "已隔离 Docker 残留运行目录：$backupPath"
}

$engineVersion = Get-DockerEngineVersion
if ($engineVersion) {
    Write-Host "Docker Engine 已经就绪：$engineVersion，无需修复。"
    exit 0
}

$dockerProcesses = Get-DockerDesktopProcesses
if ($dockerProcesses) {
    if (-not (Stop-UnhealthyDockerDesktop)) {
        throw "Docker Desktop 未能正常停止。为避免中断容器，请从 Docker Desktop 选择 Quit，再重新运行此脚本。"
    }
}

Move-StaleRuntimeDirectory `
    -DirectoryPath (Join-Path $dockerLocalPath "run") `
    -SocketNames @("sailor-ingest.sock", "dockerInference", "userAnalyticsOtlpHttp.sock")
Move-StaleRuntimeDirectory `
    -DirectoryPath $secretsLocalPath `
    -SocketNames @("engine.sock")

if (-not (Test-Path -LiteralPath $dockerDesktopPath -PathType Leaf)) {
    throw "找不到 Docker Desktop：$dockerDesktopPath"
}

Start-Process -FilePath $dockerDesktopPath -WindowStyle Hidden
$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
    Start-Sleep -Seconds 2
    $version = Get-DockerEngineVersion
    if ($version) {
        Write-Host "Docker Engine 已就绪：$version"
        exit 0
    }
} while ([DateTime]::UtcNow -lt $deadline)

throw "Docker Desktop 已启动，但 Engine 未在 $WaitSeconds 秒内就绪。"
