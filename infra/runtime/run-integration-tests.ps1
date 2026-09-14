param(
    [switch]$StopAfter
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$composeFile = Join-Path $PSScriptRoot "compose.yaml"
$python = Join-Path $repositoryRoot ".venv\Scripts\python.exe"
$gateway = Join-Path $repositoryRoot "apps\gateway"
$redisUrl = "redis://127.0.0.1:6381/0"
$pytestTemp = Join-Path $env:TEMP "bit-agent-runtime-pytest-$PID"
$originalRedisUrl = $env:BIT_AGENT_TEST_TASK_REDIS_URL
$exitCode = 1

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "找不到项目虚拟环境中的 Python：$python"
}

try {
    & docker compose --file $composeFile up --detach --wait --wait-timeout 60
    if ($LASTEXITCODE -ne 0) {
        throw "Gateway/Worker Redis 测试服务启动失败"
    }
    $env:BIT_AGENT_TEST_TASK_REDIS_URL = $redisUrl

    Push-Location $gateway
    try {
        & corepack pnpm test
        if ($LASTEXITCODE -ne 0) {
            throw "Gateway 集成测试失败"
        }
    }
    finally {
        Pop-Location
    }

    Push-Location $repositoryRoot
    try {
        & $python -m pytest -p no:cacheprovider --basetemp $pytestTemp services/agent/tests/test_worker_redis_integration.py
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $originalRedisUrl) {
        Remove-Item Env:BIT_AGENT_TEST_TASK_REDIS_URL -ErrorAction SilentlyContinue
    }
    else {
        $env:BIT_AGENT_TEST_TASK_REDIS_URL = $originalRedisUrl
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

exit $exitCode
