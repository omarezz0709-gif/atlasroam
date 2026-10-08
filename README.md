# Atlasroam

An interactive 3D travel globe for exploring, the sister project of [Faultlines](https://github.com/omarezz0709-gif/faultlines).
Click a country:

- **Places**: its main cities, nature spots and off-the-beaten-track places, as pins on the globe. Click a city to zoom in on its
  **must-sees**, **hidden spots** and **day trips**, plus tips for getting around and staying safe.
- **Entry & visa**: visa rules for your passport (ordinary or diplomatic/service), with official links and a clear "double-check" note.
- **Practical**: currency and today's rate to your currency, plugs and voltage, driving side, languages, local time and difference, calling code, emergency numbers.

A ticker shows a daily mix of hidden spots from all over the world.

**How must-sees and hidden spots are chosen** (a rule on real data, explained on the site): every place comes from Wikivoyage.
Must-sees are the listed sights with articles in the most Wikipedia languages (Wikidata sitelinks). Hidden spots are listed
sights with few or no encyclopedia articles (shops, cinemas, hotels left out), Wikivoyage's "Go next" day trips and its
"Off the beaten track" articles.

Six languages (English, Deutsch, Français, Español, Italiano, العربية with right-to-left layout), light and dark mode, phone layout, a first-visit tour.
No accounts, no cookies, no tracking: choices are stored only in the visitor's browser.

**Completely free:** Cloudflare Pages hosts the site, GitHub Actions refreshes the data.

## Data (all free, refreshed automatically)

| Data | Source | Licence | How often |
|---|---|---|---|
| Cities, sights, hidden spots, tips | [Wikivoyage](https://en.wikivoyage.org/) + Wikidata (names in 6 languages, fame) | CC BY-SA 4.0 / CC0 | each country about weekly |
| Official entry-information links | Auswärtiges Amt open data, GOV.UK FCDO API, US State Department API | free / OGL v3.0 / public domain | 4× a day |
| Visa rules | Wikipedia "Visa requirements for … citizens" | CC BY-SA 4.0 | daily |
| Visa fallback | [Passport Index dataset](https://github.com/ilyankou/passport-index-dataset) | MIT | daily |
| Plugs, voltage, driving side, languages, calling codes, emergency numbers, capitals | Wikidata | CC0 | daily |
| Time zones | IANA tz database | public domain | daily |
| Exchange rates | ECB via Frankfurter, ExchangeRate-API | free, attribution | 4× a day |
| Country outlines | Natural Earth 1:50m | public domain | (fixed) |

If a source fails, the last good data stays. Refresh slots: 00:00, 06:00, 12:00, 18:00 Berlin time; the job wakes every hour and catches up by itself when GitHub skips a run.

## Files

| File | What it is |
|---|---|
| `index.html`, `assets/` | The site (app.js = globe and panels, i18n.js = all texts in 6 languages, style.css). |
| `vendor/`, `fonts/` | globe.gl, relief images, flags and fonts, served from the site itself (no Google or CDN requests). |
| `data/` | Written by the updaters, read by the site. |
| `scripts/` | The updaters (`places.py`, `visa.py`, `facts.py`, `rates.py`, `safety.py`), `build_world.py` (one-off map build), `serve.py` (local preview). |
| `_headers` | Security and caching headers for Cloudflare Pages. |
| `.github/workflows/refresh.yml` | The scheduled data refresh. |
| `impressum.html`, `datenschutz.html` | Legal pages (fill in the highlighted placeholders). |

## Preview locally

```
python scripts/serve.py
```
then open http://127.0.0.1:8765
