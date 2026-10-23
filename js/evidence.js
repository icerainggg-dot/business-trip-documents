/*
 * 증빙서류 생성 (HWPX / PDF)
 *  - 분석 결과 → 표 레이아웃(머리행 + 영수증|확인서 캡처행) → HWPX(OWPML) 또는 PDF(페이지 이미지)
 *  - 서식: sample/output_sample.hwp 기준 (A4, 좌우 30mm, 2열 표)
 */
(function (global) {
  'use strict';
  const { MODE_LABEL } = global.Analyze;

  // ───────────────────────── 페이지 규격 (mm) ─────────────────────────
  const PAGE = { w: 210, h: 297, left: 20, right: 20, top: 25, bottom: 25 }; // top=위15+머리말10, bottom=아래15+꼬리말10
  const BODY_W = PAGE.w - PAGE.left - PAGE.right;          // 170mm
  const BODY_H = PAGE.h - PAGE.top - PAGE.bottom;          // 247mm
  const CELL_PAD_X = 1.8, CELL_PAD_Y = 0.5;                // hp:cellMargin 510/141
  const IMG_MAX_W = BODY_W / 2 - CELL_PAD_X * 2;           // 약 81.4mm
  const IMG_MAX_H_PAIR = 100;                              // 출발·도착 두 구간이 한 쪽에 들어가도록
  const CELL_MAX_H = 222;
  const HU = 7200 / 25.4;                                  // 1mm = 283.46 HWPUNIT
  const MODE_WORD = { air: '항공편', rail: '열차편', bus: '버스편', etc: '교통편' };

  // ───────────────────────── 캡처 이미지 준비 ─────────────────────────
  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('이미지 로드 실패')); i.src = src; });
  }
  // 여백(흰 영역) 잘라내기
  function trim(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0 || (x1 - x0) < w * 0.1 || (y1 - y0) < h * 0.05) return c;
    const pad = Math.round(Math.max(w, h) * 0.015);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w, x1 + pad); y1 = Math.min(h, y1 + pad);
    const o = document.createElement('canvas');
    o.width = x1 - x0; o.height = y1 - y0;
    o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    return o;
  }
  function textPage(text) {
    const c = document.createElement('canvas');
    c.width = 1240; c.height = 1754;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#111'; g.font = '28px "Malgun Gothic", "맑은 고딕", sans-serif';
    let y = 90;
    for (const line of wrap(g, text || '', c.width - 160)) { if (y > c.height - 80) break; g.fillText(line, 80, y); y += 44; }
    return c;
  }
  async function capturesOf(doc) {
    let srcs = [];
    if (doc.pages && doc.pages.length) srcs = doc.pages;
    else if (doc.previewUrl) srcs = [doc.previewUrl];
    const out = [];
    for (const s of srcs) out.push(trim(await loadImg(s)));
    if (!out.length) out.push(trim(textPage(doc.text || doc.name)));
    return out.map(cv => ({ canvas: cv, w: cv.width, h: cv.height, name: doc.name }));
  }

  // ───────────────────────── 레이아웃 모델 ─────────────────────────
  // table = { rows: [ {type:'head', title, remark} | {type:'pair', cells:[[docs]|{empty}, ...], maxH} ] }
  function buildModel(res, opts) {
    const tables = [];
    const used = new Map(); // receipt id → 처음 실린 구간 제목
    const T = [];
    const dirs = [['out', '출발', res.out, opts.remarkOut], ['local', '경유', res.local, ''], ['back', '도착', res.back, opts.remarkBack]];
    for (const [, dname, legs, remark] of dirs) {
      if (!legs.length) { if (remark) T.push({ type: 'head', title: dname, remark }); continue; }
      legs.forEach((l, i) => {
        const title = `${dname} ${MODE_WORD[l.mode] || '교통편'}${legs.length > 1 ? ` (${i + 1}구간)` : ''}`;
        T.push({ type: 'head', title, remark: i === 0 ? remark : '' });
        const left = l.receipts.length ? l.receipts.map(r => used.has(r.id) ? { note: `(${used.get(r.id)} 영수증과 동일)` } : (used.set(r.id, title), { doc: r })) : [{ note: '(영수증 미제출)' }];
        const right = l.confirm ? [{ doc: l.confirm }] : [{ note: '(탑승확인서 미제출)' }];
        T.push({ type: 'pair', cells: [left, right] });
      });
    }
    if (T.length) tables.push({ rows: T });
    // 마일리지 확인서: 출발·도착 항공 증빙 바로 다음 표
    if ((res.mileageDocs || []).length) {
      const docs = res.mileageDocs;
      // 머리행 둘째 줄: 확인서별 적립일·포인트 (연결된 항공편이 있으면 편명도)
      const info = docs.map(m => {
        const fl = [...new Set(res.legs.filter(l => l.mileage === m).map(l => l.vehicleNo).filter(Boolean))];
        return [fl.join(', '), m.f.date ? `적립일 ${m.f.date.replace(/-/g, '.')}` : '', m.f.points ? `적립 ${m.f.points}` : ''].filter(Boolean).join(' · ');
      }).filter(Boolean).join('\n');
      tables.push({ rows: [{ type: 'head', title: '마일리지 확인서', remark: info }, { type: 'spread', docs }] });
    }

    if (res.lodgings.length) {
      const rows = [];
      res.lodgings.forEach((L, i) => {
        rows.push({ type: 'head', title: '숙박' + (res.lodgings.length > 1 ? ` (${i + 1})` : '') });
        rows.push({ type: 'pair', cells: [L.receipt ? [{ doc: L.receipt }] : [{ note: '(영수증 미제출)' }], L.confirm ? [{ doc: L.confirm }] : [{ note: '(확인서 미제출)' }]] });
      });
      tables.push({ rows });
    }
    if (res.car) {
      const c = res.car;
      const info = [c.km ? `거리 ${c.km.toLocaleString('ko-KR')}km` : '', c.price ? `${c.fuelType || '유가'} ${c.price.toLocaleString('ko-KR')}원/L` : ''].filter(Boolean).join(', ');
      tables.push({ rows: [
        { type: 'head', title: '자차 이용' + (info ? ` (${info})` : '') },
        { type: 'pair', cells: [c.dist.length ? c.dist.map(d => ({ doc: d })) : [{ note: '(거리 캡처 미제출)' }], c.fuel.length ? c.fuel.map(d => ({ doc: d })) : [{ note: '(유가 캡처 미제출)' }]] },
      ] });
    }
    const spread = (title, docs) => {
      if (!docs.length) return;
      tables.push({ rows: [{ type: 'head', title }, { type: 'spread', docs }] });
    };
    spread('출장 공문·일정안내', res.officials);
    spread('기타 증빙', res.others);
    return tables;
  }

  // 문서 → 캡처 목록으로 치환, 이미지 크기(mm) 결정
  async function resolveModel(tables, onStep) {
    const cache = new Map();
    const caps = async d => { if (!cache.has(d.id)) { onStep && onStep(d.name); cache.set(d.id, await capturesOf(d)); } return cache.get(d.id); };
    const size = (cap, maxH) => {
      let w = IMG_MAX_W, h = w * cap.h / cap.w;
      if (h > maxH) { h = maxH; w = h * cap.w / cap.h; }
      return { ...cap, wmm: w, hmm: h };
    };
    for (const t of tables) {
      const rows = [];
      for (const r of t.rows) {
        if (r.type === 'head') { rows.push(r); continue; }
        if (r.type === 'pair') {
          const cells = [];
          for (const items of r.cells) {
            const list = [];
            for (const it of items) {
              if (it.note) list.push({ note: it.note });
              else (await caps(it.doc)).forEach(c => list.push({ cap: c }));
            }
            const n = list.filter(x => x.cap).length || 1;
            const maxH = n === 1 ? IMG_MAX_H_PAIR : Math.min(IMG_MAX_H_PAIR, (CELL_MAX_H - 2 * n) / n);
            cells.push(list.map(x => x.cap ? { img: size(x.cap, maxH) } : x));
          }
          rows.push({ type: 'pair', cells });
        } else if (r.type === 'spread') {
          // 여러 쪽 문서: 왼쪽·오른쪽 번갈아 2장씩 한 행
          const all = [];
          for (const d of r.docs) (await caps(d)).forEach(c => all.push(c));
          for (let i = 0; i < all.length; i += 2)
            rows.push({ type: 'pair', cells: [[{ img: size(all[i], 110) }], all[i + 1] ? [{ img: size(all[i + 1], 110) }] : []] });
        }
      }
      t.rows = rows;
    }
    return tables;
  }

  // ───────────────────────── HWPX ─────────────────────────
  const xesc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let idSeq = 1000;
  const nid = () => String(++idSeq * 7919 % 2000000000 + 100000);
  const CENTER = 20, CP_HEAD = 7, CP_NOTE = 8, CP_BODY = 9;

  function canvasToJpeg(cv, q = 0.9) {
    return new Promise(res => cv.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), 'image/jpeg', q));
  }

  async function toHwpx(tables, tpl) {
    const bins = [];
    const P = (inner, para = CENTER, br = 0) => `<hp:p id="${nid()}" paraPrIDRef="${para}" styleIDRef="0" pageBreak="${br}" columnBreak="0" merged="0">${inner}</hp:p>`;
    const RUN = (t, cp) => `<hp:run charPrIDRef="${cp}"><hp:t>${xesc(t)}</hp:t></hp:run>`;
    const pic = async img => {
      const n = bins.length + 1;
      bins.push({ id: `image${n}`, path: `BinData/image${n}.jpg`, data: await canvasToJpeg(img.canvas) });
      const w = Math.round(img.wmm * HU), h = Math.round(img.hmm * HU);
      const dw = img.w * 75, dh = img.h * 75; // 96dpi 기준 원본 크기
      const id = nid();
      return `<hp:run charPrIDRef="0"><hp:pic textWrap="SQUARE" textFlow="BOTH_SIDES" reverse="0" id="${id}" zOrder="${n}" numberingType="PICTURE" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}"><hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${w >> 1}" centerY="${h >> 1}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect><hp:imgClip left="0" right="${dw}" top="0" bottom="${dh}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${dw}" dimheight="${dh}"/><hc:img binaryItemIDRef="image${n}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/><hp:sz width="${w}" height="${h}" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment/></hp:pic></hp:run>`;
    };
    const FULL = Math.round(BODY_W * HU), HALF = Math.round(FULL / 2);
    const cell = (col, row, span, width, height, inner) =>
      `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="${span}" rowSpan="1"/><hp:cellSz width="${width}" height="${height}"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;

    // 글자처럼 취급(treatAsChar) 표는 쪽을 넘겨 나뉘지 않아, 한 쪽보다 큰 표는 통째로 다음 쪽으로 밀려
    // 첫 쪽이 빈 화면이 된다 → 제목마다 표를 새로 시작하고, 한 표가 본문 높이를 넘으면 이어지는 표로 나눔
    const MAX_TBL_H = Math.round(BODY_H * HU) - 1000;
    // 남은 자리에 안 들어가는 표 앞에서 직접 쪽을 나눈다 (쪽 나눔을 스스로 하지 않는 뷰어에서도 잘리지 않도록)
    const PAGE_CAP = Math.round(BODY_H * HU * 0.97);
    let used = 1300; // 첫 문단(구역 설정) 한 줄
    const place = h => { const br = used > 0 && used + h > PAGE_CAP ? 1 : 0; if (br) used = 0; used += h; return br; };
    const tableXml = rows => {
      const total = rows.reduce((s, r) => s + r.h, 0);
      const br = place(total + 300);
      return P(`<hp:run charPrIDRef="0"><hp:tbl id="${nid()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="2" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${FULL}" widthRelTo="ABSOLUTE" height="${total}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>${rows.map((r, ri) => r.xml(ri)).join('')}</hp:tbl></hp:run>`, 0, br);
    };

    let body = '';
    for (const t of tables) {
      let cur = [], curH = 0;
      const flush = () => { if (cur.length) body += tableXml(cur); cur = []; curH = 0; };
      for (const r of t.rows) {
        let row;
        if (r.type === 'head') {
          const inner = P(RUN(r.title, CP_HEAD)) + (r.remark ? String(r.remark).split(/\r?\n/).map(l => P(RUN(l, CP_NOTE))).join('') : '');
          // 줄 높이 = 글자 크기 × 줄간격 130% (제목 15pt, 비고 12pt) + 셀 위아래 여백
          const h = 282 + 1950 + (r.remark ? 1560 * String(r.remark).split(/\r?\n/).length : 0);
          row = { h, xml: ri => `<hp:tr>${cell(0, ri, 2, FULL, h, inner)}</hp:tr>` };
        } else {
          const inners = [];
          let rowH = 282;
          for (let ci = 0; ci < 2; ci++) {
            const items = r.cells[ci] || [];
            let inner = '', ch = 282;
            for (const it of items) {
              if (it.img) { inner += P(await pic(it.img)); ch += Math.round(it.img.hmm * HU) + 100; }
              else { inner += P(RUN(it.note, CP_NOTE)); ch += 1560; }
            }
            inners.push(inner || P(RUN('', CP_BODY)));
            rowH = Math.max(rowH, ch);
          }
          row = { h: rowH, xml: ri => `<hp:tr>${inners.map((inner, ci) => cell(ci, ri, 1, HALF, rowH, inner)).join('')}</hp:tr>` };
        }
        if (r.type === 'head' || curH + row.h > MAX_TBL_H) flush();
        cur.push(row); curH += row.h;
      }
      flush();
      body += P(RUN('', CP_BODY), 0);
      used = used + 1560 > PAGE_CAP ? 1560 : used + 1560; // 빈 줄 (12pt × 130%)
    }

    const section = tpl.section0.replace('</hs:sec>', body + '</hs:sec>');
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
    const hpf = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>출장비 증빙서류</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">출장비 증빙서류 취합</opf:meta><opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/>${bins.map(b => `<opf:item id="${b.id}" href="${b.path}" media-type="image/jpeg" isEmbeded="1"/>`).join('')}</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
    const rdf = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description><rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>`;
    const prv = tables.flatMap(t => t.rows.filter(r => r.type === 'head').map(r => r.title + (r.remark ? ' ' + r.remark : ''))).join('\r\n');

    const zip = new JSZip();
    const add = (name, data, opt) => zip.file(name, data, Object.assign({ createFolders: false }, opt));
    add('mimetype', 'application/hwp+zip', { compression: 'STORE' });
    add('version.xml', tpl.version);
    add('Contents/header.xml', tpl.header);
    add('Contents/section0.xml', section);
    add('Preview/PrvText.txt', prv);
    add('settings.xml', tpl.settings);
    add('META-INF/container.rdf', rdf);
    add('Contents/content.hpf', hpf);
    add('META-INF/container.xml', tpl.container);
    add('META-INF/manifest.xml', tpl.manifest);
    bins.forEach(b => add(b.path, b.data, { compression: 'STORE' }));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/hwp+zip' });
  }

  let tplCache = null;
  async function loadTemplate() {
    if (tplCache) return tplCache;
    const base = new URL('lib/hwpx-template/', location.href).href;
    // 서식이 바뀌어도 브라우저 캐시의 옛 파일을 쓰지 않도록 매번 서버에 확인 (변경 없으면 304로 빠르게 끝남)
    const get = async f => { const r = await fetch(base + f, { cache: 'no-cache' }); if (!r.ok) throw new Error(`HWPX 서식 파일(${f})을 불러오지 못했습니다`); return r.text(); };
    const [header, section0, version, settings, container, manifest] = await Promise.all(
      ['header.xml', 'section0.xml', 'version.xml', 'settings.xml', 'container.xml', 'manifest.xml'].map(get));
    return (tplCache = { header, section0, version, settings, container, manifest });
  }

  // ───────────────────────── PDF ─────────────────────────
  const DPI = 200, PX = DPI / 25.4;
  // 제목 HY헤드라인M 15pt, 그 외 휴먼명조 12pt (HWPX와 동일). PC에 없으면 비슷한 글꼴로 대체
  // HY 글꼴은 한글 이름이 옛 인코딩으로 들어 있어 브라우저는 영문 이름(HYHeadLine Medium)으로만 찾는다
  const HEAD_NAMES = ['HY헤드라인M', 'HYHeadLine Medium', 'HYHeadLine-Medium'];
  const BODY_NAMES = ['휴먼명조', 'HumanMyeongjo', 'Human Myeongjo'];
  const stack = (names, fallback) => names.map(n => `"${n}"`).join(', ') + ', ' + fallback;
  const HEAD_FONT = stack(HEAD_NAMES, '"Malgun Gothic", "맑은 고딕", sans-serif');
  const BODY_FONT = stack(BODY_NAMES, '"HYSinMyeongJo Medium", "HY신명조", "바탕", "Batang", serif');
  // 글꼴 설치 여부: 대체 글꼴 두 가지와 글자 폭이 모두 다르면 설치된 것으로 본다
  function hasFont(name) {
    const g = document.createElement('canvas').getContext('2d');
    const s = '출장비 증빙서류 가나다 ABC 123';
    return ['monospace', 'serif'].every(fb => {
      g.font = `40px ${fb}`; const a = g.measureText(s).width;
      g.font = `40px "${name}", ${fb}`; return g.measureText(s).width !== a;
    });
  }
  const missingFonts = () => [HEAD_NAMES, BODY_NAMES].filter(ns => !ns.some(hasFont)).map(ns => ns[0]);
  function wrap(g, text, maxW) {
    const out = [];
    String(text).split(/\r?\n/).forEach(par => {
      let line = '';
      for (const ch of par) {
        if (g.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch;
      }
      out.push(line);
    });
    return out;
  }

  async function toPdf(tables) {
    const W = Math.round(PAGE.w * PX), H = Math.round(PAGE.h * PX);
    const X0 = PAGE.left * PX, X1 = (PAGE.w - PAGE.right) * PX, Y0 = PAGE.top * PX, Y1 = (PAGE.h - PAGE.bottom) * PX;
    const MID = (X0 + X1) / 2;
    const pages = [];
    let cv, g, y;
    const newPage = () => {
      cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#000'; g.lineWidth = 0.12 * PX; g.textBaseline = 'top';
      pages.push(cv); y = Y0;
    };
    newPage();
    const headFont = `${15 / 72 * DPI}px ${HEAD_FONT}`, noteFont = `${12 / 72 * DPI}px ${BODY_FONT}`;
    const HEAD_LH = 6.9, BODY_LH = 5.5; // mm: 15pt·12pt × 줄간격 130%
    const headLines = r => {
      g.font = noteFont;
      return r.remark ? wrap(g, r.remark, X1 - X0 - 2 * CELL_PAD_X * PX) : [];
    };
    const headH = r => (2 * 1.2 + HEAD_LH) * PX + headLines(r).length * BODY_LH * PX;
    const cellH = items => {
      let h = 2 * CELL_PAD_Y * PX + 1.2 * PX;
      items.forEach(it => { h += it.img ? it.img.hmm * PX + 1.5 * PX : BODY_LH * PX + 0.5 * PX; });
      return Math.max(h, 7 * PX);
    };
    const pairH = r => Math.max(cellH(r.cells[0] || []), cellH(r.cells[1] || []));

    for (const t of tables) {
      for (let i = 0; i < t.rows.length; i++) {
        const r = t.rows[i];
        if (r.type === 'head') {
          const h = headH(r);
          const next = t.rows[i + 1];
          const need = h + (next && next.type === 'pair' ? Math.min(pairH(next), Y1 - Y0 - h) : 0);
          if (y + need > Y1 && y > Y0) newPage();
          g.strokeRect(X0, y, X1 - X0, h);
          g.fillStyle = '#000'; g.font = headFont; g.textAlign = 'center';
          g.fillText(r.title, (X0 + X1) / 2, y + 1.2 * PX);
          g.font = noteFont;
          headLines(r).forEach((l, k) => g.fillText(l, (X0 + X1) / 2, y + (1.2 + HEAD_LH) * PX + k * BODY_LH * PX));
          y += h;
        } else {
          const h = Math.min(pairH(r), Y1 - Y0);
          if (y + h > Y1 && y > Y0) newPage();
          g.strokeRect(X0, y, X1 - X0, h);
          g.beginPath(); g.moveTo(MID, y); g.lineTo(MID, y + h); g.stroke();
          [0, 1].forEach(ci => {
            const items = r.cells[ci] || [];
            const cx = ci === 0 ? (X0 + MID) / 2 : (MID + X1) / 2;
            let yy = y + (h - cellH(items)) / 2 + CELL_PAD_Y * PX + 0.6 * PX;
            items.forEach(it => {
              if (it.img) {
                const iw = it.img.wmm * PX, ih = it.img.hmm * PX;
                g.drawImage(it.img.canvas, cx - iw / 2, yy, iw, ih);
                yy += ih + 1.5 * PX;
              } else {
                g.font = noteFont; g.fillStyle = '#c0262d'; g.textAlign = 'center';
                g.fillText(it.note, cx, yy + 0.5 * PX); g.fillStyle = '#000';
                yy += BODY_LH * PX + 0.5 * PX;
              }
            });
          });
          y += h;
        }
      }
      y += 6 * PX; // 표 사이 빈 줄
    }

    const jpgs = [];
    for (const p of pages) jpgs.push({ data: await canvasToJpeg(p, 0.88), w: p.width, h: p.height });
    return new Blob([buildPdf(jpgs)], { type: 'application/pdf' });
  }

  // JPEG 페이지 이미지로 PDF 작성 (외부 라이브러리 없이)
  function buildPdf(pages) {
    const enc = new TextEncoder();
    const parts = [], offsets = [];
    let len = 0;
    const push = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    const PW = 595.28, PH = 841.89;
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
    pages.forEach((p, i) => {
      const n = 3 + i * 3;
      const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
      obj(n, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`));
      obj(n + 1, () => { push(`<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream'); });
      obj(n + 2, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.data.length} >>\nstream\n`);
        push(p.data); push('\nendstream');
      });
    });
    const total = 3 + pages.length * 3;
    const xref = len;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    const out = new Uint8Array(len);
    let o = 0;
    parts.forEach(b => { out.set(b, o); o += b.length; });
    return out;
  }

  // ───────────────────────── 외부 API ─────────────────────────
  async function generate(format, res, opts, onStep) {
    const model = await resolveModel(buildModel(res, opts || {}), onStep);
    if (!model.length) throw new Error('증빙서류에 넣을 문서가 없습니다');
    if (format === 'hwpx') return toHwpx(model, await loadTemplate());
    return toPdf(model);
  }

  global.Evidence = { generate, buildModel, missingFonts };
})(window);
