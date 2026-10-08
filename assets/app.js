/* Atlasroam: the travel globe. Plain JavaScript, no build step.
   Data (refreshed by GitHub Actions, see scripts/): data/world.json, places/XX.json (Wikivoyage), inspire.json,
   facts.json, rates.json, visa/XX.json, safety.json (only for the official entry-information links).
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
let passport = store.get('passport');
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function rgba(hex, a){ const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
function mix(hex, to, k){ const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const c = i => Math.max(0, Math.min(255, Math.round((a >> i & 255) * (1 - k) + (b >> i & 255) * k)));
  return '#' + [16, 8, 0].map(i => c(i).toString(16).padStart(2, '0')).join(''); }

/* ================================================================ GLOBE */
// "Bold tropical": every world region has its own colour family; Natural Earth's 7-colour index shades
// neighbours a little lighter or darker so borders stay readable
const GLOBE_THEME = {
  dark: {sea: '#1e1e1e', atmo: '#ff8a70', side: 'rgba(0,0,0,0.35)', stroke: 'rgba(20,20,20,0.75)', relief: '#2b2724', ambient: 1, sun: 0.6, shade: '#000000',
    fam: {lilac: '#9d86e9', mango: '#e9a548', coral: '#e9787c', mint: '#46c08c', lemon: '#e8c94a', peach: '#e88f62'}},
  light: {sea: '#f3e9df', atmo: '#ffb199', side: 'rgba(120,60,30,0.10)', stroke: 'rgba(255,255,255,0.95)', relief: '#fbf5ee', ambient: 1.75, sun: 0.12, shade: '#ffffff',
    fam: {lilac: '#c4afff', mango: '#ffc46e', coral: '#ff9a9e', mint: '#86e0b8', lemon: '#ffe170', peach: '#ffb48c'}},
};
const REGION_FAMILY = r => /Europe/.test(r) ? 'lilac' : /Africa/.test(r) ? 'mango' : r === 'Western Asia' ? 'peach' : /Asia/.test(r) ? 'coral'
  : /America|Caribbean/.test(r) ? 'mint' : 'lemon';
let GT = GLOBE_THEME.dark, globe = null, mat = null, ctr = null, FEATURES = [], MICRO = [];
let sel = null, hoverId = null, reliefOn = false;
const globeEl = $('#globe');

function baseColour(iso){
  const c = COUNTRY[iso]; if (!c) return GT.fam.lemon;
  const fam = GT.fam[REGION_FAMILY(c.r || '')];
  return mix(fam, GT.shade, ((c.c || 4) - 4) * 0.06 + 0.04);
}
function capColor(f){
  let c = baseColour(f.id);
  if (sel && f.id !== sel) c = mix(c, GT.sea, 0.72);   // the chosen country keeps its colour, the rest fades back
  if (f.id === hoverId && f.id !== sel) c = mix(c, '#ffffff', 0.3);
  return rgba(c, reliefOn ? 0.92 : 1);
}
// close to a city the camera flies low, so countries lie flat then
const altitude = f => city ? 0.0002 : f.id === sel || f.id === hoverId ? 0.012 : 0.006;
const pname = n => (n && (n[LANG] || n.en)) || '';
function tipHTML(iso){ return `<div class="tip"><b>${esc(cname(iso))}</b></div>`; }

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
    .polygonStrokeColor(() => GT.stroke)
    .polygonAltitude(altitude)
    .polygonsTransitionDuration(260)
    .polygonLabel(f => sel === f.id ? '' : tipHTML(f.id))
    .onPolygonHover(f => { hoverId = f ? f.id : null; globeEl.style.cursor = f ? 'pointer' : 'grab'; refreshGlobe(); })
    .onPolygonClick(f => { if (!justClickedPin() && f.id !== sel) select(f.id); })
    .pointsData(MICRO).pointLat('lat').pointLng('lng').pointAltitude(0.01).pointRadius(0.38)
    .pointColor(p => p.id === sel ? cssVar('--accent') : baseColour(p.id))
    .pointLabel(p => tipHTML(p.id))
    .onPointClick(p => select(p.id))
    .htmlElementsData([]).htmlLat('lat').htmlLng('lng').htmlAltitude(() => city ? 0.0004 : 0.014).htmlElement(makePin)
    .onGlobeClick(() => { if (!justClickedPin()) closePanel(); });
  globe.htmlElementVisibilityModifier((el, v) => { if (!el) return; el.style.opacity = v ? 1 : 0; el.style.pointerEvents = v ? 'auto' : 'none'; });
  mat = globe.globeMaterial();
  ctr = globe.controls();
  ctr.autoRotate = !reduceMotion; ctr.autoRotateSpeed = 0.35;
  ctr.minDistance = 100.08;   // close enough to see a city's sights (about 5 km up)
  globeEl.addEventListener('pointerdown', () => { ctr.autoRotate = false; });
  applyGlobeTheme();
}
function refreshGlobe(){
  if (!globe) return;
  globe.polygonCapColor(capColor).polygonAltitude(altitude).polygonStrokeColor(() => GT.stroke)
    .pointColor(p => p.id === sel ? cssVar('--accent') : baseColour(p.id));
}
function applyGlobeTheme(){
  const th = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  GT = GLOBE_THEME[th];
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
      const k = 1 + shade * (light ? 0.12 : 0.4) + h * (light ? -0.06 : 0.3);
      d[i] = Math.min(255, land[0] * k); d[i + 1] = Math.min(255, land[1] * k); d[i + 2] = Math.min(255, land[2] * k); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (job !== reliefJob) return;
    globe.globeImageUrl(out.toDataURL('image/jpeg', 0.88));
    mat.color.set('#ffffff'); if (mat.emissive) mat.emissive.set('#000000');
    reliefOn = true; refreshGlobe();
  } catch(e){ /* plain globe */ }
}

/* ---- pins: the country's cities and destinations, or the open city's sights ---- */
let pinClickAt = 0, PINS = [], pinOn = null;
const justClickedPin = () => Date.now() - pinClickAt < 500;
function makePin(p){
  const el = document.createElement('button');
  // phones in a city: dots only (names overlap in a small space); the tapped one shows its name
  const small = p.small || (city && mob() && p.kind !== 'city');
  el.type = 'button'; el.className = 'pin ' + p.kind + (small ? ' sm' : '') + (p === pinOn ? ' on' : '');
  el.innerHTML = `<i></i><span>${esc(pname(p.n))}</span>`;
  el.title = pname(p.n);
  el.addEventListener('click', e => { e.stopPropagation(); pinClickAt = Date.now(); onPin(p); });
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(ev => el.addEventListener(ev, e => { e.stopPropagation(); pinClickAt = Date.now(); }));
  return el;
}
function setPins(list){ PINS = list; if (globe) globe.htmlElementsData(list); }
function countryPins(data){
  const out = [];
  (data.cities || []).forEach(d => out.push({...d, kind: 'city', ref: d}));
  (data.other || []).forEach(d => out.push({...d, kind: 'other', ref: d, small: true}));
  (data.offbeat || []).forEach(d => out.push({...d, kind: 'next', ref: d, small: true}));
  return out;
}
function cityPins(dest){
  const x = dest.x || {}, out = [{...dest, kind: 'city', ref: dest}];
  (x.must || []).forEach(s => out.push({...s, kind: 'must', ref: s}));
  (x.hidden || []).forEach(s => out.push({...s, kind: 'hidden', ref: s, small: true}));
  (x.next || []).forEach(s => out.push({...s, kind: 'next', ref: s, small: true}));
  return out;
}
function onPin(p){
  if (!city && (p.kind === 'city' || p.kind === 'other') && p.ref.x) return openCity(p.ref);
  focusPlace(p.ref);
}
function focusPlace(ref){
  const p = PINS.find(x => x.ref === ref) || null;
  pinOn = p; if (globe) globe.htmlElementsData(PINS.slice());   // redraw with the highlighted one
  if (ref.lat != null) flyTo(ref.lat, ref.lng, city ? Math.min(globe.pointOfView().altitude, 0.03) : 0.4);
  const card = $(`#p-body [data-pid="${CSS.escape(placeKey(ref))}"]`);
  $$('#p-body .card.on').forEach(c => c.classList.remove('on'));
  if (card){ card.classList.add('on'); card.scrollIntoView({block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth'}); }
  if (mob() && !$('#panel').classList.contains('min')){ $('#panel').classList.add('min'); setTimeout(layout, 320); }   // phones: fold the sheet to show the spot
}
const placeKey = r => (r.n && r.n.en || r.id || '') + '|' + r.lat + '|' + r.lng;

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
  const r = mob() && sel ? Math.min(box.w, box.h) * 0.46
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
addEventListener('resize', () => { layout(); updatePassportChip(); if (tour) tourGo(tour.i); });
/* camera flights: our own animation, so a new flight cleanly replaces one still under way (the library's own
   animations overlap and then miss the target, which shows badly when close to a city) */
let flight = 0;
function flyTo(lat, lng, alt, ms = reduceMotion ? 0 : 1200){
  if (!globe) return;
  ctr.autoRotate = false;
  const id = ++flight, a = globe.pointOfView(), t0 = performance.now(), k0 = now => ms ? (now - t0) / ms : 1;
  const dLng = ((lng - a.lng + 540) % 360) - 180;
  // zoom on a log scale (smooth from far away to street level), out a little in the middle of long flights
  const la0 = Math.log(a.altitude), la1 = Math.log(alt), hop = Math.min(1, Math.hypot(lat - a.lat, dLng) / 40) * 0.6;
  stopSpin();
  const step = now => {
    if (id !== flight) return;
    if (k0(now) >= 1) stopSpin();
    const k = ms ? Math.min(1, (now - t0) / ms) : 1, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    globe.pointOfView({lat: a.lat + (lat - a.lat) * e, lng: a.lng + dLng * e, altitude: Math.exp(la0 + (la1 - la0) * e + hop * Math.sin(Math.PI * e))}, 0);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
globeEl.addEventListener('pointerdown', () => { flight++; }, true);   // the visitor grabs the globe: stop flying
/* the controls keep a little spin after the auto-rotation stops (smooth damping); near a city that spin carries the
   view kilometres away, so it is cleared whenever the camera flies somewhere */
function stopSpin(){
  ctr.autoRotate = false;
  for (const k of ['_sphericalDelta', 'sphericalDelta']) if (ctr[k] && ctr[k].set) ctr[k].set(0, 0, 0);
  for (const k of ['_panOffset', 'panOffset']) if (ctr[k] && ctr[k].set) ctr[k].set(0, 0, 0);
}
/* zoom so that all the given points fit (a country's cities, a city's sights) */
function flyToFit(pts, fallback){
  pts = pts.filter(p => p.lat != null);
  if (!pts.length){ if (fallback) flyTo(fallback.lat, fallback.lng, Math.max(1.2, fitAlt() * 0.6)); return; }
  // the middle = median (one sight with odd coordinates must not pull the view away); longitudes relative to the first point
  const med = a => { a = a.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const lng0 = pts[0].lng, lat = med(pts.map(p => p.lat));
  const lng = ((med(pts.map(p => (p.lng - lng0 + 540) % 360 - 180)) + lng0 + 540) % 360) - 180;
  // distance of the points from their middle; the farthest 15% are ignored, so one outlier doesn't zoom everything out
  const dists = pts.map(p => Math.hypot(p.lat - lat, ((p.lng - lng + 540) % 360 - 180) * Math.cos(lat * Math.PI / 180))).sort((a, b) => a - b);
  const span = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.85))] || 0.05;
  // close up, the view's height shows about 50° of arc per unit of altitude: fit the span into the free space with a margin
  const box = freeBox(), fill = Math.min(box.w, box.h) / box.h * (mob() ? 0.75 : 1);
  flyTo(lat, lng, Math.min(fitAlt() * 0.8, Math.max(0.0012, span * 2 / 50 / fill * 1.5)));
}

/* ================================================================ SELECTION + PANEL */
let tab = 'places', city = null;
const PLACES = {};
async function loadPlaces(iso){
  if (!PLACES[iso]) PLACES[iso] = getJSON(`data/places/${iso}.json`).catch(() => null);
  return PLACES[iso];
}
function select(iso, opts = {}){
  if (!COUNTRY[iso]) return;
  sel = iso; city = null; pinOn = null;
  tab = opts.tab || 'places';
  document.body.classList.add('explored');
  const p = $('#panel'); p.hidden = false; p.classList.remove('min');
  layout(); refreshGlobe(); setPins([]); renderPanel();
  const c = COUNTRY[iso];
  flyTo(c.lat, c.lng, mob() ? fitAlt() * 0.8 : Math.min(Math.max(globe.pointOfView().altitude, 1.4), fitAlt() * 0.85));
  loadPlaces(iso).then(d => {
    if (sel !== iso || city) return;
    if (d){ setPins(countryPins(d)); if (!opts.city) flyToFit((d.cities || []).concat(d.other || []), c); }
    if (opts.city && d){ const dest = (d.cities || []).concat(d.other || []).find(x => x.id === opts.city); if (dest) openCity(dest); }
    else if (tab === 'places') renderPanel();
  });
  setHash();
  closeSearch();
}
function openCity(dest){
  city = dest; tab = 'places'; pinOn = null;
  setPins(cityPins(dest));
  const x = dest.x || {};
  flyToFit([dest, ...(x.must || []), ...(x.hidden || [])], dest);
  renderPanel(); $('#p-body').scrollTop = 0; setHash();
}
function closeCity(){
  city = null; pinOn = null;
  const d = PLACES[sel];
  Promise.resolve(d).then(data => { if (data && !city){ setPins(countryPins(data)); flyToFit((data.cities || []).concat(data.other || []), COUNTRY[sel]); } });
  renderPanel(); setHash();
}
function setHash(){
  if (!sel) return history.replaceState(null, '', location.pathname + location.search);
  history.replaceState(null, '', '#' + sel + (city ? '/c/' + encodeURIComponent(city.id) : tab !== 'places' ? '/' + tab : ''));
}
function closePanel(){
  if (!sel) return;
  sel = null; city = null; $('#panel').hidden = true;
  setPins([]); layout(); refreshGlobe(); setHash();
}
$('#p-close').onclick = closePanel;
$('#p-back').onclick = closeCity;
$('#p-grip').onclick = () => { $('#panel').classList.toggle('min'); setTimeout(layout, 320); };
$$('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderPanel(); setHash(); $('#p-body').scrollTop = 0; });

function renderPanel(){
  if (!sel) return;
  const fl = $('#p-flag'); fl.src = flagSrc(sel); fl.alt = '';
  const back = $('#p-back');
  if (city){
    $('#p-name').textContent = pname(city.n);
    back.hidden = false; back.textContent = (LANG === 'ar' ? '› ' : '‹ ') + cname(sel);
    $('#p-sub').textContent = '';
  } else {
    $('#p-name').textContent = cname(sel);
    back.hidden = true; $('#p-sub').textContent = (FACTS.c[sel] && FACTS.c[sel].cap) ? `${t('capital')}: ${pname(FACTS.c[sel].cap.n)}` : '';
  }
  $('.tabs').hidden = !!city;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  const body = $('#p-body');
  if (city) renderCity(body);
  else if (tab === 'entry') renderEntry(body);
  else if (tab === 'practical') renderPractical(body);
  else renderPlaces(body);
}

/* English text from Wikivoyage, marked as such for the other languages */
const enText = s => `<span lang="en" dir="auto">${esc(s)}</span>`;
const enNote = () => LANG === 'en' ? '' : `<small>${esc(t('englishNote'))}</small>`;
function card(ref, dot, clickable = true){
  const desc = ref.d ? `<p>${enText(ref.d)}</p>` : '';
  return `<li><button class="card${clickable ? '' : ' flat'}" type="button" data-pid="${esc(placeKey(ref))}"><b><i class="${dot}"></i>${esc(pname(ref.n))}</b>${desc}</button></li>`;
}
function wvLink(title){
  const u = 'https://en.wikivoyage.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
  return `<p class="wv-src">${t('fromWV', {title: `<a href="${u}" target="_blank" rel="noopener" lang="en">${esc(title)}</a>`})} · <a class="ext" href="${u}" target="_blank" rel="noopener">${esc(t('readGuide'))}</a></p>`;
}
async function renderPlaces(body){
  const iso = sel;
  body.innerHTML = `<p class="muted">${esc(t('loading'))}</p>`;
  const d = await loadPlaces(iso);
  if (sel !== iso || city || tab !== 'places') return;
  if (!d){ body.innerHTML = `<p class="muted">${esc(t('noGuide'))}</p>`; return; }
  let h = d.intro ? `<p class="lead">${enText(d.intro)}${enNote()}</p>` : '';
  const sec = (key, dot, list) => list && list.length ? `<h3 class="sec-h"><i class="${dot}"></i>${esc(t(key))}</h3><ul class="cards">${list.map(x => card(x, dot)).join('')}</ul>` : '';
  h += sec('mainCities', 'dot-c', d.cities) + sec('otherDest', 'dot-m', d.other) + sec('offbeat', 'dot-l', d.offbeat);
  h += wvLink(d.wv);
  body.innerHTML = h;
  const all = (d.cities || []).concat(d.other || [], d.offbeat || []);
  body.querySelectorAll('.card').forEach(b => b.onclick = () => {
    const ref = all.find(x => placeKey(x) === b.dataset.pid); if (!ref) return;
    if (ref.x) openCity(ref); else focusPlace(ref);
  });
}
function renderCity(body){
  const d = city, x = d.x || {};
  let h = x.intro ? `<p class="lead">${enText(x.intro)}${enNote()}</p>` : d.d ? `<p class="lead">${enText(d.d)}${enNote()}</p>` : '';
  if (!d.x){ body.innerHTML = h + `<p class="muted">${esc(t('noDetail'))}</p>`; return; }
  const list = (key, dot, items, why) => items && items.length
    ? `<h3 class="sec-h"><i class="${dot}"></i>${esc(t(key))}</h3>${why ? `<p class="why">${esc(t(why))}</p>` : ''}<ul class="cards">${items.map(s => card(s, dot)).join('')}</ul>` : '';
  h += list('mustSee', 'dot-c', x.must, 'mustWhy') + list('hiddenSpots', 'dot-h', x.hidden, 'hiddenWhy') + list('dayTrips', 'dot-l', x.next);
  if (x.around || x.safe){
    h += `<h3 class="sec-h"><i class="dot-y"></i>${esc(t('goodToKnow'))}</h3>`;
    if (x.around) h += `<div class="tip-block"><b>${esc(t('gettingAround'))}</b><p>${enText(x.around)}</p></div>`;
    if (x.safe) h += `<div class="tip-block"><b>${esc(t('staySafe'))}</b><p>${enText(x.safe)}</p></div>`;
  }
  h += wvLink(x.wv || d.id);
  body.innerHTML = h;
  const all = [...(x.must || []), ...(x.hidden || []), ...(x.next || [])];
  body.querySelectorAll('.card').forEach(b => b.onclick = () => { const ref = all.find(s => placeKey(s) === b.dataset.pid); if (ref) focusPlace(ref); });
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
const PASSPORT_ICON = '<svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true" style="display:block"><rect x="1.5" y="1" width="15" height="18" rx="2.5" fill="none" stroke="var(--accent)" stroke-width="1.8"/><circle cx="9" cy="8.5" r="3.2" fill="none" stroke="var(--accent)" stroke-width="1.5"/><path d="M5.5 15h7" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/></svg>';
function updatePassportChip(){
  const img = $('#pp-flag'), lab = $('#pp-label');
  if (passport){ img.src = flagSrc(passport); img.hidden = false; lab.textContent = mob() ? passport : cname(passport); }
  else { img.hidden = true; lab.innerHTML = mob() ? PASSPORT_ICON : esc(t('passport')); }
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

/* ================================================================ TICKER: travel inspiration (hidden spots from everywhere, a new mix daily) */
let INSPIRE = [];
function buildTicker(){
  const items = INSPIRE.filter(it => COUNTRY[it.c]).map(it => ({it,
    text: it.k === 'offbeat' ? t('tkOffbeat', {country: cname(it.c), name: pname(it.n)})
      : t('tkHidden', {place: pname(it.in), country: cname(it.c), name: pname(it.n)})}));
  const tk = $('#ticker');
  if (!items.length){ tk.hidden = true; return; }
  const html = items.map((x, i) => `<button class="tk-item" type="button" data-i="${i}"><i class="${x.it.k === 'offbeat' ? 'dot-l' : 'dot-h'}"></i><span>${esc(x.text)}</span></button>`).join('');
  const run = $('#tk-run');
  run.innerHTML = html + html;   // twice, so the loop is seamless
  tk.hidden = false;
  requestAnimationFrame(() => { run.style.setProperty('--tk-dur', Math.max(40, run.scrollWidth / 2 / 40) + 's'); });
  setFold(store.get('tk-folded') === '1', false);
}
/* a ticker item: open its country, then its city, then fly to the spot */
$('#tk-run').addEventListener('click', async e => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  const it = INSPIRE.filter(x => COUNTRY[x.c])[+b.dataset.i]; if (!it) return;
  select(it.c);
  const d = await loadPlaces(it.c); if (!d || sel !== it.c) return;
  if (it.k === 'hidden'){
    const dest = (d.cities || []).concat(d.other || []).find(x => x.n && it.in && x.n.en === it.in.en);
    if (dest){ openCity(dest); const s = (dest.x.hidden || []).find(h => h.n.en === it.n.en); if (s) setTimeout(() => focusPlace(s), 1200); }
  } else {
    const o = (d.offbeat || []).find(x => x.n.en === it.n.en); if (o) setTimeout(() => focusPlace(o), 1200);
  }
});
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
  document.querySelector('meta[name="theme-color"]').content = th === 'light' ? '#fff8f2' : '#141414';
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
let GUIDES_AT = null;
function updateFoot(){ $('#foot-upd').textContent = GUIDES_AT ? t('dataUpdated', {date: fmtDate(GUIDES_AT)}) : ''; }

/* ================================================================ TOUR (first visit; replay from the ? help) */
const TOUR_KEY = 'tour-2';
function tourSteps(){
  return [
    {t: 't1t', b: 't1b', langs: true},
    {el: '#globe', t: 't2t', b: 't2b', globe: true},
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
/* #JP, #JP/entry, #JP/practical, #JP/c/Kyoto */
function fromHash(){
  const m = /^#([A-Z]{2})(?:\/(places|entry|practical)|\/c\/(.+))?$/.exec(location.hash);
  if (!m || !COUNTRY[m[1]]) return;
  const want = m[3] ? decodeURIComponent(m[3]) : null;
  if (m[1] === sel && (want ? city && city.id === want : !city && tab === (m[2] || 'places'))) return;   // our own replaceState
  select(m[1], {tab: m[2] || 'places', city: want});
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
  const res = await Promise.allSettled([getJSON('data/facts.json'), getJSON('data/rates.json'), getJSON('data/inspire.json'), getJSON('data/safety.json')]);
  if (res[0].status === 'fulfilled') FACTS = res[0].value;
  if (res[1].status === 'fulfilled') RATES = res[1].value;
  if (res[2].status === 'fulfilled'){ INSPIRE = res[2].value.items || []; GUIDES_AT = res[2].value.generated; }
  if (res[3].status === 'fulfilled') SAFETY = res[3].value;
  if (res.slice(0, 3).some(r => r.status === 'rejected')) toast(t('loadFail'));
  READY = true;
  buildSearch(); buildTicker(); updateFoot(); refreshGlobe();
  layout(); globe.pointOfView({altitude: fitAlt(), lat: 20, lng: 10}, 0);
  fromHash();
  if (!store.get(TOUR_KEY) && !/[?&]notour\b/.test(location.search)) setTimeout(() => { if (!tour) startTour(); }, 1500);
}
addEventListener('hashchange', fromHash);
addEventListener('load', () => setTimeout(() => { if (globe) layout(); }, 300));
start();
