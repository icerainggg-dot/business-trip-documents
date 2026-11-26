PP-OCRv5 한국어 글자 인식 모델 (화면의 [글자 인식 엔진] → PP-OCRv5 한국어)

파일                               출처 · 라이선스                                              SHA-256
PP-OCRv5_mobile_det.onnx           PaddleOCR PP-OCRv5_mobile_det (글자 영역 찾기)              4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae
                                   ONNX 변환본 — RapidOCR v3.10.0 배포본(ch_PP-OCRv5_det_mobile)과 같은 파일
                                   Apache-2.0, Copyright PaddlePaddle Authors
ppocrv5_korean_dict.txt            PaddleOCR ppocr/utils/dict/ppocrv5_korean_dict.txt            a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7
                                   (한글 11,172자 + 영문·숫자·기호, 11,945자) Apache-2.0
korean_PP-OCRv5_mobile_rec.onnx    PaddleOCR korean_PP-OCRv5_mobile_rec (한국어·영문·숫자 읽기)  cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b
                                   ONNX 변환본 — RapidOCR v3.10.0 배포본(korean_PP-OCRv5_rec_mobile)
                                   Apache-2.0. 용량(약 13MB) 때문에 기본으로 들어 있지 않음 →
                                   폴더의 get-ocr-model.bat (Mac·Linux: python3 tools/get_ocr_model.py) 로 한 번 내려받는다.
                                   스크립트는 위 SHA-256이 맞을 때만 저장한다.

PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
RapidOCR:  https://github.com/RapidAI/RapidOCR
Apache License 2.0 전문: ../hwpx-template/LICENSE
