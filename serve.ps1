# 출장비 증빙서류 취합 페이지용 로컬 웹서버 (start.bat에서 실행)
# Windows에 기본으로 들어 있는 PowerShell만 사용하므로 Python 등을 설치할 필요가 없다.
# - 이 PC에서만 접속 가능 (http://localhost:포트/), 관리자 권한 불필요
# - 브라우저가 옛 파일을 쓰지 않도록 Cache-Control: no-cache, 바뀌지 않은 파일은 304로 응답
param([int]$Port = 8080)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.xml' = 'application/xml; charset=utf-8'; '.json' = 'application/json'; '.txt' = 'text/plain; charset=utf-8'
  '.wasm' = 'application/wasm'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'
}

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  Write-Host "[오류] $Port 포트로 서버를 열지 못했습니다. 다른 프로그램이 이미 쓰고 있을 수 있습니다." -ForegroundColor Red
  Write-Host "       start.bat의 'set PORT=8080'을 다른 번호(예: 8081)로 바꿔 보세요."
  exit 1
}
Write-Host "http://localhost:$Port/ 에서 서비스 중입니다. 종료하려면 이 창을 닫으세요."

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($path)) {
      $res.StatusCode = 404
    } else {
      $mtime = [IO.File]::GetLastWriteTimeUtc($path)
      $lastMod = $mtime.ToString('R')
      $res.Headers['Cache-Control'] = 'no-cache'
      $res.Headers['Last-Modified'] = $lastMod
      if ($req.Headers['If-Modified-Since'] -eq $lastMod) {
        $res.StatusCode = 304
      } else {
        $ext = [IO.Path]::GetExtension($path).ToLower()
        $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($path)
        $res.ContentLength64 = $bytes.Length
        if ($req.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      }
    }
  } catch {
    try { $res.StatusCode = 500 } catch { }
  } finally {
    try { $res.Close() } catch { }
  }
}
