"""Local preview with the same security headers as Cloudflare Pages (_headers):  python scripts/serve.py  -> http://127.0.0.1:8765"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_headers():
    rules, cur = [], None
    for line in open(os.path.join(ROOT, "_headers"), encoding="utf-8"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            cur = (line.strip(), []); rules.append(cur)
        elif cur and ":" in line:
            k, v = line.strip().split(":", 1); cur[1].append((k.strip(), v.strip()))
    return rules


class Handler(http.server.SimpleHTTPRequestHandler):
    rules = read_headers()

    def end_headers(self):
        path = self.path.split("?")[0]
        for pat, hs in self.rules:
            if pat == "/*" or (pat.endswith("/*") and path.startswith(pat[:-1])):
                for k, v in hs:
                    self.send_header(k, v)
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=ROOT)).serve_forever()
