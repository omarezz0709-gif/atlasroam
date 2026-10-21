"""Visa rules for diplomatic and service passports, from Wikipedia's "Visa policy of <country>" articles (CC BY-SA 4.0).

Most of these articles have a section "Non-ordinary passports" (or similar) saying whose diplomatic/service passports may
enter without a visa. The formats differ, so this reads them conservatively:
  - a list, table or sentence naming countries      -> those passports: visa-free (if the section says so), with the
                                                        sentence or row as the quote shown on the site
  - "diplomatic passports of any country (except ...)" -> every passport except the ones named
  - "All European Union member states", "ASEAN", "GCC" -> expanded to their members
  - the Schengen article: "Austria, Belgium : Egypt, ...; and only diplomatic passports of ..." -> per member state
A mention the reader can't classify safely is kept as a "note": the site shows the quote and says "check", never "free".

    python scripts/diplomatic.py EG     # test: what an Egyptian diplomatic passport gets
"""
from __future__ import annotations

import re
import sys
import time
import urllib.parse

from bs4 import BeautifulSoup

from common import countries, get_json, http_get, iso2_of

API = "https://en.wikipedia.org/w/api.php"
HTML = "https://en.wikipedia.org/api/rest_v1/page/html/"
SECTION = re.compile(r"non-ordinary|diplomatic|official and service|official passports|service passports", re.I)
FREE = re.compile(r"without (a )?visas?|do(es)? not (need|require)|visa(s)? (is |are )?not required|visa[- ]free|visa exemption|exempt(ed)? from", re.I)
GROUPS = {
    "EU": ("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE", r"european union"),
    "ASEAN": ("BN KH ID LA MY MM PH SG TH VN", r"\basean\b"),
    "GCC": ("BH KW OM QA SA AE", r"\bgcc\b|gulf cooperation council"),
}
SCHENGEN = "AT BE HR CZ DK EE FI FR DE GR HU IS IT LV LI LT LU MT NL NO PL PT SK SI ES SE CH BG RO".split()


def titles() -> list[str]:
    out, cont = [], {}
    while True:
        q = {"action": "query", "list": "categorymembers", "cmtitle": "Category:Visa policy by country", "cmlimit": "500",
             "cmnamespace": "0", "format": "json", **cont}
        r = get_json(API + "?" + urllib.parse.urlencode(q))
        out += [m["title"] for m in r["query"]["categorymembers"]]
        if "continue" not in r:
            found = [t for t in out if t.startswith("Visa policy of")]
            return found + [t for t in ("Visa policy of the Schengen Area",) if t not in found]   # not in that category
        cont = r["continue"]


def text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).replace(" ,", ",").replace(" .", ".").replace("( ", "(").replace(" )", ")").strip()


def stay(s: str) -> str:
    m = re.search(r"(\d+)\s*(day|month|year)", s.lower())
    return f"{m.group(1)}{m.group(2)[0]}" if m else ""


def stay_for(name: str, t: str, default: str) -> str:
    """'Belarus (30 days)': the stay written right after this country's name, else the section's general one."""
    m = re.search(re.escape(name) + r"\s*\(([^)]*\d+\s*(?:day|month|year)s?[^)]*)\)", t, re.I)
    return stay(m.group(1)) if m else default


def snippet(s: str, name: str, width: int = 260) -> str:
    """The part of a long sentence around the country's name."""
    if len(s) <= width:
        return s
    i = max(0, s.find(name))
    a = max(0, i - width // 2)
    return ("…" if a else "") + s[a:a + width].strip() + "…"


def country_links(el) -> list[tuple[str, str]]:
    """(ISO2, name as written) for each country link inside an element."""
    out = []
    for a in el.find_all("a"):
        name = a.get_text(" ", strip=True)
        target = urllib.parse.unquote((a.get("href") or "").split("/")[-1]).replace("_", " ")
        iso = iso2_of(name) or iso2_of(target)
        if iso and len(name) > 2:
            out.append((iso, name))
    return out


def parse(title: str, known: set[str]) -> tuple[str | None, dict[str, dict]]:
    """-> (destination ISO2 or None for Schengen, {passport ISO2: entry}); Schengen returns {"schengen": {member: {...}}}."""
    soup = BeautifulSoup(http_get(HTML + urllib.parse.quote(title.replace(" ", "_"), safe=""), timeout=60), "lxml")
    for s in soup.select("sup, style, .mw-ref, .reference"):
        s.decompose()
    sec = None
    for h in soup.find_all(["h2", "h3", "h4"]):
        if SECTION.search(h.get_text()) and not re.search(r"\bvisas? for\b|official visas|types of visa", h.get_text(), re.I):
            sec = h.find_parent("section")
            break
    if sec is None:
        return None, {}
    heading = sec.find(["h2", "h3", "h4"])
    if heading:
        heading.decompose()   # the quotes start with the rule itself, not the section title
    sec_text = text(sec)
    # the section's opening sentence ("holders of diplomatic passports of the following countries may enter without a
    # visa for up to 90 days") explains bare lists of names, and gives the usual stay
    intro_el = sec.find("p")
    intro = text(intro_el) if intro_el else ""
    intro_short = intro if len(intro) <= 220 else intro[:220].rsplit(" ", 1)[0] + "…"
    default_stay = stay(intro)
    dest_name = title.replace("Visa policy of ", "").replace("the ", "", 1) if title.startswith("Visa policy of the ") else title.replace("Visa policy of ", "")
    out: dict[str, dict] = {}

    def put(iso, k, s, st):
        if iso in known and (iso not in out or (out[iso]["k"] == "note" and k == "free")):
            out[iso] = {"k": k, "s": s[:300], "st": st}

    # Schengen: one line per member state
    if "Schengen" in title:
        per: dict[str, dict] = {}
        for li in sec.find_all("li"):
            t = text(li)
            if " : " not in t and ": " not in t:
                continue
            left, right = re.split(r"\s?:\s", t, maxsplit=1)
            members = [iso2_of(x.strip()) for x in re.split(r",| and ", left)]
            members = [m for m in members if m in SCHENGEN]
            if not members or "Annex II" in t:
                continue
            # the first list ("Annex II countries ... except for") names exceptions, not exemptions
            prev = li.find_parent(["ul", "ol"]).find_previous_sibling("p") if li.find_parent(["ul", "ol"]) else None
            if prev and re.search(r"except", text(prev), re.I):
                continue
            # the names on the right are plain text: "Bolivia, Egypt, ...; and only diplomatic passports of Armenia (biometric only), ..."
            names = [re.sub(r"\(.*?\)", "", x).strip() for x in re.split(r",|;|\band only diplomatic passports of\b|\band\b", right)]
            for name in names:
                iso = iso2_of(name) if name else None
                if not iso or iso in SCHENGEN:
                    continue
                for m in members:
                    e = per.setdefault(m, {})
                    if iso in known and iso not in e:
                        e[iso] = {"k": "free", "s": snippet(t, name), "st": "90d"}
        return "SCHENGEN", per

    dest = iso2_of(dest_name)
    if not dest:
        return None, {}
    free_section = bool(FREE.search(sec_text))
    # "diplomatic passports of any country (except A, B)"
    m = re.search(r"diplomatic passports of (any|all) countr(y|ies)(\s*\(except ([^)]*)\))?", sec_text, re.I)
    if m:
        excluded = {iso2_of(x.strip()) for x in re.split(r",|\band\b", m.group(4) or "") if x.strip()}
        sent = next((x for x in re.split(r"(?<=[.!?])\s+", sec_text) if m.group(0) in x), m.group(0))
        for iso in known:
            if iso not in excluded and iso != dest:
                put(iso, "free" if FREE.search(sent) else "note", snippet(sent, m.group(0), 320), stay(sent))
    # groups (EU, ASEAN, GCC)
    for members, rx in GROUPS.values():
        for sent in re.split(r"(?<=[.!?])\s+", sec_text):
            if re.search(rx, sent, re.I) and not re.search(r"except[^.]*" + rx, sent, re.I):
                for iso in members.split():
                    if iso != dest:
                        put(iso, "free" if free_section else "note", snippet(sent, re.search(rx, sent, re.I).group(0)), default_stay)
    # every country named: the row / list item / sentence it is in
    for el in sec.find_all(["li", "tr", "p"]):
        if el.find(["li", "tr"]):   # use the innermost row or item
            continue
        t = text(el)
        for iso, name in country_links(el):
            if iso == dest:
                continue
            before = t[:max(0, t.find(name))]
            if re.search(r"except[^)]*$", before, re.I):   # named as an exception: not visa-free
                continue
            k = "free" if free_section else "note"
            if re.search(r"public affairs|only (official|service)|official passports only|service passports only", t + " " + sec_text[:300], re.I) \
                    and not re.search(r"diplomatic", t, re.I):
                k = "note"
            if el.name == "p":   # a long sentence: quote just the part around the name
                sent = next((x for x in re.split(r"(?<=[.!?])\s+", t) if name in x), t)
                put(iso, k, snippet(sent, name), stay_for(name, sent, default_stay))
            else:   # a list item or table row: the rule from the opening sentence, then the row
                row_stay = stay(t) or default_stay
                put(iso, k, (intro_short + " → " + t) if intro_short and len(t) < 120 else t, row_stay)
    return dest, out


def build(pause: float = 0.3) -> dict[str, dict[str, dict]]:
    """{passport ISO2: {destination ISO2: {k, s (quote), st (stay), t (article)}}}"""
    known = set(countries())
    result: dict[str, dict[str, dict]] = {}
    ok = 0
    for title in titles():
        try:
            dest, entries = parse(title, known)
        except Exception as e:
            print("  diplomatic: failed", title, e); continue
        time.sleep(pause)
        if not dest:
            continue
        ok += 1
        if dest == "SCHENGEN":
            for member, ent in entries.items():
                for pp, e in ent.items():
                    if pp != member:
                        result.setdefault(pp, {})[member] = {**e, "t": title}
            continue
        for pp, e in entries.items():
            result.setdefault(pp, {})[dest] = {**e, "t": title}
    print(f"diplomatic: {ok} visa-policy articles read, {sum(len(v) for v in result.values())} passport-destination rules")
    return result


if __name__ == "__main__":
    pp = (sys.argv[1:] or ["EG"])[0]
    r = build()
    mine = r.get(pp, {})
    print(pp, len(mine), "destinations")
    for d, e in sorted(mine.items()):
        print(f"  {d} {e['k']:4} {e['st']:4} {e['t'][15:]:28} | {e['s'][:110]}")
