"""PP-OCRv5 한국어 글자 인식 모델 내려받기 (Mac·Linux용, 한 번만 하면 됨)

    python3 tools/get_ocr_model.py

- 받는 파일: korean_PP-OCRv5_mobile_rec (PaddleOCR 공식 모델을 ONNX로 바꾼 것, RapidOCR 배포본, Apache-2.0, 약 13MB)
- 받은 파일의 SHA-256을 확인해 내용이 정확히 같을 때만 lib/paddleocr 에 저장한다
- Windows에서는 폴더의 get-ocr-model.bat 을 더블클릭한다
"""
import hashlib
import os
import sys
import urllib.request

NAME = 'korean_PP-OCRv5_mobile_rec.onnx'
SHA256 = 'cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b'
URLS = [
    'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx',
]
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib', 'paddleocr', NAME)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def main():
    dest = os.path.normpath(DEST)
    if os.path.exists(dest) and sha256(dest) == SHA256:
        print(f'이미 받아 두었습니다: {dest}')
        return 0
    tmp = dest + '.part'
    for url in URLS:
        print(f'내려받는 중: {url}')
        try:
            with urllib.request.urlopen(url, timeout=300) as r, open(tmp, 'wb') as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
            got = sha256(tmp)
            if got != SHA256:
                print(f'  받은 파일의 내용이 예상과 달라 쓰지 않습니다 (SHA-256 {got})')
                os.remove(tmp)
                continue
            os.replace(tmp, dest)
            print(f'완료: {dest}')
            print('페이지를 새로 고친 뒤 [글자 인식 엔진]에서 PP-OCRv5 한국어를 고르세요.')
            return 0
        except Exception as e:  # noqa: BLE001 - 어떤 오류든 다음 주소로 넘어감
            print(f'  실패: {e}')
            if os.path.exists(tmp):
                os.remove(tmp)
    print('\n[오류] 모델을 내려받지 못했습니다.')
    print(f'인터넷이 되는 PC에서 위 주소의 파일을 받아 {dest} 로 저장하세요.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
