"""Practical country facts -> data/facts.json (refreshed once a day at most; they rarely change)

  Wikidata (CC0): driving side, mains voltage and frequency, plug types, calling code, emergency numbers, currency,
                  official languages, capital (name in the site's 6 languages and position)
  IANA tz database (public domain, zone.tab): the time zones of each country

Wikidata's query service is sometimes slow or rate-limited: on failure the last good data stays, and a country
keeps any field the new answer lacks.
"""
from __future__ import annotations

import re
import sys
import time
import urllib.parse

from common import countries, due, get_json, http_get, iso_z, load_json, now_utc, save_json

SPARQL = "https://query.wikidata.org/sparql?format=json&query="
LANGS = ("en", "de", "fr", "es", "it", "ar")

# Wikidata plug items (by English label) -> the usual letter (A-N)
PLUG = {"NEMA 1-15": "A", "NEMA 5-15": "B", "Europlug": "C", "BS 546": "D", "Type D": "D", "Type E": "E", "CEE 7/5": "E",
        "Schuko": "F", "CEE 7/4": "F", "BS 1363": "G", "Type H": "H", "SI 32": "H", "AS/NZS 3112": "I", "Type I": "I",
        "SN 441011": "J", "Type J": "J", "Type K": "K", "Section 107-2-D1": "K", "Type L": "L", "CEI 23-50": "L",
        "Type M": "M", "IEC 60906-1": "N", "Type N": "N", "NBR 14136": "N", "Type A": "A", "Type B": "B", "Type C": "C",
        "Type F": "F", "Type G": "G"}

Q_FACTS = """SELECT ?iso
 (GROUP_CONCAT(DISTINCT ?driving; separator="|") AS ?dr) (GROUP_CONCAT(DISTINCT ?volt; separator="|") AS ?v)
 (GROUP_CONCAT(DISTINCT ?freq; separator="|") AS ?hz) (GROUP_CONCAT(DISTINCT ?plugL; separator="|") AS ?p)
 (GROUP_CONCAT(DISTINCT ?cc; separator="|") AS ?cal) (GROUP_CONCAT(DISTINCT ?emL; separator="|") AS ?em)
 (GROUP_CONCAT(DISTINCT ?cur; separator="|") AS ?curs) (GROUP_CONCAT(DISTINCT ?lang; separator="|") AS ?langs)
WHERE {
 ?c wdt:P297 ?iso . FILTER NOT EXISTS { ?c wdt:P576 ?ended }
 OPTIONAL { ?c wdt:P1622 ?driving }
 OPTIONAL { ?c wdt:P2884 ?volt }
 OPTIONAL { ?c wdt:P2144 ?freq }
 OPTIONAL { ?c wdt:P2853 ?plug . ?plug rdfs:label ?plugL . FILTER(LANG(?plugL) = "en") }
 OPTIONAL { ?c wdt:P474 ?cc }
 OPTIONAL { ?c wdt:P2852 ?emN . ?emN rdfs:label ?emL . FILTER(LANG(?emL) = "en") }
 OPTIONAL { ?c wdt:P38 ?curI . ?curI wdt:P498 ?cur . FILTER NOT EXISTS { ?curI wdt:P582 ?curEnd } }
 OPTIONAL { ?c wdt:P37 ?langI . ?langI wdt:P218 ?lang }
} GROUP BY ?iso"""

Q_CAPITAL = """SELECT ?iso ?cap ?coord ?lang ?name WHERE {
 ?c wdt:P297 ?iso . FILTER NOT EXISTS { ?c wdt:P576 ?ended }
 ?c p:P36 ?st . ?st ps:P36 ?cap . FILTER NOT EXISTS { ?st pq:P582 ?capEnd }
 ?cap wdt:P625 ?coord .
 ?cap rdfs:label ?name . BIND(LANG(?name) AS ?lang) FILTER(?lang IN ("en","de","fr","es","it","ar"))
}"""

LEFT, RIGHT = "Q11920728", "Q14565199"
# where Wikidata's "official language" misses the language travellers meet (e.g. the US has no official language)
LANG_FIX = {"US": ["en"], "CN": ["zh"], "TW": ["zh"], "HK": ["zh", "en"], "MO": ["zh", "pt"]}


def sparql(q: str) -> list[dict]:
    r = get_json(SPARQL + urllib.parse.quote(q), accept="application/sparql-results+json", timeout=90, tries=4)
    return r["results"]["bindings"]


def val(b: dict, k: str) -> list[str]:
    return [x for x in (b.get(k, {}).get("value") or "").split("|") if x]


def num(s: str) -> float | None:
    try:
        f = float(s)
        return int(f) if f == int(f) else f
    except ValueError:
        return None


def facts_from_wikidata() -> dict:
    out: dict[str, dict] = {}
    for b in sparql(Q_FACTS):
        iso = b["iso"]["value"].upper()
        d: dict = {}
        dr = val(b, "dr")
        if any(x.endswith(LEFT) for x in dr) != any(x.endswith(RIGHT) for x in dr):
            d["dr"] = "L" if any(x.endswith(LEFT) for x in dr) else "R"
        d["v"] = sorted({n for n in (num(x) for x in val(b, "v")) if n and 90 <= n <= 260})
        d["hz"] = sorted({n for n in (num(x) for x in val(b, "hz")) if n in (50, 60)})
        d["p"] = sorted({PLUG[x] for x in val(b, "p") if x in PLUG})
        d["cc"] = sorted({x.replace(" ", "") for x in val(b, "cal") if re.fullmatch(r"\+?[\d -]{1,8}", x)})[:3]
        d["em"] = sorted({x.strip() for x in val(b, "em") if re.fullmatch(r"\d{2,4}", x.strip())}, key=lambda x: (len(x), x))[:6]
        d["cur"] = sorted(set(val(b, "curs")))[:3]
        d["lang"] = sorted(set(val(b, "langs")))[:6]
        out[iso] = {k: v for k, v in d.items() if v}
    time.sleep(5)
    # a country can have several capitals (South Africa, Bolivia...): their names are joined, the first one's position is used
    caps: dict[str, dict[str, dict]] = {}
    for b in sparql(Q_CAPITAL):
        iso = b["iso"]["value"].upper()
        m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", b["coord"]["value"])
        if not m:
            continue
        c = caps.setdefault(iso, {}).setdefault(b["cap"]["value"], {"n": {}, "lng": round(float(m.group(1)), 3), "lat": round(float(m.group(2)), 3)})
        c["n"][b["lang"]["value"]] = b["name"]["value"]
    for iso, by_item in caps.items():
        items = sorted(by_item.values(), key=lambda c: c["n"].get("en", "~"))
        first = dict(items[0])
        first["n"] = {lg: " / ".join(c["n"].get(lg) or c["n"].get("en", "") for c in items) for lg in LANGS}
        out.setdefault(iso, {})["cap"] = first
    for iso, langs in LANG_FIX.items():
        out.setdefault(iso, {})["lang"] = langs
    return out


def timezones() -> dict[str, list[str]]:
    tab = http_get("https://raw.githubusercontent.com/eggert/tz/main/zone.tab").decode()
    out: dict[str, list[str]] = {}
    for line in tab.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        cc, _, tz = line.split("\t")[:3]
        out.setdefault(cc, []).append(tz)
    return out


def main() -> int:
    old = load_json("facts.json", {"c": {}})
    if "--force" not in sys.argv and not due(old.get("generated"), 20):
        print("facts.json is less than 20 h old, skipping"); return 0
    merged = {k: dict(v) for k, v in old.get("c", {}).items()}
    ok = []
    try:
        wd = facts_from_wikidata()
        if len(wd) < 150:
            raise RuntimeError(f"only {len(wd)} countries")
        for iso, d in wd.items():
            merged.setdefault(iso, {}).update(d)   # fields Wikidata didn't return this time stay as they were
        ok.append("wikidata")
        print("Wikidata:", len(wd), "countries")
    except Exception as e:
        print("Wikidata FAILED, keeping the last good data:", e, file=sys.stderr)
    try:
        tz = timezones()
        for iso, zones in tz.items():
            merged.setdefault(iso, {})["tz"] = zones
        ok.append("tz")
        print("time zones:", len(tz), "countries")
    except Exception as e:
        print("tz FAILED:", e, file=sys.stderr)
    known = countries()
    merged = {k: v for k, v in merged.items() if k in known}
    if not ok:
        return 1
    save_json("facts.json", {"generated": iso_z(now_utc()) if "wikidata" in ok else old.get("generated", iso_z(now_utc())),
                             "src": ok, "c": merged})
    print("facts.json:", len(merged), "countries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
