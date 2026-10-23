@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8080
echo 출장비 증빙서류 취합 페이지를 시작합니다: http://localhost:%PORT%/
echo 잠시 후 브라우저가 열립니다. 열리지 않으면 위 주소를 브라우저 주소창에 직접 입력하세요.
echo 사용하는 동안 이 창을 닫지 마세요. 다 쓰면 이 창을 닫으면 됩니다.
rem 서버가 응답할 때까지 기다렸다가 브라우저를 연다 (먼저 열면 '연결할 수 없음'이 뜸)
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest 'http://localhost:%PORT%/' -UseBasicParsing -TimeoutSec 5 | Out-Null; Start-Process 'http://localhost:%PORT%/'; break}catch{Start-Sleep -Milliseconds 500}}"
rem 설치 없이 Windows 기본 PowerShell로 웹서버 실행 (serve.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port %PORT%
echo.
echo [오류] 서버가 멈췄습니다. 위 메시지를 확인하세요.
echo 회사 보안 정책으로 PowerShell 실행이 막혀 있다면 인터넷 주소(README 참고)로 접속해 사용하세요.
pause
