/*
 * 문서 목록 + 출장정보 → 여정 구성(출발/경유/도착), 숙박, 자차, 공문 + 보완사항
 * 입력 doc: { id, name, hash, status, error, text, auto:{...}, f:{ 편집 가능한 필드 } }
 */
(function (global) {
  'use strict';
  const X = (typeof module !== 'undefined' && module.exports) ? require('./extract.js') : global.Extract;

  const TYPE_LABEL = {
    transport_receipt: '교통 영수증', transport_confirm: '탑승확인서', mileage: '마일리지 확인서',
    lodging_receipt: '숙박 영수증', lodging_confirm: '숙박 확인서',
    car_distance: '자차 거리 캡처', car_fuel: '유류비 기준 캡처',
    official: '공문·일정안내', other: '미분류',
  };
  const MODE_LABEL = { air: '항공', rail: '철도', bus: '버스', etc: '기타' };
  const MILEAGE_AIRLINES = ['대한항공', '아시아나항공', '진에어', '제주항공'];

  const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const fmtD = d => d ? d.slice(5).replace('-', '.') : '?';
  const won = n => n == null || n === '' ? '-' : Number(n).toLocaleString('ko-KR') + '원';
  // 예약번호(직접 입력 포함). 카드 승인번호는 연결 근거로만 쓰고 '불일치' 판정에는 쓰지 않음
  const resvOf = d => String(d.f.refs || '').split(/[,\s]+/).map(X.normRef).filter(Boolean);
  const refsOf = d => resvOf(d).concat((d.auto && d.auto.approvals) || []);
  const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
  const routeTxt = o => (o.from || o.to) ? `${o.from || '?'}→${o.to || '?'}` : '';

  function analyze(trip, docs) {
    trip = trip || {};
    const issues = [];
    const add = (level, area, msg, ids) => issues.push({ level, area, msg, ids: ids || [] });

    docs.filter(d => d.status === 'error').forEach(d => add('error', '파일', `${d.name}: 읽기 실패 – ${d.error || '알 수 없는 오류'}`, [d.id]));
    const ok = docs.filter(d => d.status === 'done');
    const of = t => ok.filter(d => d.f.type === t);

    // 중복 파일
    const seen = {};
    ok.forEach(d => {
      if (!d.hash) return;
      if (seen[d.hash]) add('warn', '파일', `동일한 파일이 중복 등록됨: ${seen[d.hash].name} / ${d.name}`, [seen[d.hash].id, d.id]);
      else seen[d.hash] = d;
    });
    of('other').forEach(d => add('warn', '분류', `${d.name}: 문서 종류를 판단하지 못했습니다. 종류를 직접 선택하세요.`, [d.id]));
    ok.filter(d => d.f.type !== 'other' && d.lowConfidence && !d.userTouched)
      .forEach(d => add('info', '분류', `${d.name}: 자동 분류(${TYPE_LABEL[d.f.type]}) 신뢰도가 낮습니다. 확인해 주세요.`, [d.id]));

    // ───────── 교통: 영수증 ↔ 탑승확인서 연결 ─────────
    const R = of('transport_receipt'), C = of('transport_confirm');
    const link = new Map(); // confirm.id → [receipts]
    const rUsed = new Map(); // receipt.id → count
    const linkWhy = new Map();
    const doLink = (c, r, why) => {
      if (!link.has(c.id)) link.set(c.id, []);
      link.get(c.id).push(r);
      rUsed.set(r.id, (rUsed.get(r.id) || 0) + 1);
      linkWhy.set(c.id, why);
    };
    const sameMode = (a, b) => !a.f.mode || !b.f.mode || a.f.mode === 'etc' || b.f.mode === 'etc' || a.f.mode === b.f.mode;
    const free = r => !rUsed.has(r.id);
    const unlinked = () => C.filter(c => !link.has(c.id));

    // 1) 예약번호 일치 (왕복 영수증 1장 ↔ 확인서 여러 장 허용)
    C.forEach(c => R.forEach(r => { if (X.refsMatch(refsOf(c), refsOf(r))) doLink(c, r, '예약번호'); }));
    // 2) 같은 교통수단 + 같은 날짜 + 구간 일치
    unlinked().forEach(c => {
      const r = R.find(r => free(r) && sameMode(c, r) && r.f.date && r.f.date === c.f.date &&
        X.samePlace(r.f.from, c.f.from) && X.samePlace(r.f.to, c.f.to));
      if (r) doLink(c, r, '날짜·구간');
    });
    // 3) 같은 교통수단 + 같은 금액
    unlinked().forEach(c => {
      const r = R.find(r => free(r) && sameMode(c, r) && num(r.f.amount) && num(r.f.amount) === num(c.f.amount));
      if (r) doLink(c, r, '금액');
    });
    // 4) 영수증에 확인서 날짜가 포함 (왕복 영수증 등)
    unlinked().forEach(c => {
      const r = R.find(r => sameMode(c, r) && c.f.date && ((r.auto && r.auto.allDates) || []).includes(c.f.date) && (free(r) || refsOf(r).length === 0));
      if (r) doLink(c, r, '날짜');
    });
    // 5) 남은 것이 같은 교통수단으로 1:1이면 연결 (근거 약함)
    unlinked().forEach(c => {
      const cands = R.filter(r => free(r) && sameMode(c, r));
      const others = unlinked().filter(x => x !== c && sameMode(x, c));
      if (cands.length === 1 && others.length === 0) doLink(c, cands[0], '추정');
    });

    const legs = [];
    C.forEach(c => legs.push(makeLeg(c, link.get(c.id) || [], linkWhy.get(c.id))));
    R.filter(free).forEach(r => legs.push(makeLeg(null, [r], null)));
    function makeLeg(c, rs, why) {
      const base = c || rs[0];
      const pick = k => (c && c.f[k]) || (rs.find(r => r.f[k]) || {}).f?.[k] || '';
      return {
        id: base.id, confirm: c, receipts: rs, why,
        mode: pick('mode') || 'etc', date: pick('date'), time: pick('time'), airline: pick('airline'),
        from: pick('from'), to: pick('to'), vehicleNo: pick('vehicleNo'),
        dirManual: (c && c.f.dir !== 'auto' && c.f.dir) || (rs.find(r => r.f.dir && r.f.dir !== 'auto') || {}).f?.dir || '',
        checks: [],
      };
    }

    // ───────── 숙박 ─────────
    const LR = of('lodging_receipt'), LC = of('lodging_confirm');
    const lodgings = [];
    const lrUsed = new Set();
    LC.forEach(c => {
      let r = LR.find(r => !lrUsed.has(r.id) && X.refsMatch(refsOf(c), refsOf(r)));
      let why = '예약번호';
      if (!r) { r = LR.find(r => !lrUsed.has(r.id) && r.f.checkin && r.f.checkin === c.f.checkin); why = '체크인 날짜'; }
      if (!r) { r = LR.find(r => !lrUsed.has(r.id) && num(r.f.amount) && num(r.f.amount) === num(c.f.amount)); why = '금액'; }
      if (!r) {
        const rest = LR.filter(r => !lrUsed.has(r.id));
        if (rest.length === 1 && LC.length === LR.length) { r = rest[0]; why = '추정'; }
      }
      if (r) lrUsed.add(r.id);
      lodgings.push({ id: c.id, confirm: c, receipt: r || null, why: r ? why : null });
    });
    LR.filter(r => !lrUsed.has(r.id)).forEach(r => lodgings.push({ id: r.id, confirm: null, receipt: r, why: null }));
    lodgings.forEach(L => {
      const c = L.confirm, r = L.receipt;
      L.checkin = (c && c.f.checkin) || (r && r.f.checkin) || '';
      L.checkout = (c && c.f.checkout) || (r && r.f.checkout) || '';
      L.name = (c && c.f.lodgingName) || (r && r.f.lodgingName) || '';
      L.amount = r ? num(r.f.amount) : null;
      L.nights = L.checkin && L.checkout ? diffDays(L.checkin, L.checkout) : null;
      L.checks = [];
    });
    lodgings.sort((a, b) => (a.checkin || '9').localeCompare(b.checkin || '9'));

    // ───────── 공문 ─────────
    const officials = of('official');
    const off = officials.find(o => o.f.periodStart) || null;

    // ───────── 출장기간 결정 ─────────
    const legDates = legs.map(l => l.date).filter(Boolean).sort();
    let start = trip.start || '', end = trip.end || '', periodSrc = '입력값';
    if (!start || !end) {
      const cands = { s: [], e: [] };
      if (legDates.length) { cands.s.push(legDates[0]); cands.e.push(legDates[legDates.length - 1]); }
      lodgings.forEach(L => { if (L.checkin) cands.s.push(L.checkin); if (L.checkout) cands.e.push(L.checkout); });
      if (!cands.s.length && off) { cands.s.push(off.f.periodStart); cands.e.push(off.f.periodEnd || off.f.periodStart); }
      if (!start && cands.s.length) start = cands.s.sort()[0];
      if (!end && cands.e.length) end = cands.e.sort().reverse()[0];
      periodSrc = legDates.length || lodgings.length ? '증빙 날짜로 추정' : (off ? '공문 기간' : '');
      if (start && end && end < start) end = start;
    }
    const days = start && end ? diffDays(start, end) + 1 : null;

    // ───────── 출발 / 경유 / 도착 분류 (경유: 출장 중간의 이동, 여러 교통편 가능) ─────────
    const sortLegs = arr => arr.sort((a, b) => (a.date || '9').localeCompare(b.date || '9') || (a.time || '99').localeCompare(b.time || '99'));
    sortLegs(legs);
    if (!trip.home && legs.length >= 2) {
      const a = legs[0], z = legs[legs.length - 1];
      if (a.from && z.to && X.samePlace(a.from, z.to)) trip = Object.assign({}, trip, { home: a.from, homeGuessed: true });
    }
    const firstCheckin = lodgings.map(L => L.checkin).filter(Boolean).sort()[0];
    const lastCheckout = lodgings.map(L => L.checkout).filter(Boolean).sort().reverse()[0];
    const outDay = firstCheckin && (!start || firstCheckin >= start) ? (start && start < firstCheckin ? start : firstCheckin) : start;
    const backDay = lastCheckout && (!end || lastCheckout <= end) ? (end && end > lastCheckout ? end : lastCheckout) : end;
    let dirGuessWeak = false;

    const auto = legs.filter(l => !l.dirManual);
    legs.filter(l => l.dirManual).forEach(l => { l.dir = l.dirManual; });
    if (outDay && backDay && outDay !== backDay) {
      auto.forEach(l => {
        if (!l.date) { l.dir = 'local'; return; }
        l.dir = l.date <= outDay ? 'out' : l.date >= backDay ? 'back' : 'local';
      });
    } else {
      // 당일 출장 또는 날짜 정보 부족 → 구간(출발지/도착지)으로 판단
      const home = trip.home, dest = trip.dest;
      const arr = sortLegs(auto.slice());
      let k = -1;
      if (dest) k = arr.findIndex(l => l.to && X.samePlace(l.to, dest) && X.normPlace(l.to));
      // 모든 구간에 시각이 있으면 가장 오래 머문 지점(다음 구간까지 간격이 가장 긴 곳)에서 출발/도착을 나눔
      // 예) 07:00 제주→김해, 09:30 부산→서울, 19:00 김포→제주 → 09:30 이후가 체류 → 출발 2구간 + 도착 1구간
      if (k < 0 && arr.length >= 2 && arr.every(l => l.time && l.date)) {
        const t = l => Date.parse(l.date) / 6e4 + (+l.time.slice(0, 2)) * 60 + (+l.time.slice(3, 5));
        let best = -1;
        for (let i = 0; i + 1 < arr.length; i++) { const g = t(arr[i + 1]) - t(arr[i]); if (g > best) { best = g; k = i; } }
      }
      if (k < 0 && home) {
        const firstBack = arr.findIndex((l, i) => i > 0 && l.to && X.normPlace(home) && X.samePlace(l.to, home) && X.normPlace(l.to));
        if (firstBack > 0) {
          // 집으로 돌아오는 구간 체인의 시작점 찾기
          let j = firstBack;
          while (j > 0 && arr[j - 1].to && arr[j].from && X.samePlace(arr[j - 1].to, arr[j].from) &&
            !(arr[j].from && X.samePlace(arr[j].from, arr[0].to || '#'))) j--;
          k = Math.max(0, j - 1);
        }
      }
      if (k < 0) { k = Math.ceil(arr.length / 2) - 1; if (arr.length > 1) dirGuessWeak = true; }
      arr.forEach((l, i) => { l.dir = i <= k ? 'out' : 'back'; });
    }
    // 출발 = 첫 구간과 바로 이어 탄 구간, 도착 = 마지막 구간과 바로 앞에 이어 탄 구간, 그 사이는 경유.
    // '이어 탐' = 같은 날 · 앞 구간 도착지에서 출발 · 출발 시각 4시간 이내 (시각을 모르면 이어 탄 것으로 봄)
    // 예) 10:30 제주→김포, 16:40 김포→여수(경유), 다음날 여수→제주(도착)
    {
      const mins = l => +l.time.slice(0, 2) * 60 + +l.time.slice(3, 5);
      const connected = (a, b) => a.date && a.date === b.date && (!a.to || !b.from || X.samePlace(a.to, b.from)) &&
        (!a.time || !b.time || mins(b) - mins(a) <= 240);
      const outs = sortLegs(auto.filter(l => l.dir === 'out'));
      for (let i = 1; i < outs.length; i++) if (outs[i - 1].dir !== 'out' || !connected(outs[i - 1], outs[i])) outs[i].dir = 'local';
      const backs = sortLegs(auto.filter(l => l.dir === 'back'));
      for (let i = backs.length - 2; i >= 0; i--) if (backs[i + 1].dir !== 'back' || !connected(backs[i], backs[i + 1])) backs[i].dir = 'local';
    }
    const out = sortLegs(legs.filter(l => l.dir === 'out'));
    const local = sortLegs(legs.filter(l => l.dir === 'local'));
    const back = sortLegs(legs.filter(l => l.dir === 'back'));
    const nameLegs = (arr, base) => arr.forEach((l, i) => { l.label = base + (arr.length > 1 ? ` ${i + 1}구간` : ''); });
    nameLegs(out, '출발'); nameLegs(back, '도착');
    nameLegs(local, '경유');
    if (dirGuessWeak) add('info', '교통', '구간 정보가 부족해 출발/도착을 시간 순서로 추정했습니다. 문서 카드의 구분을 확인하세요.');

    // ───────── 마일리지 확인서 (대한항공·아시아나항공·진에어·제주항공) ─────────
    const mileageDocs = of('mileage');
    const flightsOf = d => String(d.f.flights || '').split(/[,\s]+/).map(X.normRef).filter(Boolean);
    const usedMileage = new Set();
    legs.filter(l => l.mode === 'air').forEach(l => {
      const al = l.airline || X.airlineOf(l.vehicleNo, '');
      if (!MILEAGE_AIRLINES.includes(al)) return;
      l.airline = al; l.needsMileage = true;
      const fno = X.normRef(l.vehicleNo);
      // 편명이 없는 확인서(예: 제주항공 포인트 조회 화면)는 적립일로 연결. 적립은 탑승 후 늦게 될 수 있어 14일까지 허용
      const airlineOk = m => !m.f.airline || m.f.airline === al;
      const earnOf = m => [...new Set([m.f.date, ...((m.auto && m.auto.earnDates) || [])].filter(Boolean))];
      const near = (d, e) => { const g = (Date.parse(e) - Date.parse(d)) / 864e5; return g >= 0 && g <= 14; };
      l.mileage = mileageDocs.find(m => fno && flightsOf(m).includes(fno)) ||
        mileageDocs.find(m => !flightsOf(m).length && airlineOk(m) && l.date && earnOf(m).includes(l.date)) ||
        mileageDocs.find(m => !flightsOf(m).length && airlineOk(m) && l.date && earnOf(m).some(e => near(l.date, e))) || null;
      if (l.mileage && !earnOf(l.mileage).includes(l.date) && !flightsOf(l.mileage).includes(fno))
        l.mileageNote = `적립일 ${earnOf(l.mileage).find(e => near(l.date, e))}`;
      if (l.mileage) usedMileage.add(l.mileage.id);
    });
    const needM = legs.filter(l => l.needsMileage);
    const missM = needM.filter(l => !l.mileage);
    const legName = l => `${l.airline} ${l.vehicleNo || ''}(${l.label || ''} ${fmtD(l.date)})`.replace(/\s+\(/, '(');
    if (missM.length) {
      const shown = mileageDocs.map(m => [...flightsOf(m), m.f.date].filter(Boolean).join(' ')).filter(Boolean);
      add('warn', '마일리지', mileageDocs.length
        ? `마일리지 확인서에서 ${missM.map(legName).join(', ')} 편을 찾지 못했습니다${shown.length ? ` (첨부된 확인서: ${shown.join(' / ')})` : ''}. 탑승일·편명이 맞는 확인서인지 확인하세요.`
        : `${missM.map(legName).join(', ')} 편은 마일리지 확인서가 필요할 수 있는데 첨부되지 않았습니다.`, missM.map(l => l.id));
    }
    mileageDocs.filter(m => !usedMileage.has(m.id)).forEach(m =>
      add('info', '마일리지', `${m.name}: 어느 항공편의 마일리지 확인서인지 연결하지 못했습니다. 문서 카드의 편명·적립일을 확인하세요.`, [m.id]));

    // ───────── 교통 구간별 점검 ─────────
    legs.forEach(l => {
      const c = l.confirm, rs = l.receipts;
      const nm = `[${l.label}] ${MODE_LABEL[l.mode] || ''} ${fmtD(l.date)} ${routeTxt(l)}`.replace(/\s+/g, ' ').trim();
      const ids = [c, ...rs].filter(Boolean).map(d => d.id);
      if (!c) { add('error', '교통', `${nm}: 탑승확인서(승차권·탑승권 캡처 등)가 없습니다.`, ids); l.checks.push({ ok: false, t: '탑승확인서 없음' }); }
      if (!rs.length) { add('error', '교통', `${nm}: 영수증이 없습니다.`, ids); l.checks.push({ ok: false, t: '영수증 없음' }); }
      if (c && rs.length) {
        l.checks.push({ ok: true, t: `영수증↔확인서 연결(${l.why})` });
        if (l.why === '추정') add('info', '교통', `${nm}: 영수증과 확인서를 공통 정보 없이 추정으로 연결했습니다. 같은 건인지 확인하세요.`, ids);
        const cr = resvOf(c), rr = rs.flatMap(resvOf);
        if (cr.length && rr.length) {
          if (X.refsMatch(cr, rr)) l.checks.push({ ok: true, t: '예약번호 일치' });
          else { l.checks.push({ ok: false, t: '예약번호 불일치' }); add('error', '교통', `${nm}: 예약번호 불일치 (영수증 ${rr.join('/')} ↔ 확인서 ${cr.join('/')})`, ids); }
        } else l.checks.push({ ok: null, t: '예약번호 비교 불가' });
        rs.forEach(r => {
          if (c.f.date && r.f.date && r.f.date !== c.f.date && !((r.auto && r.auto.allDates) || []).includes(c.f.date)) {
            l.checks.push({ ok: false, t: '날짜 불일치' });
            add('warn', '교통', `${nm}: 영수증 날짜(${r.f.date})와 탑승일(${c.f.date})이 다릅니다. 결제일이면 무시해도 됩니다.`, ids);
          }
          if (rUsed.get(r.id) === 1 && r.f.from && c.f.from && r.f.to && c.f.to && !(X.samePlace(r.f.from, c.f.from) && X.samePlace(r.f.to, c.f.to))) {
            l.checks.push({ ok: false, t: '구간 불일치' });
            add('warn', '교통', `${nm}: 영수증 구간(${routeTxt(r.f)})과 확인서 구간(${routeTxt(c.f)})이 다릅니다.`, ids);
          }
        });
        const shared = rs.some(r => rUsed.get(r.id) > 1);
        if (!shared && rs.length === 1 && num(rs[0].f.amount) && num(c.f.amount) && num(rs[0].f.amount) !== num(c.f.amount)) {
          l.checks.push({ ok: false, t: '금액 불일치' });
          add('warn', '교통', `${nm}: 금액 불일치 (영수증 ${won(rs[0].f.amount)} ↔ 확인서 ${won(c.f.amount)})`, ids);
        }
        if (trip.name && c.text && !X.compact(c.text).includes(X.compact(trip.name)))
          add('info', '교통', `${nm}: 확인서에서 출장자 성명(${trip.name})을 찾지 못했습니다. 본인 탑승 여부를 확인하세요.`, [c.id]);
      }
      if (l.needsMileage) l.checks.push({ ok: !!l.mileage, t: l.mileage ? `마일리지 확인서${l.mileageNote ? ` (탑승 후 ${l.mileageNote})` : ''}` : '마일리지 확인서 없음' });
      if (!l.date) add('warn', '교통', `${nm}: 이용일자를 인식하지 못했습니다. 직접 입력하세요.`, ids);
      else if (start && end && (l.date < start || l.date > end))
        add('warn', '교통', `${nm}: 이용일(${l.date})이 출장기간(${start}~${end}) 밖입니다.`, ids);
      if (!l.from || !l.to) add('info', '교통', `${nm}: 출발지/도착지를 인식하지 못했습니다. 경유 연결 점검을 위해 입력을 권장합니다.`, ids);
    });
    const chainCheck = (arr, title) => {
      for (let i = 0; i + 1 < arr.length; i++) {
        const a = arr[i], b = arr[i + 1];
        if (a.to && b.from && !X.samePlace(a.to, b.from))
          add('warn', '교통', `${title} 경유 연결 확인: ${a.label}(${routeTxt(a)}) 다음 ${b.label}(${routeTxt(b)})의 출발지가 다릅니다.`, [a.id, b.id]);
      }
    };
    chainCheck(out, '출발'); chainCheck(back, '도착');
    if (trip.home) {
      if (out[0] && out[0].from && !X.samePlace(out[0].from, trip.home))
        add('info', '교통', `출발 첫 구간의 출발지(${out[0].from})가 근무지(${trip.home})와 다릅니다. 앞 구간 교통 증빙이 빠졌는지 확인하세요.`, [out[0].id]);
      const lb = back[back.length - 1];
      if (lb && lb.to && !X.samePlace(lb.to, trip.home))
        add('info', '교통', `도착 마지막 구간의 도착지(${lb.to})가 근무지(${trip.home})와 다릅니다. 이후 구간 증빙이 빠졌는지 확인하세요.`, [lb.id]);
    }

    // ───────── 숙박 점검 ─────────
    lodgings.forEach((L, i) => {
      const nm = `[숙박${lodgings.length > 1 ? ' ' + (i + 1) : ''}] ${L.name || ''} ${fmtD(L.checkin)}~${fmtD(L.checkout)}`.replace(/\s+/g, ' ');
      const ids = [L.confirm, L.receipt].filter(Boolean).map(d => d.id);
      if (!L.receipt) { add('error', '숙박', `${nm}: 숙박 영수증이 없습니다.`, ids); L.checks.push({ ok: false, t: '영수증 없음' }); }
      if (!L.confirm) { add('error', '숙박', `${nm}: 숙박 확인서(예약확인서·투숙확인서)가 없습니다.`, ids); L.checks.push({ ok: false, t: '확인서 없음' }); }
      if (L.receipt && L.confirm) {
        L.checks.push({ ok: true, t: `영수증↔확인서 연결(${L.why})` });
        const a = resvOf(L.receipt), b = resvOf(L.confirm);
        if (a.length && b.length) {
          if (X.refsMatch(a, b)) L.checks.push({ ok: true, t: '예약번호 일치' });
          else { L.checks.push({ ok: false, t: '예약번호 불일치' }); add('error', '숙박', `${nm}: 예약번호 불일치 (영수증 ${a.join('/')} ↔ 확인서 ${b.join('/')})`, ids); }
        }
        const rc = L.receipt.f, cc = L.confirm.f;
        if (rc.checkin && cc.checkin && (rc.checkin !== cc.checkin || (rc.checkout && cc.checkout && rc.checkout !== cc.checkout))) {
          L.checks.push({ ok: false, t: '숙박일 불일치' });
          add('warn', '숙박', `${nm}: 영수증(${rc.checkin}~${rc.checkout || '?'})과 확인서(${cc.checkin}~${cc.checkout || '?'})의 숙박일이 다릅니다.`, ids);
        }
        if (num(rc.amount) && num(cc.amount) && num(rc.amount) !== num(cc.amount)) {
          L.checks.push({ ok: false, t: '금액 불일치' });
          add('warn', '숙박', `${nm}: 금액 불일치 (영수증 ${won(rc.amount)} ↔ 확인서 ${won(cc.amount)})`, ids);
        }
      }
      if (!L.checkin || !L.checkout) add('warn', '숙박', `${nm}: 체크인/체크아웃 날짜를 인식하지 못했습니다. 직접 입력하세요.`, ids);
      else {
        if (out.length && out[out.length - 1].date && L === lodgings[0] && L.checkin !== out[out.length - 1].date)
          add('warn', '숙박', `${nm}: 체크인(${L.checkin})이 출발 교통편 이용일(${out[out.length - 1].date})과 다릅니다.`, ids);
        if (back.length && back[0].date && L === lodgings[lodgings.length - 1] && L.checkout !== back[0].date)
          add('warn', '숙박', `${nm}: 체크아웃(${L.checkout})이 도착 교통편 이용일(${back[0].date})과 다릅니다.`, ids);
        if (start && end && (L.checkin < start || L.checkout > end))
          add('warn', '숙박', `${nm}: 숙박기간이 출장기간(${start}~${end})을 벗어납니다.`, ids);
      }
      if (trip.name && L.confirm && L.confirm.text && !X.compact(L.confirm.text).includes(X.compact(trip.name)))
        add('info', '숙박', `${nm}: 확인서에서 출장자 성명(${trip.name})을 찾지 못했습니다.`, [L.confirm.id]);
    });
    const nightsTotal = lodgings.reduce((s, L) => s + (L.nights || 0), 0);
    if (days && days > 1) {
      if (!lodgings.length) add('info', '숙박', `${days - 1}박 출장인데 숙박 증빙이 없습니다. (숙박하지 않았거나 숙박비 미청구라면 무시)`);
      else if (nightsTotal && nightsTotal < days - 1) add('info', '숙박', `출장 ${days - 1}박 중 숙박 증빙은 ${nightsTotal}박입니다. 빠진 숙박이 있는지 확인하세요.`);
    }

    // ───────── 자차 ─────────
    const dist = of('car_distance'), fuel = of('car_fuel');
    let car = null;
    if (dist.length || fuel.length) {
      const kmOne = dist.reduce((s, d) => s + (num(d.f.km) || 0), 0);
      const km = dist.length === 1 && trip.carRoundTrip ? kmOne * 2 : kmOne;
      const price = (fuel.find(d => num(d.f.fuelPrice)) || { f: {} }).f.fuelPrice;
      const fuelType = (fuel.find(d => d.f.fuelType) || { f: {} }).f.fuelType || '';
      const eff = num(trip.fuelEff);
      const cost = km && num(price) && eff ? Math.round(km * num(price) / eff) : null;
      const toll = dist.reduce((s, d) => s + (num(d.f.toll) || 0), 0) * (dist.length === 1 && trip.carRoundTrip ? 2 : 1);
      car = { dist, fuel, km, price: num(price), fuelType, eff, cost, toll };
      if (!dist.length) add('error', '자차', '유류비 기준 캡처는 있으나 지도앱 거리 캡처가 없습니다.', fuel.map(d => d.id));
      if (!fuel.length) add('error', '자차', '지도앱 거리 캡처는 있으나 유류비 기준(오피넷 등) 캡처가 없습니다.', dist.map(d => d.id));
      dist.filter(d => !num(d.f.km)).forEach(d => add('warn', '자차', `${d.name}: 거리(km)를 인식하지 못했습니다. 직접 입력하세요.`, [d.id]));
      fuel.filter(d => !num(d.f.fuelPrice)).forEach(d => add('warn', '자차', `${d.name}: 유류 단가(원/L)를 인식하지 못했습니다. 직접 입력하세요.`, [d.id]));
      if (km && num(price) && !eff) add('info', '자차', '연비(km/L)를 입력하면 유류비가 자동 계산됩니다.');
    }

    // ───────── 공문 / 교육 ─────────
    if (trip.kind === 'education' && !officials.length)
      add('error', '공문', '교육출장은 출장공문 또는 교육 일정안내서(pdf, hwpx)를 첨부해야 합니다.');
    officials.filter(o => o.ext === 'hwp').forEach(o => add('info', '공문', `${o.name}: .hwp 파일은 내용을 읽을 수 없어 점검하지 못했습니다. hwpx 또는 pdf로 저장해 올리면 기간 대조가 가능합니다.`, [o.id]));
    if (off && start && end) {
      const s = off.f.periodStart, e = off.f.periodEnd || s;
      if (diffDays(start, s) > 1) add('warn', '공문', `출발일(${start})이 공문상 시작일(${s})보다 2일 이상 이릅니다.`, [off.id]);
      if (diffDays(e, end) > 1) add('warn', '공문', `복귀일(${end})이 공문상 종료일(${e})보다 2일 이상 늦습니다.`, [off.id]);
      if (start > s) add('warn', '공문', `출발일(${start})이 공문상 시작일(${s})보다 늦습니다.`, [off.id]);
      if (end < e) add('warn', '공문', `복귀일(${end})이 공문상 종료일(${e})보다 이릅니다.`, [off.id]);
    } else if (officials.length && !off)
      add('info', '공문', '공문에서 출장(교육) 기간을 찾지 못했습니다. 문서 카드에서 기간을 입력하면 대조합니다.', officials.map(o => o.id));

    // ───────── 전체 구성 ─────────
    if (!legs.length && !car) add('warn', '교통', '교통 증빙(영수증·탑승확인서)이나 자차 증빙이 없습니다.');
    else if (legs.length) {
      if (!out.length && !car) add('warn', '교통', '출발 교통 증빙이 없습니다.');
      if (!back.length && !car) add('info', '교통', '도착(복귀) 교통 증빙이 없습니다. 편도 출장이라면 무시하세요.');
    }

    // ───────── 금액 합계 ─────────
    const countedR = new Set();
    let transportSum = 0;
    legs.forEach(l => l.receipts.forEach(r => { if (!countedR.has(r.id)) { countedR.add(r.id); transportSum += num(r.f.amount) || 0; } }));
    const lodgingSum = lodgings.reduce((s, L) => s + (L.amount || 0), 0);
    const carSum = car ? (car.cost || 0) + (car.toll || 0) : 0;

    const order = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => order[a.level] - order[b.level]);

    return {
      period: { start, end, days, src: periodSrc },
      out, local, back, legs, lodgings, car, officials, mileageDocs,
      others: of('other'),
      issues,
      totals: { transport: transportSum, lodging: lodgingSum, car: carSum, all: transportSum + lodgingSum + carSum },
    };
  }

  // 증빙서류 묶음 순서: 공문 → 출발 → 숙박 → 경유 → 도착 → 자차 → 기타
  function evidenceOrder(res) {
    const list = [], used = new Set();
    const push = (doc, section, role) => { if (doc && !used.has(doc.id)) { used.add(doc.id); list.push({ doc, section, role }); } };
    res.officials.forEach(d => push(d, '공문', '공문·일정안내'));
    const legPush = l => { l.receipts.forEach(r => push(r, l.label, `${MODE_LABEL[l.mode] || ''} 영수증`.trim())); push(l.confirm, l.label, `${MODE_LABEL[l.mode] || ''} 탑승확인서`.trim()); };
    res.out.forEach(legPush);
    res.lodgings.forEach((L, i) => {
      const s = '숙박' + (res.lodgings.length > 1 ? ' ' + (i + 1) : '');
      push(L.receipt, s, '숙박 영수증'); push(L.confirm, s, '숙박 확인서');
    });
    res.local.forEach(legPush);
    res.back.forEach(legPush);
    (res.mileageDocs || []).forEach(d => push(d, '마일리지', '마일리지 확인서'));
    if (res.car) { res.car.dist.forEach(d => push(d, '자차', '거리 캡처')); res.car.fuel.forEach(d => push(d, '자차', '유류비 기준')); }
    res.others.forEach(d => push(d, '기타', '미분류'));
    return list;
  }

  const api = { analyze, evidenceOrder, TYPE_LABEL, MODE_LABEL, won, fmtD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Analyze = api;
})(typeof window !== 'undefined' ? window : globalThis);
