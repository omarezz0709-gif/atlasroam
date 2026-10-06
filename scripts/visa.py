"""Visa requirements per passport -> data/visa/XX.json (one small file per passport, read by the site on demand)

  Main source: Wikipedia's "Visa requirements for ... citizens" articles (CC BY-SA 4.0), kept current by many editors.
  Fallback:    Passport Index dataset (github.com/ilyankou/passport-index-dataset, MIT) for passports or destinations
               Wikipedia doesn't cover; it is older, so the site labels those entries with the dataset's date.

Neither is an official source: the site always says so and links to official pages. Runs at most once a day.
If an article can't be read, that passport keeps its last good file.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
import urllib.parse

from bs4 import BeautifulSoup

from common import DATA, countries, due, get_json, http_get, iso2_of, iso_z, load_json, now_utc, save_json

API = "https://en.wikipedia.org/w/api.php"
HTML = "https://en.wikipedia.org/api/rest_v1/page/html/"
PI_CSV = "https://raw.githubusercontent.com/ilyankou/passport-index-dataset/master/passport-index-tidy-iso2.csv"
PI_DATE = "https://api.github.com/repos/ilyankou/passport-index-dataset/commits?path=passport-index-tidy-iso2.csv&per_page=1"
# articles about special passports rather than a country's citizens
SKIP_TITLE = re.compile(r"Overseas|Protected Persons|British Subjects|European Union|EU citizens|Sahrawi|Kurdistan|Northern Cyprus|"
                        r"Somaliland|Transnistria|Abkhaz|South Ossetia|Artsakh|stateless|refugee|Order of Malta|Sovereign Military|"
                        r"non-citizens|crew members|EFTA", re.I)
# articles whose first sentence doesn't name the country in the usual way
TITLE_FIX = {"Visa requirements for Chinese citizens of Hong Kong": "HK", "Visa requirements for Chinese citizens of Macau": "MO",
             "Visa requirements for Irish citizens": "IE", "Visa requirements for Israeli citizens": "IL",
             "Visa requirements for Moroccan citizens": "MA", "Visa requirements for Pakistani citizens": "PK",
             "Visa requirements for Turkmenistani citizens": "TM"}


def category_titles() -> list[str]:
    out, cont = [], {}
    while True:
        q = {"action": "query", "list": "categorymembers", "cmtitle": "Category:Visa requirements by nationality",
             "cmlimit": "500", "cmnamespace": "0", "format": "json", **cont}
        r = get_json(API + "?" + urllib.parse.urlencode(q))
        out += [m["title"] for m in r["query"]["categorymembers"]]
        if "continue" not in r:
            return [t for t in out if t.startswith("Visa requirements for") and not SKIP_TITLE.search(t)]
        cont = r["continue"]


def kind(text: str, cls: list[str]) -> str:
    t = text.lower()
    if "freedom of movement" in t:
        return "fom"
    if re.search(r"admission refused|entry (is )?(refused|prohibited|banned)|travel ban|not allowed|banned", t):
        return "no"
    if re.search(r"electronic travel author|\beta\b|\besta\b|evisitor|electronic visa waiver|visa waiver program|k-eta|nzeta|etias|travel authori[sz]ation", t):
        return "eta"
    evisa = re.search(r"e-?visa|online visa|electronic visa", t)
    voa = "on arrival" in t
    if evisa and voa:
        return "evoa"
    if evisa:
        return "evisa"
    if voa:
        return "voa"
    if re.search(r"not required|visa[- ]free|visa waiver|id card|identity card|no visa", t):
        return "free"
    if "visa required" in t or "required" in t:
        return "req"
    if "table-yes" in cls:
        return "free"
    if "table-yes2" in cls:
        return "evisa"
    if "table-no" in cls:
        return "req"
    return ""


def stay(text: str) -> str:
    """'90 days' -> '90d', '3 months' -> '3m', '2 weeks' -> '2w', '1 year' -> '1y' (translated by the site)."""
    m = re.search(r"(\d+)\s*(day|week|month|year)", text.lower())
    return f"{m.group(1)}{m.group(2)[0]}" if m else ""


def clean(cell) -> str:
    for s in cell.select("sup, .reference, style"):
        s.decompose()
    return re.sub(r"\s+", " ", cell.get_text(" ", strip=True)).strip()


def parse_article(title: str, all_iso: set[str]) -> tuple[str | None, dict, str, dict]:
    html = http_get(HTML + urllib.parse.quote(title.replace(" ", "_"), safe=""), timeout=60).decode("utf-8")
    soup = BeautifulSoup(html, "lxml")
    mod = soup.find("meta", attrs={"property": "dc:modified"})
    modified = mod["content"] if mod else iso_z(now_utc())
    data: dict[str, list] = {}
    dips: dict[str, str] = {}
    for tab in soup.find_all("table", class_="wikitable"):
        head = [clean(c).lower() for c in tab.find("tr").find_all(["th", "td"])] if tab.find("tr") else []
        if not head or not any("requirement" in h or h.startswith("visa") or "access" in h for h in head[1:3]):
            continue
        # columns by their heading: tables differ ("Allowed stay" / "Stay duration", some have none)
        col = lambda *words: next((i for i, h in enumerate(head) if i > 1 and any(w in h for w in words)), None)
        c_stay, c_notes = col("stay", "duration"), col("note")
        for tr in tab.find_all("tr")[1:]:
            cells = tr.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            link = cells[0].find("a", href=True)
            names = [clean(cells[0])]
            if link:
                names.insert(0, urllib.parse.unquote(link["href"].split("/")[-1]).replace("_", " "))
                if link.get("title"):
                    names.insert(0, link["title"])
            iso = next((i for i in (iso2_of(n) for n in names) if i), None)
            if not iso or iso in data:
                continue
            k = kind(clean(cells[1]), cells[1].get("class") or [])
            if not k:
                continue
            notes = clean(cells[c_notes]) if c_notes is not None and len(cells) > c_notes else ""
            stay_txt = clean(cells[c_stay]) if c_stay is not None and len(cells) > c_stay else ""
            # "visa not required" while the notes say an online authorisation is needed (e.g. ESTA, eTA)
            # (only sentences about today's rule, not "will be required from 2027")
            if k == "free" and any(re.search(r"\b(ESTA|eTA|ETA|K-ETA|NZeTA|ETIAS)\b[^.]{0,40}\b(required|mandatory|needed)", x)
                                   and not re.search(r"\bwill\b|\bfrom \d{4}|planned|expected|postponed|until", x, re.I)
                                   for x in re.split(r"(?<=[.!?])\s+", notes)):
                k = "eta"
            data[iso] = [k, stay(stay_txt)]
            # what the notes say about diplomatic or service passports (shown, in English, to holders of those)
            dip = [re.sub(r"^[^()]*\)\s*", "", x).strip() for x in re.split(r"(?<=[.!?])\s+", notes)   # drops a leftover "15 days stay)"
                   if re.search(r"diplomatic|service passport|official passport", x, re.I)]
            if dip:
                dips[iso] = " ".join(dip)[:400]
    # whose passport? The lead says "... placed on citizens of Germany"; else: the one country missing from the table
    lead = " ".join(p.get_text(" ", strip=True) for p in soup.find_all("p")[:3])
    who = TITLE_FIX.get(title)
    m = None if who else re.search(r"(?:citizens|nationals|holders)[^.]{0,60}? of (?:the )?([A-Z][\w'’-]*(?:\s+(?:and|of|the|[A-Z][\w'’-]*))*)", lead)
    if m:   # "Bosnia and Herzegovina entering ..." -> try the longest run of words first, then shorter ones
        words = m.group(1).split()
        for n in range(len(words), 0, -1):
            who = iso2_of(" ".join(words[:n]))
            if who:
                break
    missing = all_iso - set(data)
    if not who and len(missing) == 1:
        who = next(iter(missing))
    return who, data, modified, dips


def passport_index() -> tuple[dict, str]:
    rows = list(csv.reader(io.StringIO(http_get(PI_CSV, timeout=60).decode())))[1:]
    try:
        date = get_json(PI_DATE)[0]["commit"]["committer"]["date"][:10]
    except Exception:
        date = ""
    m = {"visa free": "free", "eta": "eta", "e-visa": "evisa", "visa on arrival": "voa", "visa required": "req", "no admission": "no"}
    out: dict[str, dict] = {}
    for p, d, req in rows:
        if req == "-1":
            continue
        out.setdefault(p, {})[d] = ["free", f"{req}d"] if req.isdigit() else [m.get(req, ""), ""]
    return out, date


def main() -> int:
    meta = load_json("visa/index.json", {})
    if "--force" not in sys.argv and not due(meta.get("generated"), 20):
        print("visa data is less than 20 h old, skipping"); return 0
    known = countries()
    all_iso = set(known)
    titles = category_titles()
    print(len(titles), "Wikipedia articles")
    try:
        pi, pi_date = passport_index()
    except Exception as e:
        print("Passport Index dataset FAILED:", e, file=sys.stderr)
        pi, pi_date = {}, meta.get("pi_date", "")
    done: dict[str, dict] = {}
    failed = 0
    for t in titles:
        try:
            who, data, modified, dips = parse_article(t, all_iso)
        except Exception as e:
            failed += 1
            print("  failed:", t, e); continue
        if not who or len(data) < 100:
            print(f"  skipped: {t} (passport {who}, {len(data)} rows)"); continue
        if who in done and len(done[who]["v"]) >= len(data):
            continue
        done[who] = {"src": "wp", "t": t, "d": modified, "v": data, **({"dip": dips} if dips else {})}
        time.sleep(0.3)   # be gentle with Wikipedia
    print(len(done), "passports from Wikipedia,", failed, "articles failed")
    passports = {}
    for iso in sorted(set(done) | set(pi)):
        if iso not in known:
            continue
        rec = done.get(iso)
        if rec is None:
            old = load_json(f"visa/{iso}.json", None)
            if old and old.get("src") == "wp":   # Wikipedia failed this time: keep its last good version
                rec = old
            elif iso in pi:
                rec = {"src": "pi", "d": pi_date, "v": {}}
        if rec is None:
            continue
        # destinations Wikipedia doesn't list: the older dataset, marked per entry
        extra = {d: v + ["pi"] for d, v in pi.get(iso, {}).items() if d not in rec["v"] and d in known and v[0]}
        rec["v"].update(extra)
        rec["pi"] = pi_date
        save_json(f"visa/{iso}.json", rec)
        passports[iso] = rec["src"]
    save_json("visa/index.json", {"generated": iso_z(now_utc()), "pi_date": pi_date, "passports": passports})
    print(len(passports), "passport files written")
    return 0 if len(done) >= 100 else 1


if __name__ == "__main__":
    sys.exit(main())
