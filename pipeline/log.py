"""Minimal stderr logger — the pipeline runs from a terminal or CI log."""

from __future__ import annotations

import sys

from pipeline.clock import now_ist


class Logger:
    def __init__(self, name: str) -> None:
        self.name = name

    def _emit(self, level: str, msg: str) -> None:
        stamp = now_ist().strftime("%H:%M:%S")
        sys.stderr.write(f"{stamp} {level:<5} [{self.name}] {msg}\n")
        sys.stderr.flush()

    def info(self, msg: str) -> None:
        self._emit("INFO", msg)

    def warning(self, msg: str) -> None:
        self._emit("WARN", msg)

    def error(self, msg: str) -> None:
        self._emit("ERROR", msg)
