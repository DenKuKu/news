$ErrorActionPreference = "Continue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcesFile = Join-Path $PSScriptRoot "rss-sources.txt"

Set-Location $projectRoot

if (-not (Test-Path $sourcesFile)) {
    Write-Error "Не найден файл источников: $sourcesFile"
    exit 1
}

$feeds = Get-Content $sourcesFile -Encoding UTF8 |
    ForEach-Object { $_.Trim() } |
    Where-Object {
        $_ -and -not $_.StartsWith("#")
    }

if ($feeds.Count -eq 0) {
    Write-Error "Список RSS-источников пуст"
    exit 1
}

Write-Host "Найдено RSS-источников: $($feeds.Count)"
Write-Host ""

foreach ($feed in $feeds) {
    Write-Host "========================================"
    Write-Host "Импортируем: $feed"
    Write-Host "========================================"

    & node ".\scripts\import-rss.js" $feed 25

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Источник завершился с ошибкой: $feed"
    }

    Write-Host ""
}

Write-Host "Импорт всех RSS-источников завершён."
