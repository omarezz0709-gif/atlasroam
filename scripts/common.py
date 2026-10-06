"""Shared helpers for the Atlasroam data updaters (all free sources, no API keys)."""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BERLIN = ZoneInfo("Europe/Berlin")
SLOTS = (0, 6, 12, 18)       # Berlin hours of the scheduled refreshes
SLOT_WINDOW_MIN = 90         # GitHub's scheduler can start runs late
# Wikimedia and others ask automated tools to say who they are and how to reach them
UA = "atlasroam-globe/1.0 (https://github.com/omarezz0709-gif/atlasroam) free travel globe, scheduled data refresh"


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_z(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def in_slot(t_utc: dt.datetime, hours=SLOTS) -> bool:
    b = t_utc.astimezone(BERLIN)
    for h in hours:
        start = b.replace(hour=h, minute=0, second=0, microsecond=0)
        if start <= b < start + dt.timedelta(minutes=SLOT_WINDOW_MIN):
            return True
    return False


def scheduled() -> bool:
    return os.environ.get("GITHUB_EVENT_NAME") == "schedule"


def due(generated: str | None, max_age_h: float) -> bool:
    """True when the data is older than max_age_h (or missing): the catch-up rule when GitHub skipped runs."""
    g = parse_iso(generated)
    return g is None or now_utc() - g > dt.timedelta(hours=max_age_h)


def http_get(url: str, timeout: int = 40, accept: str | None = None, tries: int = 3, wait: float = 5) -> bytes:
    headers = {"User-Agent": UA, "Accept-Encoding": "gzip"}
    if accept:
        headers["Accept"] = accept
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
                b = r.read()
            return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b   # some servers send gzip without saying so
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:   # rate limited (Wikidata does this): wait longer
                time.sleep(65)
            elif e.code < 500:
                raise
            else:
                time.sleep(wait * (i + 1))
        except Exception as e:  # timeout, DNS, TLS
            last = e
            time.sleep(wait * (i + 1))
    raise last


def get_json(url: str, **kw):
    return json.loads(http_get(url, **kw))


def load_json(name: str, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(name: str, obj, compact: bool = True) -> None:
    path = os.path.join(DATA, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(path + ".tmp", path)   # never leave a half-written file behind


def strip_html(s: str) -> str:
    s = re.sub(r"<br\s*/?>|</p>|</li>|</h\d>", " ", s or "")
    s = re.sub(r"<(p|div|h\d|li|ul|ol|br)\b[^>]*>", " ", s)   # block tags separate words
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"').replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
    s = re.sub(r"\s+", " ", s)
    return re.sub(r"\s+([.,;:])", r"\1", s).strip()


# ---------------------------------------------------------------- country names -> ISO2
def norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ").replace("saint ", "st ").replace("st. ", "st ")
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"[^a-z ]", " ", s)
    s = re.sub(r"\b(the|of|republic|rep)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


_NAMES: dict[str, str] | None = None


def iso2_of(name: str) -> str | None:
    """ISO2 code for a country name as written by the FCDO, Wikipedia etc. (scripts/names.json, built by build_world.py)."""
    global _NAMES
    if _NAMES is None:
        with open(os.path.join(ROOT, "scripts", "names.json"), encoding="utf-8") as f:
            _NAMES = json.load(f)
    return _NAMES.get(norm(name))


def countries() -> dict:
    """ISO2 -> {a3, n, lat, lng} from data/world.json."""
    w = load_json("world.json", {})
    return {c["id"]: c for c in w.get("countries", [])}
