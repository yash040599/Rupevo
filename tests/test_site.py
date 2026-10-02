"""Structural checks on the static site in site/.

The site has no build step, so these catch what a bundler normally would:
broken relative links between nested pages, missing assets, a page without
the shared shell or security policy, a JS import of a missing module, and a
UPI QR image that no longer matches the UPI ID in config.js.
"""

import os
import re
import unittest
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

SITE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site")
JS_DIR = os.path.join(SITE, "assets", "js")
SKIP_SCHEMES = ("http:", "https:", "mailto:", "upi:", "data:", "javascript:", "#")


def html_pages() -> list[str]:
    pages = []
    for root, _, files in os.walk(SITE):
        pages += [os.path.join(root, f) for f in files if f.endswith(".html")]
    return sorted(pages)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.refs: list[str] = []
        self.ids: set[str] = set()
        self.csp = None
        self.base = None
        self.classic_scripts: list[str] = []
        self.module_scripts: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        if tag == "base":
            self.base = a.get("href")
        if tag == "meta" and a.get("http-equiv", "").lower() == "content-security-policy":
            self.csp = a.get("content")
        if tag == "script" and a.get("src"):
            (self.module_scripts if a.get("type") == "module" else self.classic_scripts).append(a["src"])
        for key in ("href", "src"):
            if tag in ("a", "link", "script", "img") and a.get(key):
                self.refs.append(a[key])


def parse(path: str) -> PageParser:
    parser = PageParser()
    with open(path, encoding="utf-8") as fh:
        parser.feed(fh.read())
    return parser


def resolve(page: str, ref: str, base: str | None) -> str:
    target = unquote(urlsplit(ref).path)
    if base:
        # 404.html sets <base href="/Rupevo/">, i.e. the site root.
        start = SITE
    else:
        start = os.path.dirname(page)
    full = os.path.normpath(os.path.join(start, target))
    if ref.endswith("/") or os.path.isdir(full):
        full = os.path.join(full, "index.html")
    return full


class SitePagesTest(unittest.TestCase):
    def test_every_page_has_shell_and_policy(self):
        policies = set()
        for page in html_pages():
            with self.subTest(page=os.path.relpath(page, SITE)):
                p = parse(page)
                self.assertIn("site-nav", p.ids)
                self.assertIn("site-footer", p.ids)
                self.assertIsNotNone(p.csp, "missing Content-Security-Policy meta")
                policies.add(p.csp)
                self.assertTrue(any(s.endswith("assets/js/boot.js") for s in p.classic_scripts),
                                "boot.js must load in <head> (theme before first paint)")
                self.assertEqual(len(p.module_scripts), 1, "exactly one page module expected")
        self.assertEqual(len(policies), 1, "pages disagree on the Content-Security-Policy")

    def test_relative_links_and_assets_resolve(self):
        for page in html_pages():
            p = parse(page)
            for ref in p.refs:
                if ref.startswith(SKIP_SCHEMES) or ref.startswith("//"):
                    continue
                with self.subTest(page=os.path.relpath(page, SITE), ref=ref):
                    target = resolve(page, ref, p.base)
                    self.assertTrue(target.startswith(SITE), f"{ref} escapes the site folder")
                    self.assertTrue(os.path.isfile(target), f"{ref} -> missing {target}")

    def test_js_imports_resolve(self):
        pattern = re.compile(r"""(?:from|import\()\s*['"](\.{1,2}/[^'"]+)['"]""")
        for name in os.listdir(JS_DIR):
            if not name.endswith(".js"):
                continue
            with open(os.path.join(JS_DIR, name), encoding="utf-8") as fh:
                source = fh.read()
            for spec in pattern.findall(source):
                with self.subTest(module=name, imports=spec):
                    self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(JS_DIR, spec))))


class UpiQrTest(unittest.TestCase):
    def test_qr_matches_configured_upi_id(self):
        with open(os.path.join(JS_DIR, "config.js"), encoding="utf-8") as fh:
            config = fh.read()
        match = re.search(r"upi:\s*\{\s*id:\s*'([^']*)',\s*payee:\s*'([^']*)'", config)
        self.assertIsNotNone(match, "could not find upi: { id, payee } in config.js")
        vpa, payee = match.groups()
        if not vpa:
            self.skipTest("UPI not configured")
        with open(os.path.join(SITE, "assets", "img", "upi-qr.svg"), encoding="utf-8") as fh:
            svg = fh.read()
        desc = re.search(r"<desc>(.*?)</desc>", svg, re.S)
        self.assertIsNotNone(desc, "upi-qr.svg has no <desc> payload; regenerate it")
        payload = desc.group(1).replace("&amp;", "&")
        self.assertIn(f"pa={vpa}&", payload,
                      "QR encodes a different UPI ID — run scripts/make_upi_qr.py")
        self.assertIn(f"pn={payee.replace(' ', '%20')}&", payload)
        self.assertTrue(os.path.isfile(os.path.join(SITE, "assets", "img", "upi-qr.png")))


if __name__ == "__main__":
    unittest.main()
