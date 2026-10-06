"""Official travel advice from three governments -> data/safety.json

  Germany  Auswärtiges Amt open data (www.auswaertiges-amt.de/opendata), one request
  UK       GOV.UK content API for FCDO travel advice (Open Government Licence v3.0); only changed countries are re-read
  US       State Department travel advisories API (public domain), one request

Every source is translated into the same 4 steps (the site shows each government's own wording next to it):
  1 normal precautions   2 increased caution / warnings for parts   3 avoid non-essential travel / reconsider   4 do not travel
If a source fails, its last good data is kept (and marked with when it was last read successfully).
Level changes are logged (data/safety.json -> changes) for the alerts ticker.
"""
from __future__ import annotations

import datetime as dt
import re
import sys

from common import countries, get_json, iso2_of, iso_z, load_json, now_utc, parse_iso, save_json, strip_html

AA_LIST = "https://www.auswaertiges-amt.de/opendata/travelwarning"
AA_PAGE = "https://www.auswaertiges-amt.de/de/-/{id}"   # redirects to the country's page
UK_INDEX = "https://www.gov.uk/api/content/foreign-travel-advice"
US_API = "https://cadataapi.state.gov/api/TravelAdvisories"
KEEP_CHANGES_DAYS = 45
# one page covering several places (or one place split over several pages: the strictest wins)
MULTI = {"Bonaire/St Eustatius/Saba": ["BQ"], "Cook Islands, Tokelau and Niue": ["CK", "TK", "NU"],
         "St Martin and St Barthélemy": ["MF", "BL"], "West Bank": ["PS"], "Gaza": ["PS"], "Saba and Sint Eustatius": ["BQ"],
         "French West Indies": ["GP", "MQ", "BL", "MF"], "Antarctica/British Antarctic Territory": ["AQ"]}


def put(out: dict, isos: list[str], rec: dict) -> None:
    for iso in isos:
        if iso not in out or rec["l"] > out[iso]["l"]:
            out[iso] = rec


def aa(old: dict) -> dict:
    out = {}
    r = get_json(AA_LIST)["response"]
    for k, v in r.items():
        if not k.isdigit() or not isinstance(v, dict):
            continue
        iso = v.get("countryCode")
        if not iso:
            continue
        if v.get("warning"):
            lvl, flag = 4, "warning"
        elif v.get("situationWarning"):
            lvl, flag = 3, "situationWarning"
        elif v.get("partialWarning"):
            lvl, flag = 2, "partialWarning"
        elif v.get("situationPartWarning"):
            lvl, flag = 2, "situationPartWarning"
        else:
            lvl, flag = 1, "none"
        changed = strip_html(v.get("lastChanges", "")).replace("Letzte Änderungen:", "").strip()
        out[iso] = {"l": lvl, "f": flag, "d": iso_z(dt.datetime.fromtimestamp(v["lastModified"], dt.timezone.utc)),
                    "u": AA_PAGE.format(id=k), "c": changed[:220]}
    if len(out) < 150:
        raise RuntimeError(f"Auswärtiges Amt: only {len(out)} countries")
    return out


UK_STATUS = {"avoid_all_travel_to_whole_country": 4, "avoid_all_but_essential_travel_to_whole_country": 3,
             "avoid_all_travel_to_parts": 2, "avoid_all_but_essential_travel_to_parts": 2}


def uk(old: dict) -> dict:
    idx = get_json(UK_INDEX)
    kids = idx["links"]["children"]
    if len(kids) < 150:
        raise RuntimeError(f"FCDO: only {len(kids)} countries in the index")
    out, read, failed = {}, 0, 0
    old_by_slug = {v.get("s"): (iso, v) for iso, v in old.items()}
    for ch in kids:
        slug = ch["details"]["country"]["slug"]
        name = ch["details"]["country"]["name"]
        isos = MULTI.get(name) or [iso2_of(name)]
        if not isos[0]:
            print("  FCDO: no code for", name); continue
        upd = ch.get("public_updated_at")
        prev = old_by_slug.get(slug, (None, None))[1]
        if prev and prev.get("d") == upd and "st" in prev:   # unchanged since last time: no need to read it again
            put(out, isos, prev); continue
        try:
            j = get_json(ch["api_url"], timeout=30)
            read += 1
        except Exception as e:  # keep the previous version of this country
            failed += 1
            print("  FCDO:", slug, e)
            if prev:
                put(out, isos, prev)
            continue
        st = j["details"].get("alert_status") or []
        lvl = max([UK_STATUS.get(s, 1) for s in st] or [1])
        put(out, isos, {"l": lvl, "st": st, "d": upd, "s": slug, "u": ch["web_url"],
                        "c": (j["details"].get("change_description") or "")[:220]})
    print(f"  FCDO: {read} countries re-read, {failed} failed, {len(out)} total")
    return out


def us(old: dict) -> dict:
    a3_to_2 = {c["a3"]: iso for iso, c in countries().items()}
    a3_to_2.update({"XKX": "XK", "XKV": "XK", "KOS": "XK"})
    out = {}
    for x in get_json(US_API, timeout=60):
        m = re.search(r"destination\.(\w{3})\.html", x.get("Link", ""))
        a3 = m.group(1).upper() if m else None
        name = x["Title"].split(" - ")[0].replace("Travel Advisory", "").strip()
        isos = MULTI.get(name) or [a3_to_2.get(a3) or iso2_of(name)]
        lv = re.search(r"Level (\d)", x.get("Title", ""))
        if not isos[0] or not lv:
            print("  US: skipped", x.get("Title")); continue
        summ = strip_html(x.get("Summary", ""))
        put(out, isos, {"l": int(lv.group(1)), "d": iso_z(parse_iso(x.get("Updated") or x.get("Published"))), "u": x["Link"],
                        "t": x["Title"].strip()[:160], "c": summ[:400]})
    if len(out) < 150:
        raise RuntimeError(f"US: only {len(out)} countries")
    return out


def main() -> int:
    old = load_json("safety.json", {"sources": {}, "countries": {}, "changes": []})
    now = now_utc()
    prev_by_src = {s: {iso: c[s] for iso, c in old.get("countries", {}).items() if s in c} for s in ("de", "uk", "us")}
    sources = dict(old.get("sources") or {})
    fresh, problems = {}, []
    for key, fn in (("de", aa), ("uk", uk), ("us", us)):
        try:
            fresh[key] = fn(prev_by_src[key])
            sources[key] = {"ok": iso_z(now), "n": len(fresh[key])}
            print(f"{key}: {len(fresh[key])} countries")
        except Exception as e:
            problems.append(f"{key}: {e}")
            print(f"{key}: FAILED ({e}), keeping the last good data", file=sys.stderr)
            fresh[key] = prev_by_src[key]
            sources.setdefault(key, {})["err"] = f"{iso_z(now)} {str(e)[:150]}"
    merged: dict[str, dict] = {}
    for key, data in fresh.items():
        for iso, v in data.items():
            merged.setdefault(iso, {})[key] = v
    for iso, c in merged.items():
        c["l"] = max(v["l"] for k, v in c.items() if k in ("de", "uk", "us"))
    # changes for the ticker: a source raising or lowering its level
    changes = [ch for ch in old.get("changes", []) if (now - (parse_iso(ch["at"]) or now)).days <= KEEP_CHANGES_DAYS]
    if old.get("countries"):
        for iso, c in merged.items():
            for k in ("de", "uk", "us"):
                a = (old["countries"].get(iso) or {}).get(k, {}).get("l")
                b = c.get(k, {}).get("l")
                if a and b and a != b:
                    changes.append({"c": iso, "s": k, "from": a, "to": b, "at": c[k].get("d") or iso_z(now)})
    changes.sort(key=lambda ch: ch["at"], reverse=True)
    for k, v in sources.items():
        if k in fresh and "ok" in v and v["ok"] == iso_z(now):
            v.pop("err", None)
    save_json("safety.json", {"generated": iso_z(now), "sources": sources, "countries": merged, "changes": changes[:80]})
    print(f"safety.json: {len(merged)} countries, {len(changes)} recent changes")
    return 1 if len(problems) == 3 else 0


if __name__ == "__main__":
    sys.exit(main())
