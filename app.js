/* =========================================================================
   静的 HTML SVG エディタ
   長方形 / 直線 / テキスト（フォント・サイズ・長体・カーニング・外側縁取り）
   SVG / PNG / JPEG 書き出し、SVG 読み込み
   ========================================================================= */
'use strict';

const NS = 'http://www.w3.org/2000/svg';
const $  = (id) => document.getElementById(id);

const svg     = $('canvas');
const layer   = $('layer');
const overlay = $('overlay');
const bgRect  = $('bg');

let tool     = 'select';
let selected = null;
let drag     = null;      // ドラッグ中の状態
let suppress = false;     // パネル→要素の反映抑止フラグ
let uid      = 0;

/* ---------------------------------------------------------------- ログ */
const logBox = $('logBox');
function log(msg, isErr) {
  const d  = new Date();
  const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  const el = document.createElement('div');
  el.innerHTML = `<span class="t">[${ts}]</span> <span class="${isErr ? 'e' : ''}"></span>`;
  el.lastChild.textContent = msg;
  logBox.appendChild(el);
  logBox.scrollTop = logBox.scrollHeight;
}
$('btnCopyLog').addEventListener('click', async () => {
  const text = [...logBox.children].map(n => n.textContent).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('ログをクリップボードにコピーしました');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    log('ログをコピーしました（フォールバック）');
  }
});
$('btnClearLog').addEventListener('click', () => { logBox.innerHTML = ''; log('ログをクリアしました'); });

/* ------------------------------------------------------------ 座標変換 */
function toSvgPoint(evt) {
  const p = svg.createSVGPoint();
  p.x = evt.clientX; p.y = evt.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}
function snap(v) {
  if (!$('snapChk').checked) return v;
  const g = Math.max(2, +$('gridSize').value || 20);
  return Math.round(v / g) * g;
}
function zoomFactor() { return (+$('zoom').value || 100) / 100; }

/* -------------------------------------------------------------- 履歴 */
const history = [];
let histIdx = -1;
function pushHistory(label) {
  const snapshot = layer.innerHTML;
  if (histIdx >= 0 && history[histIdx] === snapshot) return;
  history.splice(histIdx + 1);
  history.push(snapshot);
  if (history.length > 100) history.shift();
  histIdx = history.length - 1;
  if (label) log(`履歴: ${label}（${histIdx + 1} 件目）`);
  if (typeof scheduleSave === 'function') scheduleSave();
}
function applyHistory(i) {
  histIdx = i;
  layer.innerHTML = history[i];
  select(null);
  scheduleSave();
}
function undo() {
  if (histIdx <= 0) { log('これ以上元に戻せません'); return; }
  applyHistory(histIdx - 1); log('元に戻しました');
}
function redo() {
  if (histIdx >= history.length - 1) { log('これ以上やり直せません'); return; }
  applyHistory(histIdx + 1); log('やり直しました');
}

/* ---------------------------------------------------------- ツール切替 */
document.querySelectorAll('.tool').forEach(b => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});
function setTool(t) {
  tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  svg.setAttribute('class', 'tool-' + t);
  log(`ツール切替: ${({select:'選択', rect:'長方形', line:'直線', text:'テキスト'})[t]}`);
}

/* ------------------------------------------------ フォント実在チェック */
/* document.fonts.check() はフォールバックを true と返す実装があるため、
   キャンバスでの実測（候補フォント + 総称フォントの幅比較）で判定する。 */
const fontProbe  = document.createElement('canvas').getContext('2d');
const PROBE_TEXT = 'あア亜漢字国ABCMWil019@';
const PROBE_SIZE = 72;
const GENERIC = new Set(['sans-serif','serif','monospace','cursive','fantasy',
                         'system-ui','ui-sans-serif','ui-serif','ui-monospace']);
const baseWidthCache = {};

function measureWith(spec) {
  fontProbe.font = `${PROBE_SIZE}px ${spec}`;
  return fontProbe.measureText(PROBE_TEXT).width;
}
function baseWidth(base) {
  if (baseWidthCache[base] === undefined) baseWidthCache[base] = measureWith(base);
  return baseWidthCache[base];
}
/** 単一ファミリ名が実際にこの環境で使えるか */
function familyExists(name) {
  if (!name) return false;
  if (GENERIC.has(name.toLowerCase())) return true;
  const q = JSON.stringify(name);                 // 日本語名・空白入り名も安全に引用
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    // フォールバックが効いた場合は総称フォントと同じ幅になる
    if (Math.abs(measureWith(`${q}, ${base}`) - baseWidth(base)) > 0.5) return true;
  }
  return false;
}
function parseStack(v) {
  return String(v).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
/** フォントスタックのうち総称以外が 1 つでも実在すれば「利用可」 */
function stackAvailable(v) {
  const named = parseStack(v).filter(f => !GENERIC.has(f.toLowerCase()));
  if (!named.length) return true;
  return named.some(familyExists);
}
const WEB_STATE_LABEL = { idle: '（Web・未取得）', loading: '（取得中…）', ready: '', error: '（取得失敗）' };
function annotateOption(o) {
  if (o.dataset.baseLabel === undefined) o.dataset.baseLabel = o.textContent;
  if (o.dataset.webfont) {                        // Web フォントは実測判定の対象外
    const st = o.dataset.webState || 'idle';
    o.dataset.available = '1';
    o.disabled = false;
    o.textContent = o.dataset.baseLabel + WEB_STATE_LABEL[st];
    o.classList.toggle('font-missing', st === 'idle' || st === 'error');
    o.style.fontFamily = st === 'ready' ? o.value : '';
    applyMissingVisibility(o);
    return true;
  }
  const ok = stackAvailable(o.value);
  o.dataset.available = ok ? '1' : '0';
  if (ok) {
    o.textContent = o.dataset.baseLabel;
    o.classList.remove('font-missing');
    o.style.fontFamily = o.value;                 // 選択肢自身をそのフォントで表示
    o.disabled = false;
  } else {
    o.textContent = o.dataset.baseLabel + '（未インストール）';
    o.classList.add('font-missing');
    o.style.fontFamily = '';
    o.disabled = o.dataset.imported !== '1';      // 読込 SVG 由来の値は選択可のまま残す
  }
  applyMissingVisibility(o);
  return ok;
}
/** 「未インストールを隠す」に応じて option / optgroup の表示を切り替える */
function applyMissingVisibility(o) {
  if (o.dataset.webfont) { o.hidden = false; return; }   // Web フォントは常に表示
  const hide = $('hideMissing').checked;
  o.hidden = hide && o.dataset.available === '0' && o.dataset.imported !== '1' && !o.selected;
}
function updateGroupVisibility() {
  [...$('fontFamily').options].forEach(applyMissingVisibility);
  $('fontFamily').querySelectorAll('optgroup').forEach(g => {
    g.hidden = ![...g.children].some(o => !o.hidden);
  });
}
$('hideMissing').addEventListener('change', () => {
  updateGroupVisibility();
  log(`未インストールのフォント: ${$('hideMissing').checked ? '非表示' : 'グレー表示'}`);
});
async function refreshFontAvailability() {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
  const sel = $('fontFamily');
  const found = [], missing = [], web = [];
  [...sel.options].forEach(o => {
    const ok = annotateOption(o);
    if (o.dataset.webfont) web.push(o.dataset.baseLabel);
    else (ok ? found : missing).push(o.dataset.baseLabel);
  });
  const cur = sel.selectedOptions[0];
  if (cur && cur.dataset.available === '0') {
    const first = [...sel.options].find(o => o.dataset.available === '1');
    if (first) { sel.value = first.value; log(`既定フォントを「${first.dataset.baseLabel}」に変更しました`); }
  }
  updateGroupVisibility();
  log(`フォント検出: 利用可 ${found.length} 件 / 未インストール ${missing.length} 件 / Web フォント ${web.length} 件`);
  if (found.length)   log(`利用可: ${found.join('、')}`);
  if (missing.length) log(`未インストール: ${missing.join('、')}`);
}

/* ---------------------------------------------- Web フォント動的取得 */
/* 画面プレビューは <link> 注入（unicode-range により必要な字形だけが落ちてくる）。
   書き出しは css2 の text= サブセットを data URI として SVG に埋め込む。
   <img> 経由のラスタライズは外部リソースを読まないため、埋め込みが必須。 */
const GF_CSS = 'https://fonts.googleapis.com/css2';
const WEBFONTS      = new Map();   // family -> { weights, option }
const webFontLoads  = new Map();   // family -> Promise
const embedCache    = new Map();   // family|weights|文字列 -> @font-face CSS

document.querySelectorAll('#fontFamily option[data-webfont]').forEach(o => {
  WEBFONTS.set(o.dataset.webfont, { weights: o.dataset.weights || '400', option: o });
  o.dataset.webState = 'idle';
});

function gfFamilyParam(family, weights) {
  return encodeURIComponent(family).replace(/%20/g, '+') + (weights ? ':wght@' + weights : '');
}
function setWebState(family, state) {
  const info = WEBFONTS.get(family);
  if (!info) return;
  info.option.dataset.webState = state;
  annotateOption(info.option);
}
/** 画面プレビュー用に Web フォントを読み込む（多重呼び出しは 1 回にまとめる） */
function ensureWebFont(family) {
  const info = WEBFONTS.get(family);
  if (!info) return Promise.resolve(false);
  if (webFontLoads.has(family)) return webFontLoads.get(family);

  const p = (async () => {
    setWebState(family, 'loading');
    log(`Web フォント取得中: ${family}`);
    const t0 = performance.now();
    const href = `${GF_CSS}?family=${gfFamilyParam(family, info.weights)}&display=swap`;
    await new Promise((res, rej) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload  = res;
      link.onerror = () => rej(new Error('CSS を取得できませんでした'));
      document.head.appendChild(link);
    });
    // 実際に字形バイナリを取りに行かせる
    const sample = ($('txtContent').value || '') + 'あア亜漢字ABC';
    await Promise.all(info.weights.split(';').map(w =>
      document.fonts.load(`${w} 48px "${family}"`, sample)));
    setWebState(family, 'ready');
    log(`Web フォント取得完了: ${family}（${Math.round(performance.now() - t0)} ms）`);
    reapplySelected();
    renderSelection();
    return true;
  })().catch(err => {
    setWebState(family, 'error');
    log(`Web フォント取得失敗: ${family} — ${err.message}（オフライン？OS フォントで続行します）`, true);
    webFontLoads.delete(family);                  // 再試行できるようにする
    return false;
  });

  webFontLoads.set(family, p);
  return p;
}
$('fontFamily').addEventListener('change', () => {
  const o = $('fontFamily').selectedOptions[0];
  if (o && o.dataset.webfont) ensureWebFont(o.dataset.webfont);
});

/* ---- 書き出し用サブセットの取得と埋め込み ---- */
function firstFamily(v) {
  if (!v) return null;
  return String(v).split(',')[0].trim().replace(/^['"]|['"]$/g, '');
}
/** キャンバス上のテキストから「Web フォント → 使用文字・使用ウェイト」を集計 */
function collectUsedWebFonts() {
  const usage = new Map();
  layer.querySelectorAll('text').forEach(t => {
    const fam = firstFamily(t.getAttribute('font-family'));
    if (!fam || !WEBFONTS.has(fam)) return;
    const u = usage.get(fam) || { chars: new Set(), weights: new Set() };
    const str = t.dataset.text !== undefined ? t.dataset.text : t.textContent;
    for (const ch of String(str)) if (ch !== '\n') u.chars.add(ch);
    const w = t.getAttribute('font-weight');
    u.weights.add(w === 'bold' ? '700' : (/^\d+$/.test(w || '') ? w : '400'));
    usage.set(fam, u);
  });
  return usage;
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {   // 分割しないと引数上限で落ちる
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
async function fetchSubsetCSS(family, weights, chars) {
  const url = `${GF_CSS}?family=${gfFamilyParam(family, weights.join(';'))}&text=${encodeURIComponent(chars)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Fonts が ${res.status} を返しました`);
  let css = await res.text();
  let bytes = 0;
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map(m => m[1]))];
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`フォント本体が ${r.status} を返しました`);
    const buf = await r.arrayBuffer();
    bytes += buf.byteLength;
    css = css.split(u).join('data:font/woff2;base64,' + toBase64(buf));
  }
  return { css, bytes };
}
/** 使用中の Web フォントを @font-face（data URI）に変換して返す */
async function buildFontFaceCSS(usage) {
  const parts = [];
  let bytes = 0;
  for (const [family, u] of usage) {
    const avail = WEBFONTS.get(family).weights.split(';');
    let weights = [...u.weights].filter(w => avail.includes(w));
    if (!weights.length) weights = [avail[0]];
    weights.sort();
    const chars = [...u.chars].sort().join('');     // 重複除去・ソートで語順情報を落とす
    const CHUNK = 700;                              // URL 長の上限対策
    for (let i = 0; i < chars.length; i += CHUNK) {
      const slice = chars.slice(i, i + CHUNK);
      const key = `${family}|${weights.join(';')}|${slice}`;
      if (embedCache.has(key)) { parts.push(embedCache.get(key)); continue; }
      const r = await fetchSubsetCSS(family, weights, slice);
      embedCache.set(key, r.css);
      parts.push(r.css);
      bytes += r.bytes;
    }
  }
  return { css: parts.join('\n'), bytes };
}
/** 読み込んだ SVG に含まれる @font-face を head に取り込む */
function injectImportedFontFaces(css) {
  let st = document.getElementById('importedFonts');
  if (!st) { st = document.createElement('style'); st.id = 'importedFonts'; document.head.appendChild(st); }
  st.textContent += '\n' + css;
  log(`読み込んだ SVG から @font-face を ${(css.match(/@font-face/g) || []).length} 件取り込みました`);
}

/* ------------------------------------------------------- プロパティ値 */
function shapeProps() {
  return {
    fill:        $('fillNone').checked   ? 'none' : $('fillColor').value,
    stroke:      $('strokeNone').checked ? 'none' : $('strokeColor').value,
    strokeWidth: +$('strokeWidth').value || 0,
    radius:      +$('rectRadius').value  || 0,
    dash:        $('dashStyle').value
  };
}
function textProps() {
  return {
    content:  $('txtContent').value,
    family:   $('fontFamily').value,
    size:     +$('fontSize').value     || 24,
    lineH:    +$('lineHeight').value   || 1.3,
    condense: (+$('condense').value    || 100) / 100,
    ls:       +$('letterSpacing').value || 0,
    fill:     $('textFill').value,
    oColor:   $('outlineColor').value,
    oWidth:   +$('outlineWidth').value || 0,
    bold:     $('boldChk').checked,
    italic:   $('italicChk').checked,
    anchor:   $('textAnchor').value
  };
}

/* -------------------------------------------------------- 図形の生成 */
function applyShapeStyle(el, p) {
  el.setAttribute('fill', p.fill);
  el.setAttribute('stroke', p.stroke);
  el.setAttribute('stroke-width', p.strokeWidth);
  if (p.dash) el.setAttribute('stroke-dasharray', p.dash);
  else        el.removeAttribute('stroke-dasharray');
  el.setAttribute('stroke-linecap', 'butt');
}
function createRect(x, y) {
  const p  = shapeProps();
  const el = document.createElementNS(NS, 'rect');
  el.setAttribute('x', x); el.setAttribute('y', y);
  el.setAttribute('width', 0); el.setAttribute('height', 0);
  if (p.radius > 0) { el.setAttribute('rx', p.radius); el.setAttribute('ry', p.radius); }
  applyShapeStyle(el, p);
  el.id = 'sh' + (++uid);
  layer.appendChild(el);
  return el;
}
function createLine(x, y) {
  const p  = shapeProps();
  const el = document.createElementNS(NS, 'line');
  el.setAttribute('x1', x); el.setAttribute('y1', y);
  el.setAttribute('x2', x); el.setAttribute('y2', y);
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', p.stroke === 'none' ? $('strokeColor').value : p.stroke);
  el.setAttribute('stroke-width', p.strokeWidth || 2);
  el.setAttribute('stroke-linecap', 'round');
  if (p.dash) el.setAttribute('stroke-dasharray', p.dash);
  el.id = 'sh' + (++uid);
  layer.appendChild(el);
  return el;
}

/* ------------------------------------------------ テキスト（本体処理） */
function setTextLines(el, str) {
  const x  = parseFloat(el.getAttribute('x')) || 0;
  const fs = parseFloat(el.getAttribute('font-size')) || 24;
  const lh = parseFloat(el.dataset.lineHeight || '1.3');
  while (el.firstChild) el.removeChild(el.firstChild);
  const lines = String(str).split('\n');
  lines.forEach((ln, i) => {
    const t = document.createElementNS(NS, 'tspan');
    t.setAttribute('x', x);
    t.setAttribute('dy', i === 0 ? 0 : fs * lh);
    t.textContent = ln === '' ? ' ' : ln;
    el.appendChild(t);
  });
  el.dataset.text = str;
}
/** 長体（横比率）は自身のアンカー位置を基準に水平方向スケールで実現 */
function applyTextTransform(el) {
  const sx = parseFloat(el.dataset.condense || '1');
  const x  = parseFloat(el.getAttribute('x')) || 0;
  const y  = parseFloat(el.getAttribute('y')) || 0;
  if (Math.abs(sx - 1) < 1e-6) el.removeAttribute('transform');
  else el.setAttribute('transform', `translate(${x},${y}) scale(${sx},1) translate(${-x},${-y})`);
}
function applyTextStyle(el, p) {
  el.setAttribute('font-family', p.family);
  el.setAttribute('font-size', p.size);
  el.setAttribute('font-weight', p.bold ? 'bold' : 'normal');
  el.setAttribute('font-style', p.italic ? 'italic' : 'normal');
  el.setAttribute('fill', p.fill);
  el.setAttribute('letter-spacing', p.ls);
  el.setAttribute('text-anchor', p.anchor);
  el.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  el.dataset.lineHeight = p.lineH;
  el.dataset.condense   = p.condense;
  if (p.oWidth > 0) {
    // 縁取りは「外側取り」: 先に stroke を描いてから fill を上に重ねる
    el.setAttribute('paint-order', 'stroke fill markers');
    el.setAttribute('stroke', p.oColor);
    el.setAttribute('stroke-width', p.oWidth * 2);   // 内側半分は塗りで隠れるため 2 倍
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    el.dataset.outline = p.oWidth;
  } else {
    el.removeAttribute('paint-order');
    el.setAttribute('stroke', 'none');
    el.removeAttribute('stroke-width');
    el.dataset.outline = 0;
  }
  applyTextTransform(el);
}
function createText(x, y) {
  const p  = textProps();
  const el = document.createElementNS(NS, 'text');
  el.setAttribute('x', x); el.setAttribute('y', y);
  el.id = 'tx' + (++uid);
  applyTextStyle(el, p);
  setTextLines(el, p.content || 'テキスト');
  layer.appendChild(el);
  return el;
}

/* ------------------------------------------------------ 選択とハンドル */
function topLevelOf(node) {
  let n = node;
  while (n && n.parentNode !== layer) {
    if (n === svg || !n.parentNode) return null;
    n = n.parentNode;
  }
  return n;
}
function bboxOf(el) {
  let b;
  try { b = el.getBBox(); } catch (e) { return null; }
  const m = el.transform.baseVal.consolidate() ? el.transform.baseVal.consolidate().matrix : null;
  if (!m) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
    .map(([px, py]) => ({ x: m.a * px + m.c * py + m.e, y: m.b * px + m.d * py + m.f }));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
function clearHandles() { overlay.querySelectorAll('.sel').forEach(n => n.remove()); }

function mkHandle(x, y, name, k) {
  const s = 9 * k;
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('class', 'sel');
  r.setAttribute('x', x - s / 2); r.setAttribute('y', y - s / 2);
  r.setAttribute('width', s); r.setAttribute('height', s);
  r.setAttribute('fill', '#ffffff');
  r.setAttribute('stroke', '#2f6fb0');
  r.setAttribute('stroke-width', 1.5 * k);
  r.setAttribute('style', 'pointer-events:all;cursor:pointer');
  r.dataset.handle = name;
  overlay.appendChild(r);
}
function renderSelection() {
  clearHandles();
  if (!selected || !selected.parentNode) return;
  const k = 1 / zoomFactor();
  const b = bboxOf(selected);
  if (!b) return;
  const box = document.createElementNS(NS, 'rect');
  box.setAttribute('class', 'sel');
  box.setAttribute('x', b.x); box.setAttribute('y', b.y);
  box.setAttribute('width', b.width); box.setAttribute('height', b.height);
  box.setAttribute('fill', 'none');
  box.setAttribute('stroke', '#2f6fb0');
  box.setAttribute('stroke-width', 1 * k);
  box.setAttribute('stroke-dasharray', `${4 * k} ${3 * k}`);
  overlay.appendChild(box);

  const tag = selected.tagName.toLowerCase();
  if (tag === 'rect') {
    const x1 = +selected.getAttribute('x'), y1 = +selected.getAttribute('y');
    const w  = +selected.getAttribute('width'), h = +selected.getAttribute('height');
    const cx = x1 + w / 2, cy = y1 + h / 2;
    [['nw', x1, y1], ['n', cx, y1], ['ne', x1 + w, y1], ['e', x1 + w, cy],
     ['se', x1 + w, y1 + h], ['s', cx, y1 + h], ['sw', x1, y1 + h], ['w', x1, cy]]
      .forEach(([n, x, y]) => mkHandle(x, y, n, k));
  } else if (tag === 'line') {
    mkHandle(+selected.getAttribute('x1'), +selected.getAttribute('y1'), 'p1', k);
    mkHandle(+selected.getAttribute('x2'), +selected.getAttribute('y2'), 'p2', k);
  } else if (tag === 'text') {
    mkHandle(+selected.getAttribute('x'), +selected.getAttribute('y'), 'anchor', k);
  }
}
function select(el) {
  selected = el;
  renderSelection();
  if (el) { loadPropsFrom(el); log(`選択: <${el.tagName}> id=${el.id || '(なし)'}`); }
}

/* ------------------------------------------------ 要素 → パネル 反映 */
function loadPropsFrom(el) {
  suppress = true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'text') {
    $('txtContent').value = el.dataset.text !== undefined ? el.dataset.text
                            : [...el.childNodes].map(n => n.textContent).join('\n');
    const fam = el.getAttribute('font-family');
    if (fam) {
      const opt = [...$('fontFamily').options].find(o => o.value === fam);
      if (opt) $('fontFamily').value = fam;
      else {
        const o = document.createElement('option');
        o.value = fam;
        o.dataset.imported  = '1';
        o.dataset.baseLabel = fam + '（読込）';
        o.textContent = o.dataset.baseLabel;
        let grp = $('fontFamily').querySelector('optgroup[data-imported]');
        if (!grp) {
          grp = document.createElement('optgroup');
          grp.label = '読み込んだ SVG のフォント';
          grp.dataset.imported = '1';
          $('fontFamily').appendChild(grp);
        }
        grp.appendChild(o);
        if (!annotateOption(o)) log(`読み込んだフォント「${fam}」はこの環境にありません（代替表示）`, true);
        $('fontFamily').value = fam;
      }
    }
    $('fontSize').value      = parseFloat(el.getAttribute('font-size')) || 24;
    $('lineHeight').value    = parseFloat(el.dataset.lineHeight || '1.3');
    $('condense').value      = Math.round((parseFloat(el.dataset.condense || '1')) * 100);
    $('letterSpacing').value = parseFloat(el.getAttribute('letter-spacing')) || 0;
    const f = el.getAttribute('fill'); if (f && f !== 'none') $('textFill').value = toHex(f);
    const ow = el.dataset.outline !== undefined ? parseFloat(el.dataset.outline)
             : (parseFloat(el.getAttribute('stroke-width')) || 0) / 2;
    $('outlineWidth').value = ow || 0;
    const sc = el.getAttribute('stroke'); if (sc && sc !== 'none') $('outlineColor').value = toHex(sc);
    $('boldChk').checked   = (el.getAttribute('font-weight') === 'bold' || +el.getAttribute('font-weight') >= 600);
    $('italicChk').checked = el.getAttribute('font-style') === 'italic';
    $('textAnchor').value  = el.getAttribute('text-anchor') || 'start';
  } else {
    const f = el.getAttribute('fill');
    $('fillNone').checked = (f === 'none');
    if (f && f !== 'none') $('fillColor').value = toHex(f);
    const s = el.getAttribute('stroke');
    $('strokeNone').checked = (!s || s === 'none');
    if (s && s !== 'none') $('strokeColor').value = toHex(s);
    $('strokeWidth').value = parseFloat(el.getAttribute('stroke-width')) || 0;
    if (tag === 'rect') $('rectRadius').value = parseFloat(el.getAttribute('rx')) || 0;
    const d = el.getAttribute('stroke-dasharray') || '';
    const opt = [...$('dashStyle').options].find(o => o.value === d.replace(/,/g, ' ').trim());
    $('dashStyle').value = opt ? opt.value : '';
  }
  syncLabels();
  suppress = false;
}
function toHex(c) {
  c = String(c).trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map(ch => ch + ch).join('').toLowerCase();
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const [r, g, b] = m[1].split(',').map(n => Math.max(0, Math.min(255, Math.round(parseFloat(n)))));
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  const probe = document.createElement('div');
  probe.style.color = c; document.body.appendChild(probe);
  const cs = getComputedStyle(probe).color; probe.remove();
  const m2 = cs.match(/rgba?\(([^)]+)\)/);
  if (m2) {
    const [r, g, b] = m2[1].split(',').map(n => Math.round(parseFloat(n)));
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

/* ------------------------------------------------ パネル → 要素 反映 */
function reapplySelected() {
  if (suppress || !selected) return;
  const tag = selected.tagName.toLowerCase();
  if (tag === 'text') {
    const p = textProps();
    applyTextStyle(selected, p);
    setTextLines(selected, p.content);
  } else if (tag === 'rect') {
    const p = shapeProps();
    applyShapeStyle(selected, p);
    if (p.radius > 0) { selected.setAttribute('rx', p.radius); selected.setAttribute('ry', p.radius); }
    else { selected.removeAttribute('rx'); selected.removeAttribute('ry'); }
  } else if (tag === 'line') {
    const p = shapeProps();
    selected.setAttribute('stroke', p.stroke === 'none' ? $('strokeColor').value : p.stroke);
    selected.setAttribute('stroke-width', p.strokeWidth);
    if (p.dash) selected.setAttribute('stroke-dasharray', p.dash);
    else selected.removeAttribute('stroke-dasharray');
  } else {
    const p = shapeProps();
    applyShapeStyle(selected, p);
  }
  renderSelection();
}
function syncLabels() {
  $('condenseLabel').textContent = $('condense').value;
  $('lsLabel').textContent       = $('letterSpacing').value;
  $('jqLabel').textContent       = $('jpegQuality').value;
  $('zoomLabel').textContent     = $('zoom').value + '%';
}
['fillColor','fillNone','strokeColor','strokeNone','strokeWidth','rectRadius','dashStyle',
 'txtContent','fontFamily','fontSize','lineHeight','condense','letterSpacing','textFill',
 'outlineColor','outlineWidth','boldChk','italicChk','textAnchor'].forEach(id => {
  $(id).addEventListener('input',  () => { syncLabels(); reapplySelected(); });
  $(id).addEventListener('change', () => { if (selected) pushHistory('プロパティ変更'); });
});

/* ------------------------------------------------------ 移動 / 変形 */
function moveBy(el, dx, dy) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'rect' || tag === 'image') {
    el.setAttribute('x', (+el.getAttribute('x') || 0) + dx);
    el.setAttribute('y', (+el.getAttribute('y') || 0) + dy);
  } else if (tag === 'line') {
    el.setAttribute('x1', (+el.getAttribute('x1') || 0) + dx);
    el.setAttribute('y1', (+el.getAttribute('y1') || 0) + dy);
    el.setAttribute('x2', (+el.getAttribute('x2') || 0) + dx);
    el.setAttribute('y2', (+el.getAttribute('y2') || 0) + dy);
  } else if (tag === 'text') {
    const nx = (+el.getAttribute('x') || 0) + dx;
    el.setAttribute('x', nx);
    el.setAttribute('y', (+el.getAttribute('y') || 0) + dy);
    el.querySelectorAll('tspan').forEach(t => t.setAttribute('x', nx));
    applyTextTransform(el);
  } else if (tag === 'circle' || tag === 'ellipse') {
    el.setAttribute('cx', (+el.getAttribute('cx') || 0) + dx);
    el.setAttribute('cy', (+el.getAttribute('cy') || 0) + dy);
  } else {
    if (el.dataset.baseTransform === undefined) el.dataset.baseTransform = el.getAttribute('transform') || '';
    const tx = (+el.dataset.tx || 0) + dx, ty = (+el.dataset.ty || 0) + dy;
    el.dataset.tx = tx; el.dataset.ty = ty;
    el.setAttribute('transform', `translate(${tx},${ty}) ${el.dataset.baseTransform}`.trim());
  }
}
function resizeRect(el, handle, st, p) {
  let x = st.x, y = st.y, w = st.w, h = st.h;
  const px = snap(p.x), py = snap(p.y);
  if (handle.includes('w')) { w = st.x + st.w - px; x = px; }
  if (handle.includes('e')) { w = px - st.x; }
  if (handle.includes('n')) { h = st.y + st.h - py; y = py; }
  if (handle.includes('s')) { h = py - st.y; }
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  el.setAttribute('x', x); el.setAttribute('y', y);
  el.setAttribute('width', w); el.setAttribute('height', h);
}

/* -------------------------------------------------------- ポインタ操作 */
svg.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  const p = toSvgPoint(evt);
  const handleName = evt.target.dataset ? evt.target.dataset.handle : null;

  if (handleName && selected) {
    const tag = selected.tagName.toLowerCase();
    if (tag === 'rect' && handleName.length <= 2) {
      drag = { mode: 'resize', handle: handleName,
               st: { x: +selected.getAttribute('x'), y: +selected.getAttribute('y'),
                     w: +selected.getAttribute('width'), h: +selected.getAttribute('height') } };
    } else if (tag === 'line') {
      drag = { mode: 'endpoint', handle: handleName };
    } else {
      drag = { mode: 'move', last: p };
    }
    svg.setPointerCapture(evt.pointerId);
    evt.preventDefault();
    return;
  }

  if (tool === 'select') {
    const hit = topLevelOf(evt.target);
    if (hit) {
      if (hit !== selected) select(hit);
      drag = { mode: 'move', last: p, moved: false };
      svg.setPointerCapture(evt.pointerId);
    } else {
      select(null); clearHandles(); log('選択を解除しました');
    }
    return;
  }

  const sx = snap(p.x), sy = snap(p.y);
  if (tool === 'rect') {
    const el = createRect(sx, sy);
    select(el);
    drag = { mode: 'create-rect', ox: sx, oy: sy, el };
    svg.setPointerCapture(evt.pointerId);
    log(`長方形を作成開始 (${Math.round(sx)}, ${Math.round(sy)})`);
  } else if (tool === 'line') {
    const el = createLine(sx, sy);
    select(el);
    drag = { mode: 'create-line', ox: sx, oy: sy, el };
    svg.setPointerCapture(evt.pointerId);
    log(`直線を作成開始 (${Math.round(sx)}, ${Math.round(sy)})`);
  } else if (tool === 'text') {
    const el = createText(sx, sy);
    select(el);
    pushHistory('テキスト追加');
    log(`テキストを追加 (${Math.round(sx)}, ${Math.round(sy)}): "${el.dataset.text.replace(/\n/g, '\\n')}"`);
    setTool('select');
  }
});

svg.addEventListener('pointermove', (evt) => {
  if (!drag) return;
  const p = toSvgPoint(evt);
  if (drag.mode === 'create-rect') {
    let x2 = snap(p.x), y2 = snap(p.y);
    if (evt.shiftKey) {
      const s = Math.max(Math.abs(x2 - drag.ox), Math.abs(y2 - drag.oy));
      x2 = drag.ox + Math.sign(x2 - drag.ox || 1) * s;
      y2 = drag.oy + Math.sign(y2 - drag.oy || 1) * s;
    }
    drag.el.setAttribute('x', Math.min(drag.ox, x2));
    drag.el.setAttribute('y', Math.min(drag.oy, y2));
    drag.el.setAttribute('width',  Math.abs(x2 - drag.ox));
    drag.el.setAttribute('height', Math.abs(y2 - drag.oy));
  } else if (drag.mode === 'create-line') {
    let x2 = snap(p.x), y2 = snap(p.y);
    if (evt.shiftKey) {
      const dx = x2 - drag.ox, dy = y2 - drag.oy;
      const a  = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x2 = drag.ox + Math.cos(a) * len; y2 = drag.oy + Math.sin(a) * len;
    }
    drag.el.setAttribute('x2', x2); drag.el.setAttribute('y2', y2);
  } else if (drag.mode === 'move') {
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    if (dx || dy) drag.moved = true;
    moveBy(selected, dx, dy);
    drag.last = p;
  } else if (drag.mode === 'resize') {
    resizeRect(selected, drag.handle, drag.st, p);
  } else if (drag.mode === 'endpoint') {
    const n = drag.handle === 'p1' ? '1' : '2';
    let x = snap(p.x), y = snap(p.y);
    if (evt.shiftKey) {
      const ox = +selected.getAttribute('x' + (n === '1' ? '2' : '1'));
      const oy = +selected.getAttribute('y' + (n === '1' ? '2' : '1'));
      const a  = Math.round(Math.atan2(y - oy, x - ox) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x - ox, y - oy);
      x = ox + Math.cos(a) * len; y = oy + Math.sin(a) * len;
    }
    selected.setAttribute('x' + n, x); selected.setAttribute('y' + n, y);
  }
  renderSelection();
});

function endDrag(evt) {
  if (!drag) return;
  const d = drag; drag = null;
  try { svg.releasePointerCapture(evt.pointerId); } catch (e) {}
  if (d.mode === 'create-rect') {
    const w = +d.el.getAttribute('width'), h = +d.el.getAttribute('height');
    if (w < 2 && h < 2) { d.el.remove(); select(null); clearHandles(); log('長方形が小さすぎるため取り消しました'); return; }
    log(`長方形を作成: ${Math.round(w)} × ${Math.round(h)}`);
    pushHistory('長方形追加');
  } else if (d.mode === 'create-line') {
    const len = Math.hypot(+d.el.getAttribute('x2') - +d.el.getAttribute('x1'),
                           +d.el.getAttribute('y2') - +d.el.getAttribute('y1'));
    if (len < 2) { d.el.remove(); select(null); clearHandles(); log('直線が短すぎるため取り消しました'); return; }
    log(`直線を作成: 長さ ${Math.round(len)}px`);
    pushHistory('直線追加');
  } else if (d.mode === 'move' && d.moved) {
    log('要素を移動しました'); pushHistory('移動');
  } else if (d.mode === 'resize') {
    log(`サイズ変更: ${Math.round(+selected.getAttribute('width'))} × ${Math.round(+selected.getAttribute('height'))}`);
    pushHistory('サイズ変更');
  } else if (d.mode === 'endpoint') {
    log('直線の端点を変更しました'); pushHistory('端点変更');
  }
  renderSelection();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener('dblclick', (evt) => {
  const hit = topLevelOf(evt.target);
  if (hit && hit.tagName.toLowerCase() === 'text') {
    select(hit); $('txtContent').focus(); $('txtContent').select();
    log('テキスト編集: 左パネルの入力欄で編集してください');
  }
});

/* -------------------------------------------------------- 編集コマンド */
function deleteSelected() {
  if (!selected) { log('削除対象が選択されていません'); return; }
  const t = selected.tagName;
  selected.remove(); select(null); clearHandles();
  log(`削除: <${t}>`); pushHistory('削除');
}
function duplicateSelected() {
  if (!selected) { log('複製対象が選択されていません'); return; }
  const c = selected.cloneNode(true);
  c.id = (selected.tagName.toLowerCase() === 'text' ? 'tx' : 'sh') + (++uid);
  layer.appendChild(c);
  moveBy(c, 12, 12);
  select(c);
  log('要素を複製しました'); pushHistory('複製');
}
$('btnDelete').addEventListener('click', deleteSelected);
$('btnDup').addEventListener('click', duplicateSelected);
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnFront').addEventListener('click', () => {
  if (!selected) return;
  layer.appendChild(selected); renderSelection();
  log('最前面へ移動'); pushHistory('重ね順変更');
});
$('btnBack').addEventListener('click', () => {
  if (!selected) return;
  layer.insertBefore(selected, layer.firstChild); renderSelection();
  log('最背面へ移動'); pushHistory('重ね順変更');
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); e.shiftKey ? redo() : undo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'Escape') { select(null); clearHandles(); return; }
  if (['v','r','l','t'].includes(e.key.toLowerCase()) && !e.ctrlKey && !e.metaKey) {
    setTool({ v: 'select', r: 'rect', l: 'line', t: 'text' }[e.key.toLowerCase()]); return;
  }
  if (selected && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    moveBy(selected, e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0,
                     e.key === 'ArrowUp'   ? -d : e.key === 'ArrowDown'  ? d : 0);
    renderSelection(); pushHistory();
  }
});

/* ------------------------------------------------------ キャンバス設定 */
function applyCanvasSize() {
  const w = Math.max(1, +$('canvasW').value || 800);
  const h = Math.max(1, +$('canvasH').value || 600);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  bgRect.setAttribute('width', w);  bgRect.setAttribute('height', h);
  $('gridRect').setAttribute('width', w); $('gridRect').setAttribute('height', h);
  applyZoom();
  if (!$('lockAspect').dataset.userSet) { $('exportW').value = w; $('exportH').value = h; }
  log(`キャンバスサイズ: ${w} × ${h}px`);
}
function applyZoom() {
  const z = zoomFactor();
  svg.setAttribute('width',  (+$('canvasW').value || 800) * z);
  svg.setAttribute('height', (+$('canvasH').value || 600) * z);
  renderSelection();
}
function applyBg() {
  if ($('bgTransparent').checked) { bgRect.setAttribute('fill', 'none'); log('背景: 透明'); }
  else { bgRect.setAttribute('fill', $('bgColor').value); log(`背景色: ${$('bgColor').value}`); }
}
$('canvasW').addEventListener('change', applyCanvasSize);
$('canvasH').addEventListener('change', applyCanvasSize);
$('bgColor').addEventListener('input', applyBg);
$('bgTransparent').addEventListener('change', applyBg);
$('zoom').addEventListener('input', () => { syncLabels(); applyZoom(); });
function applyGrid() {
  const g = Math.max(2, +$('gridSize').value || 20);
  const pat = $('gridPattern');
  pat.setAttribute('width', g); pat.setAttribute('height', g);
  pat.firstElementChild.setAttribute('d', `M ${g} 0 L 0 0 0 ${g}`);
  $('gridRect').style.display = $('gridChk').checked ? '' : 'none';
}
$('gridChk').addEventListener('change', () => {
  applyGrid();
  log(`グリッド: ${$('gridChk').checked ? '表示' : '非表示'}`);
});
$('gridSize').addEventListener('change', () => {
  applyGrid();
  log(`グリッド幅: ${Math.max(2, +$('gridSize').value || 20)}px`);
});
$('snapChk').addEventListener('change', () => log(`スナップ: ${$('snapChk').checked ? 'ON' : 'OFF'}`));

/* --------------------------------------------------------- 書き出し */
async function serializeSVG(w, h, opts) {
  const clone = svg.cloneNode(true);
  const ov = clone.querySelector('#overlay');
  if (ov) ov.remove();
  // PNG/JPEG は <img> でのラスタライズ時に外部フォントを読めないため、つねに埋め込む
  const embed = (opts && opts.forceEmbed) || $('embedFont').checked;
  if (embed) {
    const usage = collectUsedWebFonts();
    if (usage.size) {
      try {
        const { css, bytes } = await buildFontFaceCSS(usage);
        if (css.trim()) {
          const defs = document.createElementNS(NS, 'defs');
          const st   = document.createElementNS(NS, 'style');
          st.setAttribute('type', 'text/css');
          st.textContent = `/* 埋め込みフォント: ${[...usage.keys()].join(', ')} — SIL Open Font License 1.1 */\n` + css;
          defs.appendChild(st);
          clone.insertBefore(defs, clone.firstChild);
          log(`フォント埋め込み: ${[...usage.keys()].join('、')}（woff2 ${(bytes / 1024).toFixed(1)} KB）`);
        }
      } catch (e) {
        log(`フォント埋め込みに失敗: ${e.message}（フォント名のみで書き出します）`, true);
      }
    }
  }
  clone.setAttribute('xmlns', NS);
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.removeAttribute('class');
  clone.removeAttribute('style');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function baseName() { return ($('fileName').value || 'drawing').replace(/[\\/:*?"<>|]/g, '_'); }

$('btnSVG').addEventListener('click', async () => {
  const w = +$('canvasW').value, h = +$('canvasH').value;
  const btn = $('btnSVG');
  btn.disabled = true;
  try {
    const str = await serializeSVG(w, h);
    download(new Blob([str], { type: 'image/svg+xml;charset=utf-8' }), baseName() + '.svg');
    log(`SVG を保存しました（${w} × ${h}px, ${str.length.toLocaleString()} bytes）`);
  } catch (e) {
    log(`SVG の保存に失敗しました: ${e.message}`, true);
  } finally { btn.disabled = false; }
});

async function exportRaster(type) {
  const w = Math.max(1, Math.round(+$('exportW').value || 800));
  const h = Math.max(1, Math.round(+$('exportH').value || 600));
  if (w * h > 80e6) { log('書き出しサイズが大きすぎます', true); return; }
  const str  = await serializeSVG(w, h, { forceEmbed: true });
  const blob = new Blob([str], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const q = (+$('jpegQuality').value || 92) / 100;
    cv.toBlob((b) => {
      if (!b) { log('ラスタ化に失敗しました', true); return; }
      const ext = type === 'image/png' ? '.png' : '.jpg';
      download(b, baseName() + ext);
      log(`${ext.slice(1).toUpperCase()} を保存しました（${w} × ${h}px, ${(b.size / 1024).toFixed(1)} KB）`);
    }, type, q);
  };
  img.onerror = () => { URL.revokeObjectURL(url); log('SVG の画像化に失敗しました', true); };
  img.src = url;
}
async function runExport(btn, type) {
  btn.disabled = true;
  try { await exportRaster(type); }
  catch (e) { log(`書き出しに失敗しました: ${e.message}`, true); }
  finally { btn.disabled = false; }
}
$('btnPNG').addEventListener('click',  () => runExport($('btnPNG'),  'image/png'));
$('btnJPEG').addEventListener('click', () => runExport($('btnJPEG'), 'image/jpeg'));
$('jpegQuality').addEventListener('input', syncLabels);

$('exportW').addEventListener('input', () => {
  $('lockAspect').dataset.userSet = '1';
  if ($('lockAspect').checked) {
    const r = (+$('canvasH').value || 600) / (+$('canvasW').value || 800);
    $('exportH').value = Math.max(1, Math.round((+$('exportW').value || 1) * r));
  }
});
$('exportH').addEventListener('input', () => {
  $('lockAspect').dataset.userSet = '1';
  if ($('lockAspect').checked) {
    const r = (+$('canvasW').value || 800) / (+$('canvasH').value || 600);
    $('exportW').value = Math.max(1, Math.round((+$('exportH').value || 1) * r));
  }
});
document.querySelectorAll('.presets button').forEach(b => {
  b.addEventListener('click', () => {
    const s = +b.dataset.scale;
    $('exportW').value = Math.round((+$('canvasW').value || 800) * s);
    $('exportH').value = Math.round((+$('canvasH').value || 600) * s);
    $('lockAspect').dataset.userSet = '1';
    log(`書き出しサイズ: ×${s} → ${$('exportW').value} × ${$('exportH').value}px`);
  });
});

/* ------------------------------------------------------ SVG 読み込み */
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try { loadSVGText(String(rd.result), f.name); }
    catch (err) { log('読み込みエラー: ' + err.message, true); }
  };
  rd.onerror = () => log('ファイル読み込みに失敗しました', true);
  rd.readAsText(f, 'utf-8');
  e.target.value = '';
});
function loadSVGText(text, name) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('SVG の解析に失敗しました');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') throw new Error('SVG ファイルではありません');

  let w, h;
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(n => !isNaN(n))) { w = vb[2]; h = vb[3]; }
  else { w = parseFloat(root.getAttribute('width')) || 800; h = parseFloat(root.getAttribute('height')) || 600; }
  $('canvasW').value = Math.round(w); $('canvasH').value = Math.round(h);
  $('exportW').value = Math.round(w); $('exportH').value = Math.round(h);
  applyCanvasSize();

  // インライン SVG の <style> はスコープを持たずエディタ UI 全体に効いてしまうため、
  // @font-face だけを head に取り込み、それ以外の CSS は破棄する
  const importedFamilies = new Set();
  const styles = [...root.querySelectorAll('style')];
  if (styles.length) {
    const css   = styles.map(st => st.textContent).join('\n');
    const faces = css.match(/@font-face\s*\{[\s\S]*?\}/g) || [];
    if (faces.length) {
      injectImportedFontFaces(faces.join('\n'));
      for (const m of faces.join('\n').matchAll(/font-family:\s*['"]?([^;'"]+)['"]?\s*;/g)) {
        importedFamilies.add(m[1].trim());
      }
    } else {
      log('読み込んだ SVG の <style> は破棄しました（UI 全体に影響するため）');
    }
    styles.forEach(st => st.remove());
  }

  layer.innerHTML = '';
  let count = 0;
  [...root.childNodes].forEach(n => {
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'title' || tag === 'desc' || tag === 'metadata') return;
    const im = document.importNode(n, true);
    if (im.id === 'bg') {                       // 本エディタが書き出した背景を復元
      const fill = im.getAttribute('fill') || '#ffffff';
      if (fill === 'none') { $('bgTransparent').checked = true; }
      else { $('bgTransparent').checked = false; $('bgColor').value = toHex(fill); }
      applyBg();
      return;
    }
    if (im.id === 'layer') {                    // 本エディタが書き出したレイヤ
      [...im.childNodes].forEach(c => { if (c.nodeType === 1) { layer.appendChild(c); count++; } });
      return;
    }
    im.removeAttribute('id');
    layer.appendChild(im);
    count++;
  });
  // 読み込んだテキストの内部情報を補完
  layer.querySelectorAll('text').forEach(t => {
    if (t.dataset.text === undefined) {
      const tsp = t.querySelectorAll('tspan');
      t.dataset.text = tsp.length ? [...tsp].map(s => s.textContent).join('\n') : t.textContent;
    }
    if (t.dataset.condense === undefined) t.dataset.condense = 1;
    if (t.dataset.lineHeight === undefined) t.dataset.lineHeight = 1.3;
  });
  // 使われている Web フォントを自動取得（SVG に埋め込み済みのものは取りに行かない）
  ensureWebFontsInLayer(importedFamilies);

  select(null); clearHandles();
  history.length = 0; histIdx = -1; pushHistory();
  log(`SVG を読み込みました: ${name}（${Math.round(w)} × ${Math.round(h)}px, 要素 ${count} 個）`);
}

/* -------------------------------------------------- 自動保存 / 復元 */
/* 編集内容とパネル設定を localStorage に保存し、リロード後に復元する。
   保存はブラウザ内で完結し、外部には送信しない。 */
const LS_KEY  = 'svgedit.state.v1';
const LS_FLAG = 'svgedit.autosave';
const PERSIST_IDS = [
  'canvasW','canvasH','bgColor','bgTransparent','gridChk','snapChk','gridSize','zoom',
  'fillColor','fillNone','strokeColor','strokeNone','strokeWidth','rectRadius','dashStyle',
  'txtContent','fontFamily','fontSize','lineHeight','condense','letterSpacing','textFill',
  'outlineColor','outlineWidth','boldChk','italicChk','textAnchor','hideMissing',
  'fileName','exportW','exportH','lockAspect','jpegQuality','embedFont'
];
let storageOK = true;
let saveTimer = null;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { storageOK = false; return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

function updateSavedLabel(ts) {
  if (!ts) { $('savedAt').textContent = '—'; return; }
  const d = new Date(ts);
  $('savedAt').textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')} 保存`;
}
function saveState() {
  saveTimer = null;
  if (!storageOK || !$('autoSave').checked) return;
  try {
    const controls = {};
    PERSIST_IDS.forEach(id => {
      const el = $(id);
      if (el) controls[id] = (el.type === 'checkbox') ? el.checked : el.value;
    });
    const imported = document.getElementById('importedFonts');
    const data = {
      v: 1, ts: Date.now(), controls,
      layer: layer.innerHTML,
      importedFonts: imported ? imported.textContent : ''
    };
    const str = JSON.stringify(data);
    if (str.length > 4.5e6) { log('自動保存: データが大きすぎるためスキップしました', true); return; }
    if (!lsSet(LS_KEY, str)) {
      storageOK = false;
      log('自動保存に失敗しました（保存容量の上限に達した可能性があります）', true);
      return;
    }
    updateSavedLabel(data.ts);
  } catch (e) {
    log(`自動保存に失敗しました: ${e.message}`, true);
  }
}
function scheduleSave() {
  if (!storageOK || !$('autoSave').checked) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 800);
}
/** レイヤ内で使われている Web フォントを取得する（埋め込み済みのものは除く） */
function ensureWebFontsInLayer(skip) {
  const used = new Set();
  layer.querySelectorAll('text').forEach(t => {
    const f = firstFamily(t.getAttribute('font-family'));
    if (f && WEBFONTS.has(f) && !(skip && skip.has(f))) used.add(f);
  });
  used.forEach(f => ensureWebFont(f));
}
/** 保存済みの id 連番と衝突しないように uid を進める */
function syncUidFromLayer() {
  let max = 0;
  layer.querySelectorAll('[id]').forEach(el => {
    const m = /^(?:sh|tx)(\d+)$/.exec(el.id);
    if (m) max = Math.max(max, +m[1]);
  });
  uid = Math.max(uid, max);
}
function restoreState() {
  const raw = lsGet(LS_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || d.v !== 1) return null;
    if (d.controls) {
      Object.entries(d.controls).forEach(([id, v]) => {
        const el = $(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!v;
        else if (el.tagName === 'SELECT') {          // 存在しない選択肢は無視する
          if ([...el.options].some(o => o.value === v)) el.value = v;
        } else el.value = v;
      });
    }
    if (d.importedFonts) {
      const st = document.createElement('style');
      st.id = 'importedFonts';
      st.textContent = d.importedFonts;
      document.head.appendChild(st);
    }
    if (d.controls && +d.controls.exportW && +d.controls.exportW !== +d.controls.canvasW) {
      $('lockAspect').dataset.userSet = '1';       // 復元した書き出しサイズを維持する
    }
    layer.innerHTML = d.layer || '';
    syncUidFromLayer();
    return d;
  } catch (e) {
    log(`前回の状態を復元できませんでした: ${e.message}`, true);
    return null;
  }
}
function clearState() {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
  updateSavedLabel(null);
}
$('autoSave').addEventListener('change', () => {
  const on = $('autoSave').checked;
  lsSet(LS_FLAG, on ? '1' : '0');
  if (on) { saveState(); log('自動保存: ON'); }
  else { clearState(); log('自動保存: OFF（保存済みの内容も削除しました）'); }
});
$('btnNewDoc').addEventListener('click', () => {
  layer.innerHTML = '';
  select(null); clearHandles();
  history.length = 0; histIdx = -1; pushHistory();
  clearState(); saveState();
  log('新規作成しました（保存内容を消去）');
});
// 入力・編集のたびに保存（デバウンス）。閉じる直前は取りこぼさないよう即時保存する。
document.addEventListener('change', scheduleSave);
document.addEventListener('input',  scheduleSave);
window.addEventListener('beforeunload', () => { if (saveTimer) { clearTimeout(saveTimer); saveState(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) { clearTimeout(saveTimer); saveState(); } });

/* ------------------------------------------------------------ 初期化 */
setTool('select');
if (lsGet(LS_FLAG) === '0') $('autoSave').checked = false;
const restored = $('autoSave').checked ? restoreState() : null;
applyCanvasSize();
applyBg();
applyGrid();
syncLabels();
pushHistory();
refreshFontAvailability();
log('SVG エディタを起動しました。ツールを選んでキャンバスをドラッグしてください。');
log('ショートカット: V=選択 R=長方形 L=直線 T=テキスト / Delete=削除 / Ctrl+Z=元に戻す / Ctrl+D=複製 / Shift=45度・正方形');
if (!storageOK) {
  $('autoSave').checked = false;
  $('autoSave').disabled = true;
  $('savedAt').textContent = '利用不可';
  log('このブラウザでは localStorage が使えないため、自動保存を無効にしました', true);
} else if (restored) {
  updateSavedLabel(restored.ts);
  const n = layer.children.length;
  const ago = Math.round((Date.now() - restored.ts) / 1000);
  log(`前回の状態を復元しました（要素 ${n} 個 / ${ago < 60 ? ago + '秒前' : Math.round(ago / 60) + '分前'}の保存）`);
  ensureWebFontsInLayer();
} else {
  log('自動保存 ON: 編集内容はこのブラウザに保存され、次回アクセス時に復元されます');
}
