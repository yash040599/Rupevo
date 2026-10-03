"""Write market snapshots into the site's data folder."""

from __future__ import annotations

import json
import os
import traceback

from pipeline import india, us
from pipeline.log import Logger
from pipeline.providers.yahoo import ProviderError, YahooChart
from pipeline.snapshot import SnapshotError, compute_changes
from pipeline.universes import load as load_universe

MARKETS = ("india", "us")
# Each market publishes one snapshot per list:
# (snapshot key = file name, universe, exchange, where the list comes from).
SNAPSHOTS = {
    "india": (("india", "nifty100", None, "NSE India"),),
    "us": (("us", "nasdaq100", "NASDAQ", "Nasdaq"),
           ("us-nyse", "nyse100", "NYSE", "Nasdaq stock screener (NYSE listings)")),
}


def snapshot_path(out_dir: str, market: str) -> str:
    return os.path.join(out_dir, f"{market}.json")


def load_previous(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            blob = json.load(fh)
        return blob if isinstance(blob, dict) else None
    except (OSError, ValueError):
        return None


def write_snapshot(path: str, snapshot: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(snapshot, fh, indent=1, ensure_ascii=False, default=str)
        fh.write("\n")
    os.replace(tmp, path)


def publish_market(market: str, *, out_dir: str, cache_dir: str, chart: YahooChart,
                   fx: dict, limit: int | None = None) -> list[dict]:
    """Build, diff and write every snapshot of one market. One result record per snapshot;
    a list that fails keeps its previous snapshot without stopping the others."""
    return [publish_snapshot(key, universe_key, exchange, source, out_dir=out_dir,
                             cache_dir=cache_dir, chart=chart, fx=fx, limit=limit)
            for key, universe_key, exchange, source in SNAPSHOTS[market]]


def publish_snapshot(key: str, universe_key: str, exchange: str | None, source: str, *,
                     out_dir: str, cache_dir: str, chart: YahooChart, fx: dict,
                     limit: int | None = None) -> dict:
    """Build, diff and write one snapshot. Returns a one-line result record."""
    log = Logger(key)
    path = snapshot_path(out_dir, key)
    universe = load_universe(universe_key)
    try:
        if key == "india":
            snap = india.build(universe, chart, log, limit=limit)
        else:
            snap = us.build(universe, chart, cache_dir, log, limit=limit, market=key,
                            exchange=exchange, constituents_source=source)
    except (SnapshotError, ProviderError) as exc:
        log.error(f"not published: {exc}")
        return {"market": key, "ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — one list must not sink the others
        log.error(f"not published: {exc}\n{traceback.format_exc()}")
        return {"market": key, "ok": False, "error": f"{type(exc).__name__}: {exc}"}

    previous = load_previous(path)
    if not fx.get("usd_inr") and previous and (previous.get("fx") or {}).get("usd_inr"):
        fx = dict(previous["fx"], stale=True)
    snap["fx"] = fx
    changes, base = compute_changes(snap, previous)
    snap["changes"] = changes
    snap["changes_base"] = base
    write_snapshot(path, snap)
    log.info(f"wrote {path}: {snap['stats']['ranked']} ranked, changes: {changes['summary']}")
    return {"market": key, "ok": True, "ranked": snap["stats"]["ranked"],
            "data_through": snap["data_through"], "changes": changes["summary"],
            "errors": snap["stats"]["errors"]}


def write_job_summary(results: list[dict]) -> None:
    """Markdown summary for the GitHub Actions run page (no-op locally)."""
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if not target:
        return
    lines = ["### Rupevo data refresh", "",
             "| Market | Result | Ranked | Data through | Changes |",
             "|---|---|---|---|---|"]
    for r in results:
        if r["ok"]:
            lines.append(f"| {r['market']} | published | {r['ranked']} | "
                         f"{r['data_through']} | {r['changes']} |")
        else:
            lines.append(f"| {r['market']} | **failed** — {r['error']} | | | |")
    with open(target, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
