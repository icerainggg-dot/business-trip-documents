/*
 * 로컬 LLM 연결 (Ollama · vLLM 등 OpenAI 호환 서버)
 *  - 연결 설정은 화면에서 그때그때 바꿀 수 있음 (서버 종류·주소·모델·API 키·이미지 전송 등)
 *  - 1) 서류별 판독 extractDoc: 이미지(비전 모델) + OCR 텍스트 → 종류·실제 출발일·구간·편명·금액 …
 *  - 2) 여정 정리 planTrip: 서류별 판독 결과 전체 → 출발/경유/도착 구분, 영수증↔확인서 짝, 점검 의견
 * 브라우저(window.LLM)와 Node(module.exports) 양쪽에서 사용
 */
(function (global) {
  'use strict';
  const X = (typeof module !== 'undefined' && module.exports) ? require('./extract.js') : global.Extract;

  const PROVIDERS = {
    ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434' },
    openai: { label: 'vLLM · OpenAI 호환 (LM Studio, llama.cpp server 등)', baseUrl: 'http://localhost:8000/v1' },
  };
  const DEFAULTS = {
    enabled: false,
    provider: 'ollama',
    baseUrl: '',          // 비우면 서버 종류별 기본 주소
    model: '',
    apiKey: '',           // vLLM --api-key 등. Ollama는 비워 둠
    vision: 'auto',       // auto: 모델이 이미지를 받으면 보냄 | on | off
    temperature: 0,
    numCtx: 8192,         // Ollama 컨텍스트 길이
    timeoutSec: 300,
    think: false,         // 생각(thinking) 모드: 느리지만 판단이 더 정확할 수 있음 (지원 모델만)
    maxImageSide: 1280,   // 이미지 긴 변 (토큰·속도 절약)
    maxTextChars: 3500,   // 서류 1건당 보낼 OCR 텍스트 길이
  };
  const settingsOf = s => Object.assign({}, DEFAULTS, s || {});
  const baseOf = s => String(s.baseUrl || PROVIDERS[s.provider].baseUrl).replace(/\/+$/, '');

  // ───────────────────────── HTTP ─────────────────────────
  async function http(s, path, body, method) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), (s.timeoutSec || 300) * 1000);
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = 'Bearer ' + s.apiKey;
    let res;
    try {
      res = await fetch(baseOf(s) + path, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`응답 시간 초과(${s.timeoutSec}초)`);
      throw new Error(`서버에 연결할 수 없습니다 (${baseOf(s)}). 서버 실행 여부와 주소, CORS 허용 설정을 확인하세요`);
    } finally { clearTimeout(t); }
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    try { return JSON.parse(txt); } catch (e) { throw new Error('서버 응답이 JSON이 아닙니다: ' + txt.slice(0, 200)); }
  }

  async function listModels(s) {
    s = settingsOf(s);
    if (s.provider === 'ollama') return ((await http(s, '/api/tags')).models || []).map(m => m.name);
    return ((await http(s, '/models')).data || []).map(m => m.id);
  }

  // 이미지 입력 가능 여부
  //  1) Ollama /api/show의 capabilities(그 밖에는 모델 이름)로 1차 판단
  //  2) 실제로 보이는지 자가 점검: 빨간 사각형 그림을 보여주고 색을 묻는다.
  //     (모델 정보에 vision이 있어도 GGUF에 비전 모듈이 빠져 있으면 그림을 못 보고 내용을 지어냄)
  const VISION_NAME = /(vl|vision|gemma-?3|gemma-?4|gemma3n|llava|pixtral|minicpm-?v|internvl|qwen.*omni|phi-?3\.5-?v|phi-?4-?multimodal|llama-?3\.2-?\d+b-?vision|mistral-small-3)/i;
  const PROBE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAApUlEQVR42u3dQREAIAgAQXWsYAL7RzIBITCBAdS9L78deFMzs+hcQwAIECBAgAC9Wj8N1hi/WcwIG+TEAAECBAgQIAECBAgQIECAAAESIECAAAECBAiQAAECBAgQIECABAgQIECAAAECBAgBIECAAAECBAiQAAECBAgQIECABAgQIECAAAECJECAAAECBAgQIEACBAgQIEC3VT0esUGAAAECBOjVNj4oCbtGj0ybAAAAAElFTkSuQmCC';
  const capCache = {};
  async function modelInfo(s) {
    s = settingsOf(s);
    const key = s.provider + '|' + baseOf(s) + '|' + s.model;
    if (capCache[key]) return capCache[key];
    let info = { vision: VISION_NAME.test(s.model), thinking: false, visionClaimed: false, visionChecked: false };
    if (s.provider === 'ollama') {
      try {
        const r = await http(s, '/api/show', { model: s.model });
        const caps = r.capabilities || [];
        info = { vision: caps.includes('vision'), thinking: caps.includes('thinking') };
      } catch (e) { /* 구버전 Ollama: 이름으로 추정 */ }
    }
    info.visionClaimed = info.vision;
    capCache[key] = info; // 아래 점검 요청이 다시 modelInfo를 부를 때 쓰도록 먼저 저장
    if (info.vision) {
      try {
        const r = await chatJSON(s, {
          system: 'JSON으로만 답한다.', user: '첨부한 그림 가운데 사각형의 색은? 그림이 보이지 않으면 none.', images: [PROBE_PNG],
          schema: { type: 'object', properties: { color: { type: 'string', enum: ['red', 'green', 'blue', 'black', 'white', 'none'] } }, required: ['color'] },
        });
        info.vision = String(r.color).toLowerCase() === 'red';
        info.visionChecked = true;
      } catch (e) { info.vision = false; info.visionChecked = true; }
    }
    return info;
  }
  async function useVision(s) {
    if (s.vision === 'on') return true;
    if (s.vision === 'off') return false;
    return (await modelInfo(s)).vision;
  }

  async function testConnection(s) {
    s = settingsOf(s);
    const models = await listModels(s);
    if (!s.model) return { ok: false, models, msg: `연결됨 · 모델 ${models.length}개. 사용할 모델을 고르세요.` };
    if (models.length && !models.includes(s.model)) return { ok: false, models, msg: `서버에 '${s.model}' 모델이 없습니다.` };
    const t0 = Date.now();
    const r = await chatJSON(s, { system: '반드시 JSON으로만 답한다.', user: '{"ok": true} 를 그대로 출력하라.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const info = await modelInfo(s);
    const vision = await useVision(s);
    const vTxt = s.vision === 'off' ? '보내지 않음(설정)'
      : s.vision === 'on' ? `항상 보냄(설정)${info.visionChecked && !info.vision ? ' — 주의: 자가 점검에서 이 모델은 그림을 읽지 못했습니다' : ''}`
      : info.vision ? '실제로 읽음 → 함께 보냄'
      : info.visionClaimed ? '모델 정보엔 있으나 자가 점검에서 그림을 읽지 못함 → 글자만 보냄'
      : '지원 안 함 → 글자만 보냄';
    return { ok: !!r, models, vision, msg: `연결 성공 · ${s.model} · 응답 ${sec}초 · 이미지: ${vTxt}` };
  }

  // ───────────────────────── 채팅 (JSON 응답) ─────────────────────────
  const b64 = dataUrl => String(dataUrl).replace(/^data:[^,]*,/, '');
  function parseJSON(txt) {
    let t = String(txt || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (e) { /* 앞뒤 군말 제거 후 재시도 */ }
    const a = t.indexOf('{'), z = t.lastIndexOf('}');
    if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (e) { /* 아래에서 오류 */ } }
    throw new Error('LLM 응답을 JSON으로 읽지 못했습니다: ' + t.slice(0, 200));
  }
  async function chatJSON(s, { system, user, images, schema }) {
    s = settingsOf(s);
    if (!s.model) throw new Error('LLM 모델을 선택하세요');
    images = images || [];
    if (s.provider === 'ollama') {
      const info = await modelInfo(s);
      const body = {
        model: s.model, stream: false, keep_alive: '15m',
        messages: [{ role: 'system', content: system }, Object.assign({ role: 'user', content: user }, images.length ? { images: images.map(b64) } : {})],
        format: schema || 'json',
        options: { temperature: s.temperature, num_ctx: s.numCtx },
      };
      if (info.thinking) body.think = !!s.think; // 생각 모드를 끄면 바로 JSON만 출력
      const r = await http(s, '/api/chat', body);
      return parseJSON(r.message && r.message.content);
    }
    const content = images.length
      ? [{ type: 'text', text: user }, ...images.map(u => ({ type: 'image_url', image_url: { url: /^data:/.test(u) ? u : 'data:image/jpeg;base64,' + u } }))]
      : user;
    const body = {
      model: s.model, temperature: s.temperature, max_tokens: s.think ? 8192 : 2048,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      response_format: schema ? { type: 'json_schema', json_schema: { name: 'result', schema } } : { type: 'json_object' },
    };
    // 생각 모드 끄기: vLLM(Qwen3 등 chat template) · Ollama /v1(reasoning_effort)
    if (!s.think) { body.chat_template_kwargs = { enable_thinking: false }; body.reasoning_effort = 'none'; }
    // 서버가 모르는 옵션으로 거절(4xx)하면 하나씩 빼고 재시도: 생각 옵션 → json_schema(→ 일반 JSON 모드)
    const fallbacks = [
      b => { if (!('chat_template_kwargs' in b) && !('reasoning_effort' in b)) return false; delete b.chat_template_kwargs; delete b.reasoning_effort; return true; },
      b => { if (!schema || b.response_format.type !== 'json_schema') return false; b.response_format = { type: 'json_object' }; return true; },
    ];
    let r, fi = 0;
    for (;;) {
      try { r = await http(s, '/chat/completions', body); break; } catch (e) {
        if (!/HTTP 4\d\d/.test(e.message)) throw e;
        let applied = false;
        while (fi < fallbacks.length && !applied) applied = fallbacks[fi++](body);
        if (!applied) throw e;
      }
    }
    const msg = r.choices && r.choices[0] && r.choices[0].message;
    return parseJSON(msg && msg.content);
  }

  // ───────────────────────── 값 정리 ─────────────────────────
  const p2 = n => String(n).padStart(2, '0');
  function normDate(v) {
    const m = /(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/.exec(String(v || ''));
    if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return '';
    return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
  }
  function normTime(v) {
    const m = /([01]?\d|2[0-3])\s*:\s*([0-5]\d)/.exec(String(v || ''));
    return m ? `${p2(m[1])}:${m[2]}` : '';
  }
  function normPlace(v) {
    const t = String(v || '').trim();
    if (!t) return '';
    const codes = t.toUpperCase().match(/\b[A-Z]{3}\b/g) || [];
    for (const c of codes) { const p = X && X.placeOfToken(c); if (p) return p; }
    const p = X && (X.matchPlace(t) || X.placeOfToken(t));
    return p || t.replace(/\s*\(.*?\)\s*/g, '').trim();
  }
  const normNo = v => String(v || '').toUpperCase().replace(/\s+/g, '');
  const normAmount = v => { const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n) : ''; };
  const strList = v => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map(x => String(x).trim()).filter(Boolean);

  // ───────────────────────── 1) 서류별 판독 ─────────────────────────
  const DOC_TYPES = ['transport_receipt', 'transport_confirm', 'mileage', 'lodging_receipt', 'lodging_confirm', 'car_distance', 'car_fuel', 'official', 'other'];
  const S = { type: 'string' };
  const DOC_SCHEMA = {
    type: 'object',
    properties: {
      docType: { type: 'string', enum: DOC_TYPES },
      mode: { type: 'string', enum: ['air', 'rail', 'bus', 'etc', ''] },
      travelDate: S, depTime: S, from: S, to: S, vehicleNo: S, airline: S,
      amount: { type: 'number' }, payDate: S,
      reservationNos: { type: 'array', items: S },
      flights: { type: 'array', items: S },
      checkin: S, checkout: S, lodgingName: S, item: S,
      passenger: S, note: S,
    },
    required: ['docType', 'mode', 'travelDate', 'depTime', 'from', 'to', 'vehicleNo', 'airline', 'amount', 'payDate',
      'reservationNos', 'flights', 'checkin', 'checkout', 'lodgingName', 'item', 'passenger', 'note'],
  };
  const DOC_SYSTEM = `너는 출장비 증빙서류를 판독하는 도우미다. 서류 1건(이미지 그리고/또는 OCR 텍스트)을 보고 JSON으로만 답한다.
서류에 없는 값은 빈 문자열("") 또는 0으로 두고, 절대 지어내지 않는다. OCR 텍스트는 오인식이 많으니 이미지가 있으면 이미지를 우선한다.

docType (하나만):
- transport_receipt: 항공·철도·버스 요금 결제 영수증, 지불영수증, 카드 매출전표
- transport_confirm: 탑승권, 승차권, 탑승확인서, e-티켓, 항공권 구매내역 상세처럼 실제 편명·탑승일시가 나온 서류(사용완료·탑승완료 표시 포함)
- mileage: 항공 마일리지·포인트 적립 내역 화면
- lodging_receipt: 숙박비 결제 영수증·카드 매출전표 (판매처가 숙박 예약 플랫폼이어도 상품이 숙소면 여기)
- lodging_confirm: 숙박 예약확인서, 숙박 이용내역, 투숙 확인서
- car_distance: 지도 앱 경로·거리 캡처 / car_fuel: 유가(오피넷 등) 캡처 / official: 공문·교육 일정 안내 / other: 그 밖
mode: air(항공) rail(철도) bus(버스) etc(그 밖 교통) — 교통 서류가 아니면 ""

중요 규칙:
- travelDate = 실제로 탑승·승차·출발하는 날짜(YYYY-MM-DD). 구매일자·결제일자·예약일자·발권일·거래일·운임 유효기간·조회기간은 travelDate가 아니다. 서류에 탑승일이 없으면 "".
- depTime = 그 편의 출발 시각(HH:MM). '탑승시간/출발시간'처럼 둘 다 있으면 출발시간. 결제 시각은 아니다.
- from/to = 출발지/도착지를 한글 도시·공항 이름으로 (GMP→김포, CJU→제주, KWJ→광주, PUS→김해, ICN→인천, '서울/김포'→김포). 'A - B', 'A → B', '출발(From) A / 도착(To) B'는 A가 출발지.
- vehicleNo = 편명·열차번호 (예: KE1234, 7C101, KTX 101). airline = 항공사 한글 이름.
- amount = 실제 결제한 총액(원, 숫자만). '총 결제금액'·'합계'·'승인금액'·'결제금액' 우선. 영수증이 아니라도 금액이 분명히 적혀 있으면 적는다.
- payDate = 결제·구매·예약일(YYYY-MM-DD).
- reservationNos = 예약번호·항공권번호·주문번호·숙소 예약번호 (카드 승인번호·사업자등록번호·전화번호 제외).
- flights = (마일리지 서류) 적립 내역에 나온 편명들. 마일리지 서류의 travelDate는 적립 내역에 적힌 탑승(적립) 일자.
- checkin/checkout = 숙박 체크인·체크아웃 날짜, lodgingName = 숙소 이름.
- item = 결제한 상품명 또는 가맹점(예: 카드전표의 '상품명 ○○호텔 강남점').
- passenger = 승객·이용자 이름. note = 판단 근거 한 줄(한국어).`;

  // 이미지를 함께 보낼 때는 규칙 기반 1차 인식값을 주지 않는다 (작은 모델이 틀린 1차값을 그대로 따라 하는 문제)
  function docUserPrompt(doc, ruleGuess, maxChars) {
    const text = String(doc.text || '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return `파일명: ${doc.name}
${ruleGuess ? `규칙 기반 1차 인식(틀릴 수 있음): ${JSON.stringify(ruleGuess)}\n` : '서류 이미지를 첨부했다. 값은 이미지에서 읽고, 아래 OCR 텍스트는 참고만 한다.\n'}OCR 텍스트(오인식 많음):
"""
${text.slice(0, maxChars) || '(없음)'}
"""`;
  }
  const guessOf = f => {
    const g = {};
    ['type', 'mode', 'date', 'time', 'from', 'to', 'vehicleNo', 'airline', 'amount', 'refs', 'checkin', 'checkout', 'lodgingName', 'flights']
      .forEach(k => { if (f && f[k] !== '' && f[k] != null) g[k] = f[k]; });
    return g;
  };

  // images: 데이터 URL 배열 (브라우저에서 축소해 넘김). 반환: 앱의 문서 필드(f) 형식
  async function extractDoc(s, doc, images) {
    s = settingsOf(s);
    const vision = images && images.length && await useVision(s);
    const r = await chatJSON(s, {
      system: DOC_SYSTEM,
      user: docUserPrompt(doc, vision ? null : guessOf(doc.f), s.maxTextChars),
      images: vision ? images : [],
      schema: DOC_SCHEMA,
    });
    const type = DOC_TYPES.includes(r.docType) ? r.docType : '';
    const isTr = /^transport_/.test(type), isLod = /^lodging_/.test(type);
    const f = {
      type,
      mode: isTr ? (['air', 'rail', 'bus', 'etc'].includes(r.mode) ? r.mode : '') : '',
      date: type === 'mileage' || isTr ? normDate(r.travelDate) : '',
      time: isTr ? normTime(r.depTime) : '',
      from: isTr || type === 'car_distance' ? normPlace(r.from) : '',
      to: isTr || type === 'car_distance' ? normPlace(r.to) : '',
      vehicleNo: isTr ? normNo(r.vehicleNo) : '',
      airline: String(r.airline || '').trim(),
      amount: normAmount(r.amount),
      refs: strList(r.reservationNos).map(normNo).filter(v => v.length >= 5).join(', '),
      flights: strList(r.flights).map(normNo).join(', '),
      checkin: isLod ? normDate(r.checkin) : '',
      checkout: isLod ? normDate(r.checkout) : '',
      lodgingName: isLod ? String(r.lodgingName || '').trim() : '',
    };
    // 교통수단이 비었는데 편명이 항공 편명이면 항공
    if (isTr && !f.mode && X && X.findFlights(f.vehicleNo).length) f.mode = 'air';
    return { f, item: String(r.item || '').trim(), payDate: normDate(r.payDate), passenger: String(r.passenger || '').trim(), note: String(r.note || '').trim(), vision: !!vision };
  }

  /*
   * LLM 판독값(우선) + 규칙 인식값(보조) 합치기. 작은 로컬 모델이 흔히 내는 실수는 일반 규칙으로 걸러낸다
   *  rule: 규칙 기반 필드(f) / ai: extractDoc 결과 / auto: Extract.analyzeText 결과
   *  반환: { f: 합친 필드, src: { 필드: 'ai' } }
   */
  const RAIL_BUS_NO = /^(KTX(-?산천|-?이음)?|SRT|ITX(-?새마을|-?청춘|-?마음)?|새마을호?|무궁화호?|누리로)?[\s-]?\d{1,5}$/i;
  const isVehicleNo = v => !!v && v.length <= 16 && ((X && X.findFlights(v)[0] === v.replace(/\s/g, '')) || (RAIL_BUS_NO.test(v) && !/^\d{6,}$/.test(v)));
  function mergeDoc(rule, ai, auto) {
    rule = rule || {};
    const a = (ai && ai.f) || {}, out = Object.assign({}, rule), src = {};
    const set = (k, v) => { if (v !== '' && v != null && String(v) !== String(rule[k] == null ? '' : rule[k])) { out[k] = v; src[k] = 'ai'; } else if (v !== '' && v != null) out[k] = v; };

    // 종류: 교통이라면서 수단·구간·편명이 하나도 없거나 '그 밖'이면 규칙 분류를 따른다
    let type = a.type || rule.type || 'other';
    const trEvidence = a.mode || a.from || a.to || isVehicleNo(a.vehicleNo);
    if (/^transport_/.test(type) && !trEvidence && rule.type && rule.type !== 'other' && rule.type !== type) type = rule.type;
    if (type === 'other' && rule.type && rule.type !== 'other') type = rule.type;
    set('type', type);

    // 영수증의 '탑승일'이 결제·구매일과 같으면 구매일을 잘못 읽은 것으로 본다 → 날짜는 짝지은 탑승확인서 기준
    const payDates = [ai && ai.payDate, auto && auto.payDate].filter(Boolean);
    let date = a.date;
    if (date && type === 'transport_receipt' && payDates.includes(date) && !(auto && auto.date === date)) date = '';
    // 날짜 교차 확인: AI가 읽은 날짜가 OCR 글자 어디에도 없는데 규칙이 OCR에서 찾은 날짜와 다르면 OCR 쪽을 쓴다
    // (비전 모델이 '2026.11.11'을 '2026-11-01'로 읽는 등)
    const seen = (auto && auto.allDates) || [];
    const corroborate = (v, ruleV) => (v && ruleV && v !== ruleV && !seen.includes(v) && seen.includes(ruleV)) ? ruleV : v;
    set('date', corroborate(date, rule.date));
    set('checkin', corroborate(a.checkin, rule.checkin));
    set('checkout', corroborate(a.checkout, rule.checkout));
    ['mode', 'time', 'from', 'to', 'airline', 'amount', 'lodgingName'].forEach(k => set(k, a[k]));
    set('vehicleNo', isVehicleNo(a.vehicleNo) ? a.vehicleNo : '');
    const fl = String(a.flights || '').split(/[,\s]+/).filter(v => X && X.findFlights(v).length);
    if (fl.length) set('flights', [...new Set(fl.concat(String(rule.flights || '').split(/[,\s]+/).filter(Boolean)))].join(', '));
    // 예약번호는 합집합 (서로 다른 번호 체계를 모두 짝짓기 근거로 쓰도록)
    const refs = [...new Set(String(a.refs || '').split(/[,\s]+/).concat(String(rule.refs || '').split(/[,\s]+/)).filter(Boolean))];
    if (refs.length) set('refs', refs.join(', '));
    // 규칙 값 중 LLM이 다른 종류로 본 서류에는 맞지 않는 칸은 비운다
    if (!/^transport_/.test(type)) { ['mode', 'time', 'vehicleNo'].forEach(k => { out[k] = ''; }); if (type !== 'car_distance') { out.from = ''; out.to = ''; } }
    if (!/^lodging_/.test(type)) { out.checkin = ''; out.checkout = ''; }
    return { f: out, src };
  }

  // ───────────────────────── 2) 여정 정리 ─────────────────────────
  const PLAN_SCHEMA = {
    type: 'object',
    properties: {
      legs: {
        type: 'array', items: {
          type: 'object',
          properties: {
            dir: { type: 'string', enum: ['out', 'local', 'back'] },
            confirmId: S, receiptIds: { type: 'array', items: S }, mileageId: S,
            date: S, from: S, to: S, reason: S,
          },
          required: ['dir', 'confirmId', 'receiptIds', 'mileageId', 'date', 'from', 'to', 'reason'],
        },
      },
      lodgings: {
        type: 'array', items: {
          type: 'object', properties: { receiptId: S, confirmId: S }, required: ['receiptId', 'confirmId'],
        },
      },
      period: { type: 'object', properties: { start: S, end: S }, required: ['start', 'end'] },
      issues: {
        type: 'array', items: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['error', 'warn', 'info'] }, msg: S, docIds: { type: 'array', items: S } },
          required: ['level', 'msg', 'docIds'],
        },
      },
    },
    required: ['legs', 'lodgings', 'period', 'issues'],
  };
  const PLAN_SYSTEM = `너는 공무원 출장 여비 증빙을 점검하는 담당자다. 서류별 판독 결과 목록을 보고 출장 여정을 정리해 JSON으로만 답한다.

여정 정리 규칙:
- 교통 구간(leg) 하나 = 실제로 탄 편 하나. 탑승확인서(transport_confirm)가 있으면 confirmId에 넣고, 같은 편의 영수증(transport_receipt)을 receiptIds에 넣는다. 확인서 없이 영수증만 있는 편도 leg로 만든다(confirmId는 "").
- 영수증↔확인서 짝은 예약번호·항공권번호 일치, 같은 항공사·구간, 금액을 근거로 한다. 영수증의 날짜는 구매일일 수 있으니 짝짓기에 쓰지 않는다.
- 선후관계는 반드시 실제 탑승일(travelDate)과 출발시각으로 정한다. 구매일·결제일·예약일로 정하지 않는다.
- dir: 출장지로 가는 첫 이동(같은 날 이어 탄 환승 포함)은 out(출발), 근무지로 돌아오는 마지막 이동(같은 날 이어 탄 환승 포함)은 back(도착), 그 사이 출장지 간 이동은 local(경유).
  근무지는 보통 첫 구간의 출발지이자 마지막 구간의 도착지다.
- 마일리지 서류(mileage)가 그 편의 적립 내역이면 mileageId에 넣는다(편명 또는 항공사·탑승일로 판단).
- 숙박 영수증과 숙박 확인서는 숙소 이름·예약번호·금액·날짜로 짝지어 lodgings에 넣는다(없는 쪽은 "").
- period: 출장 시작일=첫 교통편 탑승일(또는 첫 체크인), 종료일=마지막 교통편 탑승일(또는 마지막 체크아웃).
- issues: 실제로 확인된 문제만 짧게(한 문장) 적는다. 문제가 없으면 빈 배열. 추측·일반론·정상인 항목은 적지 않는다.
  확인할 것: 구간이 이어지지 않음(예: '김포 도착(10.02) 후 광주 출발(10.04) 사이 이동 증빙 없음'), 영수증 또는 탑승확인서 없음, 금액·예약번호 불일치, 숙박 기간과 교통 일정이 안 맞음, 탑승일이 출장 기간 밖.
  msg에는 내부 id(d1 등)를 쓰지 말고 편명·구간·날짜·숙소명으로 적는다. 관련 서류 id는 docIds에만 넣는다.
  level: error(빠진 서류) / warn(확인 필요) / info(참고).
- id는 목록에 있는 것만 쓴다. 서류 하나를 여러 leg에 넣지 않는다(왕복 영수증 1장은 예외로 두 leg에 넣을 수 있음).`;

  function planUserPrompt(trip, docs) {
    const rows = docs.map(d => {
      const f = d.f || {};
      const o = { id: d.id, file: d.name, type: f.type };
      ['mode', 'date', 'time', 'from', 'to', 'vehicleNo', 'airline', 'amount', 'refs', 'flights', 'checkin', 'checkout', 'lodgingName', 'periodStart', 'periodEnd', 'title']
        .forEach(k => { if (f[k] !== '' && f[k] != null) o[k === 'date' ? 'travelDate' : k === 'time' ? 'depTime' : k] = f[k]; });
      if (d.ai && d.ai.payDate) o.payDate = d.ai.payDate;
      else if (d.auto && d.auto.payDate) o.payDate = d.auto.payDate;
      if (d.ai && d.ai.passenger) o.passenger = d.ai.passenger;
      if (d.ai && d.ai.item) o.item = d.ai.item;
      return o;
    }).sort((a, b) => String(a.travelDate || a.checkin || '9').localeCompare(String(b.travelDate || b.checkin || '9')) || String(a.depTime || '').localeCompare(String(b.depTime || '')));
    const t = trip || {};
    const extra = [t.remarkOut && `출발 특이사항: ${t.remarkOut}`, t.remarkBack && `도착 특이사항: ${t.remarkBack}`].filter(Boolean).join('\n');
    return `${extra ? extra + '\n' : ''}서류 목록(탑승일 순):\n${rows.map(r => JSON.stringify(r)).join('\n')}`;
  }

  // 반환 계획은 id 검증을 거친 것만 남김
  async function planTrip(s, trip, docs) {
    s = settingsOf(s);
    const r = await chatJSON(s, { system: PLAN_SYSTEM, user: planUserPrompt(trip, docs), schema: PLAN_SCHEMA });
    const byId = Object.fromEntries(docs.map(d => [d.id, d]));
    const typeIs = (id, re) => id && byId[id] && re.test(byId[id].f.type) ? id : '';
    const legs = (r.legs || []).map(l => ({
      dir: ['out', 'local', 'back'].includes(l.dir) ? l.dir : '',
      confirmId: typeIs(l.confirmId, /^transport_confirm$/),
      receiptIds: strList(l.receiptIds).filter(id => typeIs(id, /^transport_receipt$/)),
      mileageId: typeIs(l.mileageId, /^mileage$/),
      reason: String(l.reason || '').trim(),
    })).filter(l => l.dir && (l.confirmId || l.receiptIds.length));
    // 확인서는 한 leg에만
    const seenC = new Set();
    const legsU = legs.filter(l => !l.confirmId || (!seenC.has(l.confirmId) && seenC.add(l.confirmId)));
    const lodgings = (r.lodgings || []).map(L => ({
      receiptId: typeIs(L.receiptId, /^lodging_receipt$/), confirmId: typeIs(L.confirmId, /^lodging_confirm$/),
    })).filter(L => L.receiptId || L.confirmId);
    const issues = (r.issues || []).map(i => ({
      level: ['error', 'warn', 'info'].includes(i.level) ? i.level : 'info',
      // 내부 id(d3)가 문장에 섞이면 파일명으로 바꾼다
      msg: String(i.msg || '').trim().replace(/\(?\b(d\d+)\b\)?/g, (m, id) => byId[id] ? `(${byId[id].name})` : m).replace(/\s+\(/g, ' ('),
      ids: [...new Set(strList(i.docIds).concat(String(i.msg || '').match(/\bd\d+\b/g) || []))].filter(id => byId[id]),
    })).filter(i => i.msg);
    const period = { start: normDate(r.period && r.period.start), end: normDate(r.period && r.period.end) };
    if (period.start && period.end && period.end < period.start) period.end = period.start;
    return { legs: legsU, lodgings, issues, period, model: s.model, at: Date.now() };
  }

  const api = { PROVIDERS, DEFAULTS, settingsOf, baseOf, listModels, modelInfo, useVision, testConnection, chatJSON, extractDoc, mergeDoc, planTrip, parseJSON };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LLM = api;
})(typeof window !== 'undefined' ? window : globalThis);
