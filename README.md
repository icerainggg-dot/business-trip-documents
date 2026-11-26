# 출장비 증빙서류 취합

교통 영수증·탑승확인서·숙박 영수증·지도 캡처·공문을 한꺼번에 올리면 자동으로 분류하고, 빠진 서류와 불일치 항목을 알려준 뒤 **증빙서류(HWPX·PDF)** 를 만들어 주는 웹 페이지입니다.

- 출발 / 경유 / 숙박 / 도착으로 여정을 정리하고, 영수증과 탑승확인서를 예약번호로 짝지어 점검합니다.
- 캡처 이미지는 글자 인식(OCR)으로, PDF·HWPX는 본문을 읽어서 날짜·구간·편명·금액을 뽑습니다. 글자 인식 엔진은 **Tesseract(기본)** 와 **PP-OCRv5 한국어** 중에서 고를 수 있습니다.
- 증빙서류는 제목 HY헤드라인M 15pt, 본문 휴먼명조 12pt, A4(위·아래 15mm, 좌·우 20mm, 머리말·꼬리말 10mm)로 만듭니다.

> **올린 파일은 어디로도 전송되지 않습니다.** 모든 처리는 사용하는 PC의 브라우저 안에서만 이뤄집니다. (로컬 LLM을 연결하면 서류 이미지·글자가 지정한 LLM 서버로만 보내집니다)

## 사용 방법

1. 이 페이지 위쪽 초록색 **Code → Download ZIP** 을 눌러 내려받습니다.
2. ZIP **압축을 풉니다.** (ZIP 안에서 바로 실행하면 동작하지 않습니다)
3. 압축을 푼 폴더의 **`start.bat`** 을 더블클릭합니다. 잠시 후 브라우저에 `http://localhost:8080/` 이 열립니다.
4. 다 쓰면 검은 창을 닫습니다.

- Python 등 **따로 설치할 것은 없습니다.** Windows에 기본으로 들어 있는 PowerShell로 동작합니다.
- 인터넷 연결 없이도 동작합니다. (글자 인식 엔진·데이터가 폴더 안에 들어 있음)
- 처음 실행할 때 "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행** 을 누르세요.
- `index.html` 을 직접 열면 이미지 글자 인식이 되지 않습니다. 꼭 `start.bat` 으로 실행하세요.
- 8080 포트를 다른 프로그램이 쓰고 있으면 `start.bat` 의 `set PORT=8080` 을 다른 번호로 바꾸세요.
- Mac·Linux: 폴더에서 `python3 serve.py` 를 실행한 뒤 `http://localhost:8080/` 을 엽니다.

## 알아둘 점

- **PDF 글꼴**: PDF는 사용하는 PC에 설치된 글꼴로 만들어집니다. 휴먼명조·HY헤드라인M이 없는 PC에서는 비슷한 글꼴(바탕·맑은 고딕)로 대체되며, 만들기 전에 알려 줍니다. HWPX는 한글에서 열면 지정 글꼴로 나옵니다.
- **자동 인식 결과는 꼭 확인하세요.** 캡처 화질에 따라 날짜·금액 등이 틀릴 수 있습니다. 4번 "문서별 인식 결과"에서 직접 고치면 바로 다시 점검합니다.
- 같은 파일(이름이 달라도 내용이 같으면)을 다시 올리면 자동으로 건너뜁니다.

## 글자 인식 엔진 (Tesseract / PP-OCRv5 한국어)

**2 서류 등록** 위의 **글자 인식 엔진** 에서 고릅니다(선택은 이 브라우저에 저장). 두 엔진 모두 이 PC의 브라우저 안에서만 동작합니다.

| | Tesseract (기본) | PP-OCRv5 한국어 |
|---|---|---|
| 모델 | tessdata `kor`+`eng` | `PP-OCRv5_mobile_det` + `korean_PP-OCRv5_mobile_rec` |
| 준비 | 바로 사용 | 처음 한 번 **`get-ocr-model.bat`** 실행 (약 13MB 내려받기) |
| 특징 | 가볍고 빠름 | 한국어 전용 딥러닝 모델. 편명·공항코드·예약번호처럼 영문·숫자가 섞인 글자에 강함 |
| 속도(참고) | 서류 1건 약 1초 | 서류 1건 약 1~1.5초 (처음 한 번 엔진 불러오기 몇 초) |

- **PP-OCRv5를 고르는 법**: 폴더의 `get-ocr-model.bat` 을 더블클릭해 모델을 받은 뒤(Mac·Linux: `python3 tools/get_ocr_model.py`), 페이지를 새로 고치고 엔진을 **PP-OCRv5 한국어** 로 바꿉니다. 스크립트는 받은 파일의 SHA-256이 맞을 때만 저장합니다. 회사망에서 내려받기가 막히면 인터넷이 되는 PC에서 받아 `lib\paddleocr\korean_PP-OCRv5_mobile_rec.onnx` 로 넣으면 됩니다.
- 이미 읽은 서류가 있을 때 엔진을 바꾸면 **고른 엔진으로 다시 인식** 버튼이 나타납니다(직접 고친 서류는 제외). 문서 카드에는 어느 엔진으로 읽었는지 표시됩니다.
- PP-OCRv5를 쓸 수 없으면(모델 파일 없음 등) 그 서류는 Tesseract로 읽고 카드에 **PP-OCRv5 실패 → Tesseract로 읽음** 으로 알려 줍니다.
- 검토 메모: PaddleOCR의 기본 `PP-OCRv5_mobile/server_rec` 와 새 `PP-OCRv6` 는 중국어·영어·일본어용이라 **한글을 읽지 못합니다.** 한국어는 별도 모델 `korean_PP-OCRv5_mobile_rec` 를 써야 하며, PaddleOCR 공식 문서 기준 한국어 평가셋(5,007장) 정확도 88.0%입니다(같은 문서의 이전 세대 `korean_PP-OCRv3_mobile_rec` 표기는 60.2%).
- 사진처럼 크게 기울어진 서류는 글자 영역을 수평 상자로만 잡으므로 인식이 떨어질 수 있습니다. 캡처·스캔본은 문제없습니다.

## 로컬 LLM 연결 (선택)

항공사·운송사마다 서류 모양이 달라 규칙만으로는 출발·경유·도착을 정확히 가르기 어려울 때, PC나 사내 서버의 LLM을 연결할 수 있습니다. 화면의 **AI 로컬 LLM 연결** 칸에서 켜고 끄며, 서버 종류·주소·모델은 언제든 바꿀 수 있습니다(설정은 이 브라우저에만 저장).

- **하는 일**
  1. 서류마다 이미지(비전 모델이면)와 인식 글자를 보내 종류·**실제 출발일**(구매·결제·예약일이 아님)·출발시각·구간·편명·금액·예약번호를 판독합니다.
  2. 판독 결과 전체로 **출발/경유/도착 구분, 영수증↔확인서 짝, 숙박 짝, 출장기간, 점검 의견**을 AI가 먼저 정리합니다.
  3. AI가 비워 둔 곳과 AI 호출이 실패한 서류는 기존 규칙으로 채웁니다. 작은 모델이 자주 하는 실수(영수증의 구매일을 탑승일로, 항공권번호를 편명으로, 날짜 순서와 맞지 않는 출발/도착 구분 등)는 규칙으로 걸러냅니다. 문서 카드에서 직접 고친 값이 가장 우선입니다.
- **Ollama**: 서버 종류 `Ollama`, 주소 비워 두면 `http://localhost:11434`. 이미지를 읽는 모델(예: `gemma4:e4b`, `gemma3:4b`, `qwen2.5vl`)을 권장합니다.
- **vLLM 등 OpenAI 호환 서버**(LM Studio, llama.cpp server 포함): 서버 종류 `vLLM · OpenAI 호환`, 주소 예 `http://localhost:8000/v1`, 필요하면 API 키(`--api-key`). 예) `vllm serve Qwen/Qwen2.5-VL-7B-Instruct --allowed-origins '["*"]'`
- **연결 테스트** 버튼으로 모델 목록·응답 시간·이미지 전송 여부를 확인할 수 있습니다.
- 이미지 보내기가 `자동`이면 처음 한 번 작은 그림으로 **모델이 그림을 실제로 읽는지 점검**합니다. 모델 정보에 vision이 있어도 그림을 못 읽으면(비전 모듈이 빠진 GGUF 등) 글자만 보냅니다.
- 서류를 다 읽은 뒤 LLM을 켰거나 서류를 고쳤다면 결과 칸의 **AI로 다시 정리** 를 누르세요.
- 속도 참고: GTX 1660 SUPER(6GB)에서 `gemma4:e4b`로 서류 1건 판독 10~20초, 여정 정리 약 25초. **생각 모드**는 3~4배 느립니다.
- 페이지를 `localhost`가 아닌 주소(사내 웹서버 등)로 열면 LLM 서버에서 그 주소를 허용해야 합니다 — Ollama: 환경변수 `OLLAMA_ORIGINS=http://서버주소`, vLLM: `--allowed-origins`.

## 사내 웹서버에 올리기

폴더 전체를 IIS 등 웹서버에 그대로 올리면 됩니다. IIS용 설정(`.wasm`·`.gz` 형식 등록, 캐시 재확인)은 `web.config` 에 들어 있습니다.

## 포함된 오픈소스

| 구성 요소 | 버전 | 라이선스 | 위치 |
|---|---|---|---|
| [Tesseract.js](https://github.com/naptha/tesseract.js) (글자 인식) | 5.1.1 | Apache-2.0 | `lib/tesseract` |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | — | Apache-2.0 | `lib/tesseract/core` |
| [tessdata](https://github.com/tesseract-ocr/tessdata) (kor·eng 학습 데이터) | — | Apache-2.0 | `lib/tesseract/lang` |
| [PDF.js](https://github.com/mozilla/pdf.js) | 3.11.174 | Apache-2.0 | `lib/pdfjs` |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT | `lib/jszip.min.js` |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (PP-OCRv5 실행) | 1.24.3 | MIT | `lib/onnxruntime` |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 모델·한국어 사전 ([RapidOCR](https://github.com/RapidAI/RapidOCR) ONNX 변환본) | PP-OCRv5 | Apache-2.0 | `lib/paddleocr` |
| [python-hwpx](https://github.com/airmang/python-hwpx) 기본 서식 | — | Apache-2.0 | `lib/hwpx-template` |

Apache License 2.0 전문은 `lib/hwpx-template/LICENSE` 에 있습니다.
