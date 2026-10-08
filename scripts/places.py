"""Cities, sights and hidden spots per country -> data/places/XX.json (+ data/places/index.json, data/inspire.json)

Source: English Wikivoyage (CC BY-SA 4.0), read through its public API, politely and one page at a time.
  country article  "Cities" (about 9 main cities) and "Other destinations" (parks, islands...), each with a short line
  "Off the beaten track in <country>" articles, where they exist: hand-picked lesser-known places
  each city / destination article: the opening text, the See and Do listings (with map coordinates), "Get around"
                   and "Stay safe" (first paragraph), and "Go next" (day trips). Big cities split into districts:
                   their district pages are read too.
Wikidata (CC0): names in the site's 6 languages, and how famous a sight is = in how many Wikipedia languages it has
  an article. The most famous become "must-sees"; sights with few or no articles, the "Go next" day trips and the
  off-the-beaten-track places become "hidden spots". That is a rule on real data, and the site says so.

Rolling refresh: each run updates the countries whose file is oldest (up to --max, default 20), so every country is
refreshed about weekly and a skipped run is simply caught up by the next. A page that can't be read keeps its last data.
    python scripts/places.py              # the oldest 20 countries
    python scripts/places.py JP FR        # just these
    python scripts/places.py --all        # everything (first build; takes about an hour)
"""
from __future__ import annotations

import html
import random
import re
import sys
import time
import urllib.parse

from common import countries, get_json, iso_z, load_json, now_utc, parse_iso, save_json

WV = "https://en.wikivoyage.org/w/api.php"
WD = "https://www.wikidata.org/w/api.php"
SPARQL = "https://query.wikidata.org/sparql?format=json&query="
LANGS = ("en", "de", "fr", "es", "it", "ar")
MAX_DEST = 9          # cities, and other destinations, read in detail per country
MAX_DISTRICTS = 6     # district pages read for a big city
MUST, HIDDEN = 8, 8   # sights kept per destination
REFRESH_DAYS = 7
PAUSE = 0.25          # seconds between API calls


def wv(**q):
    q.update(format="json", formatversion="2", maxlag="5")
    time.sleep(PAUSE)
    return get_json(WV + "?" + urllib.parse.urlencode(q), timeout=60)


def wikitext(title: str) -> tuple[str, str] | None:
    """(wikitext, final title) of a page, following redirects; None if it doesn't exist."""
    try:
        r = wv(action="parse", page=title, prop="wikitext", redirects=1)
    except Exception as e:
        if "missingtitle" in str(e):
            return None
        raise
    if "error" in r:
        return None
    return r["parse"]["wikitext"], r["parse"]["title"]


# ---------------------------------------------------------------- wikitext helpers
def templates(text: str, names: tuple[str, ...]) -> list[tuple[int, str, dict]]:
    """Every {{name|a=b|...}} (names lower-case), as (position, name, params); handles nested {{ }} and [[ ]]."""
    out = []
    for m in re.finditer(r"\{\{\s*(" + "|".join(names) + r")\s*[|}]", text, re.I):
        start, i, depth = m.start(), m.start() + 2, 1
        while i < len(text) and depth:
            if text.startswith("{{", i) or text.startswith("[[", i):
                depth += 1; i += 2
            elif text.startswith("}}", i) or text.startswith("]]", i):
                depth -= 1; i += 2
            else:
                i += 1
        body = text[start + 2:i - 2]
        parts, buf, d, j = [], "", 0, 0
        while j < len(body):
            two = body[j:j + 2]
            if two in ("{{", "[["):
                d += 1; buf += two; j += 2; continue
            if two in ("}}", "]]"):
                d -= 1; buf += two; j += 2; continue
            if body[j] == "|" and d == 0:
                parts.append(buf); buf = ""; j += 1; continue
            buf += body[j]; j += 1
        parts.append(buf)
        params = {}
        for p in parts[1:]:
            if "=" in p:
                k, v = p.split("=", 1)
                params[k.strip().lower()] = v.strip()
        out.append((start, parts[0].strip().lower(), params))
    return out


def clean(s: str, limit: int = 0) -> str:
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", s or "", flags=re.S)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    for _ in range(3):   # keep the text of a few inline templates, drop the rest
        s = re.sub(r"\{\{(?:lang|nowrap|w|ill)\|(?:[^|{}]*\|)?([^|{}]*)\}\}", r"\1", s, flags=re.I)
        s = re.sub(r"\{\{(?:km|mi|m|ft)\|([^|{}]*)[^{}]*\}\}", r"\1", s, flags=re.I)
        s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:File|Image):[^\]]*\]\]", "", s, flags=re.I)
    s = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\]", "", s)
    s = re.sub(r"'{2,}", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip(" -—–:;,")
    if limit and len(s) > limit:
        cut = s[:limit]
        s = (cut[:cut.rfind(". ") + 1] if ". " in cut[limit // 2:] else cut.rsplit(" ", 1)[0] + "…")
    return s


def section(w: str, name: str, level: int = 2) -> str:
    """Text of a section (with its sub-sections) by heading name."""
    eq = "=" * level
    m = re.search(r"\n" + eq + r"\s*" + name + r"\s*" + eq + r"\s*\n(.*?)(?=\n={1," + str(level) + r"}[^=]|\Z)", "\n" + w, re.S | re.I)
    return m.group(1) if m else ""


def first_paragraph(text: str, limit: int = 420) -> str:
    for para in re.split(r"\n\s*\n", text):
        # drop banner / infobox / image lines sitting on top of the first sentence
        p = "\n".join(l for l in para.strip().splitlines() if not re.match(r"\s*(\{\{[^{}]*\}\}\s*$|\[\[(File|Image):)", l, re.I)).strip()
        if not p or p.startswith(("{{", "[[File", "[[Image", "*", "#", "=", "|", "<")):
            continue
        c = clean(p, limit)
        if len(c) > 60:
            return c
    return ""


def lead(w: str) -> str:
    return first_paragraph(re.split(r"\n==[^=]", "\n" + w, maxsplit=1)[0], 480)


def num(v) -> float | None:
    try:
        return round(float(v), 5)
    except (TypeError, ValueError):
        return None


def link_target(name: str) -> str | None:
    m = re.search(r"\[\[([^\]|#]+)", name or "")
    return m.group(1).strip() if m else None


def bullets(text: str) -> list[dict]:
    """Destinations listed as bullets: '* {{marker|name=[[X]]|lat=..}} — desc' or '* [[X]] — desc'."""
    out = []
    for line in text.splitlines():
        if not line.lstrip().startswith("*"):
            continue
        mk = templates(line, ("marker", "listing", "go", "see", "do"))
        if mk:
            p = mk[0][2]
            target = link_target(p.get("name", "")) or clean(p.get("name", ""))
            lat, lng, q = num(p.get("lat")), num(p.get("long")), p.get("wikidata") or None
            rest = line[line.find("}}", mk[0][0]) + 2:] if "}}" in line else ""
        else:
            target = link_target(line)
            lat = lng = q = None
            rest = line.split("]]", 1)[1] if "]]" in line else ""
        if not target:
            continue
        out.append({"t": target, "lat": lat, "lng": lng, "q": q, "d": clean(rest, 200)})
    return out


def listings(w: str) -> list[dict]:
    out = []
    for kind in ("See", "Do"):
        sec = section(w, kind)
        for _, name, p in templates(sec, ("see", "do", "listing")):
            k = p.get("type", name).lower()
            if k not in ("see", "do"):
                k = kind.lower()
            n = clean(p.get("name", ""))
            lat, lng = num(p.get("lat")), num(p.get("long"))
            if not n or lat is None or lng is None:
                continue   # without a position it can't be a pin
            out.append({"n": n, "lat": lat, "lng": lng, "k": k, "q": (p.get("wikidata") or "").strip() or None,
                        "wp": clean(p.get("wikipedia") or "") or None, "d": clean(p.get("content") or p.get("description") or "", 230)})
    return out


def districts(w: str, title: str) -> list[str]:
    sec = section(w, "Districts")
    found = []
    for m in re.finditer(r"\[\[(" + re.escape(title) + r"/[^\]|#]+)", sec):
        if m.group(1) not in found:
            found.append(m.group(1))
    return found[:MAX_DISTRICTS]


# ---------------------------------------------------------------- Wikidata: names and fame
_WD_CACHE: dict[str, dict] = {}


def wikidata(qids: list[str]) -> dict[str, dict]:
    """QID -> {"n": {lang: label}, "s": number of Wikipedia sitelinks}."""
    need = [q for q in dict.fromkeys(qids) if q and re.fullmatch(r"Q\d+", q) and q not in _WD_CACHE]
    for i in range(0, len(need), 50):
        chunk = need[i:i + 50]
        try:
            time.sleep(PAUSE)
            r = get_json(WD + "?" + urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(chunk), "props": "labels|sitelinks",
                                                             "languages": "|".join(LANGS), "format": "json"}), timeout=60)
        except Exception as e:
            print("  Wikidata labels failed:", e); continue
        for q, ent in r.get("entities", {}).items():
            labels = {lg: v["value"] for lg, v in (ent.get("labels") or {}).items()}
            sl = sum(1 for k in (ent.get("sitelinks") or {}) if k.endswith("wiki") and k not in ("commonswiki", "specieswiki"))
            _WD_CACHE[q] = {"n": labels, "s": sl}
    return {q: _WD_CACHE[q] for q in qids if q in _WD_CACHE}


FAMOUS = re.compile(r"most famous|best[- ]known|main attraction|iconic|must[- ]see|highlight of|top attraction|landmark of", re.I)
COMMERCIAL = re.compile(r"cinema|movie theat|bowling|karaoke|shopping|\bmall\b|department store|casino|arcade|\bgym\b|fitness|golf|"
                        r"\bseats?\b|multiplex|nightclub|\bbar\b|pub\b|restaurant|hotel|hostel|supermarket|outlet", re.I)


def wp_items(titles: list[str]) -> dict[str, str]:
    """English Wikipedia title -> Wikidata item."""
    out = {}
    titles = [t for t in dict.fromkeys(titles) if t]
    for i in range(0, len(titles), 50):
        try:
            time.sleep(PAUSE)
            r = get_json("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({"action": "query", "titles": "|".join(titles[i:i + 50]),
                         "prop": "pageprops", "ppprop": "wikibase_item", "redirects": "1", "format": "json", "formatversion": "2"}), timeout=60)
        except Exception as e:
            print("  Wikipedia lookup failed:", e); continue
        q = r.get("query", {})
        back = {}
        for n in q.get("normalized", []) + q.get("redirects", []):
            back.setdefault(n["to"], []).append(n["from"])
        for p in q.get("pages", []):
            item = (p.get("pageprops") or {}).get("wikibase_item")
            if not item:
                continue
            for t in [p["title"]] + back.get(p["title"], []) + [f for b in back.get(p["title"], []) for f in back.get(b, [])]:
                out[t] = item
    return out


def page_info(titles: list[str]) -> dict[str, dict]:
    """Wikivoyage title -> {lat, lng, q} (page coordinates and Wikidata item), 50 titles per call."""
    out = {}
    titles = [t for t in dict.fromkeys(titles) if t]
    for i in range(0, len(titles), 50):
        r = wv(action="query", titles="|".join(titles[i:i + 50]), prop="coordinates|pageprops", ppprop="wikibase_item", redirects=1)
        q = r.get("query", {})
        redir = {x["from"]: x["to"] for x in q.get("redirects", [])}
        by_title = {}
        for p in q.get("pages", []):
            if p.get("missing"):
                continue
            c = (p.get("coordinates") or [{}])[0]
            by_title[p["title"]] = {"lat": num(c.get("lat")), "lng": num(c.get("lon")), "q": (p.get("pageprops") or {}).get("wikibase_item"), "title": p["title"]}
        for t in titles[i:i + 50]:
            hit = by_title.get(redir.get(t, t))
            if hit:
                out[t] = hit
    return out


def names(label_src: dict | None, en: str) -> dict:
    n = {lg: v for lg, v in ((label_src or {}).get("n") or {}).items() if lg in LANGS}
    n["en"] = en   # Wikivoyage's own title stays the English name
    return n


# ---------------------------------------------------------------- one destination, one country
def destination(entry: dict, info: dict) -> dict | None:
    got = wikitext(entry["t"])
    if not got:
        return None
    w, title = got
    sights = listings(w)
    for d in districts(w, title):
        sub = wikitext(d)
        if sub:
            sights += listings(sub[0])
    seen, uniq = set(), []
    for s in sights:
        key = s["n"].lower()
        if key not in seen:
            seen.add(key); uniq.append(s)
    # listings that name only their Wikipedia article: look up its Wikidata item
    wp_q = wp_items([s["wp"] for s in uniq if not s["q"] and s["wp"]])
    for s in uniq:
        s["q"] = s["q"] or wp_q.get(s["wp"] or "")
    wd = wikidata([s["q"] for s in uniq if s["q"]])
    for s in uniq:
        meta = wd.get(s["q"] or "")
        s["w"] = meta["s"] if meta else (1 if s["wp"] else 0)
        s["n"] = names(meta, s["n"])
    # must-sees: sights (not activities like sports clubs) with articles in many Wikipedia languages
    ranked = sorted((s for s in uniq if s["k"] == "see"), key=lambda s: -s["w"])
    must, must_q = [], set()
    for s in ranked:   # one per Wikidata item (a palace and its garden can share one)
        if s["w"] >= 3 and s["q"] not in must_q and len(must) < MUST:
            must.append(s); must_q.add(s["q"])
    famous_names = [m["n"]["en"].lower() for m in must]
    same = lambda s: any(f in s["n"]["en"].lower() or s["n"]["en"].lower() in f for f in famous_names)
    # hidden spots: few or no encyclopedia articles, not described as the famous one, not cinemas, malls and the like
    rest = [s for s in uniq if s not in must and not same(s) and s["w"] <= 3 and not FAMOUS.search(s["d"])
            and not COMMERCIAL.search(s["n"]["en"] + " " + s["d"])]
    rest.sort(key=lambda s: s["k"] != "see")   # sights before activities
    pick = rest[:HIDDEN * 2]
    random.Random(title).shuffle(pick)   # a stable mix, not just the first ones listed
    hidden = sorted(pick[:HIDDEN], key=lambda s: s["w"])
    nxt, seen_t = [], set()
    for x in bullets(section(w, "Go next")):
        if x["t"] not in seen_t and x["t"] != title:
            seen_t.add(x["t"]); nxt.append(x)
    nxt = nxt[:8]
    pin = page_info([x["t"] for x in nxt])
    nexts = []
    for x in nxt:
        p = pin.get(x["t"], {})
        lat, lng = x["lat"] or p.get("lat"), x["lng"] or p.get("lng")
        if lat is not None and lng is not None:
            nexts.append({"t": x["t"], "q": x["q"] or p.get("q"), "lat": lat, "lng": lng, "d": x["d"]})
    nwd = wikidata([x["q"] for x in nexts if x["q"]])
    for x in nexts:
        x["n"] = names(nwd.get(x["q"] or ""), x.pop("t"))
    strip = lambda s: {k: v for k, v in s.items() if k in ("n", "lat", "lng", "k", "d", "w", "q")}
    return {"wv": title, "intro": lead(w), "around": first_paragraph(section(w, "Get around")), "safe": first_paragraph(section(w, "Stay safe")),
            "must": [strip(s) for s in must], "hidden": [strip(s) for s in hidden], "next": nexts}


def offbeat_titles() -> dict[str, str]:
    """country name -> 'Off the beaten track in X' article title."""
    out = {}
    for prefix in ("Off the beaten track in ", "Off the beaten path in "):
        r = wv(action="query", list="prefixsearch", pssearch=prefix, pslimit="100")
        for p in r.get("query", {}).get("prefixsearch", []):
            out[p["title"][len(prefix):].strip()] = p["title"]
    return out


def country_titles() -> dict[str, str]:
    """ISO2 -> English Wikivoyage article, from Wikidata (kept from the last run if Wikidata is busy)."""
    old = load_json("places/index.json", {}).get("titles", {})
    q = """SELECT ?iso ?article WHERE { ?c wdt:P297 ?iso . FILTER NOT EXISTS { ?c wdt:P576 ?e }
      ?article schema:about ?c ; schema:isPartOf <https://en.wikivoyage.org/> . }"""
    try:
        r = get_json(SPARQL + urllib.parse.quote(q), accept="application/sparql-results+json", timeout=90)
        new = {b["iso"]["value"].upper(): urllib.parse.unquote(b["article"]["value"].split("/wiki/")[1]).replace("_", " ")
               for b in r["results"]["bindings"]}
        if len(new) > 150:
            return {**old, **new}
    except Exception as e:
        print("Wikidata country titles failed, using the last good list:", e)
    return old


def build_country(iso: str, title: str, offbeat: dict[str, str]) -> dict | None:
    got = wikitext(title)
    if not got:
        return None
    w, title = got
    cities = bullets(section(w, "Cities"))[:MAX_DEST]
    others = bullets(section(w, "Other destinations"))[:MAX_DEST]
    off = []
    ot = offbeat.get(title)
    if ot:
        og = wikitext(ot)
        if og:
            off = bullets(og[0])[:12]
    allx = cities + others + off
    pin = page_info([x["t"] for x in allx])
    for x in allx:
        p = pin.get(x["t"], {})
        x["lat"] = x["lat"] if x["lat"] is not None else p.get("lat")
        x["lng"] = x["lng"] if x["lng"] is not None else p.get("lng")
        x["q"] = x["q"] or p.get("q")
        x["exists"] = bool(p)
    wd = wikidata([x["q"] for x in allx if x["q"]])
    out = {"wv": title, "intro": lead(w), "cities": [], "other": [], "offbeat": []}
    for key, lst, detail in (("cities", cities, True), ("other", others, True), ("offbeat", off, False)):
        for x in lst:
            if x["lat"] is None or x["lng"] is None:
                continue
            d = {"id": x["t"], "n": names(wd.get(x["q"] or ""), x["t"]), "lat": x["lat"], "lng": x["lng"], "d": x["d"]}
            if detail and x["exists"]:
                try:
                    det = destination(x, {})
                    if det:
                        d["x"] = det
                except Exception as e:
                    print(f"  {x['t']}: {e}")
            out[key].append(d)
    return out


def inspiration(index: dict) -> list[dict]:
    """A mix of hidden spots and off-the-beaten-track places from every country, for the ticker."""
    pool = []
    for iso in index.get("done", {}):
        c = load_json(f"places/{iso}.json", None)
        if not c:
            continue
        for o in c.get("offbeat", []):
            if o.get("d"):
                pool.append({"c": iso, "k": "offbeat", "n": o["n"], "d": o["d"], "lat": o["lat"], "lng": o["lng"]})
        for dest in c.get("cities", []) + c.get("other", []):
            for h in (dest.get("x") or {}).get("hidden", [])[:2]:
                if h.get("d"):
                    pool.append({"c": iso, "k": "hidden", "in": dest["n"], "n": h["n"], "d": h["d"], "lat": h["lat"], "lng": h["lng"]})
    rnd = random.Random(now_utc().strftime("%Y-%m-%d"))   # a new mix every day
    rnd.shuffle(pool)
    return pool[:40]


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    limit = 10**6 if "--all" in sys.argv else next((int(a.split("=")[1]) for a in sys.argv if a.startswith("--max=")), 20)
    index = load_json("places/index.json", {"done": {}})
    titles = country_titles()
    known = countries()
    todo = [i for i in args if i in titles] if args else sorted(
        (i for i in titles if i in known), key=lambda i: index["done"].get(i, ""))
    if not args:
        todo = [i for i in todo if (now_utc() - (parse_iso(index["done"].get(i)) or parse_iso("2000-01-01T00:00:00Z"))).days >= REFRESH_DAYS][:limit]
    offbeat = offbeat_titles()
    print(f"{len(todo)} countries to refresh; {len(offbeat)} off-the-beaten-track articles")
    ok = 0
    for iso in todo:
        t0 = time.time()
        try:
            data = build_country(iso, titles[iso], offbeat)
        except Exception as e:
            print(f"{iso}: FAILED ({e}), keeping the last data"); continue
        if not data or not (data["cities"] or data["other"]):
            print(f"{iso}: nothing found on {titles[iso]}")
            index["done"][iso] = iso_z(now_utc()); continue
        data["generated"] = iso_z(now_utc())
        save_json(f"places/{iso}.json", data)
        index["done"][iso] = data["generated"]
        ok += 1
        n = sum(len((d.get("x") or {}).get("must", [])) + len((d.get("x") or {}).get("hidden", [])) for d in data["cities"] + data["other"])
        print(f"{iso}: {len(data['cities'])} cities, {len(data['other'])} other, {len(data['offbeat'])} off-beat, {n} sights ({time.time() - t0:.0f} s)")
        index["titles"] = titles
        save_json("places/index.json", index)   # after every country, so an interrupted run keeps its progress
    index["titles"] = titles
    index["generated"] = iso_z(now_utc())
    save_json("places/index.json", index)
    save_json("inspire.json", {"generated": iso_z(now_utc()), "items": inspiration(index)})
    print(f"done: {ok} of {len(todo)} countries")
    return 0 if ok or not todo else 1


if __name__ == "__main__":
    sys.exit(main())
