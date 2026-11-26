(function () {
  'use strict';
  const { analyze, evidenceOrder, TYPE_LABEL, MODE_LABEL, won, fmtD } = window.Analyze;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { docs: [], result: null, seq: 0 };
  const queue = [];
  let busy = false;

  // ───────────────────────── 특이사항 ─────────────────────────
  const tripForm = $('#trip');
  function trip() {
    const f = tripForm.elements;
    return { remarkOut: f.remarkOut.value.trim(), remarkBack: f.remarkBack.value.trim() };
  }

  // ───────────────────────── AI(로컬 LLM) 연결 설정 ─────────────────────────
  // 설정은 이 브라우저에만 저장 (서버 종류·주소·모델 등을 그때그때 바꿔 쓸 수 있음)
  const LLM_KEY = 'btd.llm';
  const llmForm = $('#llm');
  let llmS = LLM.settingsOf((() => { try { return JSON.parse(localStorage.getItem(LLM_KEY) || '{}'); } catch (e) { return {}; } })());
  const llmOn = () => !!(llmS.enabled && llmS.model);
  const ai = { plan: null, running: false, error: '', seq: 0, stale: false };
  function fillLlmForm() {
    const f = llmForm.elements;
    f.enabled.checked = !!llmS.enabled; f.provider.value = llmS.provider; f.baseUrl.value = llmS.baseUrl;
    f.baseUrl.placeholder = LLM.PROVIDERS[llmS.provider].baseUrl;
    f.model.value = llmS.model; f.apiKey.value = llmS.apiKey; f.vision.value = llmS.vision;
    f.numCtx.value = llmS.numCtx; f.timeoutSec.value = llmS.timeoutSec; f.think.checked = !!llmS.think;
    f.numCtx.disabled = llmS.provider !== 'ollama';
    updateLlmBadge();
  }
  function updateLlmBadge() {
    const b = $('#llm-badge');
    b.textContent = llmOn() ? `사용 중 · ${LLM.PROVIDERS[llmS.provider].label.split(' ')[0]} · ${llmS.model}` : llmS.enabled ? '모델을 고르세요' : '사용 안 함';
    b.classList.toggle('on', llmOn());
    $('#btn-ai').hidden = !llmOn();
  }
  function readLlmForm() {
    const f = llmForm.elements;
    const prov = f.provider.value;
    if (prov !== llmS.provider) { f.baseUrl.value = ''; f.model.value = ''; $('#llm-models').innerHTML = ''; }
    llmS = LLM.settingsOf({
      enabled: f.enabled.checked, provider: prov, baseUrl: f.baseUrl.value.trim(), model: f.model.value.trim(),
      apiKey: f.apiKey.value.trim(), vision: f.vision.value, think: f.think.checked,
      numCtx: +f.numCtx.value || LLM.DEFAULTS.numCtx, timeoutSec: +f.timeoutSec.value || LLM.DEFAULTS.timeoutSec,
    });
    try { localStorage.setItem(LLM_KEY, JSON.stringify(llmS)); } catch (e) { /* 저장 불가(사생활 보호 모드 등): 이번 세션만 사용 */ }
    fillLlmForm();
  }
  function llmStatus(msg, cls) { const el = $('#llm-status'); el.textContent = msg; el.className = 'hint' + (cls ? ' ' + cls : ''); }
  async function refreshModels(quiet) {
    try {
      const ms = await LLM.listModels(llmS);
      $('#llm-models').innerHTML = ms.map(m => `<option value="${esc(m)}">`).join('');
      if (!quiet) llmStatus(`모델 ${ms.length}개: ${ms.join(', ') || '(없음)'}`, ms.length ? 'ok' : 'err');
      return ms;
    } catch (e) { if (!quiet) llmStatus(e.message, 'err'); return []; }
  }
  llmForm.addEventListener('change', () => {
    const wasOn = llmOn();
    readLlmForm();
    if (!wasOn && llmOn() && state.docs.some(d => d.status === 'done')) llmStatus('[AI로 다시 정리]를 누르면 이미 읽은 서류도 AI로 판독합니다.');
    scheduleAnalyze(0);
  });
  $('#llm-refresh').addEventListener('click', () => refreshModels(false));
  $('#llm-test').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true; llmStatus('연결 확인 중… (모델을 처음 불러오면 오래 걸릴 수 있습니다)');
    try {
      const r = await LLM.testConnection(llmS);
      $('#llm-models').innerHTML = r.models.map(m => `<option value="${esc(m)}">`).join('');
      llmStatus(r.msg, r.ok ? 'ok' : 'err');
    } catch (err) { llmStatus(err.message, 'err'); } finally { btn.disabled = false; }
  });

  // 서류 이미지 → LLM에 보낼 축소 JPEG (PDF는 앞 2쪽)
  async function docImages(doc) {
    const srcs = doc.pages && doc.pages.length ? doc.pages.slice(0, 2) : doc.previewUrl ? [doc.previewUrl] : [];
    const out = [];
    for (const src of srcs) {
      try {
        const img = await Ingest.loadImage(src);
        const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, llmS.maxImageSide / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        out.push(c.toDataURL('image/jpeg', 0.85));
      } catch (e) { /* 이미지 없이 글자만 보냄 */ }
    }
    return out;
  }
  // 서류 1건 AI 판독 → 규칙 인식값과 합쳐 문서 필드에 반영 (사용자가 고친 서류는 건드리지 않음)
  async function aiReadDoc(doc) {
    if (doc.userTouched || !doc.auto) return;
    doc.aiBusy = true; updateStatus(doc);
    try {
      const rule = fieldsFromAuto(doc.auto);
      const r = await LLM.extractDoc(llmS, Object.assign({}, doc, { f: rule }), await docImages(doc));
      if (doc.userTouched) return;
      const m = LLM.mergeDoc(rule, r, doc.auto);
      doc.ai = r; doc.aiSrc = m.src; doc.aiError = '';
      doc.f = Object.assign(m.f, { dir: doc.f.dir || 'auto' });
      doc.lowConfidence = false;
    } catch (e) {
      console.error(e);
      doc.aiError = e.message || String(e);
    } finally { doc.aiBusy = false; }
  }
  // 전체 서류 → AI 여정 정리 (늦게 끝난 이전 요청 결과는 버림)
  async function runPlan() {
    const docs = state.docs.filter(d => d.status === 'done');
    if (!llmOn() || !docs.length) return;
    const my = ++ai.seq;
    ai.running = true; ai.error = '';
    runAnalyze();
    try {
      const p = await LLM.planTrip(llmS, trip(), docs);
      if (my === ai.seq) { ai.plan = p; ai.stale = false; }
    } catch (e) {
      console.error(e);
      if (my === ai.seq) ai.error = e.message || String(e);
    } finally {
      if (my === ai.seq) { ai.running = false; runAnalyze(); }
    }
  }

  // ───────────────────────── 글자 인식 엔진 ─────────────────────────
  // Tesseract(기본) / PP-OCRv5 한국어 중 선택. 선택은 이 브라우저에만 저장
  const OCR_KEY = 'btd.ocr';
  const ocrSel = $('#ocr-engine');
  let paddleOk = null; // 한국어 인식 모델 파일이 있는지 (null: 확인 전)
  let paddleErr = '';  // 엔진 준비 중 오류
  function ocrStatus() {
    const el = $('#ocr-status');
    const opt = ocrSel.querySelector('option[value="paddle"]');
    opt.textContent = 'PP-OCRv5 한국어' + (paddleOk === false ? ' — 모델 내려받기 필요' : ' (korean_PP-OCRv5_mobile_rec)');
    let msg = '추가 설치 없이 동작하는 기본 엔진입니다.', cls = '';
    if (ocrSel.value === 'paddle') {
      if (paddleOk === false) {
        msg = '한국어 인식 모델 파일(lib/paddleocr/korean_PP-OCRv5_mobile_rec.onnx)이 없습니다. 폴더의 <code>get-ocr-model.bat</code>을 한 번 실행해 내려받은 뒤(약 13MB) 이 페이지를 새로 고치세요. 그전까지는 Tesseract로 읽습니다.'; cls = 'err';
      } else if (paddleErr) { msg = `PP-OCRv5를 준비하지 못했습니다: ${esc(paddleErr)} — Tesseract로 읽습니다.`; cls = 'err'; }
      else msg = '한국어 전용 PP-OCRv5 모델로 읽습니다. 이 PC 안에서만 처리되며, 처음 한 번은 엔진을 불러오느라 몇 초 걸립니다.' + (paddleOk ? '' : ' (모델 확인 중…)');
    }
    el.innerHTML = msg; el.className = 'hint' + (cls ? ' ' + cls : '');
    // 이미 읽은 서류 중 다른 엔진으로 읽은 것 → 다시 인식 버튼
    const n = rerunTargets().length;
    const btn = $('#ocr-rerun');
    btn.hidden = !n || (ocrSel.value === 'paddle' && (paddleOk === false || !!paddleErr));
    btn.textContent = `고른 엔진으로 다시 인식 (${n}건)`;
  }
  const rerunTargets = () => state.docs.filter(d => d.status === 'done' && d.ocrEngine && d.ocrEngine !== ocrSel.value && !d.userTouched);
  function setOcrEngine(v, save) {
    ocrSel.value = Ingest.ENGINE_LABEL[v] ? v : 'tesseract';
    Ingest.setEngine(ocrSel.value);
    if (save) { try { localStorage.setItem(OCR_KEY, ocrSel.value); } catch (e) { /* 저장 불가: 이번 세션만 */ } }
    ocrStatus();
    if (ocrSel.value === 'paddle' && location.protocol !== 'file:') {
      PaddleOcr.available().then(ok => {
        paddleOk = ok; ocrStatus();
        // 미리 엔진을 불러 두면 첫 서류가 빨라지고, 문제가 있으면 바로 알 수 있음
        if (ok) PaddleOcr.init().then(() => { paddleErr = ''; ocrStatus(); }, e => { paddleErr = e.message || String(e); ocrStatus(); });
      });
    }
  }
  ocrSel.addEventListener('change', () => { paddleErr = ''; setOcrEngine(ocrSel.value, true); });
  $('#ocr-rerun').addEventListener('click', () => {
    const list = rerunTargets();
    if (!list.length) return;
    list.forEach(d => swapDoc(d, d.file, d.hash));
    updateProgress();
    scheduleAnalyze(0);
    pump();
    ocrStatus();
  });
  setOcrEngine((() => { try { return localStorage.getItem(OCR_KEY); } catch (e) { return null; } })() || 'tesseract', false);

  // ───────────────────────── 파일 등록 ─────────────────────────
  const drop = $('#drop'), fileInput = $('#file');
  // file:// 로 열면 OCR 워커를 불러올 수 없음 → start.bat(로컬 서버)로 열도록 안내
  if (location.protocol === 'file:') $('#file-warn').hidden = false;
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));

  // 내용이 같은 파일(이름이 달라도)은 다시 읽지 않고 건너뜀. 앞서 읽기 실패한 파일이면 새 것으로 교체
  async function hashOf(file) {
    try { return Ingest.hashOf(await file.arrayBuffer()); } catch (e) { return ''; /* 읽기 오류는 처리 단계에서 표시 */ }
  }
  function newDoc(file, hash) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return { id: 'd' + (++state.seq), file, name: file.name, ext, hash, status: 'queued', step: '대기', f: { type: 'other', dir: 'auto' } };
  }
  async function addFiles(files) {
    const list = [...files];
    const skipped = [];
    for (const file of list) {
      const hash = await hashOf(file);
      const prev = hash && state.docs.find(d => d.hash === hash);
      if (prev && prev.status !== 'error') { skipped.push(file.name === prev.name ? file.name : `${file.name}(=${prev.name})`); continue; }
      if (prev) removeDoc(prev);
      const doc = newDoc(file, hash);
      state.docs.push(doc);
      queue.push(doc);
      renderDocCard(doc);
    }
    const note = $('#dup-note');
    note.hidden = !skipped.length;
    note.textContent = skipped.length ? `이미 등록된 파일과 같은 파일 ${skipped.length}개는 건너뛰었습니다: ${skipped.join(', ')}` : '';
    $('#docs-sec').hidden = !state.docs.length;
    pump();
  }
  function removeDoc(doc) {
    state.docs = state.docs.filter(d => d !== doc);
    if (ai.plan) ai.stale = true;
    const card = docsBox.querySelector(`[data-id="${doc.id}"]`);
    if (card) card.remove();
    if (doc.previewUrl) URL.revokeObjectURL(doc.previewUrl);
  }

  // 파일 교체: 문서 카드의 [교체] → 새 파일을 같은 자리에 넣고 다시 인식 (예: 금액이 다른 영수증을 맞는 것으로 바꿀 때)
  const replaceInput = Object.assign(document.createElement('input'), { type: 'file', accept: fileInput.accept, hidden: true });
  document.body.appendChild(replaceInput);
  let replaceTarget = null;
  replaceInput.addEventListener('change', () => {
    const file = replaceInput.files[0], old = replaceTarget;
    replaceInput.value = ''; replaceTarget = null;
    if (file && old && state.docs.includes(old)) replaceDoc(old, file);
  });
  async function replaceDoc(old, file) {
    const hash = await hashOf(file);
    if (hash && hash === old.hash) { alert(`${file.name}은(는) 지금 등록된 파일과 같은 파일입니다.`); return; }
    const same = hash && state.docs.find(d => d !== old && d.hash === hash && d.status !== 'error');
    if (same) { alert(`${file.name}은(는) 이미 등록된 ${same.name}과(와) 같은 파일이라 교체하지 않았습니다.`); return; }
    if (!state.docs.includes(old)) return;
    swapDoc(old, file, hash);
    updateProgress();
    scheduleAnalyze(0);
    pump();
  }
  // 같은 자리에 새 문서를 넣고 읽기 대기열에 올림 (파일 교체·다른 엔진으로 다시 인식)
  function swapDoc(old, file, hash) {
    const doc = newDoc(file, hash);
    state.docs[state.docs.indexOf(old)] = doc;
    if (ai.plan) ai.stale = true;
    if (old.previewUrl) URL.revokeObjectURL(old.previewUrl);
    const oldCard = docsBox.querySelector(`[data-id="${old.id}"]`);
    renderDocCard(doc);
    const card = docsBox.querySelector(`[data-id="${doc.id}"]`);
    if (oldCard) docsBox.replaceChild(card, oldCard);
    card.classList.add('flash');
    queue.push(doc);
    return doc;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const doc = queue.shift();
      if (!state.docs.includes(doc)) continue;
      doc.status = 'reading';
      const step = (msg, p) => { doc.step = msg; doc.pct = p; updateStatus(doc); updateProgress(); };
      step('읽는 중');
      try {
        const text = await Ingest.ingest(doc, step);
        doc.text = text || '';
        doc.auto = Extract.analyzeText(doc.text, { filename: doc.name, ext: doc.ext, refYear: yearHint() });
        doc.f = fieldsFromAuto(doc.auto);
        doc.lowConfidence = doc.auto.confidence < 2;
        if (llmOn()) { step('AI 판독 중'); await aiReadDoc(doc); }
        doc.status = 'done';
      } catch (e) {
        console.error(e);
        doc.status = 'error';
        doc.error = e.message || String(e);
      }
      // 읽는 동안 삭제·교체된 문서는 카드를 다시 그리지 않음
      if (!state.docs.includes(doc)) { if (doc.previewUrl) URL.revokeObjectURL(doc.previewUrl); updateProgress(); scheduleAnalyze(50); continue; }
      renderDocCard(doc);
      updateProgress();
      scheduleAnalyze(50);
    }
    busy = false;
    updateProgress();
    ocrStatus();
    if (llmOn() && state.docs.some(d => d.status === 'done')) runPlan();
  }
  function yearHint() { return undefined; }
  function fieldsFromAuto(a) {
    return {
      type: a.docType, dir: 'auto', mode: a.mode || '', date: a.date || '', time: a.time || '',
      from: a.from || '', to: a.to || '', vehicleNo: a.vehicleNo || '', airline: a.airline || '', flights: (a.flights || []).join(', '), points: a.points || '', refs: (a.refs || []).join(', '),
      amount: a.amount ?? '', checkin: a.checkin || '', checkout: a.checkout || '', lodgingName: a.lodgingName || '',
      km: a.km ?? '', toll: a.toll ?? '', fuelType: a.fuelType || '', fuelPrice: a.fuelPrice ?? '',
      periodStart: a.periodStart || '', periodEnd: a.periodEnd || '', title: a.title || '',
    };
  }
  function updateProgress() {
    const total = state.docs.length;
    const done = state.docs.filter(d => d.status === 'done' || d.status === 'error').length;
    const box = $('#progress');
    box.hidden = done === total;
    if (done < total) {
      const cur = state.docs.find(d => d.status === 'reading');
      const frac = (done + (cur && cur.pct ? cur.pct : 0)) / total;
      $('.bar i', box).style.width = (frac * 100).toFixed(1) + '%';
      $('span', box).textContent = `${done}/${total} 처리 완료` + (cur ? ` · ${cur.name} – ${cur.step}` : '') +
        (state.docs.some(d => d.kind === 'image') && done === 0 ? ' (처음 한 번은 글자인식 엔진을 불러오느라 시간이 걸립니다)' : '');
    }
  }

  // ───────────────────────── 문서 카드 ─────────────────────────
  const F = {
    mode: { label: '교통수단', type: 'select', opts: [['', '선택'], ['air', '항공'], ['rail', '철도'], ['bus', '버스'], ['etc', '기타']] },
    dir: { label: '구분', type: 'select', opts: [['auto', '자동'], ['out', '출발'], ['local', '경유'], ['back', '도착']] },
    date: { label: '이용일', type: 'date' }, time: { label: '출발시각', type: 'text', ph: 'HH:MM' },
    from: { label: '출발지', type: 'text' }, to: { label: '도착지', type: 'text' },
    vehicleNo: { label: '편명/열차', type: 'text' }, airline: { label: '항공사', type: 'text' },
    flights: { label: '편명', type: 'text', ph: '여러 개는 쉼표로 (예: KE1011, 7C123)' },
    points: { label: '적립 포인트', type: 'text', ph: '예: 3,994P' }, refs: { label: '예약·승차권번호', type: 'text', ph: '여러 개는 쉼표로' },
    amount: { label: '금액(원)', type: 'number' },
    lodgingName: { label: '숙소명', type: 'text' }, checkin: { label: '체크인', type: 'date' }, checkout: { label: '체크아웃', type: 'date' },
    km: { label: '거리(km)', type: 'number' }, toll: { label: '통행료(원)', type: 'number' },
    fuelType: { label: '유종', type: 'select', opts: [['', '선택'], ['휘발유', '휘발유'], ['경유', '경유'], ['LPG', 'LPG']] },
    fuelPrice: { label: '단가(원/L)', type: 'number' },
    title: { label: '제목', type: 'text' }, periodStart: { label: '기간 시작', type: 'date' }, periodEnd: { label: '기간 종료', type: 'date' },
  };
  const FIELDS_BY_TYPE = {
    transport_receipt: ['mode', 'dir', 'date', 'time', 'from', 'to', 'vehicleNo', 'airline', 'refs', 'amount'],
    transport_confirm: ['mode', 'dir', 'date', 'time', 'from', 'to', 'vehicleNo', 'airline', 'refs', 'amount'],
    mileage: ['date', 'points', 'airline', 'flights'],
    lodging_receipt: ['lodgingName', 'checkin', 'checkout', 'refs', 'amount'],
    lodging_confirm: ['lodgingName', 'checkin', 'checkout', 'refs', 'amount'],
    car_distance: ['from', 'to', 'km', 'toll'],
    car_fuel: ['fuelType', 'fuelPrice'],
    official: ['title', 'periodStart', 'periodEnd'],
    other: [],
  };
  const docsBox = $('#docs');

  function thumbHtml(doc) {
    if (doc.thumb) return `<img src="${doc.thumb}" alt="">`;
    const label = { pdf: 'PDF', hwpx: 'HWPX', hwp: 'HWP' }[doc.ext] || (doc.ext || '').toUpperCase();
    return `<div class="ph">${esc(label || '파일')}</div>`;
  }
  function aiTag(doc) {
    if (doc.aiBusy) return '<span class="tag run">AI 판독 중</span>';
    if (doc.aiError) return `<span class="tag err" title="${esc(doc.aiError)}">AI 판독 실패 – 규칙 인식값 사용</span>`;
    if (doc.ai) return `<span class="tag ai" title="${esc(doc.ai.note || '')}">AI 판독${doc.ai.vision ? '(이미지)' : ''}</span>`;
    return '';
  }
  function engineTag(doc) {
    if (!doc.ocrEngine) return '';
    if (doc.ocrFallback) return `<span class="tag warn" title="${esc(doc.ocrFallback)}">PP-OCRv5 실패 → Tesseract로 읽음</span>`;
    return `<span class="tag eng" title="글자 인식 엔진">${esc(Ingest.ENGINE_LABEL[doc.ocrEngine])}</span>`;
  }
  function statusHtml(doc) {
    if (doc.status === 'done') return aiTag(doc) + (doc.ai && !doc.aiError ? '' : doc.lowConfidence ? '<span class="tag warn">분류 확인 필요</span>' : '<span class="tag ok">인식 완료</span>') + engineTag(doc);
    if (doc.status === 'error') return `<span class="tag err">오류: ${esc(doc.error)}</span>`;
    return `<span class="tag run">${esc(doc.step || '대기')}${doc.pct ? ' ' + Math.round(doc.pct * 100) + '%' : ''}</span>`;
  }
  function renderDocCard(doc) {
    let el = docsBox.querySelector(`[data-id="${doc.id}"]`);
    if (!el) {
      el = document.createElement('article');
      el.className = 'doc';
      el.dataset.id = doc.id;
      docsBox.appendChild(el);
    }
    const ready = doc.status === 'done';
    const typeSel = Object.keys(TYPE_LABEL).map(k => `<option value="${k}"${doc.f.type === k ? ' selected' : ''}>${TYPE_LABEL[k]}</option>`).join('');
    const fields = ready ? (FIELDS_BY_TYPE[doc.f.type] || []).map(k => fieldHtml(k, doc.f[k], doc.f.type, doc.aiSrc && doc.aiSrc[k] && !doc.userTouched)).join('') : '';
    el.innerHTML = `
      <div class="thumb" data-act="view">${thumbHtml(doc)}</div>
      <div class="meta">
        <div class="name-row">
          <div class="name" title="${esc(doc.name)}">${esc(doc.name)}</div>
          <div class="card-acts">
            <button type="button" data-act="replace" title="다른 파일로 바꿔 다시 인식">교체</button>
            <button type="button" class="del" data-act="del" title="이 파일 삭제">삭제</button>
          </div>
        </div>
        <div class="status">${statusHtml(doc)}${doc.note ? `<span class="tag">${esc(doc.note)}</span>` : ''}</div>
        ${ready ? `<label class="type">종류<select data-k="type">${typeSel}</select></label>
        <div class="fields">${fields}</div>
        <details><summary>인식된 텍스트</summary><pre>${esc(doc.text || '(텍스트 없음)')}</pre></details>` : ''}
      </div>`;
  }
  const LABEL_BY_TYPE = { mileage: { date: '적립일' } };
  function fieldHtml(k, v, type, byAI) {
    const d = Object.assign({}, F[k], LABEL_BY_TYPE[type] && LABEL_BY_TYPE[type][k] ? { label: LABEL_BY_TYPE[type][k] } : {});
    v = v == null ? '' : v;
    const lab = byAI ? '<label class="from-ai" title="AI 판독값">' : '<label>';
    if (d.type === 'select')
      return `${lab}${d.label}<select data-k="${k}">${d.opts.map(([o, l]) => `<option value="${o}"${String(v) === o ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
    return `${lab}${d.label}<input data-k="${k}" type="${d.type}"${d.type === 'number' ? ' step="any"' : ''} value="${esc(v)}" placeholder="${esc(d.ph || '')}"></label>`;
  }
  function updateStatus(doc) {
    const s = docsBox.querySelector(`[data-id="${doc.id}"] .status`);
    if (s) s.innerHTML = statusHtml(doc);
  }
  const docById = id => state.docs.find(d => d.id === id);

  docsBox.addEventListener('input', e => {
    const k = e.target.dataset.k;
    const card = e.target.closest('.doc');
    if (!k || !card) return;
    const doc = docById(card.dataset.id);
    doc.f[k] = e.target.value;
    doc.userTouched = true;
    if (ai.plan) ai.stale = true;
    if (k === 'type') { doc.lowConfidence = false; renderDocCard(doc); }
    scheduleAnalyze();
  });
  docsBox.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const doc = docById(act.closest('.doc').dataset.id);
    if (act.dataset.act === 'del') {
      removeDoc(doc);
      $('#docs-sec').hidden = !state.docs.length;
      updateProgress();
      scheduleAnalyze(0);
      ocrStatus();
    } else if (act.dataset.act === 'replace') {
      replaceTarget = doc;
      replaceInput.click();
    } else if (act.dataset.act === 'view') openViewer(doc);
  });

  // ───────────────────────── 미리보기 ─────────────────────────
  const viewer = $('#viewer');
  function openViewer(doc) {
    const imgs = doc.pages && doc.pages.length ? doc.pages : doc.previewUrl ? [doc.previewUrl] : [];
    $('.body', viewer).innerHTML = imgs.length ? imgs.map(s => `<img src="${s}" alt="">`).join('')
      : `<pre>${esc(doc.text || '미리보기를 지원하지 않는 파일입니다.')}</pre>`;
    viewer.hidden = false;
  }
  viewer.addEventListener('click', e => { if (e.target === viewer || e.target.classList.contains('close')) viewer.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') viewer.hidden = true; });

  // ───────────────────────── 분석 · 결과 ─────────────────────────
  let timer = null;
  function scheduleAnalyze(ms = 250) { clearTimeout(timer); timer = setTimeout(runAnalyze, ms); }
  function runAnalyze() {
    const finished = state.docs.filter(d => d.status === 'done' || d.status === 'error');
    $('#result').hidden = !finished.length;
    if (!finished.length) return;
    state.result = analyze(trip(), finished, llmOn() ? ai.plan : null);
    renderResult(state.result);
  }

  const mileageInfo = m => [m.f.date ? `적립일 ${m.f.date.replace(/-/g, '.')}` : '적립일 미상', m.f.points || ''].filter(Boolean).join(' · ');
  function docLink(d) { return d ? `<a href="#" data-goto="${d.id}" title="${esc(d.name)}">${esc(d.name)}</a>` : ''; }

  function aiLineHtml(r) {
    if (!llmOn()) return '';
    const failed = state.docs.filter(d => d.aiError).length;
    const failTxt = failed ? ` · AI 판독 실패 ${failed}건은 규칙 인식값 사용` : '';
    if (ai.running) return `<p class="ai-line run">AI(${esc(llmS.model)})가 여정과 점검 결과를 정리하는 중입니다… 지금 보이는 것은 규칙으로 정리한 결과입니다.${failTxt}</p>`;
    if (ai.error) return `<p class="ai-line err">AI 여정 정리 실패: ${esc(ai.error)} — 규칙으로만 정리했습니다. [AI로 다시 정리]로 재시도하세요.${failTxt}</p>`;
    if (r.ai) return `<p class="ai-line">AI(${esc(r.ai.model)}) 판단을 우선해 여정과 점검 결과를 정리했고, 빈 곳은 규칙으로 보완했습니다.${r.ai.dirRejected ? ' (AI 구분이 날짜 순서와 맞지 않아 구분은 규칙으로 정리)' : ''}${ai.stale ? ' 서류가 바뀌었습니다 — [AI로 다시 정리]를 누르면 반영됩니다.' : ''}${failTxt}</p>`;
    return '';
  }
  function renderResult(r) {
    const pending = state.docs.filter(d => d.status === 'queued' || d.status === 'reading').length;
    const nE = r.issues.filter(i => i.level === 'error').length, nW = r.issues.filter(i => i.level === 'warn').length;
    $('#summary').innerHTML = `
      <div class="kpis">
        <div><b>${r.period.start ? `${r.period.start} ~ ${r.period.end}` : '미정'}</b><span>출장기간${r.period.days ? ` (${r.period.days > 1 ? r.period.days - 1 + '박 ' : ''}${r.period.days}일)` : ''}${r.period.src ? ' · ' + r.period.src : ''}</span></div>
        <div><b>${won(r.totals.transport)}</b><span>교통비 (영수증 기준)</span></div>
        <div><b>${won(r.totals.lodging)}</b><span>숙박비</span></div>
        ${r.car ? `<div><b>${r.car.km ? r.car.km.toLocaleString('ko-KR') + 'km' : '거리 미상'}</b><span>자차 이동거리</span></div>` : ''}
        <div class="${nE ? 'bad' : nW ? 'mid' : 'good'}"><b>${nE ? `보완 ${nE}건` : nW ? `확인 ${nW}건` : '이상 없음'}</b><span>점검 결과</span></div>
      </div>
      ${pending ? `<p class="hint">아직 ${pending}개 파일을 처리 중입니다. 완료되면 결과가 갱신됩니다.</p>` : ''}
      ${aiLineHtml(r)}`;

    const LV = { error: ['err', '보완 필요'], warn: ['warn', '확인 필요'], info: ['info', '참고'] };
    $('#issues').innerHTML = r.issues.length ? `<h3>보완·확인 사항</h3><ul class="issues">${r.issues.map(i =>
      `<li class="${LV[i.level][0]}${i.ai ? ' ai' : ''}"><span class="lv">${LV[i.level][1]}</span><span class="area">${esc(i.area)}</span><span class="msg">${esc(i.msg)}</span>${i.ids.length ? `<a href="#" data-goto="${i.ids[0]}">문서 보기</a>` : ''}</li>`).join('')}</ul>`
      : '<p class="allgood">빠진 서류나 불일치 항목이 없습니다.</p>';

    const chk = c => `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'na'}">${esc(c.t)}</li>`;
    const legCard = l => `
      <div class="leg">
        <div class="leg-h"><b>${esc(l.label)}${l.dirByAI ? '<span class="by-ai" title="AI가 구분">AI</span>' : ''}</b><span class="mode m-${l.mode}">${MODE_LABEL[l.mode] || '교통'}</span></div>
        <div class="leg-r">${esc(l.from || '?')} <i>→</i> ${esc(l.to || '?')}</div>
        <div class="leg-d">${esc(l.date || '날짜 미상')} ${esc(l.time || '')} ${esc(l.vehicleNo || '')}</div>
        <div class="pair">
          <div class="${l.receipts.length ? 'has' : 'miss'}">영수증 ${l.receipts.length ? l.receipts.map(docLink).join(', ') : '<em>없음</em>'}</div>
          <div class="${l.confirm ? 'has' : 'miss'}">확인서 ${l.confirm ? docLink(l.confirm) + (l.confirmDups.length ? ` (같은 편: ${l.confirmDups.map(docLink).join(', ')})` : '') : '<em>없음</em>'}</div>
          ${l.needsMileage ? `<div class="${l.mileage ? 'has' : 'miss'}">마일리지 ${l.mileage ? `${docLink(l.mileage)} · ${esc(mileageInfo(l.mileage))}` : '<em>없음</em>'}</div>` : ''}
        </div>
        <ul class="checks">${l.checks.map(chk).join('')}</ul>
      </div>`;
    const lodgingCard = (L, i) => `
      <div class="leg lodging">
        <div class="leg-h"><b>숙박${r.lodgings.length > 1 ? ' ' + (i + 1) : ''}</b><span class="mode m-lodging">${L.nights != null ? L.nights + '박' : '숙박'}</span></div>
        <div class="leg-r">${esc(L.name || '숙소명 미상')}</div>
        <div class="leg-d">${esc(L.checkin || '?')} ~ ${esc(L.checkout || '?')} · ${won(L.amount)}</div>
        <div class="pair">
          <div class="${L.receipt ? 'has' : 'miss'}">영수증 ${L.receipt ? docLink(L.receipt) : '<em>없음</em>'}</div>
          <div class="${L.confirm ? 'has' : 'miss'}">확인서 ${L.confirm ? docLink(L.confirm) : '<em>없음</em>'}</div>
        </div>
        <ul class="checks">${L.checks.map(chk).join('')}</ul>
      </div>`;
    const col = (title, inner) => `<div class="col"><h4>${title}</h4>${inner || '<p class="empty">없음</p>'}</div>`;
    const car = r.car;
    $('#journey').innerHTML = `
      <h3>여정 구성</h3>
      <div class="cols">
        ${col('출발', r.out.map(legCard).join(''))}
        ${col('경유', r.local.map(legCard).join(''))}
        ${col('숙박', r.lodgings.map(lodgingCard).join(''))}
        ${col('도착', r.back.map(legCard).join(''))}
      </div>
      ${car ? `<div class="car"><h4>자차 이용</h4>
        <p>거리 <b>${car.km ? car.km.toLocaleString('ko-KR') + 'km' : '?'}</b> · ${esc(car.fuelType || '유종')} 단가 <b>${car.price ? car.price.toLocaleString('ko-KR') + '원/L' : '?'}</b>${car.toll ? ` · 통행료 <b>${won(car.toll)}</b>` : ''}</p>
        <p class="files">거리 캡처: ${car.dist.map(docLink).join(', ') || '<em>없음</em>'} · 유가 캡처: ${car.fuel.map(docLink).join(', ') || '<em>없음</em>'}</p></div>` : ''}
      ${r.officials.length ? `<div class="car"><h4>공문·일정안내</h4>${r.officials.map(o => `<p>${docLink(o)} ${o.f.title ? '· ' + esc(o.f.title) : ''} ${o.f.periodStart ? `· ${esc(o.f.periodStart)} ~ ${esc(o.f.periodEnd || o.f.periodStart)}` : ''}</p>`).join('')}</div>` : ''}`;
  }

  $('#result').addEventListener('click', e => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    const card = docsBox.querySelector(`[data-id="${a.dataset.goto}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  });

  // ───────────────────────── 증빙서류 생성 (HWPX / PDF) ─────────────────────────
  async function makeEvidence(format, btn) {
    if (!state.result) return;
    if (state.docs.some(d => d.status === 'queued' || d.status === 'reading')) { alert('아직 처리 중인 파일이 있습니다. 완료 후 다시 눌러주세요.'); return; }
    const nE = state.result.issues.filter(i => i.level === 'error').length;
    if (nE && !confirm(`보완이 필요한 항목이 ${nE}건 있습니다. 그래도 증빙서류를 만들까요?`)) return;
    // PDF는 이 PC에 설치된 글꼴로 그림 → 지정 글꼴이 없으면 알림 (HWPX는 한글에서 열 때 글꼴이 적용됨)
    const miss = format === 'pdf' ? Evidence.missingFonts() : [];
    const SUBST = { 휴먼명조: '바탕', HY헤드라인M: '맑은 고딕' };
    if (miss.length && !confirm(`이 PC에 ${miss.join(', ')} 글꼴이 없어 PDF에는 비슷한 글꼴(${miss.map(f => `${f}→${SUBST[f]}`).join(', ')})이 쓰입니다.\n그대로 만들까요? (HWPX는 한글에서 열면 지정 글꼴로 나옵니다)`)) return;
    const label = btn.textContent;
    document.querySelectorAll('.actions button').forEach(b => { b.disabled = true; });
    try {
      btn.textContent = '만드는 중…';
      const blob = await Evidence.generate(format, state.result, trip(), name => { btn.textContent = `캡처 중: ${name}`; });
      const p = state.result.period;
      download(blob, `출장증빙서류${p.start ? '_' + p.start.replace(/-/g, '') : ''}.${format}`);
    } catch (e) {
      console.error(e);
      alert('증빙서류를 만들지 못했습니다: ' + (e.message || e));
    } finally {
      btn.textContent = label;
      document.querySelectorAll('.actions button').forEach(b => { b.disabled = false; });
    }
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  $('#btn-hwpx').addEventListener('click', e => makeEvidence('hwpx', e.currentTarget));
  $('#btn-pdf').addEventListener('click', e => makeEvidence('pdf', e.currentTarget));

  // ───────────────────────── ZIP ─────────────────────────
  $('#btn-zip').addEventListener('click', async () => {
    if (!state.result) return;
    const zip = new JSZip();
    const order = evidenceOrder(state.result);
    const csv = [['순번', '구분', '서류', '파일명(원본)', '저장 파일명', '일자', '금액']];
    const clean = s => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_');
    order.forEach((o, i) => {
      const d = o.doc;
      const date = (d.f.date || d.f.checkin || '').replace(/-/g, '');
      const fname = `${String(i + 1).padStart(2, '0')}_${clean(o.section)}_${clean(o.role)}${date ? '_' + date : ''}.${d.ext}`;
      zip.file(fname, d.file);
      csv.push([i + 1, o.section, o.role, d.name, fname, d.f.date || d.f.checkin || '', d.f.amount || '']);
    });
    zip.file('증빙목록.csv', '﻿' + csv.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n'));
    const blob = await zip.generateAsync({ type: 'blob' });
    download(blob, `출장증빙파일_${(state.result.period.start || '').replace(/-/g, '')}.zip`);
  });

  $('#btn-ai').addEventListener('click', async e => {
    if (busy) { alert('아직 처리 중인 파일이 있습니다. 완료 후 다시 눌러주세요.'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      for (const d of state.docs.filter(d => d.status === 'done' && (!d.ai || d.aiError) && !d.userTouched)) {
        await aiReadDoc(d);
        if (state.docs.includes(d)) renderDocCard(d);
      }
      await runPlan();
    } finally { btn.disabled = false; }
  });
  fillLlmForm();
  if (llmS.enabled) { $('#llm-box').open = !llmS.model; refreshModels(true); }

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('등록한 서류를 모두 지울까요?')) return;
    state.docs.forEach(d => d.previewUrl && URL.revokeObjectURL(d.previewUrl));
    state.docs = []; queue.length = 0; state.result = null;
    ai.plan = null; ai.error = ''; ai.stale = false; ai.seq++; ai.running = false;
    docsBox.innerHTML = '';
    $('#docs-sec').hidden = true; $('#result').hidden = true; $('#dup-note').hidden = true;
    updateProgress();
    ocrStatus();
  });
})();
