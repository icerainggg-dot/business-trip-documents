# PP-OCRv5 한국어 글자 인식 모델 내려받기 (get-ocr-model.bat 에서 실행, 한 번만 하면 됨)
# - 받는 파일: korean_PP-OCRv5_mobile_rec (PaddleOCR 공식 모델을 ONNX로 바꾼 것, RapidOCR 배포본, Apache-2.0, 약 13MB)
# - 받은 파일의 SHA-256을 확인해 내용이 정확히 같을 때만 lib\paddleocr 에 저장한다
# - 서류는 어디로도 보내지 않는다 (모델 파일만 내려받음)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PowerShell 5.1은 진행 표시 때문에 내려받기가 매우 느려짐
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
# 회사 프록시(로그인한 Windows 계정으로 인증)를 그대로 사용
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }

$name = 'korean_PP-OCRv5_mobile_rec.onnx'
$sha256 = 'cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b'
$urls = @(
  'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx'
)
$dir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\lib\paddleocr'))
$dest = Join-Path $dir $name

function Get-Sha256([string]$path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() }

if ((Test-Path -LiteralPath $dest) -and (Get-Sha256 $dest) -eq $sha256) {
  Write-Host "이미 받아 두었습니다: $dest" -ForegroundColor Green
  Write-Host '페이지에서 [글자 인식 엔진]을 PP-OCRv5 한국어로 고르면 됩니다.'
  exit 0
}

$tmp = "$dest.part"
foreach ($u in $urls) {
  Write-Host "내려받는 중: $u"
  try {
    Invoke-WebRequest -Uri $u -OutFile $tmp -UseBasicParsing -TimeoutSec 300
    $got = Get-Sha256 $tmp
    if ($got -ne $sha256) {
      Write-Host "  받은 파일의 내용이 예상과 달라 쓰지 않습니다 (SHA-256 $got)" -ForegroundColor Yellow
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      continue
    }
    Move-Item -LiteralPath $tmp -Destination $dest -Force
    Write-Host "완료: $dest" -ForegroundColor Green
    Write-Host '페이지를 새로 고친 뒤 [글자 인식 엔진]에서 PP-OCRv5 한국어를 고르세요.'
    exit 0
  } catch {
    Write-Host "  실패: $($_.Exception.Message)" -ForegroundColor Yellow
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host '[오류] 모델을 내려받지 못했습니다.' -ForegroundColor Red
Write-Host '회사망에서 위 주소가 막혀 있으면, 인터넷이 되는 PC에서 같은 주소의 파일을 받아'
Write-Host "  $dest"
Write-Host '로 저장하세요. (파일 이름을 위와 똑같이 바꿔야 합니다)'
exit 1
