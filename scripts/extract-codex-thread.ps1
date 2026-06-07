param(
  [string]$File = "C:\Users\ADMIN\.codex\sessions\2026\06\04\rollout-2026-06-04T00-13-04-019e8e79-5e32-7600-8e22-967af846c4e9.jsonl",
  [string]$Out  = "C:\Users\ADMIN\Documents\codex 2\kiro-account-manager-web\Kiro-account-manager\docs\codex-thread-summary.md"
)

$fs = New-Object System.IO.FileStream($File,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite)
$sr = New-Object System.IO.StreamReader($fs)
$sb = New-Object System.Text.StringBuilder

$n = 0
while (($line = $sr.ReadLine()) -ne $null) {
  $n++
  if ($line.Length -lt 2) { continue }
  try { $obj = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
  if ($obj.type -ne 'response_item') { continue }
  $p = $obj.payload
  if ($p.type -ne 'message') { continue }
  $role = $p.role
  if ($role -ne 'user' -and $role -ne 'assistant') { continue }

  $text = ($p.content | Where-Object { $_.type -eq 'input_text' -or $_.type -eq 'output_text' } | ForEach-Object { $_.text }) -join "`n"
  if ([string]::IsNullOrWhiteSpace($text)) { continue }
  # Skip injected context blocks
  if ($text -match '^<(environment_context|permissions|app-context|user_instructions)' ) { continue }
  if ($text -match '^<environment_context>') { continue }

  $ts = $obj.timestamp
  [void]$sb.AppendLine("## [$role] $ts")
  [void]$sb.AppendLine()
  [void]$sb.AppendLine($text.Trim())
  [void]$sb.AppendLine()
  [void]$sb.AppendLine("---")
  [void]$sb.AppendLine()
}
$sr.Close(); $fs.Close()

[System.IO.File]::WriteAllText($Out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Lines scanned: $n"
Write-Output "Output: $Out"
Write-Output "Output size (chars): $($sb.Length)"
