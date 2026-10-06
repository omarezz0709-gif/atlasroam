/* Atlasroam: the travel globe. Plain JavaScript, no build step.
   Data (refreshed by GitHub Actions, see scripts/): data/world.json, safety.json, facts.json, rates.json, visa/XX.json.
   Everything the visitor chooses (language, theme, passport, currency, tour seen) stays in this browser (localStorage). */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k, d = null){ try { const v = localStorage.getItem('ar-' + k); return v === null ? d : v; } catch(e){ return d; } },
  set(k, v){ try { v === null ? localStorage.removeItem('ar-' + k) : localStorage.setItem('ar-' + k, v); } catch(e){} },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const mob = () => innerWidth <= 760;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================================================================ LANGUAGE */
let LANG = document.documentElement.lang || 'en';
function t(key, vars){
  const e = T[key];
  let s = e ? (e[LANGS.indexOf(LANG)] || e[0]) : key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
const LOC = () => LANG === 'ar' ? 'ar-u-nu-latn' : LANG;   // Arabic text with the same digits as phone numbers
const dnCache = {};
function dn(type){ const k = LANG + type; if (!dnCache[k]) try { dnCache[k] = new Intl.DisplayNames([LOC()], {type}); } catch(e){ dnCache[k] = {of: x => x}; } return dnCache[k]; }
function cname(iso){
  if (!iso) return '';
  try { const n = dn('region').of(iso); if (n && n !== iso) return n; } catch(e){}
  return (COUNTRY[iso] || {}).n || iso;
}
const curName = c => { try { return dn('currency').of(c) || c; } catch(e){ return c; } };
const langName = c => { try { const n = dn('language').of(c); return n && n !== c ? n : c; } catch(e){ return c; } };
function fmtDate(iso, withTime){
  const d = new Date(iso); if (isNaN(d)) return iso || '';
  return d.toLocaleDateString(LOC(), {day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? {hour: '2-digit', minute: '2-digit'} : {})});
}
const fmtNum = (n, max = 4) => n.toLocaleString(LOC(), {maximumSignificantDigits: max});
const flagSrc = iso => `vendor/flags/${iso.toLowerCase()}.svg`;

function applyStatic(){
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
}
function setLang(l, save = true){
  if (!LANGS.includes(l)) l = 'en';
  LANG = l;
  document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
  if (save) store.set('lang', l);
  $('#lang').value = l;
  applyStatic();
  if (READY){ buildSearch(); updatePassportChip(); renderPanel(); buildTicker(); refreshGlobe(); updateFoot(); layout(); }
}
$('#lang').innerHTML = LANGS.map(l => `<option value="${l}" lang="${l}">${l.toUpperCase()} · ${LANG_NAMES[l]}</option>`).join('');
$('#lang').onchange = e => setLang(e.target.value);

/* ================================================================ DATA */
let READY = false, WORLD = null, SAFETY = {countries: {}, changes: []}, FACTS = {c: {}}, RATES = null;
const COUNTRY = {};
const getJSON = u => fetch(u, {cache: 'no-cache'}).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
function toast(msg, ms = 6000){ const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { el.hidden = true; }, ms); }

/* ================================================================ SETTINGS */
let colourBy = store.get('colour', 'max');
if (!['max', 'de', 'uk', 'us'].includes(colourBy)) colourBy = 'max';
let passport = store.get('passport');
$('#colour-by').value = colourBy;
$('#colour-by').onchange = e => { colourBy = e.target.value; store.set('colour', colourBy); refreshGlobe(); renderBadge(); };

function level(iso, src = colourBy){
  const s = SAFETY.countries[iso]; if (!s) return 0;
  return src === 'max' ? s.l || 0 : (s[src] || {}).l || 0;
}
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
let LV = [];
function readLevelColours(){ LV = [0, 1, 2, 3, 4].map(i => cssVar('--lv' + i)); }
function rgba(hex, a){ const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
function mix(hex, to, k){ const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const c = i => Math.round((a >> i & 255) * (1 - k) + (b >> i & 255) * k);
  return '#' + [16, 8, 0].map(i => c(i).toString(16).padStart(2, '0')).join(''); }

/* ================================================================ GLOBE */
const GLOBE_THEME = {
  dark: {sea: '#0a1730', atmo: '#7c8dff', side: 'rgba(0,0,0,0.3)', stroke: 'rgba(255,255,255,0.20)', relief: '#26324c', ambient: 1, sun: 0.6, hoverMix: '#ffffff'},
  light: {sea: '#b9cfe6', atmo: '#9fb6ff', side: 'rgba(30,40,60,0.10)', stroke: 'rgba(20,35,70,0.30)', relief: '#ece6d8', ambient: 1.25, sun: 0.35, hoverMix: '#ffffff'},
};
let GT = GLOBE_THEME.dark, globe = null, mat = null, ctr = null, FEATURES = [], MICRO = [];
let sel = null, hoverId = null, reliefOn = false;
const globeEl = $('#globe');

function capColor(f){
  const lv = level(f.id), base = LV[lv] || LV[0];
  let c = f.id === hoverId && f.id !== sel ? mix(base, GT.hoverMix, 0.28) : base;
  const a = sel && f.id !== sel ? (reliefOn ? 0.55 : 0.75) : (reliefOn ? 0.86 : 1);
  return rgba(c, a);
}
const altitude = f => f.id === sel ? 0.024 : f.id === hoverId ? 0.014 : 0.007;
function tipHTML(iso){
  const lv = level(iso);
  return `<div class="tip"><b>${esc(cname(iso))}</b><span><i style="background:${LV[lv]}"></i>${esc(t('l' + lv))}</span></div>`;
}

function initGlobe(){
  FEATURES = WORLD.shapes.map(s => ({type: 'Feature', id: s.id, part: s.part, properties: {}, geometry: s.g}));
  MICRO = WORLD.countries.filter(c => c.micro);
  globe = new Globe(globeEl, {animateIn: !reduceMotion})
    .width(innerWidth).height(innerHeight)
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true).atmosphereColor(GT.atmo).atmosphereAltitude(0.16)
    .showGraticules(false)
    .polygonsData(FEATURES)
    .polygonCapColor(capColor)
    .polygonSideColor(() => GT.side)
    .polygonStrokeColor(f => f.id === sel ? cssVar('--accent') : GT.stroke)
    .polygonAltitude(altitude)
    .polygonsTransitionDuration(260)
    .polygonLabel(f => tipHTML(f.id))
    .onPolygonHover(f => { hoverId = f ? f.id : null; globeEl.style.cursor = f ? 'pointer' : 'grab'; refreshGlobe(); })
    .onPolygonClick(f => select(f.id))
    .pointsData(MICRO).pointLat('lat').pointLng('lng').pointAltitude(0.012).pointRadius(0.38)
    .pointColor(p => p.id === sel ? cssVar('--accent') : LV[level(p.id)] || LV[0])
    .pointLabel(p => tipHTML(p.id))
    .onPointClick(p => select(p.id))
    .onGlobeClick(() => closePanel());
  mat = globe.globeMaterial();
  ctr = globe.controls();
  ctr.autoRotate = !reduceMotion; ctr.autoRotateSpeed = 0.35;
  globeEl.addEventListener('pointerdown', () => { ctr.autoRotate = false; });
  applyGlobeTheme();
}
function refreshGlobe(){
  if (!globe) return;
  globe.polygonCapColor(capColor).polygonAltitude(altitude).polygonStrokeColor(f => f.id === sel ? cssVar('--accent') : GT.stroke)
    .pointColor(p => p.id === sel ? cssVar('--accent') : LV[level(p.id)] || LV[0]);
}
function applyGlobeTheme(){
  const th = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  GT = GLOBE_THEME[th]; readLevelColours();
  if (!globe) return;
  if (!reliefOn){ mat.color.set(GT.sea); if (mat.emissive) mat.emissive.set('#000000'); }
  globe.atmosphereColor(GT.atmo).polygonSideColor(() => GT.side);
  globe.scene().traverse(o => { if (o.isAmbientLight) o.intensity = Math.PI * GT.ambient; if (o.isDirectionalLight) o.intensity = Math.PI * GT.sun; });
  buildRelief();
  refreshGlobe();
}
/* terrain relief: an elevation map turned into hill shading in the theme's colours (as in Faultlines); without it the globe is plain */
let reliefImgs = null, reliefJob = 0;
const loadImg = u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
async function buildRelief(){
  const job = ++reliefJob;
  try {
    if (!reliefImgs) reliefImgs = await Promise.all([loadImg('vendor/earth-topology.png'), loadImg('vendor/earth-water.png')]);
    if (job !== reliefJob) return;
    const W = 2048, H = 1024, px = img => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.drawImage(img, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
    const elev = px(reliefImgs[0]), water = px(reliefImgs[1]);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const ctx = out.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    const hex = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
    const sea = hex(GT.sea), land = hex(GT.relief), light = GT === GLOBE_THEME.light;
    const E = (x, y) => elev[(((y + H) % H) * W + ((x + W) % W)) * 4];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
      const i = (y * W + x) * 4;
      if (water[i] > 128){ d[i] = sea[0]; d[i + 1] = sea[1]; d[i + 2] = sea[2]; d[i + 3] = 255; continue; }
      const dx = E(x + 1, y) - E(x - 1, y), dy = E(x, y + 1) - E(x, y - 1);
      const shade = Math.max(-1, Math.min(1, (-dx - dy) / 60)), h = E(x, y) / 255;
      const k = 1 + shade * (light ? 0.2 : 0.45) + h * (light ? -0.1 : 0.35);
      d[i] = Math.min(255, land[0] * k); d[i + 1] = Math.min(255, land[1] * k); d[i + 2] = Math.min(255, land[2] * k); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (job !== reliefJob) return;
    globe.globeImageUrl(out.toDataURL('image/jpeg', 0.88));
    mat.color.set('#ffffff'); if (mat.emissive) mat.emissive.set('#000000');
    reliefOn = true; refreshGlobe();
  } catch(e){ /* plain globe */ }
}

/* layout: the globe fills the space beside the panel (desktop) or above it (phone) */
const PANEL_W = 452;
function freeBox(){
  const W = innerWidth, H = innerHeight, open = !!sel;
  if (mob()){   // phone with the sheet open: the globe sits in the gap between the top bar and the sheet
    if (!open) return {x: 0, y: 0, w: W, h: H};
    const top = $('.top').getBoundingClientRect().bottom, ph = $('#panel').getBoundingClientRect().height;
    return {x: 0, y: top, w: W, h: Math.max(160, H - top - ph + 16)};
  }
  return {x: open && LANG === 'ar' ? PANEL_W : 0, y: 0, w: open ? W - PANEL_W : W, h: H};
}
function fitAlt(box = freeBox()){
  const top = mob() ? 110 : 70;
  const r = mob() && sel ? Math.min(box.w, box.h) * 0.46   // the gap above the sheet: header and legend are already outside it
    : Math.max(mob() ? 110 : 150, Math.min(box.w - 24, box.h - top - (mob() ? 120 : 60)) * 0.47);
  const fov = (globe ? globe.camera().fov : 50) * Math.PI / 180;
  const theta = Math.atan(r * Math.tan(fov / 2) / (box.h / 2));
  return Math.min(6, Math.max(1.5, 1 / Math.sin(theta) - 1));
}
function layout(){
  if (!globe) return;
  const b = freeBox();
  globeEl.style.width = b.w + 'px'; globeEl.style.height = b.h + 'px';
  globeEl.style.left = b.x + 'px'; globeEl.style.top = b.y + 'px';
  globe.width(b.w).height(b.h);
  document.body.classList.toggle('p-open', !!sel);
}
addEventListener('resize', () => { layout(); if (tour) tourGo(tour.i); });
function fly(iso){
  const c = COUNTRY[iso]; if (!c || !globe) return;
  ctr.autoRotate = false;
  const pov = globe.pointOfView(), alt = mob() ? fitAlt() * 0.8 : Math.min(Math.max(pov.altitude, 1.4), fitAlt() * 0.85);
  globe.pointOfView({lat: c.lat, lng: c.lng, altitude: alt}, reduceMotion ? 0 : 1000);
}

/* ================================================================ SELECTION + PANEL */
let tab = 'safety';
function select(iso, opts = {}){
  if (!COUNTRY[iso]) return;
  sel = iso;
  if (opts.tab) tab = opts.tab;
  const p = $('#panel'); p.hidden = false; p.classList.remove('min');
  layout(); refreshGlobe(); renderPanel(); fly(iso);
  history.replaceState(null, '', '#' + iso + (tab !== 'safety' ? '/' + tab : ''));
  closeSearch();
}
function closePanel(){
  if (!sel) return;
  sel = null; $('#panel').hidden = true;
  layout(); refreshGlobe();
  history.replaceState(null, '', location.pathname + location.search);
}
$('#p-close').onclick = closePanel;
$('#p-grip').onclick = () => { $('#panel').classList.toggle('min'); setTimeout(layout, 320); };
$$('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderPanel(); history.replaceState(null, '', '#' + sel + (tab !== 'safety' ? '/' + tab : '')); $('#p-body').scrollTop = 0; });

function renderBadge(){
  if (!sel) return;
  const lv = level(sel);
  $('#p-badge').innerHTML = `<i class="lv${lv}"></i>${esc(t('l' + lv))}${colourBy !== 'max' ? ` <span class="small">(${esc(t('src' + colourBy.toUpperCase()))})</span>` : ''}`;
}
function renderPanel(){
  if (!sel) return;
  $('#p-name').textContent = cname(sel);
  const fl = $('#p-flag'); fl.src = flagSrc(sel); fl.alt = '';
  renderBadge();
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  const body = $('#p-body');
  if (tab === 'entry') renderEntry(body);
  else if (tab === 'practical') renderPractical(body);
  else renderSafety(body);
}

const SRC = [['de', 'DE', 'nameDE'], ['uk', 'GB', 'nameUK'], ['us', 'US', 'nameUS']];
function renderSafety(body){
  const s = SAFETY.countries[sel] || {};
  let h = `<h3>${esc(t('officialAdvice'))}</h3>`;
  for (const [k, home, nameKey] of SRC){
    const r = s[k];
    h += `<div class="src l${r ? r.l : 0}"><div class="src-name"><img src="${flagSrc(home)}" alt="">${esc(t(nameKey))}</div>`;
    if (sel === home && !r) h += `<p class="src-meta">${esc(t('ownCountry'))}</p>`;
    else if (!r) h += `<p class="src-meta">${esc(t('notCovered'))}</p>`;
    else {
      let what;
      if (k === 'de') what = t('de_' + r.f);
      else if (k === 'uk') what = r.st && r.st.length ? r.st.map(x => t('uk_' + x)).join(' · ') : t('uk_none');
      else what = t('us_' + r.l);
      h += `<div class="src-level">${esc(what)}</div>
        <div class="src-meta"><span>${esc(t('updated', {date: fmtDate(r.d)}))}</span><a class="ext" href="${esc(r.u)}" target="_blank" rel="noopener">${esc(t('readOfficial'))}</a></div>`;
      if (r.c) h += `<details><summary>${esc(t(k === 'us' ? 'summaryOrig' : 'latestChange'))}</summary><p lang="${k === 'de' ? 'de' : 'en'}" dir="ltr">${esc(r.c)}${r.c.length >= 399 ? '…' : ''}</p></details>`;
    }
    h += '</div>';
  }
  h += `<p class="note warn">${esc(t('safetyNote'))}</p>`;
  if (SAFETY.generated) h += `<p class="small">${esc(t('checkedAt', {date: fmtDate(SAFETY.generated, true)}))}</p>`;
  body.innerHTML = h;
}

const VISA_CACHE = {};
async function loadVisa(pp){
  if (!VISA_CACHE[pp]) VISA_CACHE[pp] = getJSON(`data/visa/${pp}.json`).catch(e => { delete VISA_CACHE[pp]; throw e; });
  return VISA_CACHE[pp];
}
const VISA_CLASS = {fom: ['ok', '✓'], free: ['ok', '✓'], eta: ['mid', '⌨'], evisa: ['mid', '⌨'], evoa: ['mid', '✈'], voa: ['mid', '✈'], req: ['bad', '✎'], no: ['bad', '⛔']};
/* Arabic counts: 1, 2 (dual), 3–10 (plural), 11+ (singular accusative) */
const AR_UNITS = {d: ['يوم واحد', 'يومان', '{n} أيام', '{n} يومًا'], w: ['أسبوع واحد', 'أسبوعان', '{n} أسابيع', '{n} أسبوعًا'],
  m: ['شهر واحد', 'شهران', '{n} أشهر', '{n} شهرًا'], y: ['سنة واحدة', 'سنتان', '{n} سنوات', '{n} سنة'], h: ['ساعة واحدة', 'ساعتان', '{n} ساعات', '{n} ساعة']};
function countText(u, n){
  if (LANG === 'ar' && AR_UNITS[u]){
    const f = AR_UNITS[u], k = n !== Math.floor(n) ? 3 : n === 1 ? 0 : n === 2 ? 1 : n <= 10 ? 2 : 3;
    return f[k].replace('{n}', n.toLocaleString(LOC(), {maximumFractionDigits: 2}));
  }
  if (u === 'h') return t('hours', {n: n.toLocaleString(LOC(), {maximumFractionDigits: 2})});
  return n === 1 ? t('u_' + u + '1') : t('u_' + u, {n});
}
function stayText(s){
  const m = /^(\d+)([dwmy])$/.exec(s || ''); if (!m) return '';
  return t('stayUpTo', {n: countText(m[2], +m[1])});
}
async function renderEntry(body){
  const iso = sel;
  if (!passport){
    body.innerHTML = `<h3>${esc(t('choosePassport'))}</h3><p class="muted">${esc(t('passportWhy'))}</p><p><button class="btn go" type="button" id="pick-pp">${esc(t('choosePassport'))}</button></p>`;
    $('#pick-pp').onclick = openPassport;
    return;
  }
  const dipl = store.get('pp-type') === 'dip';
  let h = `<div class="row" style="margin-bottom:10px"><img class="flag" src="${flagSrc(passport)}" alt=""><b>${esc(t('entryFor', {country: cname(passport)}))}</b>
    <button class="btn" type="button" id="chg-pp" style="margin-inline-start:auto;padding:4px 12px">${esc(t('change'))}</button></div>
    <div class="seg" role="radiogroup"><button type="button" role="radio" data-pt="ord" aria-checked="${!dipl}">${esc(t('ppOrdinary'))}</button><button type="button" role="radio" data-pt="dip" aria-checked="${dipl}">${esc(t('ppDiplomatic'))}</button></div>`;
  const wire = () => { $('#chg-pp').onclick = openPassport; $$('.seg [data-pt]').forEach(b => b.onclick = () => { store.set('pp-type', b.dataset.pt); renderPanel(); }); };
  if (passport === iso){
    body.innerHTML = h + `<p>${esc(t('ownPassport'))}</p>`; wire(); return;
  }
  body.innerHTML = h + `<p class="muted">${esc(t('loading'))}</p>`; wire();
  let v = null, rec = null;
  try { rec = await loadVisa(passport); v = rec.v[iso]; } catch(e){ /* below */ }
  if (sel !== iso || tab !== 'entry') return;   // the visitor moved on meanwhile
  if (dipl){   // diplomatic/service passports: special agreements; show what is public, never guess
    const note = rec && rec.dip && rec.dip[iso];
    h += `<div class="visa mid"><span class="vi" aria-hidden="true">✦</span><div><span>${esc(t('dipIntro', {country: cname(iso)}))}</span></div></div>`;
    h += note ? `<p class="small">${esc(t('dipNote'))}</p><blockquote class="quote" lang="en" dir="ltr">${esc(note)}</blockquote>` : `<p class="muted">${esc(t('dipNone'))}</p>`;
    if (v) h += `<p class="small" style="margin-top:14px">${esc(t('forOrdinary'))}</p>`;
  }
  if (v){
    const [cls, ic] = VISA_CLASS[v[0]] || ['mid', '?'];
    h += `<div class="visa ${cls}${dipl ? ' dim' : ''}"><span class="vi" aria-hidden="true">${ic}</span><div><b>${esc(t('v_' + v[0]))}</b>${v[1] ? `<span>${esc(stayText(v[1]))}</span>` : ''}</div></div>`;
    if (v[2] === 'pi' || rec.src === 'pi') h += `<p class="small">${esc(t(rec.src === 'pi' ? 'visaSrcPI' : 'olderEntry', {date: fmtDate(rec.pi)}))}</p>`;
    else h += `<p class="small">${t('visaSrcWP', {title: `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(rec.t.replace(/ /g, '_'))}" target="_blank" rel="noopener" lang="en" dir="ltr">${esc(rec.t)}</a>`, date: esc(fmtDate(rec.d))})}</p>`;
  } else h += `<p>${esc(t('noVisaData'))}</p>`;
  h += `<p class="note warn">${esc(t('visaNote'))}</p><h3>${esc(t('officialEntry'))}</h3><ul class="links">`;
  const s = SAFETY.countries[iso] || {};
  if (passport === 'DE' && s.de) h += `<li><a href="${esc(s.de.u)}" target="_blank" rel="noopener">${esc(t('entryDE'))}</a></li>`;
  if (passport === 'GB' && s.uk) h += `<li><a href="${esc(s.uk.u)}/entry-requirements" target="_blank" rel="noopener">${esc(t('entryUK'))}</a></li>`;
  if (passport === 'US' && s.us) h += `<li><a href="${esc(s.us.u)}" target="_blank" rel="noopener">${esc(t('entryUS'))}</a></li>`;
  h += `<li><a href="https://www.iatatravelcentre.com/" target="_blank" rel="noopener">${esc(t('entryIATA'))}</a></li></ul>
    <p class="muted" style="font-size:13px">${esc(t('entryEmbassy', {country: cname(iso)}))}</p>`;
  body.innerHTML = h;
  wire();
}

/* ---- practical ---- */
const PLUG_FITS = {C: ['C', 'E', 'F', 'J', 'K', 'L', 'N'], E: ['E', 'F'], F: ['E', 'F'], A: ['A', 'B'], B: ['B']};
function homeCurrency(){
  const saved = store.get('cur');
  if (saved && RATES && RATES.r[saved]) return saved;
  const f = passport && FACTS.c[passport];
  const c = f && (f.cur || []).find(x => RATES && RATES.r[x]);
  return c || 'EUR';
}
function tzOffset(tz, d = new Date()){
  try {
    const s = new Intl.DateTimeFormat('en-US', {timeZone: tz, timeZoneName: 'longOffset'}).formatToParts(d).find(p => p.type === 'timeZoneName').value;
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(s); if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0));
  } catch(e){ return null; }
}
const hoursText = min => countText('h', Math.abs(min) / 60);
function renderPractical(body){
  const f = FACTS.c[sel], hf = passport ? FACTS.c[passport] || {} : {};
  if (!f){ body.innerHTML = `<p class="muted">${esc(t('noData'))}</p>`; return; }
  let h = '<dl class="kv">';
  // currency and today's rate
  if (f.cur && f.cur.length && RATES){
    const home = homeCurrency(), main = f.cur.find(c => RATES.r[c]) || f.cur[0];
    let rate = '';
    if (main === home) rate = `<small>${esc(t('sameCurrency'))}</small>`;
    else if (RATES.r[main] && RATES.r[home]){
      const x = RATES.r[main] / RATES.r[home];
      const ecb = RATES.s[main] === 'ecb' && RATES.s[home] === 'ecb';
      const srcName = ecb ? 'ECB' : 'ExchangeRate-API', date = ecb ? RATES.d.ecb : RATES.d.er;
      rate = `<span dir="ltr">1 ${home} = ${fmtNum(x)} ${main}</span><br><span dir="ltr">1 ${main} = ${fmtNum(1 / x)} ${home}</span>
        <small>${esc(t('rateFrom', {src: srcName, date: fmtDate(date)}))}</small>`;
    } else rate = `<small>${esc(t('noRate'))}</small>`;
    const opts = Object.keys(RATES.r).sort((a, b) => curName(a).localeCompare(curName(b), LOC()))
      .map(c => `<option value="${c}"${c === home ? ' selected' : ''}>${esc(curName(c))} (${c})</option>`).join('');
    h += `<dt>${esc(t('currency'))}</dt><dd>${f.cur.map(c => `${esc(curName(c))} (${c})`).join(', ')}<br>${rate}
      <small><label>${esc(t('yourCurrency'))}: <select class="cur-select" id="cur-sel">${opts}</select></label></small></dd>`;
  }
  // power
  if (f.p || f.v){
    let extra = '';
    if (f.p && hf.p && passport !== sel){
      const fits = hf.p.some(mine => (PLUG_FITS[mine] || [mine]).some(x => f.p.includes(x)));
      extra += `<small>${esc(t(fits ? 'plugsFit' : 'plugsAdapter', {list: hf.p.join(', ')}))}</small>`;
    }
    if (f.v && hf.v && passport !== sel && Math.abs(Math.max(...f.v) - Math.max(...hf.v)) > 40) extra += `<small>⚡ ${esc(t('voltageDiff'))}</small>`;
    h += `<dt>${esc(t('power'))}</dt><dd>${f.p ? esc(t('plugs', {list: f.p.join(', ')})) : ''}${f.v ? `<br><span dir="ltr">${f.v.join(' / ')} V${f.hz ? ' · ' + f.hz.join(' / ') + ' Hz' : ''}</span>` : ''}${extra}</dd>`;
  }
  if (f.dr) h += `<dt>${esc(t('driving'))}</dt><dd>${esc(t(f.dr === 'L' ? 'driveL' : 'driveR'))}</dd>`;
  if (f.lang && f.lang.length) h += `<dt>${esc(t('languages'))}</dt><dd>${esc(f.lang.map(langName).join(', '))}</dd>`;
  // time: the zone nearest the capital, and the difference to the visitor's own clock
  if (f.tz && f.tz.length){
    const now = new Date(), mine = -now.getTimezoneOffset();
    const offs = [...new Set(f.tz.map(z => tzOffset(z, now)).filter(x => x !== null))].sort((a, b) => a - b);
    let zone = f.tz[0];
    if (f.cap && offs.length > 1){ const want = f.cap.lng / 15 * 60; zone = f.tz.slice().sort((a, b) => Math.abs(tzOffset(a, now) - want) - Math.abs(tzOffset(b, now) - want))[0]; }
    const off = tzOffset(zone, now), diff = off - mine;
    const local = now.toLocaleTimeString(LOC(), {timeZone: zone, hour: '2-digit', minute: '2-digit'});
    const rel = diff === 0 ? t('sameTime') : t(diff > 0 ? 'ahead' : 'behind', {h: hoursText(diff)});
    h += `<dt>${esc(t('time'))}</dt><dd>${esc(t('localTime', {time: local}))}${f.cap && offs.length > 1 ? ` (${esc(f.cap.n[LANG] || f.cap.n.en)})` : ''}<small>${esc(rel)}</small>${offs.length > 1 ? `<small>${esc(t('zones', {n: offs.length}))}</small>` : ''}</dd>`;
  }
  if (f.cc) h += `<dt>${esc(t('callingCode'))}</dt><dd dir="ltr" style="text-align:start">${esc(f.cc.join(', '))}</dd>`;
  if (f.em) h += `<dt>${esc(t('emergency'))}</dt><dd dir="ltr" style="text-align:start"><b>${esc(f.em.join(' · '))}</b></dd>`;
  if (f.cap) h += `<dt>${esc(t('capital'))}</dt><dd>${esc(f.cap.n[LANG] || f.cap.n.en)}</dd>`;
  h += '</dl>';
  h += `<p class="note">${esc(t('practicalNote'))}</p>
    <p class="sources-line">${esc(t('sources'))}: <a href="https://www.wikidata.org/" target="_blank" rel="noopener">Wikidata</a> (CC0) ·
      <a href="https://www.iana.org/time-zones" target="_blank" rel="noopener">IANA tz</a> ·
      <a href="https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html" target="_blank" rel="noopener">ECB</a> ·
      <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">Rates By Exchange Rate API</a></p>`;
  body.innerHTML = h;
  const cs = $('#cur-sel'); if (cs) cs.onchange = e => { store.set('cur', e.target.value); renderPanel(); };
}

/* ================================================================ PASSPORT */
function updatePassportChip(){
  const img = $('#pp-flag'), lab = $('#pp-label');
  if (passport){ img.src = flagSrc(passport); img.hidden = false; lab.textContent = mob() ? passport : cname(passport); }
  else { img.hidden = true; lab.textContent = mob() ? '🛂' : t('passport'); }
}
function sortedCountries(){
  return Object.keys(COUNTRY).filter(i => i !== 'AQ').sort((a, b) => cname(a).localeCompare(cname(b), LOC()));
}
function openPassport(){
  const m = $('#pp-modal'); m.hidden = false;
  const q = $('#pp-q'); q.value = ''; fillPassport('');
  setTimeout(() => q.focus(), 50);
}
function fillPassport(q){
  const n = norm(q);
  $('#pp-list').innerHTML = sortedCountries().filter(i => !n || norm(cname(i)).includes(n) || norm(COUNTRY[i].n).includes(n))
    .map(i => `<li role="option" data-iso="${i}" aria-selected="${i === passport}"><img class="flag" src="${flagSrc(i)}" alt="" loading="lazy">${esc(cname(i))}</li>`).join('');
}
$('#pp-q').oninput = e => fillPassport(e.target.value);
$('#pp-list').onclick = e => {
  const li = e.target.closest('[data-iso]'); if (!li) return;
  passport = li.dataset.iso; store.set('passport', passport); store.set('cur', null);
  $('#pp-modal').hidden = true; updatePassportChip(); renderPanel();
};
$('#pp-btn').onclick = openPassport;

/* ================================================================ SEARCH */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
let SEARCH = [], qSel = -1;
function buildSearch(){
  SEARCH = Object.keys(COUNTRY).map(i => {
    const f = FACTS.c[i] || {}, cap = f.cap ? f.cap.n[LANG] || f.cap.n.en : '';
    return {i, name: cname(i), cap, keys: [cname(i), COUNTRY[i].n, i, cap, ...(f.cap ? Object.values(f.cap.n) : [])].map(norm)};
  });
}
function runSearch(){
  const q = norm($('#q').value), list = $('#q-list');
  if (!q){ closeSearch(); return; }
  const hits = SEARCH.map(s => ({s, score: s.keys[0].startsWith(q) ? 0 : s.keys.some(k => k.startsWith(q)) ? 1 : s.keys.some(k => k.includes(q)) ? 2 : 9}))
    .filter(x => x.score < 9).sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name, LOC())).slice(0, 8);
  qSel = hits.length ? 0 : -1;
  list.innerHTML = hits.length ? hits.map((x, k) => `<li role="option" data-iso="${x.s.i}" aria-selected="${k === 0}"><img class="flag" src="${flagSrc(x.s.i)}" alt="">${esc(x.s.name)}${x.s.cap ? `<small>${esc(x.s.cap)}</small>` : ''}</li>`).join('')
    : `<li class="muted">${esc(t('noMatch'))}</li>`;
  list.hidden = false;
}
function closeSearch(){ $('#q-list').hidden = true; qSel = -1; }
$('#q').addEventListener('input', runSearch);
$('#q').addEventListener('keydown', e => {
  const items = $$('#q-list li[data-iso]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault(); if (!items.length) return;
    qSel = (qSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, k) => li.setAttribute('aria-selected', k === qSel));
  } else if (e.key === 'Enter' && items[qSel]){ select(items[qSel].dataset.iso); $('#q').value = ''; $('#q').blur(); }
  else if (e.key === 'Escape'){ closeSearch(); $('#q').blur(); }
});
$('#q-list').addEventListener('click', e => { const li = e.target.closest('[data-iso]'); if (li){ select(li.dataset.iso); $('#q').value = ''; } });
document.addEventListener('pointerdown', e => { if (!e.target.closest('.search')) closeSearch(); });

/* ================================================================ TICKER: newest changes in official advice, then "do not travel" */
function buildTicker(){
  const items = [], seen = new Set(), now = Date.now(), srcName = k => t('src' + k.toUpperCase());
  for (const ch of SAFETY.changes || []){
    if (items.length >= 12) break;
    items.push({c: ch.c, lv: ch.to, at: ch.at, text: t(ch.to > ch.from ? 'tkRaised' : 'tkLowered', {country: cname(ch.c), src: srcName(ch.s), level: t('l' + ch.to)})});
    seen.add(ch.c + ch.s);
  }
  const recent = [];
  for (const [iso, c] of Object.entries(SAFETY.countries)) for (const k of ['de', 'uk', 'us']){
    const r = c[k]; if (!r || r.l < 2 || seen.has(iso + k)) continue;
    const age = (now - new Date(r.d)) / 864e5;
    if (age <= 10) recent.push({c: iso, lv: r.l, at: r.d, text: t('tkUpdated', {country: cname(iso), src: srcName(k), level: t('l' + r.l)})});
  }
  recent.sort((a, b) => b.lv - a.lv || (a.at < b.at ? 1 : -1));
  items.push(...recent.slice(0, 14));
  const dnt = Object.entries(SAFETY.countries).filter(([, c]) => c.l === 4)
    .map(([iso, c]) => ({c: iso, lv: 4, text: t('tkDoNot', {country: cname(iso), srcs: ['de', 'uk', 'us'].filter(k => (c[k] || {}).l === 4).map(srcName).join(', ')})}))
    .sort((a, b) => a.text.localeCompare(b.text, LOC()));
  items.push(...dnt);
  const tk = $('#ticker');
  if (!items.length){ tk.hidden = true; return; }
  const html = items.map(it => `<button class="tk-item" type="button" data-iso="${it.c}"><i class="lv${it.lv}"></i><span>${esc(it.text)}</span>${it.at ? `<time>${esc(fmtDate(it.at))}</time>` : ''}</button>`).join('');
  const run = $('#tk-run');
  run.innerHTML = html + html;   // twice, so the loop is seamless
  tk.hidden = false;
  requestAnimationFrame(() => { run.style.setProperty('--tk-dur', Math.max(30, run.scrollWidth / 2 / 45) + 's'); });
  setFold(store.get('tk-folded') === '1', false);
}
$('#tk-run').addEventListener('click', e => { const b = e.target.closest('[data-iso]'); if (b) select(b.dataset.iso); });
function setFold(f, save = true){
  const tk = $('#ticker'), b = $('#tk-fold');
  tk.classList.toggle('folded', f);
  b.setAttribute('aria-expanded', !f); b.title = t(f ? 'openTicker' : 'foldTicker');
  if (save) store.set('tk-folded', f ? '1' : '0');
}
$('#tk-fold').onclick = () => setFold(!$('#ticker').classList.contains('folded'));

/* ================================================================ TOOLS */
function applyTheme(th, save){
  th = th === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = th;
  if (save) store.set('theme', th);
  $('#theme-btn').textContent = th === 'light' ? '☾' : '☀';
  document.querySelector('meta[name="theme-color"]').content = th === 'light' ? '#e9eff6' : '#060b17';
  applyGlobeTheme();
  if (READY) buildTicker();
}
$('#theme-btn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => { if (!store.get('theme')) applyTheme(e.matches ? 'light' : 'dark'); }); } catch(e){}

/* no accidental page zoom: pinching zooms the globe, never the page (as in Faultlines) */
addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, {passive: false});
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), {passive: false}));
document.addEventListener('touchmove', e => { if (e.touches.length > 1 && !e.target.closest('#globe')) e.preventDefault(); }, {passive: false});
$('#reset-btn').onclick = () => {
  if (globe) globe.pointOfView({altitude: fitAlt()}, reduceMotion ? 0 : 800);
  const vp = document.querySelector('meta[name="viewport"]'), orig = vp.content;
  if (window.visualViewport && visualViewport.scale > 1.01){ vp.content = orig.replace(/,?\s*maximum-scale=[\d.]+/, '') + ', maximum-scale=1'; setTimeout(() => { vp.content = orig; }, 400); }
};

/* modals */
$('#help-btn').onclick = () => { $('#help').hidden = false; };
$$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; }));
$('#replay-btn').onclick = () => { $('#help').hidden = true; startTour(); };
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || tour) return;
  const open = $$('.modal').find(m => !m.hidden);
  if (open) open.hidden = true; else if (sel && document.activeElement !== $('#q')) closePanel();
});
function updateFoot(){ $('#foot-upd').textContent = SAFETY.generated ? t('dataUpdated', {date: fmtDate(SAFETY.generated)}) : ''; }

/* ================================================================ TOUR (first visit; replay from the ? help) */
const TOUR_KEY = 'tour-1';
function tourSteps(){
  return [
    {t: 't1t', b: 't1b', langs: true},
    {el: '#globe', t: 't2t', b: 't2b', globe: true},
    {el: '#legend', t: 't3t', b: 't3b'},
    {el: '#pp-btn', t: 't4t', b: 't4b'},
    {el: '.search', t: 't5t', b: 't5b'},
    {el: '#ticker', t: 't6t', b: 't6b'},
    {el: '#help-btn', t: 't7t', b: 't7b', last: true},
  ];
}
const tourVisible = st => { if (!st.el) return true; const e = $(st.el); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
let tour = null;
function startTour(){
  endTour(false); closePanel();
  const steps = tourSteps(), box = document.createElement('div');
  box.className = 'tour'; box.setAttribute('role', 'dialog');
  box.innerHTML = `<div class="tour-spot none"></div><div class="tour-card"><h4></h4><p></p>
    <div class="tour-langs"><small></small><div>${LANGS.map(l => `<button class="tour-btn" type="button" data-lang="${l}" lang="${l}">${LANG_NAMES[l]}</button>`).join('')}</div></div>
    <div class="tour-foot"><span class="tour-dots">${steps.map(() => '<i></i>').join('')}</span>
    <button class="tour-btn skip" type="button" data-t="skip"></button><button class="tour-btn" type="button" data-t="back"></button><button class="tour-btn go" type="button" data-t="next"></button></div></div>`;
  document.body.appendChild(box);
  tour = {i: 0, steps, box};
  box.addEventListener('click', e => {
    const l = e.target.closest('[data-lang]');
    if (l){ setLang(l.dataset.lang); tourGo(tour.i); return; }
    const b = e.target.closest('[data-t]'); if (!b) return;
    if (b.dataset.t === 'skip') endTour(true); else if (b.dataset.t === 'back') tourGo(tour.i - 1, -1); else tourGo(tour.i + 1);
  });
  tourGo(0);
}
function tourGo(i, dir = 1){
  if (!tour) return;
  while (i >= 0 && i < tour.steps.length && !tourVisible(tour.steps[i])) i += dir;
  if (i >= tour.steps.length) return endTour(true);
  tour.i = i = Math.max(0, i);
  const st = tour.steps[i], box = tour.box, spot = box.querySelector('.tour-spot'), card = box.querySelector('.tour-card');
  card.querySelector('h4').textContent = t(st.t); card.querySelector('p').textContent = t(st.b);
  box.querySelector('.tour-langs small').textContent = t('tourLang');
  box.querySelector('.tour-langs').hidden = !st.langs;
  box.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('go', b.dataset.lang === LANG));
  box.querySelectorAll('.tour-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
  const back = box.querySelector('[data-t="back"]'); back.hidden = i === 0; back.textContent = t('back');
  const skip = box.querySelector('[data-t="skip"]'); skip.hidden = !!st.last; skip.textContent = t('skip');
  box.querySelector('[data-t="next"]').textContent = st.last ? t('letsGo') : i === 0 ? t('tourStart') : t('next');
  $$('.ico.lit').forEach(b => b.classList.remove('lit'));
  if (st.last) $('#help-btn').classList.add('lit');
  const W = innerWidth, H = innerHeight, pad = 12, cw = card.offsetWidth, ch = card.offsetHeight;
  const el = st.el && $(st.el);
  if (!el){ spot.className = 'tour-spot none'; card.style.left = (W - cw) / 2 + 'px'; card.style.top = Math.max(pad, (H - ch) / 2) + 'px'; return; }
  let r = el.getBoundingClientRect();
  if (st.globe){ const b = freeBox(), size = Math.min(b.w - 40, b.h - 160); r = {left: b.x + b.w / 2 - size / 2, top: b.h / 2 - size / 2 + 20, width: size, height: size}; r.right = r.left + size; r.bottom = r.top + size; spot.style.borderRadius = '50%'; }
  else spot.style.borderRadius = '12px';
  const m = 6; spot.className = 'tour-spot';
  Object.assign(spot.style, {left: r.left - m + 'px', top: r.top - m + 'px', width: r.width + 2 * m + 'px', height: r.height + 2 * m + 'px'});
  let x, y;
  if (!mob() && r.right + pad + cw < W){ x = r.right + pad * 2; y = r.top; }
  else if (!mob() && r.left - pad * 2 - cw > 0){ x = r.left - pad * 2 - cw; y = r.top; }
  else if (r.bottom + pad + ch < H){ x = r.left + r.width / 2 - cw / 2; y = r.bottom + pad * 2; }
  else if (r.top - pad - ch > 0){ x = r.left + r.width / 2 - cw / 2; y = r.top - pad * 2 - ch; }
  else { x = (W - cw) / 2; y = H - ch - pad; }
  card.style.left = Math.min(Math.max(pad, x), W - cw - pad) + 'px';
  card.style.top = Math.min(Math.max(pad, y), H - ch - pad) + 'px';
}
function endTour(done){
  if (!tour) return;
  tour.box.remove(); tour = null;
  $$('.ico.lit').forEach(b => b.classList.remove('lit'));
  if (done) store.set(TOUR_KEY, '1');
}
addEventListener('keydown', e => { if (!tour) return;
  if (e.key === 'Escape') endTour(true); else if (e.key === 'ArrowRight' || e.key === 'Enter') tourGo(tour.i + 1); else if (e.key === 'ArrowLeft') tourGo(tour.i - 1, -1); });

/* ================================================================ START */
function fromHash(){
  const m = /^#([A-Z]{2})(?:\/(safety|entry|practical))?$/.exec(location.hash);
  if (m && COUNTRY[m[1]]) select(m[1], {tab: m[2] || 'safety'});
}
async function start(){
  applyStatic();
  $('#lang').value = LANG;
  applyTheme(document.documentElement.dataset.theme);
  updatePassportChip();
  try { WORLD = await getJSON('data/world.json'); }
  catch(e){ toast(t('loadFail'), 20000); return; }
  WORLD.countries.forEach(c => { COUNTRY[c.id] = c; });
  initGlobe();
  const res = await Promise.allSettled([getJSON('data/safety.json'), getJSON('data/facts.json'), getJSON('data/rates.json')]);
  if (res[0].status === 'fulfilled') SAFETY = res[0].value;
  if (res[1].status === 'fulfilled') FACTS = res[1].value;
  if (res[2].status === 'fulfilled') RATES = res[2].value;
  if (res.some(r => r.status === 'rejected')) toast(t('loadFail'));
  READY = true;
  buildSearch(); buildTicker(); updateFoot(); refreshGlobe();
  layout(); globe.pointOfView({altitude: fitAlt(), lat: 20, lng: 10}, 0);
  fromHash();
  if (!store.get(TOUR_KEY) && !/[?&]notour\b/.test(location.search)) setTimeout(() => { if (!tour) startTour(); }, 1500);
}
addEventListener('hashchange', fromHash);
addEventListener('load', () => setTimeout(() => { if (globe) layout(); }, 300));
start();
