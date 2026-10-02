"""Command line for the data pipeline.

    python -m pipeline refresh [--market both|india|us]
    python -m pipeline universe [--only nifty100|nasdaq100]
"""

from __future__ import annotations

import argparse
import os
import sys

from pipeline.log import Logger

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO_ROOT, "site", "data")
DEFAULT_CACHE = os.path.join(REPO_ROOT, ".cache")


def _cmd_refresh(args: argparse.Namespace) -> int:
    from pipeline.providers.yahoo import YahooChart
    from pipeline.publish import MARKETS, publish_market, write_job_summary

    out_dir = os.path.abspath(args.out)
    if args.limit and out_dir == os.path.abspath(DEFAULT_OUT):
        print("--limit builds a partial ranking; pass --out <dir> so the "
              "published data is not overwritten.", file=sys.stderr)
        return 2

    markets = MARKETS if args.market == "both" else (args.market,)
    chart = YahooChart(Logger("yahoo"))
    fx = chart.usd_inr()
    results = [publish_market(m, out_dir=out_dir, cache_dir=os.path.abspath(args.cache),
                              chart=chart, fx=fx, limit=args.limit)
               for m in markets]
    write_job_summary(results)
    for r in results:
        status = (f"published ({r['ranked']} ranked, data through {r['data_through']})"
                  if r["ok"] else f"FAILED: {r['error']}")
        print(f"{r['market']:>6}: {status}")
    return 0 if all(r["ok"] for r in results) else 1


def _cmd_universe(args: argparse.Namespace) -> int:
    from pipeline.universes import UNIVERSES
    from pipeline.universes.refresh import refresh

    keys = UNIVERSES if not args.only else (args.only,)
    failed = False
    for key in keys:
        try:
            refresh(key)
        except Exception as exc:  # noqa: BLE001 — report and keep the checked-in list
            failed = True
            Logger("universe").error(f"{key}: kept the existing list ({exc})")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog="python -m pipeline",
                                     description="Rupevo data pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    p_refresh = sub.add_parser("refresh", help="rebuild ranking snapshots")
    p_refresh.add_argument("--market", choices=("both", "india", "us"), default="both")
    p_refresh.add_argument("--out", default=DEFAULT_OUT,
                           help="output folder (default: site/data)")
    p_refresh.add_argument("--cache", default=DEFAULT_CACHE,
                           help="working cache folder (default: .cache)")
    p_refresh.add_argument("--limit", type=int, default=None,
                           help="only the first N constituents (testing; needs --out)")
    p_refresh.set_defaults(func=_cmd_refresh)

    p_universe = sub.add_parser("universe", help="refresh index constituent lists")
    p_universe.add_argument("--only", choices=("nifty100", "nasdaq100"))
    p_universe.set_defaults(func=_cmd_universe)

    args = parser.parse_args(argv)
    return args.func(args)
