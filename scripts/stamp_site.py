"""Prepares a copy of site/ for deployment: versioned asset URLs and preload hints.

The site has no build step, and GitHub Pages lets browsers cache every file for
10 minutes under an unchanging URL. After a deploy, a browser could combine a
new page script with an old cached module it imports, and a page whose imports
no longer match does not start at all. In the copy, this script:

* adds ?v=<hash of the site's JS and CSS> to every script, stylesheet and
  relative module import, so a deploy that changes code changes every URL
  (data-only deploys keep the URLs, so browsers keep their cached code);
* lists each page's whole module graph as <link rel="modulepreload"> after its
  module script, so the browser fetches the modules in parallel instead of
  discovering them one import level at a time.

Usage: python scripts/stamp_site.py site _site
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sys
from pathlib import Path

# Relative module specifiers: `from './x.js'`, `import './x.js'` and `import('./x.js')`.
IMPORT_RE = re.compile(r"""(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?/[^'"\s?#]+\.js)\2""")
SCRIPT_RE = re.compile(r'(<script\b[^>]*?\bsrc=")([^"?#:]+\.js)(")')
STYLE_RE = re.compile(r'(<link\b[^>]*?\brel="stylesheet"[^>]*?\bhref=")([^"?#:]+\.css)(")')
MODULE_TAG_RE = re.compile(
    r'^([ \t]*)<script\b[^>]*\btype="module"[^>]*\bsrc="([^"?#:]+\.js)"[^>]*></script>(?=[ \t]*\r?$)', re.M)
BASE_RE = re.compile(r'<base\b[^>]*\bhref="[^"]*"')


def code_version(site: Path) -> str:
    """A short hash of the site's JavaScript and CSS (not its data or pages)."""
    digest = hashlib.sha256()
    for path in sorted((site / "assets").rglob("*")):
        if path.is_file() and path.suffix in {".js", ".css"}:
            digest.update(path.relative_to(site).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()[:10]


def imports(module: Path) -> list[Path]:
    text = module.read_text(encoding="utf-8")
    return [(module.parent / spec).resolve() for _, _, spec in IMPORT_RE.findall(text)]


def module_graph(entry: Path) -> list[Path]:
    """Every module `entry` imports, directly or not, nearest first (the entry itself excluded)."""
    entry = entry.resolve()
    seen, order, queue = {entry}, [], [entry]
    while queue:
        for dep in imports(queue.pop(0)):
            if dep not in seen:
                seen.add(dep)
                order.append(dep)
                queue.append(dep)
    return order


def stamp_js(text: str, version: str) -> str:
    return IMPORT_RE.sub(lambda m: f"{m[1]}{m[2]}{m[3]}?v={version}{m[2]}", text)


def stamp_html(text: str, page_dir: Path, site: Path, version: str) -> str:
    # A page with <base href> (404.html) resolves its URLs against the site root.
    ref_dir = site if BASE_RE.search(text) else page_dir

    def with_preloads(m: re.Match) -> str:
        indent = m[1]
        links = [f'{indent}<link rel="modulepreload" href="{Path(os.path.relpath(dep, ref_dir)).as_posix()}?v={version}">'
                 for dep in module_graph(ref_dir / m[2])]
        return "\n".join([m[0], *links])

    text = MODULE_TAG_RE.sub(with_preloads, text)
    text = SCRIPT_RE.sub(lambda m: f"{m[1]}{m[2]}?v={version}{m[3]}", text)
    return STYLE_RE.sub(lambda m: f"{m[1]}{m[2]}?v={version}{m[3]}", text)


def stamp(src: Path, out: Path) -> str:
    """Copy `src` to `out` and stamp the copy. Returns the asset version."""
    src = src.resolve()
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(src, out)
    version = code_version(src)
    for path in out.rglob("*"):
        if path.suffix not in {".js", ".html"}:
            continue
        text = path.read_bytes().decode("utf-8")
        if path.suffix == ".js":
            text = stamp_js(text, version)
        else:
            text = stamp_html(text, src / path.parent.relative_to(out), src, version)
        path.write_bytes(text.encode("utf-8"))
    return version


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    version = stamp(Path(argv[1]), Path(argv[2]))
    print(f"Stamped {argv[2]} with asset version {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
