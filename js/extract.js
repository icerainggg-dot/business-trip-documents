/*
 * 문서 텍스트(OCR/PDF/HWPX) → 문서 분류 + 핵심 항목 추출
 * 브라우저(window.Extract)와 Node(module.exports) 양쪽에서 사용
 */
(function (global) {
  'use strict';

  // ───────────────────────── 공통 유틸 ─────────────────────────
  const p2 = n => String(n).padStart(2, '0');
  const compact = t => (t || '').replace(/\s+/g, '').toLowerCase();
  const countKw = (c, list) => list.reduce((n, k) => n + (c.includes(k.toLowerCase()) ? 1 : 0), 0);
  const normRef = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const toNum = s => {
    if (s == null) return null;
    const n = Number(String(s).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  // ───────────────────────── 키워드 사전 ─────────────────────────
  const MODE_KW = {
    air: ['항공', '탑승권', 'boarding', '편명', 'flight', '대한항공', 'koreanair', 'korean air', '아시아나', 'asiana',
      '제주항공', 'jejuair', '진에어', 'jinair', '티웨이', 'tway', '에어부산', 'airbusan', '에어서울', 'airseoul',
      '이스타', 'eastar', '에어로케이', 'aerok', '에어프레미아', '파라타', '공항', '게이트', 'gate', '수하물',
      'e-ticket', '이티켓', '전자항공권', '항공권', '탑승수속'],
    rail: ['코레일', 'korail', 'ktx', 'srt', 'itx', '새마을', '무궁화', '누리로', '열차', '호차', '한국철도공사',
      '에스알', '레츠코레일', '철도', '승차일', '열차번호', '좌석번호'],
    bus: ['고속버스', '시외버스', '버스', '터미널', '버스타고', '티머니', 'tmoney', '코버스', 'kobus', '배차', '승차홈',
      '고속버스통합예매', '시외버스통합예매'],
  };
  const TRANSPORT_GENERIC = ['탑승', '승차', '운임', '여정', '편도', '왕복', '승객'];
  const RECEIPT_KW = ['영수증', '매출전표', '신용카드', '카드번호', '승인번호', '승인일시', '결제', '합계', '부가세',
    '부가가치세', '가맹점', '사업자등록번호', '사업자번호', '현금영수증', '거래일시', '할부', '공급가액', 'receipt',
    '카드종류', '결제수단', '결제금액', '지불', '대표자', '거래명세', '세금계산서'];
  const CONFIRM_TR_KW = ['탑승확인', '탑승권', 'boardingpass', 'boarding pass', '보딩패스', '승차확인', '승차권', '이용내역',
    '여정', '탑승객', '승객', '좌석', '호차', '게이트', 'gate', '이티켓', 'e-ticket', '발권확인', '탑승일', '승차일',
    '운행', '확인서', '탑승내역', '이용확인', 'seat', 'passenger', '탑승자', '탑승증명', '승차권번호'];
  const LODGING_KW = ['숙박', '호텔', 'hotel', '객실', '체크인', '체크아웃', 'check-in', 'checkin', 'check-out', 'checkout',
    '입실', '퇴실', '투숙', '리조트', 'resort', '모텔', '펜션', '게스트하우스', '레지던스', '야놀자', '여기어때',
    '아고다', 'agoda', '호텔스닷컴', 'hotels.com', '부킹닷컴', 'booking.com', '에어비앤비', 'airbnb', '숙소', '룸타입', '객실타입',
    '놀유니버스'];
  const LODGING_CONFIRM_KW = ['예약확인', '투숙확인', '숙박확인', '확인서', '바우처', 'voucher', '예약내역', '투숙객',
    '예약자', 'confirmation', '숙박일정', '이용확인', '투숙사실', '숙박사실', '예약완료', '예약상세', '숙소예약번호', '이용자정보',
    '상품및이용정보'];
  const CAR_KW = ['길찾기', '경로', '소요시간', '예상시간', '자동차', '자가용', '카카오맵', 'kakaomap', '네이버지도',
    '네이버맵', 'navermap', '티맵', 'tmap', '카카오내비', '최적', '추천경로', '큰길우선', '무료도로', '통행료',
    '최단', '고속도로', '내비', '주행', '택시비', '예상요금', '도착예정'];
  const FUEL_KW = ['오피넷', 'opinet', '유가', '휘발유', '경유', 'lpg', '평균판매가격', '주유소', '유류', '원/l', '원/ℓ',
    '석유', '보통휘발유', '자동차용경유', '판매가격', '한국석유공사', '평균가격'];
  const OFFICIAL_KW = ['공문', '시행', '수신', '발신', '참조', '협조', '교육', '연수', '과정', '일정', '안내', '시간표',
    '붙임', '개최', '워크숍', '세미나', '교육생', '입교', '수료', '기안', '결재', '문서번호', '교육기간', '교육장소',
    '소집', '참가', '회의', '출장명령', '계획', '대상자', '장소'];

  const MILEAGE_KW = ['마일리지', 'mileage', '스카이패스', 'skypass', '아시아나클럽', 'asianaclub', 'asiana club',
    '나비포인트', '리프레시포인트', 'refreshpoint', 'refresh point', '적립확인', '탑승마일', '마일리지적립', '적립내역', '적립예정',
    '항공권탑승', '탑승적립', '(적립)', '포인트조회', '사용가능포인트', '적립포인트', '소멸일자', '소멸포인트',
    '총적립', '적립일', '적립처', '적립/사용', '마일리지조회'];
  const FN_MILEAGE = ['마일리지', 'mileage', '적립', 'skypass', '스카이패스', '포인트'];
  // 편명 코드 → 항공사
  const AIRLINE_CODE = { KE: '대한항공', OZ: '아시아나항공', LJ: '진에어', '7C': '제주항공', TW: '티웨이항공', BX: '에어부산',
    RS: '에어서울', ZE: '이스타항공', RF: '에어로케이', YP: '에어프레미아', '4V': '플라이강원', '4H': '하이에어' };
  const AIRLINE_KW = [['대한항공', '대한항공'], ['koreanair', '대한항공'], ['korean air', '대한항공'], ['아시아나', '아시아나항공'],
    ['asiana', '아시아나항공'], ['진에어', '진에어'], ['jinair', '진에어'], ['jin air', '진에어'], ['제주항공', '제주항공'],
    ['jejuair', '제주항공'], ['jeju air', '제주항공'], ['티웨이', '티웨이항공'], ["t'way", '티웨이항공'], ['트리니티항공', '티웨이항공'],
    ['에어부산', '에어부산'], ['airbusan', '에어부산'], ['에어서울', '에어서울'], ['airseoul', '에어서울'], ['이스타', '이스타항공'],
    ['eastar', '이스타항공'], ['에어로케이', '에어로케이'], ['에어프레미아', '에어프레미아']];
  const FLIGHT_RE = /(?<![A-Z0-9])(KE|OZ|7C|LJ|TW|BX|RS|ZE|RF|YP|4V|4H)\s?(\d{2,4})(?!\d)/g;
  // OCR이 OZ를 0Z/0z로 읽는 경우 보정
  const fixFlightOcr = t => t.replace(/(?<![A-Za-z0-9])0[Zz](?=\s?\d{3,4}(?!\d))/g, 'OZ')
    .replace(/\[\s*0[2Zz]\s?(\d{3,4})\s*\]/g, '[OZ$1]') // 영수증 '[OZ8735]'를 '[028735]'로 읽는 경우
    .replace(/^(\s*)0[27Zz]\s?(\d{4})(?=\s*$)/gm, '$1OZ$2'); // 마일리지 내역의 한 줄짜리 'OZ8199'를 '078199'로 읽는 경우
  function findFlights(text) {
    const out = new Set(); let m; FLIGHT_RE.lastIndex = 0;
    while ((m = FLIGHT_RE.exec(fixFlightOcr(text).toUpperCase()))) out.add(m[1] + m[2]);
    return [...out];
  }
  function airlineOf(vehicleNo, text) {
    const m = /^(KE|OZ|7C|LJ|TW|BX|RS|ZE|RF|YP|4V|4H)\d/.exec(String(vehicleNo || '').toUpperCase().replace(/\s/g, ''));
    if (m) return AIRLINE_CODE[m[1]];
    const c = (text || '').toLowerCase();
    let best = null;
    for (const [k, v] of AIRLINE_KW) { const i = c.indexOf(k); if (i >= 0 && (!best || i < best.i)) best = { i, v }; }
    return best ? best.v : '';
  }

  const FN_HINT = {
    transport: ['항공', 'ktx', 'srt', '기차', '열차', '철도', '버스', '탑승', '승차', '교통', '비행', 'boarding', '코레일'],
    lodging: ['숙박', '호텔', '숙소', '모텔', '리조트', 'hotel'],
    car: ['거리', '지도', '맵', '경로', '길찾기', '자차', '자가용', 'map', '네비', '내비'],
    fuel: ['유가', '유류', '오피넷', '주유', 'opinet', '기름값', '유류비'],
    official: ['공문', '일정', '안내', '교육', '연수', '시간표', '출장명령'],
  };
  const FN_RECEIPT = ['영수증', '매출전표', 'receipt', '결제', '카드'];
  const FN_CONFIRM = ['확인서', '확인', '탑승권', '승차권', '바우처', 'voucher', '이용내역', '예약내역', '탑승', '승차'];

  // ───────────────────────── 장소 ─────────────────────────
  const IATA = {
    GMP: '김포', ICN: '인천', CJU: '제주', PUS: '김해', TAE: '대구', CJJ: '청주', KWJ: '광주', RSU: '여수',
    USN: '울산', HIN: '사천', KPO: '포항경주', YNY: '양양', WJU: '원주', KUV: '군산', MWX: '무안',
  };
  // 영문 공항/도시 이름 (탑승권 영문 표기)
  const PLACE_EN = {
    GIMPO: '김포', SEOUL: '서울', INCHEON: '인천', JEJU: '제주', GIMHAE: '김해', BUSAN: '부산', DAEGU: '대구',
    CHEONGJU: '청주', GWANGJU: '광주', YEOSU: '여수', ULSAN: '울산', SACHEON: '사천', POHANG: '포항경주',
    POHANGGYEONGJU: '포항경주', YANGYANG: '양양', WONJU: '원주', GUNSAN: '군산', MUAN: '무안',
  };
  const PLACES = [
    '서울', '용산', '수서', '동탄', '평택지제', '광명', '영등포', '청량리', '상봉', '행신', '천안아산', '천안', '오송',
    '대전', '서대전', '김천구미', '동대구', '서대구', '대구', '신경주', '경주', '울산', '부산', '구포', '밀양', '마산',
    '창원중앙', '창원', '진주', '포항', '광주송정', '광주', '나주', '목포', '익산', '전주', '남원', '순천', '여수엑스포',
    '여천', '여수', '정읍', '공주', '강릉', '평창', '진부', '둔내', '횡성', '만종', '원주', '제천', '단양', '영주', '안동',
    '춘천', '청주', '세종', '김포', '인천', '제주', '김해', '사천', '양양', '군산', '무안', '포항경주', '동서울',
    '서울경부', '센트럴시티', '서울남부', '남부', '부산종합', '노포', '사상', '해운대', '수원', '성남', '분당', '의정부',
    '고양', '용인', '홍성', '서산', '당진', '아산', '보령', '논산', '김제', '거제', '통영', '양산', '구미', '김천', '상주',
    '문경', '영천', '경산', '속초', '동해', '삼척', '태백', '오산', '평택', '안산', '안양', '부천', '파주', '이천',
    '충주', '서천', '정선', '완도', '해남', '고흥', '광양', '하동', '거창', '합천', '영덕', '울진', '봉화',
  ].sort((a, b) => b.length - a.length);

  function normPlace(s) {
    if (!s) return '';
    let t = String(s).replace(/\s+/g, '').replace(/[()（）]/g, '');
    t = t.replace(/(국제공항|공항|종합버스터미널|고속버스터미널|시외버스터미널|버스터미널|종합터미널|터미널|정류장|정류소|역)$/, '');
    return t;
  }
  function matchPlace(tok) {
    if (!tok) return null;
    const up = tok.toUpperCase().trim();
    if (IATA[up]) return IATA[up];
    if (PLACE_EN[up.replace(/[\s\-]/g, '')]) return PLACE_EN[up.replace(/[\s\-]/g, '')];
    const n = normPlace(tok);
    if (PLACES.includes(n)) return n;
    for (const p of PLACES) if (n.startsWith(p) || n.endsWith(p)) return p;
    return null;
  }
  // 같은 도시 안의 역/터미널/공항은 같은 곳으로 본다 (예: 서울역·수서역, 동대구·대구)
  const CITY = {
    서울: ['서울', '용산', '수서', '영등포', '청량리', '상봉', '동서울', '센트럴시티', '서울경부', '서울남부', '남부', '김포'],
    부산: ['부산', '구포', '김해', '부산종합', '노포', '사상', '해운대'],
    대구: ['대구', '동대구', '서대구'],
    대전: ['대전', '서대전'],
    광주: ['광주', '광주송정'],
    여수: ['여수', '여수엑스포', '여천'],
    경주: ['경주', '신경주', '포항경주'],
    창원: ['창원', '창원중앙', '마산'],
  };
  const cityOf = p => { for (const c in CITY) if (CITY[c].includes(p)) return c; return p; };
  function samePlace(a, b) {
    const x = normPlace(a), y = normPlace(b);
    if (!x || !y) return true; // 비교 불가 → 불일치로 보지 않음
    if (x === y || x.includes(y) || y.includes(x)) return true;
    const px = matchPlace(x), py = matchPlace(y);
    return !!(px && py && cityOf(px) === cityOf(py));
  }

  // ───────────────────────── 날짜 ─────────────────────────
  const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

  // OCR이 연도에 숫자를 하나 더 붙이는 경우 보정 (예: 20226-04-16 → 2026-04-16)
  function fixOcrYear(text) {
    const cur = new Date().getFullYear();
    return text.replace(/(?<!\d)(2\d{4})(?=\s*[.\-\/]\s*\d{1,2}\s*[.\-\/]\s*\d{1,2})/g, y5 => {
      let best = null;
      for (let i = 1; i < 5; i++) {
        const y = +(y5.slice(0, i) + y5.slice(i + 1));
        if (y >= 2015 && y <= cur + 2 && (!best || Math.abs(y - cur) < Math.abs(best - cur))) best = y;
      }
      return best ? String(best) + ' ' : y5;
    });
  }

  function findDates(text, refYear) {
    text = fixOcrYear(text);
    const out = [];
    const used = [];
    const overlaps = (s, e) => used.some(([a, b]) => s < b && e > a);
    const push = (y, m, d, idx, len) => {
      y = +y; m = +m; d = +d;
      if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return;
      if (overlaps(idx, idx + len)) return;
      used.push([idx, idx + len]);
      out.push({ date: `${y}-${p2(m)}-${p2(d)}`, idx, len });
    };
    let m;
    const re1 = /(20\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})(?!\d)/g;
    while ((m = re1.exec(text))) push(m[1], m[2], m[3], m.index, m[0].length);
    const re2 = /(?<![\d.\/\-])(\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?![\d:])/g;
    while ((m = re2.exec(text))) push(2000 + +m[1], m[2], m[3], m.index, m[0].length);
    const re5 = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g; // 20261012 (8자리)
    while ((m = re5.exec(text))) push(m[1], m[2], m[3], m.index, m[0].length);
    const ry = refYear || guessYear(out) || new Date().getFullYear();
    const re3 = /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    while ((m = re3.exec(text))) push(ry, m[1], m[2], m.index, m[0].length);
    const re4 = /(?<![\d.\/])(\d{1,2})\s*[\/.]\s*(\d{1,2})\s*\.?\s*\(\s*[월화수목금토일]/g;
    while ((m = re4.exec(text))) push(ry, m[1], m[2], m.index, m[0].length);
    const re6 = /(?<![A-Za-z\d])(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*(20\d{2}|\d{2})?(?![A-Za-z])/gi;
    while ((m = re6.exec(text))) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : ry;
      push(y, MON[m[2].toUpperCase()], m[1], m.index, m[0].length);
    }
    const re7 = /(?<![A-Za-z])(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s*(\d{1,2}),?\s*(20\d{2})/gi;
    while ((m = re7.exec(text))) push(m[3], MON[m[1].toUpperCase()], m[2], m.index, m[0].length);
    return out.sort((a, b) => a.idx - b.idx);
  }
  function guessYear(dates) {
    const cnt = {};
    dates.forEach(d => { const y = d.date.slice(0, 4); cnt[y] = (cnt[y] || 0) + 1; });
    const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    return best ? +best : null;
  }
  const preCtx = (text, idx, n = 22) => compact(text.slice(Math.max(0, idx - n), idx));

  const PURCHASE_CTX = /(결제|발권|구매|승인|발행|예매일|예약일|거래|출력|인쇄|조회|주문|입금|환불|취소|작성|등록|발급|시행일|기준일|조사일|생성|issu|print|(approval|payment|reservation|booking|transaction|purchase|order)date)/;
  const TRAVEL_CTX = /(탑승|승차|출발|운행|이용일|여정|가는|오는|일자|날짜|date|dep|체크인|입실|일시)/;
  // '예약일자'·'결제일시'·'Payment Date'의 '일자/일시/date'는 탑승일 근거가 아님
  const PURCHASE_DATE_LABEL = /(결제|발권|구매|승인|발행|예매|예약|거래|주문|입금|환불|취소|작성|등록|발급|시행|기준|조사|생성)일(자|시)?|(approval|payment|reservation|booking|transaction|purchase|order|issue|issuing)date/g;
  const isTravelCtx = c => TRAVEL_CTX.test(c.replace(PURCHASE_DATE_LABEL, ''));

  function pickTravelDate(text, dates) {
    if (!dates.length) return { travelDate: '', payDate: '' };
    let best = null, pay = '';
    dates.forEach(d => {
      // 같은 줄 앞쪽 라벨이 가장 확실한 근거 (예: '날짜 Date 2026-10-22' vs '발급일 Issuing Date')
      const ls = text.lastIndexOf('\n', d.idx - 1) + 1;
      const label = compact(text.slice(ls, d.idx));
      // 줄에 라벨이 없으면 바로 위 두 줄을 본다 (OCR 표는 라벨이 윗줄로 떨어지는 경우가 많음)
      let ps = ls;
      for (let k = 0; k < 2 && ps > 0; k++) ps = text.lastIndexOf('\n', ps - 2) + 1;
      const c = compact(text.slice(ps, d.idx)).slice(-40);
      let s = 0;
      if (PURCHASE_CTX.test(label)) { s -= 4; if (!pay) pay = d.date; }
      else if (isTravelCtx(label)) s += 3;
      else {
        if (isTravelCtx(c)) s += 2;
        if (PURCHASE_CTX.test(c)) { s -= 3; if (!pay) pay = d.date; }
      }
      // 근거가 같으면 늦은 날짜 우선 (결제일은 보통 탑승일보다 앞섬)
      if (!best || s > best.s || (s === best.s && d.date > best.date)) best = { s, date: d.date };
    });
    return { travelDate: best.s > -2 ? best.date : '', payDate: pay || (best.s <= -2 ? best.date : '') };
  }

  // 날짜 범위 (YYYY.MM.DD ~ [YYYY.]MM.DD | DD)
  function findRanges(text, refYear) {
    const ry = refYear || new Date().getFullYear();
    const re = /(?:(20\d{2})\s*[.\-\/년]\s*)?(\d{1,2})\s*[.\/월]\s*(\d{1,2})\s*[.일]?\s*(?:\([^)\n]{0,6}\))?\s*(?:\d{1,2}\s*:\s*\d{2})?\s*(?:부터)?\s*[~∼～〜–\-]\s*(?:(20\d{2})\s*[.\-\/년]\s*)?(?:(\d{1,2})\s*[.\/월]\s*)?(\d{1,2})(?!\d)/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const y1 = +(m[1] || ry), m1 = +m[2], d1 = +m[3];
      const y2 = +(m[4] || y1), m2 = +(m[5] || m1), d2 = +m[6];
      if (m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12 || d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) continue;
      const s = `${y1}-${p2(m1)}-${p2(d1)}`, e = `${y2}-${p2(m2)}-${p2(d2)}`;
      const span = (Date.parse(e) - Date.parse(s)) / 864e5;
      if (!(span >= 0 && span <= 60)) continue;
      out.push({ start: s, end: e, idx: m.index });
    }
    return out;
  }

  // ───────────────────────── 금액/번호 ─────────────────────────
  function normAmountText(text) {
    text = text.replace(/[ \t]{2,}/g, ' '); // OCR 표의 긴 공백 때문에 '승인금액 … KRW 54,900'을 못 잇는 문제
    // '8만 8,933원' → '88,933원'
    text = text.replace(/(?<![\d,])(\d{1,4})\s*만\s*(\d{1,3}(?:,\d{3})|\d{1,4})?\s*원/g,
      (_, a, b) => (+a * 10000 + (toNum(b) || 0)).toLocaleString('en-US') + '원');
    // 라벨만 있는 줄 다음 줄에 금액만 있는 경우 ('결제금액 Amount' ↵ '59,900') 한 줄로 합침
    return text.replace(/^([^\d\n]*(?:금\s*액|amount|합\s*계|total)[^\d\n]*)\n(\s*(?:KRW|₩)?\s*\d{1,3}(?:,\d{3})+\s*원?\s*)$/gim, '$1 $2');
  }
  // 문서에 적힌 금액 전부 (주문금액·승인금액 등). 할인 등 음수 금액은 제외
  function findAllAmounts(text) {
    const out = new Set();
    for (const m of normAmountText(text).matchAll(/(?<![\d,.\-])\d{1,3}(?:,\d{3})+(?![\d,])/g)) {
      const v = toNum(m[0]);
      if (v >= 1000 && v <= 20000000) out.add(v);
    }
    return [...out];
  }
  function findAmount(text) {
    text = normAmountText(text);
    const re = /(결\s*제\s*금\s*액|승\s*인\s*금\s*액|합\s*계(?:\s*금\s*액)?|총\s*(?:결\s*제\s*)?금\s*액|총\s*액|결\s*제\s*액|받\s*[을은]\s*금\s*액|청\s*구\s*금\s*액|이\s*용\s*금\s*액|판\s*매\s*금\s*액|운\s*임|요\s*금|금\s*액|total|amount)[^\d\n]{0,20}?(\d{1,3}(?:[,.]\d{3})+|\d{3,8})(?!\d)/gi;
    const prio = l => {
      const c = compact(l);
      if (/결제|승인|합계|총/.test(c) || c === 'total') return 3;
      if (/받|청구|이용|판매/.test(c)) return 2;
      return 1;
    };
    let best = null, m;
    while ((m = re.exec(text))) {
      const v = toNum(m[2].replace(/\./g, ','));
      if (v == null || v < 100 || v > 20000000) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
      if (/^\s*[:시분]/.test(after) || /^\s*(km|㎞)/i.test(after)) continue;
      const p = prio(m[1]);
      if (!best || p > best.p || (p === best.p && v > best.v)) best = { p, v };
    }
    if (best) return best.v;
    const re2 = /(?:₩|KRW)\s*(\d{1,3}(?:,\d{3})+|\d{3,8})|(\d{1,3}(?:,\d{3})+|\d{3,8})\s*원(?![\/\s]*[lℓL리])/g;
    let mx = null;
    while ((m = re2.exec(text))) {
      const v = toNum(m[1] || m[2]);
      if (v != null && v >= 100 && v <= 20000000 && (mx == null || v > mx)) mx = v;
    }
    return mx;
  }

  function findRefs(text) {
    const refs = new Set();
    const re = /(예\s*약|예\s*매|발\s*권|승\s*차\s*권|티\s*켓|구\s*매|주\s*문|확\s*인|항\s*공\s*권|e-?\s*티\s*켓|booking|reservation|confirmation|ticket|order)\s*(?:번\s*호|no\.?|nbr|number|코\s*드|code|#)\s*[:：#.]?\s*([A-Za-z0-9](?:[A-Za-z0-9\-]|\s(?=\d)){3,30})/gi;
    let m;
    while ((m = re.exec(text))) {
      const v = normRef(m[2]);
      if (v.length >= 5 && (/\d/.test(v) || /^[A-Z]{6}$/.test(v))) refs.add(v);
    }
    const rePnr = /PNR\s*[:：#]?\s*([A-Z0-9]{5,8})/gi;
    while ((m = rePnr.exec(text))) refs.add(normRef(m[1]));
    // 표 형식 PDF는 '예약 번호' 라벨과 값이 떨어져 추출됨 → 영문+숫자 6자리 예약코드(PNR)를 따로 수집
    if (/(예\s*약|예\s*매|reservation|booking|pnr)/i.test(text)) {
      const rePnr6 = /(?<![A-Za-z0-9])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6}(?![A-Za-z0-9])/g;
      while ((m = rePnr6.exec(text))) if (!/^(KE|OZ|7C|LJ|TW|BX|RS|ZE|RF|YP|4V|4H)\d{3,4}$/.test(m[0])) refs.add(m[0]);
    }
    const reEt = /(?<!\d)(\d{3})[\s-]?(\d{10})(?!\d)/g; // 항공 e-ticket 번호
    while ((m = reEt.exec(text))) refs.add(m[1] + m[2]);
    const approvals = new Set();
    const reAp = /승\s*인\s*번\s*호\s*[:：]?\s*(\d{6,12})/g;
    while ((m = reAp.exec(text))) approvals.add(m[1]);
    return { refs: [...refs], approvals: [...approvals] };
  }

  function refsMatch(a, b) {
    for (const x of a || []) for (const y of b || []) {
      const p = normRef(x), q = normRef(y);
      if (!p || !q) continue;
      if (p === q) return true;
      if (Math.min(p.length, q.length) >= 6 && (p.includes(q) || q.includes(p))) return true;
      if (ocrNear(p, q)) return true;
    }
    return false;
  }
  // 긴 숫자 번호(항공권번호 등)를 OCR이 한 자리 잘못 읽은 경우 (9882… → 9832…).
  // 같은 예약의 연번 항공권은 끝자리만 다르므로 끝 2자리가 다르면 다른 번호로 본다
  function ocrNear(p, q) {
    if (p.length !== q.length || p.length < 10 || !/^\d+$/.test(p + q)) return false;
    const diff = [...p].map((c, i) => c !== q[i] ? i : -1).filter(i => i >= 0);
    return diff.length === 1 && diff[0] < p.length - 2;
  }

  // ───────────────────────── 구간(출발→도착) ─────────────────────────
  // OCR은 괄호 속 공항코드를 자주 틀림(CJU→CIU, GMP→6MP) → 한 글자 차이까지는 공항코드로 인정
  const IATA_OCR = { 0: 'O', 1: 'I', 5: 'S', 6: 'G', 8: 'B' };
  function fuzzyIata(tok) {
    if (!/^[A-Z0-9]{3}$/.test(tok)) return null; // 공항코드는 대문자 (영문 단어 'the' 등 제외)
    const up = tok.replace(/[01568]/g, c => IATA_OCR[c]);
    if (!/^[A-Z]{3}$/.test(up)) return null;
    if (IATA[up]) return IATA[up];
    const near = Object.keys(IATA).filter(k => [...k].filter((c, i) => c !== up[i]).length === 1);
    return near.length === 1 ? IATA[near[0]] : null;
  }
  const AIRPORT_NAMES = new Set(Object.values(IATA));
  function placeOfWord(w) {
    const hits = w.split('/').map(p => normPlace(p.replace(/(발|행)$/, ''))).filter(p => PLACES.includes(p));
    // '서울/김포'처럼 도시와 공항이 같이 오면 공항 이름을 쓴다
    return hits.find(h => AIRPORT_NAMES.has(h)) || hits[hits.length - 1] || null;
  }
  const ROUTE_LABEL = /(구\s*간|여\s*정|노\s*선|route|itinerary)/i;
  const ROUTE_SEP = /(→|->|=>|>|⇒|➔|➜|➝|⟶|▶|►|▷|〉|~|－|—|–|―|ㅡ|一|-)/;
  // 한 줄에서 장소를 순서대로 뽑는다. '제주(CJU)', '서울 / 김포 /SEL(GMP)'처럼 괄호·빗금으로 붙은 이름은
  // 같은 장소로 합치고, 그중 공항 이름이 있으면 공항 이름을 쓴다
  function placesInLine(line) {
    const items = [];
    const re = /[가-힣]+(?:\/[가-힣]+)*|[A-Za-z0-9]+/g;
    let m;
    while ((m = re.exec(line))) {
      const tok = m[0];
      // 마일리지 내역의 'RSUCJU'처럼 공항코드 두 개가 붙은 구간 표기
      if (/^[A-Z]{6}$/.test(tok) && IATA[tok.slice(0, 3)] && IATA[tok.slice(3)]) {
        items.push({ place: IATA[tok.slice(0, 3)], start: m.index, end: m.index + 3, pair: true });
        items.push({ place: IATA[tok.slice(3)], start: m.index + 3, end: m.index + 6, pair: true });
        continue;
      }
      const place = /[가-힣]/.test(tok) ? placeOfWord(tok) : tok.length === 3 ? fuzzyIata(tok) : PLACE_EN[tok.toUpperCase()] || null;
      const prev = items[items.length - 1];
      if (prev && /^\s*[(\/]\s*$/.test(line.slice(prev.end, m.index))) {
        if (!prev.place || (place && AIRPORT_NAMES.has(place) && !AIRPORT_NAMES.has(prev.place))) prev.place = place || prev.place;
        prev.end = m.index + tok.length;
        continue;
      }
      items.push({ place, start: m.index, end: m.index + tok.length });
    }
    const out = [];
    for (const it of items) if (it.place && (!out.length || out[out.length - 1].place !== it.place)) out.push(it);
    return out;
  }
  function findRouteByLine(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ps = placesInLine(lines[i]);
      if (ps.length < 2) continue;
      const near = [lines[i - 1], lines[i], lines[i + 1]].some(l => l && ROUTE_LABEL.test(l));
      const sep = ROUTE_SEP.test(lines[i].slice(ps[0].end, ps[1].start));
      if (near || sep || (ps[0].pair && ps[1].pair)) return { from: ps[0].place, to: ps[1].place };
    }
    return null;
  }

  function findRoute(text) {
    const byLine = findRouteByLine(text);
    if (byLine) return byLine;
    const tc = text.replace(/([가-힣]) (?=[가-힣])/g, '$1');
    let m;
    const reArrow = /([가-힣A-Za-z()]{2,14})\s*(?:\(?\d{1,2}\s*:\s*\d{2}\)?\s*)?(?:→|->|=>|>>|⇒|➔|➜|➝|⟶|▶|►|▷|>|〉|~|－|-|—|–|―|ㅡ|一)\s*([가-힣A-Za-z()]{2,14})/g;
    while ((m = reArrow.exec(tc))) {
      const a = matchPlace(m[1]), b = matchPlace(m[2]);
      if (a && b && a !== b) return { from: a, to: b };
      reArrow.lastIndex = m.index + m[1].length; // 연속 패턴(A→B→C) 대응
    }
    const take = re => {
      let r; re.lastIndex = 0;
      while ((r = re.exec(tc))) { const p = matchPlace(r[1]); if (p) return p; }
      return null;
    };
    const from = take(/출\s*발(?:역|지|공항|터미널)?\s*[:：]?\s*([가-힣A-Z]{2,14})/g);
    const to = take(/도\s*착(?:역|지|공항|터미널)?\s*[:：]?\s*([가-힣A-Z]{2,14})/g);
    if (from && to && from !== to) return { from, to };
    const codes = [];
    const reCode = new RegExp('\\b(' + Object.keys(IATA).join('|') + ')\\b', 'g');
    while ((m = reCode.exec(text.toUpperCase()))) {
      const c = IATA[m[1]];
      if (!codes.length || codes[codes.length - 1] !== c) codes.push(c);
      if (codes.length === 2) return { from: codes[0], to: codes[1] };
    }
    return { from: from || '', to: to || '' };
  }

  function findTimes(text) {
    const out = [];
    const re = /(?<![\d:])([01]?\d|2[0-3])\s*:\s*([0-5]\d)(:[0-5]\d)?(?![\d:])/g;
    // 초까지 있는 시각(21:05:57)은 대개 결제 시각 → 초 없는 시각이 하나도 없을 때만 쓴다 (이스타 '2026-10-27 16:40:00' 등)
    const withSec = [];
    // 휴대폰 캡처 첫 줄(상태표시줄)의 현재 시각은 제외
    const first = /^\s*([^\n]*)/.exec(text);
    const statusEnd = first && !/[가-힣]/.test(first[1]) ? first[0].length : 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index < statusEnd) continue;
      const c = preCtx(text, m.index, 25);
      if (/(결제|승인|거래|발행|출력|조회|인쇄|발권|구매|주문|예매일|approval|payment|transaction)/.test(c)) continue;
      (m[3] ? withSec : out).push(`${p2(m[1])}:${m[2]}`);
    }
    return out.length ? out : withSec;
  }

  function findVehicle(text) {
    const t = fixFlightOcr(text).replace(/\b(oz|ke)(?=\s?\d{2,4}\b)/gi, s => s.toUpperCase());
    let m = /\b(KE|OZ|7C|LJ|TW|BX|RS|ZE|RF|YP|4V|4H)\s?(\d{2,4})\b/.exec(t);
    // '편명:ZE284'의 항공사 코드를 OCR이 '가284'처럼 깨뜨린 경우: 문서의 항공사로 코드를 채움
    // (예매 목록 캡처에서 깨진 첫 편 대신 아래쪽 다른 예약의 편명을 집는 문제)
    const lb = /편\s*명\s*[:：]\s*([^\d\s:：]{1,2})\s?(\d{3,4})(?!\d)/.exec(t);
    if (lb && !AIRLINE_CODE[lb[1].toUpperCase()] && (!m || lb.index < m.index)) {
      const code = Object.keys(AIRLINE_CODE).find(k => AIRLINE_CODE[k] === airlineOf('', text));
      if (code) return code + lb[2];
    }
    if (m) return m[1] + m[2];
    m = /(KTX-?산천|KTX-?이음|KTX|SRT|ITX-?새마을|ITX-?청춘|ITX-?마음|새마을호?|무궁화호?|누리로)\s*-?\s*(\d{1,4})?(?!\d)/i.exec(text);
    if (m) return (m[1].toUpperCase() + (m[2] ? ' ' + m[2] : '')).trim();
    return '';
  }

  // ───────────────────────── 숙박 ─────────────────────────
  function findLodgingDates(text, dates) {
    const IN = /(체크인|check-?in|입실|투숙일|숙박일|이용일|도착일)/g;
    const OUT = /(체크아웃|check-?out|퇴실|출발일)/g;
    let checkin = '', checkout = '';
    for (const d of dates) {
      const c = preCtx(text, d.idx, 32);
      const li = lastIdx(c, IN), lo = lastIdx(c, OUT);
      if (li < 0 && lo < 0) continue;
      if (lo > li) { if (!checkout) checkout = d.date; } else if (!checkin) checkin = d.date;
    }
    const nm = /(\d{1,2})\s*박/.exec(text);
    const nights = nm ? +nm[1] : null;
    if (!checkin || !checkout) {
      const r = findRanges(text, guessYear(dates))[0];
      if (r) { checkin = checkin || r.start; checkout = checkout || r.end; }
    }
    if (checkin && !checkout && nights) checkout = addDays(checkin, nights);
    if (!checkin && !checkout) {
      const ds = [...new Set(dates.filter(d => !PURCHASE_CTX.test(preCtx(text, d.idx))).map(d => d.date))].sort();
      if (ds.length >= 2) { checkin = ds[0]; checkout = ds[ds.length - 1]; }
    }
    return { checkin, checkout, nights };
  }
  function lastIdx(str, re) {
    let i = -1, m; re.lastIndex = 0;
    while ((m = re.exec(str))) i = m.index;
    return i;
  }
  function addDays(d, n) {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function findLodgingName(text) {
    const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean);
    for (const l of lines) {
      if (/(주소|address|사업자|tel|전화)/i.test(l)) continue;
      if (/(호텔|hotel|리조트|resort|모텔|펜션|게스트하우스|레지던스|스테이|\binn\b|콘도)/i.test(l) && l.length <= 50)
        return l.replace(/^(상품명|숙소명|숙박업소|호텔명|가맹점명)\s*[:：]?\s*/, '').replace(/\s{2,}/g, ' ');
    }
    return '';
  }

  // ───────────────────────── 자차 ─────────────────────────
  function findKm(text) {
    const t = text.replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');
    let m = /(총\s*거\s*리|주\s*행\s*거\s*리|거\s*리)\s*[:：]?\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:km|㎞|킬로)/i.exec(t);
    if (m) return +m[2];
    m = /(\d{1,4}(?:\.\d{1,2})?)\s*(?:km|㎞|킬로)/i.exec(t);
    return m ? +m[1] : null;
  }
  function findToll(text) {
    const m = /통\s*행\s*료[^\d\n]{0,10}(\d{1,3}(?:,\d{3})+|\d{3,6})\s*원?/.exec(text);
    return m ? toNum(m[1]) : null;
  }
  function findFuel(text) {
    const re = /(보통\s*휘\s*발\s*유|고급\s*휘\s*발\s*유|휘\s*발\s*유|자동차용\s*경\s*유|경\s*유|LPG|부탄)[^\d\n]{0,25}(\d,?\d{3}(?:\.\d{1,2})?)/gi;
    let m;
    while ((m = re.exec(text))) {
      const v = toNum(m[2]);
      if (v >= 500 && v <= 3500) {
        const k = compact(m[1]);
        const type = k.includes('경유') ? '경유' : (k.includes('lpg') || k.includes('부탄')) ? 'LPG' : '휘발유';
        return { fuelType: type, fuelPrice: v };
      }
    }
    return { fuelType: '', fuelPrice: null };
  }

  // ───────────────────────── 공문 ─────────────────────────
  function findOfficial(text, dates) {
    const ranges = findRanges(text, guessYear(dates));
    let r = ranges.find(x => /(기간|일시|일정|교육일|연수일|일자|기한|날짜)/.test(preCtx(text, x.idx, 30))) || ranges[0];
    let periodStart = r ? r.start : '', periodEnd = r ? r.end : '';
    if (!r) {
      const d = dates.find(x => /(기간|일시|일정|교육일|일자)/.test(preCtx(text, x.idx, 30)));
      if (d) periodStart = periodEnd = d.date;
    }
    let title = '';
    const tm = /제\s*목\s*[:：]?\s*([^\n]{2,80})/.exec(text);
    if (tm) title = tm[1].trim();
    else {
      const l = text.split('\n').map(s => s.trim()).find(s => /(과정|교육|연수|워크숍|세미나|회의)/.test(s) && s.length <= 80);
      title = l || '';
    }
    return { periodStart, periodEnd, title };
  }

  // 마일리지/포인트 적립일: 조회기간(~ 범위)·소멸/만료일은 제외
  function findEarnDates(text, dates) {
    const out = [];
    for (const d of dates) {
      // 라벨은 같은 줄이나 바로 윗줄(라벨만 있는 줄)에서 찾는다. 위의 안내문('…상세내역 조회 결과입니다')은 라벨이 아님
      const ls = text.lastIndexOf('\n', d.idx - 1) + 1;
      const prevLine = compact(text.slice(text.lastIndexOf('\n', ls - 2) + 1, ls));
      const before = compact(text.slice(ls, d.idx));
      const label = before + (prevLine.length <= 12 ? '|' + prevLine : '');
      const after = compact(text.slice(d.idx + d.len, d.idx + d.len + 8));
      if (/(소멸|만료|유효|날짜선택|조회|기간)/.test(label) || /~$/.test(before) ||/^(\([월화수목금토일]\))?~/.test(after)) continue;
      if (!out.includes(d.date)) out.push(d.date);
    }
    return out;
  }

  // 적립 포인트/마일리지: '+ 3,994P', '적립 마일리지 165' 등 (보유·사용가능 잔액은 제외)
  function findPoints(text) {
    const unit = u => /p|포인트/i.test(u) ? 'P' : '마일';
    let m = /\+\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(P|포인트|마일리지|마일|miles?)(?![A-Za-z])/i.exec(text);
    if (m) return `${Number(m[1].replace(/,/g, '')).toLocaleString('ko-KR')}${unit(m[2])}`;
    m = /적\s*립\s*(?:마\s*일\s*리\s*지|포\s*인\s*트|마\s*일)?\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(P|포인트|마일리지|마일|miles?)?/i.exec(text);
    if (m) return `${Number(m[1].replace(/,/g, '')).toLocaleString('ko-KR')}${m[2] ? unit(m[2]) : /포인트|point/i.test(text) ? 'P' : '마일'}`;
    m = /(?:탑\s*승|적\s*립)\s*(마\s*일\s*리\s*지|마\s*일|포\s*인\s*트)\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)/.exec(text);
    if (m) return `${Number(m[2].replace(/,/g, '')).toLocaleString('ko-KR')}${unit(m[1])}`;
    return '';
  }

  // ───────────────────────── 분류 ─────────────────────────
  function classify(text, filename, ext) {
    const c = compact(text);
    const fn = compact(filename);
    const modeScore = {};
    const cm = c.replace(/유니버스/g, ''); // 야놀자 운영사 '놀유니버스'의 '버스'는 교통수단이 아님
    for (const k in MODE_KW) modeScore[k] = countKw(cm, MODE_KW[k]) + countKw(fn, MODE_KW[k]) * 2;
    const mode = Object.keys(modeScore).sort((a, b) => modeScore[b] - modeScore[a])[0];
    const modeBest = modeScore[mode];
    const hasKm = /\d\s*(km|㎞)/i.test(text);

    const s = {
      transport: modeBest * 2 + countKw(c, TRANSPORT_GENERIC),
      lodging: countKw(c, LODGING_KW) * 2 + (/\d\s*박/.test(text) ? 1 : 0),
      car: hasKm ? 2 + countKw(c, CAR_KW) * 2 : countKw(c, CAR_KW),
      fuel: countKw(c, FUEL_KW) * 2 + (/\d[,.]?\d{3}\s*(원\s*\/\s*[lℓL리])/.test(text) ? 2 : 0),
      official: countKw(c, OFFICIAL_KW) + (/^hwpx?$/.test(ext) ? 8 : 0),
      mileage: (n => n >= 2 ? n * 4 : n * 2)(countKw(c, MILEAGE_KW)) + (countKw(fn, FN_MILEAGE) ? 10 : 0) +
        // '2026.10.23 OZ8199 RSUCJU +109' 같은 적립 행이 여러 줄이면 적립내역 화면
        ((text.match(/20\d{2}\s*[.\-\/]\s*\d{1,2}\s*[.\-\/]\s*\d{1,2}[^\n]*\+\s*\d[\d,]*\s*$/gm) || []).length >= 2 ? 6 : 0),
    };
    for (const k in FN_HINT) if (countKw(fn, FN_HINT[k])) s[k] += 6;
    // 지도 캡처에도 '버스','도착' 등이 섞이므로 km+지도 키워드가 강하면 자차 우선
    if (hasKm && countKw(c, CAR_KW) >= 2) s.car += 3;

    const ranked = Object.keys(s).sort((a, b) => s[b] - s[a]);
    const top = ranked[0];
    const confidence = s[top] - s[ranked[1]];
    if (s[top] < 2) return { docType: 'other', mode: '', scores: s, confidence: 0 };

    let docType = top;
    if (top === 'transport' || top === 'lodging') {
      // 예약내역 화면 아래의 '영수증 조회하기' 같은 버튼 글자는 영수증 근거가 아님
      const cr = c.replace(/영수증(조회|보기|발급|출력|확인)(하기)?/g, '');
      const r = countKw(cr, RECEIPT_KW) + countKw(fn, FN_RECEIPT) * 5;
      const k = countKw(c, top === 'transport' ? CONFIRM_TR_KW : LODGING_CONFIRM_KW) + countKw(fn, FN_CONFIRM) * 5;
      let role = r > k ? 'receipt' : 'confirm';
      if (r === k && /(승인번호|카드번호|매출전표)/.test(c)) role = 'receipt';
      docType = `${top}_${role}`;
    } else if (top === 'car') docType = 'car_distance';
    else if (top === 'fuel') docType = 'car_fuel';
    else if (top === 'mileage') docType = 'mileage';
    return { docType, mode: top === 'transport' && modeBest > 0 ? mode : '', scores: s, confidence };
  }

  // ───────────────────────── 메인 ─────────────────────────
  function analyzeText(text, opts = {}) {
    text = (text || '').replace(/\r/g, '');
    const filename = opts.filename || '';
    const ext = (opts.ext || '').toLowerCase();
    const cls = classify(text, filename, ext);
    const dates = findDates(text, opts.refYear);
    const { travelDate, payDate } = pickTravelDate(text, dates);
    const route = findRoute(text);
    const times = findTimes(text);
    const { refs, approvals } = findRefs(text);
    const lod = findLodgingDates(text, dates);
    const earnDates = cls.docType === 'mileage' ? findEarnDates(text, dates) : [];
    const fuel = findFuel(text);
    const off = findOfficial(text, dates);
    let mode = cls.mode;
    if (!mode && cls.docType.startsWith('transport')) mode = 'etc';

    return {
      docType: cls.docType,
      confidence: cls.confidence,
      scores: cls.scores,
      mode,
      date: cls.docType.startsWith('lodging') ? (lod.checkin || travelDate) : cls.docType === 'mileage' ? (earnDates[0] || travelDate) : travelDate,
      earnDates,
      points: cls.docType === 'mileage' ? findPoints(text) : '',
      allDates: [...new Set(dates.map(d => d.date))],
      payDate,
      time: times[0] || '',
      arrTime: times[1] || '',
      from: route.from,
      to: route.to,
      vehicleNo: findVehicle(text),
      flights: findFlights(text),
      airline: (cls.mode === 'air' || cls.docType === 'mileage') ? airlineOf(findVehicle(text), text) : '',
      refs,
      approvals,
      amount: findAmount(text),
      amounts: findAllAmounts(text),
      checkin: lod.checkin,
      checkout: lod.checkout,
      nights: lod.nights,
      lodgingName: findLodgingName(text),
      km: findKm(text),
      toll: findToll(text),
      fuelType: fuel.fuelType,
      fuelPrice: fuel.fuelPrice,
      periodStart: off.periodStart,
      periodEnd: off.periodEnd,
      title: off.title,
    };
  }

  const api = { analyzeText, classify, findDates, findRanges, findAmount, findRefs, refsMatch, findRoute, findKm,
    findFuel, normPlace, samePlace, matchPlace, normRef, addDays, compact, airlineOf, findFlights };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Extract = api;
})(typeof window !== 'undefined' ? window : globalThis);
