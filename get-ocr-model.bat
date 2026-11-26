@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo PP-OCRv5 한국어 글자 인식 모델(약 13MB)을 내려받습니다. 한 번만 하면 됩니다.
echo 서류는 어디로도 보내지 않습니다. 모델 파일만 내려받습니다.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-ocr-model.ps1"
echo.
pause
