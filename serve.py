# 출장비 증빙서류 취합 페이지용 로컬 웹서버 (start.bat에서 실행)
# python -m http.server 와 같지만, 브라우저가 매번 최신 파일인지 확인하도록 Cache-Control: no-cache 를 붙인다.
# (바뀌지 않은 파일은 304 응답으로 바로 끝나므로 느려지지 않음)
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.js': 'text/javascript',
        '.gz': 'application/octet-stream',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'http://localhost:{port}/ 에서 서비스 중')
    http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
