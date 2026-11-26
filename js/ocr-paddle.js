/*
 * PP-OCRv5 한국어 글자 인식 (브라우저 안에서만 실행, ONNX Runtime Web · wasm)
 *  - 글자 영역 찾기: PP-OCRv5_mobile_det (DB)
 *  - 글자 읽기: korean_PP-OCRv5_mobile_rec (한국어·영문·숫자, CTC)
 *  - 결과는 Tesseract와 같은 모양 { text, words:[{ text, bbox:{x0,y0,x1,y1} }] } 으로 돌려준다
 *    → 이후 분류·추출(Extract)과 출발/도착 배치 판정(routeFromLayout)을 그대로 쓴다
 * 모델 파일은 lib/paddleocr/ 에 둔다. 한국어 인식 모델은 용량 때문에 get-ocr-model.bat 으로 한 번 내려받는다.
 */
(function (global) {
  'use strict';
  const base = new URL('.', location.href).href;
  const DIR = base + 'lib/paddleocr/';
  const cfg = {
    det: DIR + 'PP-OCRv5_mobile_det.onnx',
    rec: DIR + 'korean_PP-OCRv5_mobile_rec.onnx',
    dict: DIR + 'ppocrv5_korean_dict.txt',
    ortDir: base + 'lib/onnxruntime/',
    // 글자 영역 찾기 (PaddleOCR 기본값과 같음)
    detMaxSide: 2560, detThresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, minSize: 3,
    // 글자 읽기
    recHeight: 48, recBatch: 6, recMaxWidth: 3200,
  };
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

  let loading = null;
  let missing = null; // 모델 파일이 없어서 실패한 경우: 서류마다 다시 받지 않고 바로 실패 (파일이 생기면 available()이 풀어 줌)

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('ONNX Runtime을 불러오지 못했습니다 (lib/onnxruntime)'));
      document.head.appendChild(s);
    });
  }
  async function fetchBuf(url, what) {
    let r;
    try { r = await fetch(url, { cache: 'no-cache' }); } catch (e) { throw new Error(`${what}을(를) 읽지 못했습니다`); }
    if (r.status === 404) throw (missing = new Error(`${what}이(가) 없습니다 — 폴더의 get-ocr-model.bat 을 실행해 내려받으세요`));
    if (!r.ok) throw new Error(`${what}을(를) 읽지 못했습니다 (HTTP ${r.status})`);
    return r.arrayBuffer();
  }

  // 한국어 인식 모델이 폴더에 있는지 (화면 안내용)
  async function available() {
    try {
      const r = await fetch(cfg.rec, { method: 'HEAD', cache: 'no-cache' });
      if (r.ok) missing = null;
      return r.ok;
    } catch (e) { return false; }
  }

  function init() {
    if (location.protocol === 'file:') return Promise.reject(new Error('index.html을 직접 열면 글자 인식을 할 수 없습니다. start.bat으로 실행하세요'));
    if (missing) return Promise.reject(missing);
    if (!loading) {
      loading = (async () => {
        if (!global.ort) await loadScript(cfg.ortDir + 'ort.wasm.min.js');
        const ort = global.ort;
        ort.env.wasm.wasmPaths = cfg.ortDir;
        // 멀티스레드는 COOP/COEP(교차 출처 격리)가 있어야 동작 → 없으면 1스레드
        ort.env.wasm.numThreads = global.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
        const recBuf = await fetchBuf(cfg.rec, '한국어 인식 모델(korean_PP-OCRv5_mobile_rec.onnx)');
        const [detBuf, dictTxt] = await Promise.all([
          fetchBuf(cfg.det, '글자 영역 모델(PP-OCRv5_mobile_det)'),
          fetchBuf(cfg.dict, '한국어 글자 사전').then(b => new TextDecoder('utf-8').decode(b)),
        ]);
        const det = await ort.InferenceSession.create(detBuf, opt);
        const rec = await ort.InferenceSession.create(recBuf, opt);
        const chars = dictTxt.replace(/\r/g, '').split('\n');
        while (chars.length && chars[chars.length - 1] === '') chars.pop();
        return { ort, det, rec, chars };
      })();
      loading.catch(() => { loading = null; }); // 실패하면 다음에 다시 시도 (예: 모델을 내려받은 뒤)
    }
    return loading;
  }

  function toCanvas(src) {
    if (src instanceof HTMLCanvasElement) return src;
    const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(src, 0, 0);
    return c;
  }

  // RGBA → Float32 CHW (PaddleOCR와 같이 BGR 순서로 정규화)
  function toTensorData(rgba, w, h, out, outW, mean, std) {
    const plane = h * outW;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, o = y * outW + x;
        out[o] = (rgba[i + 2] / 255 - mean[0]) / std[0];
        out[plane + o] = (rgba[i + 1] / 255 - mean[1]) / std[1];
        out[2 * plane + o] = (rgba[i] / 255 - mean[2]) / std[2];
      }
    }
  }

  // ── 글자 영역 찾기 (DB 후처리: 이진화 → 연결 요소 → 점수 확인 → 넓히기) ──
  async function detect(m, canvas) {
    const W = canvas.width, H = canvas.height;
    const s = Math.min(1, cfg.detMaxSide / Math.max(W, H));
    const dw = Math.max(32, Math.round(W * s / 32) * 32), dh = Math.max(32, Math.round(H * s / 32) * 32);
    const c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, dw, dh);
    const data = new Float32Array(3 * dw * dh);
    toTensorData(g.getImageData(0, 0, dw, dh).data, dw, dh, data, dw, MEAN, STD);
    const out = await m.det.run({ [m.det.inputNames[0]]: new m.ort.Tensor('float32', data, [1, 3, dh, dw]) });
    const prob = out[m.det.outputNames[0]].data;

    // 4방향 연결 요소
    const n = dw * dh, label = new Int32Array(n), stack = new Int32Array(n);
    const boxes = [];
    let id = 0;
    for (let p = 0; p < n; p++) {
      if (label[p] || prob[p] <= cfg.detThresh) continue;
      id++;
      let top = 0, minX = dw, maxX = -1, minY = dh, maxY = -1, sum = 0, cnt = 0;
      stack[top++] = p; label[p] = id;
      while (top) {
        const q = stack[--top], x = q % dw, y = (q - x) / dw;
        sum += prob[q]; cnt++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x > 0 && !label[q - 1] && prob[q - 1] > cfg.detThresh) { label[q - 1] = id; stack[top++] = q - 1; }
        if (x < dw - 1 && !label[q + 1] && prob[q + 1] > cfg.detThresh) { label[q + 1] = id; stack[top++] = q + 1; }
        if (y > 0 && !label[q - dw] && prob[q - dw] > cfg.detThresh) { label[q - dw] = id; stack[top++] = q - dw; }
        if (y < dh - 1 && !label[q + dw] && prob[q + dw] > cfg.detThresh) { label[q + dw] = id; stack[top++] = q + dw; }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (Math.min(bw, bh) < cfg.minSize || sum / cnt < cfg.boxThresh) continue;
      // 모델은 글자 영역을 줄여서 예측 → 넓이×비율/둘레 만큼 바깥으로 넓힘
      const d = bw * bh * cfg.unclipRatio / (2 * (bw + bh));
      if (Math.min(bw, bh) + 2 * d < cfg.minSize + 2) continue;
      const kx = W / dw, ky = H / dh;
      const x0 = Math.max(0, (minX - d) * kx), y0 = Math.max(0, (minY - d) * ky);
      const x1 = Math.min(W, (maxX + 1 + d) * kx), y1 = Math.min(H, (maxY + 1 + d) * ky);
      if (x1 - x0 >= 2 && y1 - y0 >= 2) boxes.push({ x0, y0, x1, y1 });
    }
    return boxes;
  }

  // ── 글자 읽기 (높이 48로 맞춰 묶음 처리 → CTC 디코딩) ──
  function cropLine(canvas, b) {
    const x = Math.floor(b.x0), y = Math.floor(b.y0), w = Math.max(1, Math.ceil(b.x1) - x), h = Math.max(1, Math.ceil(b.y1) - y);
    const vertical = h >= w * 1.5; // 세로쓰기 줄은 눕혀서 읽음 (PaddleOCR와 같음)
    const c = document.createElement('canvas');
    c.width = vertical ? h : w; c.height = vertical ? w : h;
    const g = c.getContext('2d');
    if (vertical) { g.translate(0, w); g.rotate(-Math.PI / 2); }
    g.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    return c;
  }
  async function recognizeLines(m, canvas, boxes, onProgress) {
    const H = cfg.recHeight;
    const items = boxes.map((b, i) => { const c = cropLine(canvas, b); return { i, c, r: c.width / c.height }; });
    items.sort((a, b) => a.r - b.r);
    const res = new Array(boxes.length);
    const C = m.chars.length;
    for (let s = 0; s < items.length; s += cfg.recBatch) {
      const batch = items.slice(s, s + cfg.recBatch);
      const maxR = Math.max(320 / H, ...batch.map(it => it.r));
      const BW = Math.min(cfg.recMaxWidth, Math.ceil(H * maxR));
      const data = new Float32Array(batch.length * 3 * H * BW); // 0 = 오른쪽 여백 (PaddleOCR와 같음)
      batch.forEach((it, k) => {
        const w = Math.max(1, Math.min(BW, Math.ceil(H * it.r)));
        const t = document.createElement('canvas');
        t.width = w; t.height = H;
        const g = t.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(it.c, 0, 0, w, H);
        toTensorData(g.getImageData(0, 0, w, H).data, w, H, data.subarray(k * 3 * H * BW, (k + 1) * 3 * H * BW), BW, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
      });
      const out = await m.rec.run({ [m.rec.inputNames[0]]: new m.ort.Tensor('float32', data, [batch.length, 3, H, BW]) });
      const o = out[m.rec.outputNames[0]];
      const [, T, K] = o.dims;
      // 출력 칸 = 공백(blank) + 사전 + (띄어쓰기). 사전과 모델이 맞지 않으면 엉뚱한 글자가 나오므로 멈춤
      if (K !== C + 2 && K !== C + 1) throw new Error(`인식 모델과 글자 사전이 맞지 않습니다 (모델 ${K}칸, 사전 ${C}자)`);
      const table = ['', ...m.chars, ' '];
      batch.forEach((it, k) => {
        const cs = [], at = [];
        let prev = 0, sc = 0;
        for (let t = 0; t < T; t++) {
          const off = (k * T + t) * K;
          let best = 0, bp = o.data[off];
          for (let j = 1; j < K; j++) if (o.data[off + j] > bp) { bp = o.data[off + j]; best = j; }
          if (best && best !== prev) { cs.push(table[best] || ''); at.push(t); sc += bp; }
          prev = best;
        }
        res[it.i] = { text: spaceByGap(cs, at).trim(), score: cs.length ? sc / cs.length : 0 };
      });
      if (onProgress) onProgress(0.25 + 0.75 * Math.min(1, (s + batch.length) / items.length));
    }
    return res;
  }

  // 숫자·영문 사이 띄어쓰기를 모델이 빠뜨린 경우 보완 ('2026-04-1711:00' → '2026-04-17 11:00')
  // 글자가 찍힌 시간축 위치(at)의 간격이 그 줄의 보통 글자 간격보다 확연히 넓으면 띄어쓰기로 본다
  const ALNUM = /^[0-9A-Za-z]$/;
  function spaceByGap(cs, at) {
    const gaps = [];
    for (let i = 1; i < cs.length; i++) if (ALNUM.test(cs[i - 1]) && ALNUM.test(cs[i])) gaps.push(at[i] - at[i - 1]);
    if (gaps.length < 3) return cs.join('');
    const med = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
    let out = cs[0] || '';
    for (let i = 1; i < cs.length; i++) {
      if (ALNUM.test(cs[i - 1]) && ALNUM.test(cs[i]) && at[i] - at[i - 1] >= Math.max(med * 1.75, med + 2)) out += ' ';
      out += cs[i];
    }
    return out;
  }

  // 줄 상자들을 읽는 순서로: 세로로 겹치는 상자끼리 한 줄, 줄 안에서는 왼쪽부터
  function toPage(boxes, lines) {
    const items = boxes.map((b, i) => Object.assign({}, b, lines[i])).filter(it => it.text);
    items.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const rows = [];
    for (const it of items) {
      const h = it.y1 - it.y0;
      const row = rows.find(r => {
        const ov = Math.min(r.y1, it.y1) - Math.max(r.y0, it.y0);
        return ov > 0.5 * Math.min(h, r.y1 - r.y0);
      });
      if (row) { row.items.push(it); row.y0 = Math.min(row.y0, it.y0); row.y1 = Math.max(row.y1, it.y1); } else rows.push({ y0: it.y0, y1: it.y1, items: [it] });
    }
    rows.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const words = [];
    const text = rows.map(r => {
      r.items.sort((a, b) => a.x0 - b.x0);
      r.items.forEach(it => {
        // 줄 상자를 낱말로 나눔 (글자 수 비례로 x 좌표 배분) → Tesseract 단어 좌표와 같은 모양
        const parts = it.text.split(/\s+/).filter(Boolean);
        const total = it.text.length, cw = (it.x1 - it.x0) / Math.max(1, total);
        let pos = 0;
        parts.forEach(p => {
          const at = it.text.indexOf(p, pos);
          words.push({ text: p, confidence: Math.round(it.score * 100), bbox: { x0: it.x0 + at * cw, y0: it.y0, x1: it.x0 + (at + p.length) * cw, y1: it.y1 } });
          pos = at + p.length;
        });
      });
      return r.items.map(it => it.text).join(' ');
    }).join('\n');
    return { text, words };
  }

  async function recognize(source, onProgress) {
    const m = await init();
    const canvas = toCanvas(source);
    if (onProgress) onProgress(0.05);
    const boxes = await detect(m, canvas);
    if (onProgress) onProgress(0.25);
    if (!boxes.length) return { text: '', words: [] };
    const lines = await recognizeLines(m, canvas, boxes, onProgress);
    return toPage(boxes, lines);
  }

  // 시험·교체용: 모델·사전 경로 바꾸기 (바꾸면 다음 인식 때 다시 불러옴)
  function configure(o) { Object.assign(cfg, o || {}); loading = null; missing = null; }

  global.PaddleOcr = { recognize, available, init, configure, config: cfg };
})(window);
