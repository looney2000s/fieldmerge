param([ValidateSet('Setup','Start','Verify','Stop','Status')][string]$Action='Status')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$taskRoot=Split-Path -Parent $PSScriptRoot
$dockerCommand=Get-Command docker -ErrorAction SilentlyContinue
if ($dockerCommand) { $script:Docker=$dockerCommand.Source }
else {
 $script:Docker=Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
 if (-not (Test-Path -LiteralPath $script:Docker)) { throw 'Docker CLI not found. Reopen your terminal after installing Docker Desktop.' }
}
function Invoke-Docker {
 & $script:Docker @args
 if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)." }
}
$env:PATH=(Split-Path -Parent $script:Docker)+[IO.Path]::PathSeparator+$env:PATH
$compose=@('compose','--project-directory',$taskRoot,'-f',(Join-Path $taskRoot 'compose.yaml'))
function Prepare-Fixtures {
 $nodeCommand=Get-Command node -ErrorAction Stop
 & $nodeCommand.Source (Join-Path $taskRoot 'database/scripts/generate-fixtures.mjs')
 if ($LASTEXITCODE -ne 0) { throw 'Fixture generation failed.' }
}
function Apply-Schema([string]$Service,[string]$Database) {
 foreach ($migration in Get-ChildItem -LiteralPath (Join-Path $taskRoot 'database/postgres/migrations') -Filter '*.sql' | Sort-Object Name) {
 if ($migration.Name -notmatch '^(\d{3})_[a-z_]+\.sql$') { throw 'Unexpected migration filename.' }
 $version=$Matches[1]
 $checksum=(Get-FileHash -Algorithm SHA256 -LiteralPath $migration.FullName).Hash.ToLowerInvariant()
 $registered=Invoke-Docker @compose exec -T $Service psql -X -U fieldmerge_owner -d $Database -tAc "SELECT to_regclass('fieldmerge_meta.migrations') IS NOT NULL"
 if (($registered -join '').Trim() -eq 't') {
  $old=Invoke-Docker @compose exec -T $Service psql -X -U fieldmerge_owner -d $Database -tAc "SELECT checksum FROM fieldmerge_meta.migrations WHERE version='$version'"
 } else { $old=@() }
 if (($old -join '').Trim()) {
  if (($old -join '').Trim() -ne $checksum) { throw "Applied migration $version checksum differs. Add a new migration instead." }
  Write-Host "Schema $version already applied: $Service/$Database"
 } else {
  Invoke-Docker @compose exec -T $Service psql -X -U fieldmerge_owner -d $Database -v ON_ERROR_STOP=1 -v "migration_hash=$checksum" -f "/database/postgres/migrations/$($migration.Name)"
 }
 }
}
function Seed-Sql([string]$Service,[string]$Database) {
 Invoke-Docker @compose exec -T $Service psql -X -U fieldmerge_owner -d $Database -v ON_ERROR_STOP=1 -f /fixtures/seed.sql
}
function Init-Mongo([string]$Service,[string]$Database) {
 Invoke-Docker @compose exec -T -e "FM_DB=$Database" $Service mongosh --quiet --file /database/mongodb/initialize.js
 Invoke-Docker @compose exec -T -e "FM_DB=$Database" $Service mongosh --quiet --file /database/mongodb/seed.js
}
function Verify-Databases {
 Invoke-Docker @compose --profile test up -d --wait --wait-timeout 180 postgres-test mongo-test
 $testName='fieldmerge_test_'+[guid]::NewGuid().ToString('N')
 Invoke-Docker @compose exec -T postgres-test createdb -U fieldmerge_owner $testName
 Apply-Schema 'postgres-test' $testName
 Seed-Sql 'postgres-test' $testName
 # Re-seed to verify repeatability without resetting any records.
 Seed-Sql 'postgres-test' $testName
 Init-Mongo 'mongo-test' $testName
 Init-Mongo 'mongo-test' $testName
 $sqlOutput=Invoke-Docker @compose exec -T postgres-test psql -X -U fieldmerge_owner -d $testName -v ON_ERROR_STOP=1 -f /tests/postgres_structure.sql
 $sqlOutput | ForEach-Object { Write-Host $_ }
 $workflowOutput=Invoke-Docker @compose exec -T postgres-test psql -X -U fieldmerge_owner -d $testName -v ON_ERROR_STOP=1 -f /tests/postgres_reconciliation.sql
 $workflowOutput | ForEach-Object { Write-Host $_ }
 $reviewOutput=Invoke-Docker @compose exec -T postgres-test psql -X -U fieldmerge_owner -d $testName -v ON_ERROR_STOP=1 -f /tests/postgres_reviews.sql
 $reviewOutput | ForEach-Object { Write-Host $_ }
 $integrityOutput=Invoke-Docker @compose exec -T postgres-test psql -X -U fieldmerge_owner -d $testName -v ON_ERROR_STOP=1 -f /tests/postgres_integrity.sql
 $integrityOutput | ForEach-Object { Write-Host $_ }
 $nodeCommand=Get-Command node -ErrorAction Stop
 $commitOutput=& $nodeCommand.Source (Join-Path $taskRoot 'tests/database/integrity_commit.mjs') $script:Docker $taskRoot $testName
 if ($LASTEXITCODE -ne 0) { throw 'Commit-time integrity checks failed.' }
 $commitOutput | ForEach-Object { Write-Host $_ }
 $raceOutput=& $nodeCommand.Source (Join-Path $taskRoot 'tests/database/reconciliation_concurrency.mjs') $script:Docker $taskRoot $testName
 if ($LASTEXITCODE -ne 0) { throw 'Concurrent reconciliation checks failed.' }
 $raceOutput | ForEach-Object { Write-Host $_ }
 $reviewRaceOutput=& $nodeCommand.Source (Join-Path $taskRoot 'tests/database/review_concurrency.mjs') $script:Docker $taskRoot $testName
 if ($LASTEXITCODE -ne 0) { throw 'Concurrent reviewer checks failed.' }
 $reviewRaceOutput | ForEach-Object { Write-Host $_ }
 $mongoOutput=Invoke-Docker @compose exec -T -e "FM_DB=$testName" mongo-test mongosh --quiet --file /tests/mongodb_structure.js
 $mongoOutput | ForEach-Object { Write-Host $_ }
 $sqlForms=Invoke-Docker @compose exec -T postgres-test psql -X -U fieldmerge_owner -d $testName -tAc "SELECT form_version||':'||schema_hash FROM fieldmerge.form_versions ORDER BY form_version"
 $mongoForms=Invoke-Docker @compose exec -T -e "FM_DB=$testName" mongo-test mongosh --quiet --file /tests/form_registry.js
 if (($sqlForms -join "`n").Trim() -ne ($mongoForms -join "`n").Trim()) { throw 'SQL/MongoDB form registry hashes differ.' }
 Write-Host 'Cross-store form registry hashes match for both forms.'
 # Retain this isolated test database for inspection. Test services have only tmpfs storage,
 # no published ports, and no access to development named volumes.
 $reportDir=Join-Path $taskRoot 'output/database'
 New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
 $report=@{
  verified_at_utc=[DateTime]::UtcNow.ToString('o');milestone='deferred workflow integrity and protected publication';
  test_database=$testName;postgres_output=@($sqlOutput);mongo_output=@($mongoOutput);
  form_registry_hashes_match=$true;
  reconciliation_output=@($workflowOutput);concurrency_output=@($raceOutput);
  reviewer_output=@($reviewOutput);reviewer_concurrency_output=@($reviewRaceOutput);
  integrity_output=@($integrityOutput);
  commit_output=@($commitOutput);
  migration_checksums=@(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'database/postgres/migrations') -Filter '*.sql' | Sort-Object Name | ForEach-Object { @{file=$_.Name;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash} });
  migration_checksum=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskRoot 'database/postgres/migrations/001_structure.sql')).Hash;
  remaining='HTTP API and draft/finalization verification is separate in output/api/verification.json. Persistent recovery workers, richer query/export routes, full acceptance coverage and UI remain.'
 }
 $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDir 'verification.json') -Encoding utf8
 Write-Host 'Structural verification passed. Report: output/database/verification.json'
}
Push-Location $taskRoot
try {
 switch ($Action) {
  'Start' { Prepare-Fixtures; Invoke-Docker @compose up -d --wait --wait-timeout 180 postgres mongo }
  'Setup' {
   Prepare-Fixtures
   Invoke-Docker @compose up -d --wait --wait-timeout 180 postgres mongo
   Verify-Databases
   Apply-Schema 'postgres' 'fieldmerge'; Seed-Sql 'postgres' 'fieldmerge'; Init-Mongo 'mongo' 'fieldmerge'
   Write-Host 'Development schemas ready. Secrets are in ignored .env and tmp/database-fixtures/demo-accounts.json.'
  }
  'Verify' { Prepare-Fixtures; Verify-Databases }
  'Stop' { Invoke-Docker @compose --profile test stop }
  'Status' { Invoke-Docker @compose --profile test ps }
 }
} finally { Pop-Location }
