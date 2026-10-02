"""Generate the UPI QR code shown in the "Buy me a coffee" dialog.

    python scripts/make_upi_qr.py yash040599@okhdfcbank --payee "Yash Agrawal"

Writes site/assets/img/upi-qr.svg (shown on the page) and upi-qr.png (the
"Save QR image" download, which UPI apps can scan from the gallery). Re-run
after changing the UPI ID in site/assets/js/config.js;
tests/test_site.py fails while the two disagree. Needs `segno`
(requirements-dev.txt).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from urllib.parse import quote

import segno

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(REPO_ROOT, "site", "assets", "img")
VPA_RE = re.compile(r"^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$")


def upi_uri(vpa: str, payee: str) -> str:
    """Standard UPI payment URI without an amount (the payer chooses one)."""
    return f"upi://pay?pa={vpa}&pn={quote(payee)}&cu=INR"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("vpa", help="UPI ID, e.g. name@okhdfcbank")
    parser.add_argument("--payee", default="Rupevo", help="name shown in the payer's app")
    args = parser.parse_args(argv)

    if not VPA_RE.match(args.vpa):
        print(f"{args.vpa!r} does not look like a UPI ID (name@bank)", file=sys.stderr)
        return 2

    uri = upi_uri(args.vpa, args.payee)
    qr = segno.make(uri, error="m", micro=False)
    os.makedirs(IMG_DIR, exist_ok=True)
    qr.save(os.path.join(IMG_DIR, "upi-qr.svg"), kind="svg", border=4, dark="#000",
            light="#fff", omitsize=True, xmldecl=False,
            title=f"UPI QR code for {args.vpa}", desc=uri)
    qr.save(os.path.join(IMG_DIR, "upi-qr.png"), kind="png", scale=12, border=4,
            dark="#000", light="#fff")
    print(f"QR version {qr.version}, error level {qr.error}: {uri}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
