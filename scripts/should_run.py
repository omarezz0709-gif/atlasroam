"""Decides whether the hourly data job should do a refresh (prints run=true/false for GitHub Actions).

Refresh slots are 00:00, 06:00, 12:00 and 18:00 Berlin time. The job is woken every hour, so when GitHub drops or
delays a scheduled run (it does), the next hour catches up: it runs when inside a slot window OR when the safety data
is older than 6.5 hours. Manual runs ("Run workflow") always refresh.
"""
import os

from common import in_slot, load_json, now_utc, parse_iso, scheduled


def main() -> None:
    gen = parse_iso(load_json("safety.json", {}).get("generated"))
    age_h = (now_utc() - gen).total_seconds() / 3600 if gen else 999
    if not scheduled():
        run, why = True, "manual run"
    elif in_slot(now_utc()) and age_h > 2:   # (a slot window spans two hourly wake-ups: refresh only once)
        run, why = True, "refresh slot"
    elif age_h > 6.5:
        run, why = True, f"catch-up: safety data is {age_h:.1f} h old"
    else:
        run, why = False, f"not a slot, data is {age_h:.1f} h old"
    print(why)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"run={'true' if run else 'false'}\n")


if __name__ == "__main__":
    main()
