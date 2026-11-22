/*
 * 파일 → 텍스트/미리보기 이미지
 *  - 이미지: Tesseract OCR (kor+eng, 로컬 lib)
 *  - PDF: pdf.js 텍스트 추출, 텍스트가 없으면(스캔본) 페이지 렌더링 후 OCR
 *  - HWPX: zip 내부 Preview/PrvText.txt 또는 Contents/section*.xml
 *  - HWP: 텍스트 추출 불가 (파일명으로만 분류)
 */
(function (global) {
  'use strict';
  const base = new URL('.', location.href).href;
  pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'lib/pdfjs/pdf.worker.min.js';

  const MAX_PDF_PAGES = 15;
  let ocrWorker = null, ocrInit = null, ocrProgress = () => {};

  function getOcr() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    if (location.protocol === 'file:') return Promise.reject(new Error('index.html을 직접 열면 글자 인식을 할 수 없습니다. start.bat으로 실행하세요'));
    if (!ocrInit) {
      ocrInit = Tesseract.createWorker(['kor', 'eng'], 1, {
        workerPath: base + 'lib/tesseract/worker.min.js',
        corePath: base + 'lib/tesseract/core',
        langPath: base + 'lib/tesseract/lang',
        gzip: true,
        logger: m => { if (m.status === 'recognizing text') ocrProgress(m.progress); },
      }).then(w => (ocrWorker = w));
    }
    return ocrInit;
  }

  // 인식 결과 전체(text + 단어 좌표 words)를 돌려준다. psm을 주면 그 배치 방식으로 읽고 끝나면 기본값(6)으로 되돌림
  async function ocrData(source, onProgress, psm) {
    const w = await getOcr();
    ocrProgress = onProgress || (() => {});
    if (psm) await w.setParameters({ tessedit_pageseg_mode: psm });
    try {
      const { data } = await w.recognize(source);
      return { text: data.text || '', words: data.words || [] };
    } finally {
      ocrProgress = () => {};
      if (psm) await w.setParameters({ tessedit_pageseg_mode: '6' });
    }
  }
  const ocr = async (source, onProgress) => (await ocrData(source, onProgress)).text;

  /*
   * 출발지·도착지 보완 (항공사·운송사별 화면 모양과 무관한 공통 처리)
   * 글자만으로 구간을 못 찾은 교통 문서는 글자 '배치'로 찾는다: Extract.routeFromLayout
   *  - words: 1차 인식 단어 좌표 / reread: 더 크게·흩어진 글자 모드로 다시 읽는 함수(이미지·스캔 PDF)
   * 찾은 값은 '구간: 제주 → 청주' / '편명: LJ7489' 줄로 본문 앞에 붙여 이후 분석이 그대로 쓰게 한다
   */
  async function enrichTransport(text, words, reread) {
    const X = global.Extract;
    if (!X) return text;
    const a = X.analyzeText(text);
    const looksTransport = /^transport_/.test(a.docType) || (X.DEP_LABEL.test(text) && X.ARR_LABEL.test(text));
    if (!looksTransport) return text;
    const needRoute = () => !a.from || !a.to;
    const head = [];
    let r = needRoute() ? X.routeFromLayout(words) : null;
    // 편명은 탑승확인서에서만 다시 찾는다 (편명이 원래 없는 지불영수증까지 재인식하지 않도록)
    let flight = a.vehicleNo || a.docType !== 'transport_confirm' || a.mode !== 'air' ? '' : null;
    if ((needRoute() && !r) || flight === null) {
      const d = reread && await reread();
      if (d) {
        if (needRoute() && !r) r = X.routeFromLayout(d.words);
        if (flight === null) flight = X.findFlights(d.text || '')[0] || null;
      }
    }
    if (r && needRoute()) head.push(`구간: ${r.from} → ${r.to}`);
    if (flight) head.push(`편명: ${flight}`);
    return head.length ? head.join('\n') + '\n' + text : text;
  }

  // 작은 캡처는 확대해야 인식률이 올라감
  function loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('이미지를 열 수 없습니다'));
      img.src = url;
    });
  }
  function toCanvas(img, maxSide, scale) {
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    let s = scale || 1;
    if (!scale && Math.max(w, h) < 1300) s = Math.min(2.5, 1600 / Math.max(w, h));
    if (maxSide && Math.max(w, h) * s > maxSide) s = maxSide / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function fnv(buf) {
    const a = new Uint8Array(buf);
    let h = 0x811c9dc5;
    for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + '-' + a.length;
  }

  async function readImage(doc, buf, step) {
    doc.previewUrl = URL.createObjectURL(new Blob([buf], { type: doc.file.type || 'image/png' }));
    doc.thumb = doc.previewUrl;
    const img = await loadImage(doc.previewUrl);
    step('글자 인식 중');
    const first = await ocrData(toCanvas(img, 4000), p => step('글자 인식 중', p));
    const X = global.Extract;
    if (!X) return first.text;
    // 마일리지·포인트 적립내역의 회색 편명(OZ8199, LJ7484 등)은 원본 크기로는 거의 못 읽음 → 확대해서 한 번 더 인식
    if (/마일리지|적립|포인트/.test(first.text) && !X.findFlights(first.text).length) {
      for (const s of [1.6, 2]) {
        step('글자 인식 중(확대)');
        const big = await ocr(toCanvas(img, 4000, s), p => step('글자 인식 중(확대)', p));
        if (X.findFlights(big).length) return big;
      }
    }
    // 탑승권 등: 큰 글씨로 띄엄띄엄 놓인 지명·편명은 기본 인식이 자주 깨뜨림 → 2배 확대 + 흩어진 글자 모드(PSM 11)로 재확인
    return enrichTransport(first.text, first.words, () => {
      step('글자 인식 중(구간 재확인)');
      return ocrData(toCanvas(img, 4000, 2), p => step('글자 인식 중(구간 재확인)', p), '11');
    });
  }

  async function readPdf(doc, buf, step) {
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: base + 'lib/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: base + 'lib/pdfjs/standard_fonts/',
    }).promise;
    const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
    if (pdf.numPages > MAX_PDF_PAGES) doc.note = `${pdf.numPages}쪽 중 앞 ${MAX_PDF_PAGES}쪽만 처리`;
    doc.pages = [];
    const texts = [];
    for (let i = 1; i <= n; i++) {
      step(`PDF ${i}/${n}쪽`);
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      // 글자 좌표(위→아래 좌표계)를 OCR 단어와 같은 모양으로: 출발/도착 배치 판정에 사용
      const ph = page.view[3] - page.view[1];
      const words = tc.items.filter(it => it.str && it.str.trim() && it.transform).flatMap(it => {
        const h = Math.abs(it.transform[3]) || it.height || 10, y1 = ph - it.transform[5], x0 = it.transform[4];
        const parts = it.str.trim().split(/\s+/), cw = (it.width || h * it.str.length) / Math.max(1, it.str.length);
        let x = x0;
        return parts.map(p => { const b = { x0: x, y0: y1 - h, x1: x + p.length * cw, y1 }; x += (p.length + 1) * cw; return { text: p, bbox: b }; });
      });
      let t = '', lastY = null;
      tc.items.forEach(it => {
        const y = it.transform ? it.transform[5] : null;
        if (lastY != null && y != null && Math.abs(y - lastY) > 3 && !t.endsWith('\n')) t += '\n';
        t += it.str;
        if (it.hasEOL) t += '\n';
        lastY = y;
      });
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      doc.pages.push(c.toDataURL('image/jpeg', 0.88));
      if (t.replace(/\s/g, '').length < 30) { // 스캔 PDF
        step(`PDF ${i}/${n}쪽 글자 인식`);
        const d = await ocrData(c, p => step(`PDF ${i}/${n}쪽 글자 인식`, p));
        t = await enrichTransport(d.text, d.words, () => {
          step(`PDF ${i}/${n}쪽 구간 재확인`);
          const big = page.getViewport({ scale: 3 });
          const c2 = document.createElement('canvas');
          c2.width = big.width; c2.height = big.height;
          const g2 = c2.getContext('2d');
          g2.fillStyle = '#fff'; g2.fillRect(0, 0, c2.width, c2.height);
          return page.render({ canvasContext: g2, viewport: big }).promise
            .then(() => ocrData(c2, p => step(`PDF ${i}/${n}쪽 구간 재확인`, p), '11'));
        });
      } else t = await enrichTransport(t, words, null);
      texts.push(t);
    }
    doc.thumb = doc.pages[0];
    return texts.join('\n\n');
  }

  async function readHwpx(doc, buf) {
    const zip = await JSZip.loadAsync(buf);
    const prvImg = zip.file('Preview/PrvImage.png');
    if (prvImg) {
      doc.previewUrl = URL.createObjectURL(await prvImg.async('blob'));
      doc.thumb = doc.previewUrl;
    }
    const secs = Object.keys(zip.files).filter(n => /^Contents\/section\d+\.xml$/i.test(n)).sort();
    if (secs.length) {
      const out = [];
      for (const s of secs) {
        const xml = new DOMParser().parseFromString(await zip.file(s).async('string'), 'application/xml');
        xml.querySelectorAll('*').forEach(el => {
          if (el.localName === 'p') out.push('\n');
          else if (el.localName === 't') out.push(el.textContent);
          else if (el.localName === 'tab') out.push(' ');
        });
      }
      const t = out.join('').replace(/\n{3,}/g, '\n\n').trim();
      if (t) return t;
    }
    const prv = zip.file('Preview/PrvText.txt');
    if (prv) return prv.async('string');
    throw new Error('hwpx 내용을 읽지 못했습니다');
  }

  async function ingest(doc, step) {
    const buf = await doc.file.arrayBuffer();
    doc.hash = doc.hash || fnv(buf);
    const ext = doc.ext;
    if (/^(jpe?g|png|gif|bmp|webp)$/.test(ext) || (doc.file.type || '').startsWith('image/')) { doc.kind = 'image'; return readImage(doc, buf, step); }
    if (ext === 'pdf') { doc.kind = 'pdf'; return readPdf(doc, buf, step); }
    if (ext === 'hwpx') { doc.kind = 'hwpx'; return readHwpx(doc, buf); }
    if (ext === 'hwp') { doc.kind = 'hwp'; doc.note = 'hwp는 내용을 읽을 수 없어 파일명으로 분류했습니다'; return ''; }
    throw new Error('지원하지 않는 형식 (jpg, png, pdf, hwpx만 가능)');
  }

  global.Ingest = { ingest, loadImage, hashOf: fnv };
})(window);
