param(
  [switch]$Full
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host "== eslint ==" -ForegroundColor Cyan
node node_modules\eslint\bin\eslint.js .
if ($LASTEXITCODE -ne 0) {
  # 内存紧张时 Node 偶发 OOM 崩溃，重试一次
  Write-Host "eslint failed once (exit $LASTEXITCODE), retrying..." -ForegroundColor DarkYellow
  node node_modules\eslint\bin\eslint.js .
  if ($LASTEXITCODE -ne 0) { throw "eslint failed" }
}

Write-Host "== typecheck (node + web) ==" -ForegroundColor Cyan
node node_modules\typescript\bin\tsc --noEmit -p tsconfig.node.json
if ($LASTEXITCODE -ne 0) { throw "tsc node failed" }
node node_modules\typescript\bin\tsc --noEmit -p tsconfig.web.json
if ($LASTEXITCODE -ne 0) { throw "tsc web failed" }

Write-Host "== build ==" -ForegroundColor Cyan
node node_modules\electron-vite\bin\electron-vite.js build
if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed" }

if ($Full) {
  Write-Host "== dir package ==" -ForegroundColor Cyan
  node node_modules\electron-builder\out\cli\cli.js --win dir
  if ($LASTEXITCODE -ne 0) { throw "electron-builder dir failed" }
}

Write-Host "verify OK" -ForegroundColor Green
