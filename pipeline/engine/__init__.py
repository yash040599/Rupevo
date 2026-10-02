"""Scoring engine migrated from ai-portfolio-manager.

Pure arithmetic over candle lists and fundamentals dicts: no network, no
broker, no global config. Keeping it pure is what lets the same code run
locally and inside the GitHub Actions refresh job.
"""
