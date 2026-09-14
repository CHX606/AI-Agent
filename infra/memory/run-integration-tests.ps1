param(
    [switch]$FullSuite,
    [switch]$StopAfter
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$composeFile = Join-Path $PSScriptRoot "compose.yaml"
$python = Join-Path $repositoryRoot ".venv\Scripts\python.exe"
$pytestTemp = Join-Path $env:TEMP "bit-agent-memory-pytest-$PID"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "找不到项目虚拟环境中的 Python：$python"
}

$testVariables = @{
    BIT_AGENT_TEST_REDIS_URL = "redis://127.0.0.1:6380/0"
    BIT_AGENT_TEST_POSTGRES_DSN = "postgresql://bit_agent_test:bit_agent_test@127.0.0.1:55432/bit_agent_test"
    BIT_AGENT_TEST_LLM = "1"
}
$originalVariables = @{}
$testExitCode = 1

try {
    & docker compose --file $composeFile up --detach --wait --wait-timeout 60
    if ($LASTEXITCODE -ne 0) {
        throw "Redis/PostgreSQL 测试服务启动失败"
    }

    foreach ($name in $testVariables.Keys) {
        $existing = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        $originalVariables[$name] = if ($null -eq $existing) { $null } else { $existing.Value }
        Set-Item -LiteralPath "Env:$name" -Value $testVariables[$name]
    }

    Push-Location $repositoryRoot
    try {
        $pytestArguments = @(
            "-m", "pytest",
            "-p", "no:cacheprovider",
            "--basetemp", $pytestTemp
        )
        if (-not $FullSuite) {
            $pytestArguments += "services/agent/tests/test_memory_backends_integration.py"
        }
        & $python @pytestArguments
        $testExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($name in $testVariables.Keys) {
        if ($null -eq $originalVariables[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -LiteralPath "Env:$name" -Value $originalVariables[$name]
        }
    }

    if ($StopAfter) {
        & docker compose --file $composeFile down
    }

    if (Test-Path -LiteralPath $pytestTemp) {
        $resolvedTemp = (Resolve-Path -LiteralPath $pytestTemp).Path
        if ($resolvedTemp -ne $pytestTemp) {
            throw "拒绝清理非预期 pytest 目录：$resolvedTemp"
        }
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}

exit $testExitCode
