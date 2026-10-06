"""Exchange rates -> data/rates.json (base EUR)

  ECB reference rates via Frankfurter (api.frankfurter.dev, free, ~30 major currencies), preferred where available
  ExchangeRate-API open access (open.er-api.com, free, attribution required) for all other currencies

If both fail, the last good rates stay (the site shows their date).
"""
from __future__ import annotations

import sys

from common import get_json, iso_z, load_json, now_utc, save_json


def main() -> int:
    old = load_json("rates.json", {})
    rates, src, dates = dict(old.get("r") or {}), dict(old.get("s") or {}), dict(old.get("d") or {})
    ok = 0
    try:
        er = get_json("https://open.er-api.com/v6/latest/EUR")
        if er.get("result") != "success" or len(er.get("rates", {})) < 100:
            raise RuntimeError("unexpected answer")
        day = iso_z(now_utc())[:10]
        for k, v in er["rates"].items():
            rates[k], src[k] = v, "er"
        dates["er"] = er.get("time_last_update_utc", day)
        ok += 1
        print("open.er-api:", len(er["rates"]))
    except Exception as e:
        print("open.er-api FAILED:", e, file=sys.stderr)
    try:
        fr = get_json("https://api.frankfurter.dev/v1/latest?base=EUR")
        for k, v in fr["rates"].items():
            rates[k], src[k] = v, "ecb"
        rates["EUR"], src["EUR"] = 1, "ecb"
        dates["ecb"] = fr["date"]
        ok += 1
        print("ECB:", len(fr["rates"]))
    except Exception as e:
        print("ECB FAILED:", e, file=sys.stderr)
    if not ok:
        return 1
    save_json("rates.json", {"generated": iso_z(now_utc()), "base": "EUR", "r": rates, "s": src, "d": dates})
    return 0


if __name__ == "__main__":
    sys.exit(main())
