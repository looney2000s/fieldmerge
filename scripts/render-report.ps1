param([string]$Document='output/documents/FieldMerge_Implementation_Report.docx')
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$inputPath=[IO.Path]::GetFullPath((Join-Path $taskRoot $Document))
if (-not $inputPath.StartsWith($taskRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Document must remain inside the project.' }
$renderDir=Join-Path $taskRoot 'tmp/implementation-report/render'
New-Item -ItemType Directory -Force -Path $renderDir | Out-Null
[string]$pdfPath=Join-Path $renderDir 'FieldMerge_Implementation_Report.pdf'
[int]$pdfFormat=17
$word=$null
$doc=$null
try {
 Write-Output 'Creating hidden Word instance.'
 $word=New-Object -ComObject Word.Application
 Write-Output 'Configuring renderer.'
 $word.Visible=$false
 $word.DisplayAlerts=0
 $word.AutomationSecurity=3
 Write-Output 'Opening report read only.'
 $doc=$word.Documents.Open($inputPath,$false,$true,$false)
 Write-Output 'Exporting report layout.'
 $doc.SaveAs2([ref]$pdfPath,[ref]$pdfFormat)
 Write-Output 'Word exported the report to the private QA directory; inspect the PDF page count and PNGs separately.'
} finally {
 if ($doc) {try {$doc.Close(0)} catch {};[Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) | Out-Null}
 if ($word) {try {$word.Quit(0)} catch {};[Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null}
}
