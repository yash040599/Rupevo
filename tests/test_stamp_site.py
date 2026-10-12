"""The deploy-time stamping of site/ (scripts/stamp_site.py).

The deployed copy must version every script, stylesheet and module import (so a
browser never combines cached old modules with new ones), preload each page's
whole module graph, and change nothing else.
"""

import importlib.util
import re
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
_spec = importlib.util.spec_from_file_location("stamp_site", ROOT / "scripts" / "stamp_site.py")
stamp_site = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stamp_site)

ANY_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.\.?/[^'"]+)['"]""")
PRELOAD = re.compile(r'<link rel="modulepreload" href="([^"]+)">')


class StampSiteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "site"
        cls.version = stamp_site.stamp(SITE, cls.out)
        cls.tag = f"?v={cls.version}"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def stamped_imports(self, module: Path) -> list[Path]:
        specs = ANY_IMPORT.findall(module.read_text(encoding="utf-8"))
        for spec in specs:
            self.assertTrue(spec.endswith(self.tag), f"{module.name}: unversioned import {spec}")
        return [(module.parent / spec.split("?")[0]).resolve() for spec in specs]

    def test_every_module_import_is_versioned_and_resolves(self):
        for module in (self.out / "assets").rglob("*.js"):
            with self.subTest(module=module.name):
                for dep in self.stamped_imports(module):
                    self.assertTrue(dep.is_file(), f"{module.name} imports missing {dep}")

    def test_pages_version_assets_and_preload_their_whole_module_graph(self):
        for page in self.out.rglob("*.html"):
            text = page.read_text(encoding="utf-8")
            with self.subTest(page=page.relative_to(self.out).as_posix()):
                urls = re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', text)
                urls += re.findall(r'<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"', text)
                for url in urls:
                    self.assertTrue(url.endswith(self.tag), f"unversioned {url}")
                ref = self.out if "<base " in text else page.parent
                entry = re.search(r'<script type="module" src="([^"?]+)', text)
                self.assertIsNotNone(entry, "no page module")
                start = (ref / entry[1]).resolve()
                graph, queue = set(), [start]
                while queue:
                    for dep in self.stamped_imports(queue.pop()):
                        if dep not in graph and dep != start:
                            graph.add(dep)
                            queue.append(dep)
                preloads = PRELOAD.findall(text)
                for href in preloads:
                    self.assertTrue(href.endswith(self.tag), f"unversioned preload {href}")
                self.assertEqual({(ref / h.split("?")[0]).resolve() for h in preloads}, graph)
                self.assertEqual(len(preloads), len(graph), "duplicate preloads")

    def test_stamping_only_adds_versions_and_preloads(self):
        for path in SITE.rglob("*"):
            if not path.is_file():
                continue
            stamped = self.out / path.relative_to(SITE)
            with self.subTest(file=path.relative_to(SITE).as_posix()):
                if path.suffix in {".js", ".html"}:
                    text = stamped.read_bytes().decode("utf-8")
                    text = re.sub(r'\n[ \t]*<link rel="modulepreload" href="[^"]*">', "", text)
                    self.assertEqual(text.replace(self.tag, ""), path.read_bytes().decode("utf-8"))
                else:
                    self.assertEqual(stamped.read_bytes(), path.read_bytes())

    def test_version_follows_code_not_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "site"
            shutil.copytree(SITE, copy)
            before = stamp_site.code_version(copy)
            (copy / "data" / "india.json").write_text("{}", encoding="utf-8")
            (copy / "index.html").write_text("<!DOCTYPE html>", encoding="utf-8")
            self.assertEqual(stamp_site.code_version(copy), before, "data and pages must not change the version")
            core = copy / "assets" / "js" / "core.js"
            core.write_text(core.read_text(encoding="utf-8") + "\n// changed\n", encoding="utf-8")
            self.assertNotEqual(stamp_site.code_version(copy), before)


if __name__ == "__main__":
    unittest.main()
