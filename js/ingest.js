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

  async function ocr(source, onProgress) {
    const w = await getOcr();
    ocrProgress = onProgress || (() => {});
    const { data } = await w.recognize(source);
    ocrProgress = () => {};
    return data.text || '';
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
  function toCanvas(img, maxSide) {
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    let s = 1;
    if (Math.max(w, h) < 1300) s = Math.min(2.5, 1600 / Math.max(w, h));
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
    return ocr(toCanvas(img, 4000), p => step('글자 인식 중', p));
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
        t = await ocr(c, p => step(`PDF ${i}/${n}쪽 글자 인식`, p));
      }
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
