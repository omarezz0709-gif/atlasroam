"""Real-browser test of the site (headless Chromium via Playwright): every scenario must load without errors and show
what it should. Screenshots go to a folder outside the project for a human look.

    pip install playwright && python -m playwright install chromium
    python scripts/browser_test.py                                   # local preview (python scripts/serve.py 8766)
    python scripts/browser_test.py --base https://atlasroam.pages.dev/ d-kyoto m-search-fr   # some scenarios, live site
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile

from playwright.async_api import async_playwright

OUT = os.path.join(tempfile.gettempdir(), "atlasroam-shots")

# name: (path, language, theme, width, height, passport, steps, check = JS returning true when the page is right)
S = {
    "d-home-light": ("", "en", "light", 1366, 800, "DE", [], "() => document.querySelectorAll('.tk-item').length > 0"),
    "d-home-dark": ("", "en", "dark", 1366, 800, "DE", [], "() => document.querySelectorAll('.tk-item').length > 0"),
    "d-jp": ("#JP", "en", "light", 1366, 800, "DE", [], "() => PINS.length > 5 && document.querySelectorAll('#p-body .card').length > 5"),
    "d-kyoto": ("#JP/c/Kyoto", "en", "light", 1366, 800, "DE", [], "() => city && city.id === 'Kyoto' && PINS.length > 5"),
    "d-kyoto-de": ("#JP/c/Kyoto", "de", "dark", 1366, 800, "DE", ["scroll:700"], "() => city && document.querySelector('#p-name').textContent.length > 0"),
    "d-ar-cairo": ("#EG/c/Cairo", "ar", "light", 1366, 800, "EG", [], "() => document.documentElement.dir === 'rtl' && city"),
    "m-fr-it": ("#IT", "fr", "light", 390, 844, "EG", [], "() => PINS.length > 5"),
    "m-es-rome": ("#IT/c/Rome", "es", "dark", 390, 844, "EG", [], "() => city && city.id === 'Rome'"),
    "d-it-entry": ("#US/entry", "it", "light", 1366, 800, "EG", [], "() => !!document.querySelector('.visa')"),
    "d-dip-it": ("#IT/entry", "en", "light", 1366, 800, "EG", ["dip"], "() => !!document.querySelector('.visa.ok') && !!document.querySelector('.quote')"),
    "d-dip-de": ("#DE/entry", "de", "dark", 1366, 800, "EG", ["dip"], "() => !!document.querySelector('#p-body .note.warn')"),
    "m-ar-dip-tr": ("#TR/entry", "ar", "light", 390, 844, "EG", ["dip"], "() => !!document.querySelector('.visa.ok')"),
    "d-search": ("", "en", "light", 1366, 800, "EG", ["type:#q=kyo"], "() => !!document.querySelector('#q-list li[data-city]')"),
    "m-search-fr": ("", "fr", "dark", 390, 844, "EG", ["type:#q=venise"], "() => !!document.querySelector('#q-list li[data-city]')"),
    "m-home": ("", "en", "light", 390, 844, "", [], "() => true"),
    "d-tour": ("", "en", "light", 1366, 800, "", ["tour"], "() => !!document.querySelector('.tour-card')"),
}


async def run(base: str, names: list[str]) -> int:
    os.makedirs(OUT, exist_ok=True)
    bad = 0
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        for name in names:
            path, lang, theme, w, h, pp, steps, check = S[name]
            ctx = await b.new_context(viewport={"width": w, "height": h}, is_mobile=w < 700, has_touch=w < 700)
            init = f"localStorage.setItem('ar-lang','{lang}');localStorage.setItem('ar-theme','{theme}');"
            init += f"localStorage.setItem('ar-passport','{pp}');" if pp else ""
            init += "" if "tour" in steps else "localStorage.setItem('ar-tour-2','1');"
            init += "localStorage.setItem('ar-pp-type','dip');" if "dip" in steps else ""
            await ctx.add_init_script(init)
            pg = await ctx.new_page()
            errs: list[str] = []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(base + path)
            for _ in range(80):
                if await pg.evaluate("() => typeof READY !== 'undefined' && READY"):
                    break
                await pg.wait_for_timeout(500)
            await pg.wait_for_timeout(4000)
            for st in steps:
                if st.startswith("type:"):
                    sel, txt = st[5:].split("=", 1)
                    await pg.focus(sel); await pg.wait_for_timeout(1500); await pg.fill(sel, txt); await pg.wait_for_timeout(800)
                elif st.startswith("scroll:"):
                    await pg.evaluate(f"() => document.querySelector('#p-body').scrollTop = {st[7:]}"); await pg.wait_for_timeout(500)
            ok = False
            for _ in range(10):   # data may still be arriving
                try:
                    ok = bool(await pg.evaluate(check))
                except Exception as e:
                    errs.append(f"check: {e}")
                if ok:
                    break
                await pg.wait_for_timeout(1000)
            for attempt in range(2):
                try:
                    await pg.screenshot(path=os.path.join(OUT, name + ".png"), timeout=90000); break
                except Exception:
                    pass
            status = "ok" if ok and not errs else "FAIL"
            bad += status != "ok"
            print(f"{status:4} {name:14} {lang} {theme:5} {w}px  {'' if ok else 'check failed '}{errs[:3] if errs else ''}", flush=True)
            await ctx.close()
        await b.close()
    print(f"{len(names) - bad}/{len(names)} ok · screenshots in {OUT}")
    return bad


if __name__ == "__main__":
    args = sys.argv[1:]
    base = "http://127.0.0.1:8766/"
    if "--base" in args:
        i = args.index("--base"); base = args[i + 1]; del args[i:i + 2]
    sys.exit(1 if asyncio.run(run(base, args or list(S))) else 0)
