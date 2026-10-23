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

  // ───────────────────────── 파일 등록 ─────────────────────────
  const drop = $('#drop'), fileInput = $('#file');
  // file:// 로 열면 OCR 워커를 불러올 수 없음 → start.bat(로컬 서버)로 열도록 안내
  if (location.protocol === 'file:') $('#file-warn').hidden = false;
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));

  // 내용이 같은 파일(이름이 달라도)은 다시 읽지 않고 건너뜀. 앞서 읽기 실패한 파일이면 새 것으로 교체
  async function addFiles(files) {
    const list = [...files];
    const skipped = [];
    for (const file of list) {
      let hash = '';
      try { hash = Ingest.hashOf(await file.arrayBuffer()); } catch (e) { /* 읽기 오류는 처리 단계에서 표시 */ }
      const prev = hash && state.docs.find(d => d.hash === hash);
      if (prev && prev.status !== 'error') { skipped.push(file.name === prev.name ? file.name : `${file.name}(=${prev.name})`); continue; }
      if (prev) removeDoc(prev);
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const doc = { id: 'd' + (++state.seq), file, name: file.name, ext, hash, status: 'queued', step: '대기', f: { type: 'other', dir: 'auto' } };
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
    const card = docsBox.querySelector(`[data-id="${doc.id}"]`);
    if (card) card.remove();
    if (doc.previewUrl) URL.revokeObjectURL(doc.previewUrl);
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
        doc.status = 'done';
      } catch (e) {
        console.error(e);
        doc.status = 'error';
        doc.error = e.message || String(e);
      }
      renderDocCard(doc);
      updateProgress();
      scheduleAnalyze(50);
    }
    busy = false;
    updateProgress();
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
  function statusHtml(doc) {
    if (doc.status === 'done') return doc.lowConfidence ? '<span class="tag warn">분류 확인 필요</span>' : '<span class="tag ok">인식 완료</span>';
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
    const fields = ready ? (FIELDS_BY_TYPE[doc.f.type] || []).map(k => fieldHtml(k, doc.f[k], doc.f.type)).join('') : '';
    el.innerHTML = `
      <div class="thumb" data-act="view">${thumbHtml(doc)}</div>
      <div class="meta">
        <div class="name" title="${esc(doc.name)}">${esc(doc.name)}</div>
        <div class="status">${statusHtml(doc)}${doc.note ? `<span class="tag">${esc(doc.note)}</span>` : ''}</div>
        ${ready ? `<label class="type">종류<select data-k="type">${typeSel}</select></label>
        <div class="fields">${fields}</div>
        <details><summary>인식된 텍스트</summary><pre>${esc(doc.text || '(텍스트 없음)')}</pre></details>` : ''}
      </div>
      <button type="button" class="del" data-act="del" title="삭제">×</button>`;
  }
  const LABEL_BY_TYPE = { mileage: { date: '적립일' } };
  function fieldHtml(k, v, type) {
    const d = Object.assign({}, F[k], LABEL_BY_TYPE[type] && LABEL_BY_TYPE[type][k] ? { label: LABEL_BY_TYPE[type][k] } : {});
    v = v == null ? '' : v;
    if (d.type === 'select')
      return `<label>${d.label}<select data-k="${k}">${d.opts.map(([o, l]) => `<option value="${o}"${String(v) === o ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
    return `<label>${d.label}<input data-k="${k}" type="${d.type}"${d.type === 'number' ? ' step="any"' : ''} value="${esc(v)}" placeholder="${esc(d.ph || '')}"></label>`;
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
    state.result = analyze(trip(), finished);
    renderResult(state.result);
  }

  const mileageInfo = m => [m.f.date ? `적립일 ${m.f.date.replace(/-/g, '.')}` : '적립일 미상', m.f.points || ''].filter(Boolean).join(' · ');
  function docLink(d) { return d ? `<a href="#" data-goto="${d.id}" title="${esc(d.name)}">${esc(d.name)}</a>` : ''; }

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
      ${pending ? `<p class="hint">아직 ${pending}개 파일을 처리 중입니다. 완료되면 결과가 갱신됩니다.</p>` : ''}`;

    const LV = { error: ['err', '보완 필요'], warn: ['warn', '확인 필요'], info: ['info', '참고'] };
    $('#issues').innerHTML = r.issues.length ? `<h3>보완·확인 사항</h3><ul class="issues">${r.issues.map(i =>
      `<li class="${LV[i.level][0]}"><span class="lv">${LV[i.level][1]}</span><span class="area">${esc(i.area)}</span><span class="msg">${esc(i.msg)}</span>${i.ids.length ? `<a href="#" data-goto="${i.ids[0]}">문서 보기</a>` : ''}</li>`).join('')}</ul>`
      : '<p class="allgood">빠진 서류나 불일치 항목이 없습니다.</p>';

    const chk = c => `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'na'}">${esc(c.t)}</li>`;
    const legCard = l => `
      <div class="leg">
        <div class="leg-h"><b>${esc(l.label)}</b><span class="mode m-${l.mode}">${MODE_LABEL[l.mode] || '교통'}</span></div>
        <div class="leg-r">${esc(l.from || '?')} <i>→</i> ${esc(l.to || '?')}</div>
        <div class="leg-d">${esc(l.date || '날짜 미상')} ${esc(l.time || '')} ${esc(l.vehicleNo || '')}</div>
        <div class="pair">
          <div class="${l.receipts.length ? 'has' : 'miss'}">영수증 ${l.receipts.length ? l.receipts.map(docLink).join(', ') : '<em>없음</em>'}</div>
          <div class="${l.confirm ? 'has' : 'miss'}">확인서 ${l.confirm ? docLink(l.confirm) : '<em>없음</em>'}</div>
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

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('등록한 서류를 모두 지울까요?')) return;
    state.docs.forEach(d => d.previewUrl && URL.revokeObjectURL(d.previewUrl));
    state.docs = []; queue.length = 0; state.result = null;
    docsBox.innerHTML = '';
    $('#docs-sec').hidden = true; $('#result').hidden = true; $('#dup-note').hidden = true;
    updateProgress();
  });
})();
