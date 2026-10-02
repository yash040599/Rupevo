"""Sector buckets for NSE symbols, used by the sector-leader bonus.

Migrated from ai-portfolio-manager `modes/trade/stock_scanner.py`
(`SECTOR_MAP`) so the bonus behaves the same as in the local tool, plus the
names that joined the Nifty 100 in NSE's September 2026 rebalance. A symbol
missing here falls into OTHER, which the sector-leader bonus ignores;
`tests/test_universes.py` fails when a constituent is unmapped.
"""

from __future__ import annotations

SECTOR_MAP: dict[str, str] = {
    # Banking
    "HDFCBANK": "BANKING", "ICICIBANK": "BANKING", "KOTAKBANK": "BANKING",
    "AXISBANK": "BANKING", "SBIN": "BANKING", "BANKBARODA": "BANKING",
    "PNB": "BANKING", "CANBK": "BANKING", "UNIONBANK": "BANKING",
    "IDFCFIRSTB": "BANKING", "FEDERALBNK": "BANKING", "YESBANK": "BANKING",
    "INDUSINDBK": "BANKING",
    # NBFC / insurance / capital markets
    "BAJFINANCE": "FINANCE", "BAJAJFINSV": "FINANCE", "CHOLAFIN": "FINANCE",
    "SHRIRAMFIN": "FINANCE", "MUTHOOTFIN": "FINANCE", "JIOFIN": "FINANCE",
    "HDFCLIFE": "FINANCE", "SBILIFE": "FINANCE", "HDFCAMC": "FINANCE",
    "PFC": "FINANCE", "RECLTD": "FINANCE", "IRFC": "FINANCE",
    "CANFINHOME": "FINANCE", "MFSL": "FINANCE", "LICHSGFIN": "FINANCE",
    "TATACAP": "FINANCE", "BSE": "FINANCE",
    # IT
    "TCS": "IT", "INFY": "IT", "HCLTECH": "IT", "WIPRO": "IT",
    "TECHM": "IT", "LTM": "IT", "NAUKRI": "IT", "OFSS": "IT",
    # Healthcare
    "SUNPHARMA": "PHARMA", "DRREDDY": "PHARMA", "CIPLA": "PHARMA",
    "APOLLOHOSP": "PHARMA", "DIVISLAB": "PHARMA", "TORNTPHARM": "PHARMA",
    "MAXHEALTH": "PHARMA", "BIOCON": "PHARMA", "AUROPHARMA": "PHARMA",
    "ZYDUSLIFE": "PHARMA",
    # Auto
    "MARUTI": "AUTO", "BAJAJ-AUTO": "AUTO", "EICHERMOT": "AUTO",
    "M&M": "AUTO", "TVSMOTOR": "AUTO", "HYUNDAI": "AUTO",
    "HEROMOTOCO": "AUTO", "TATAMOTORS": "AUTO", "MOTHERSON": "AUTO",
    "ESCORTS": "AUTO", "TMPV": "AUTO", "TMCV": "AUTO",
    # Oil, gas & energy
    "RELIANCE": "ENERGY", "ONGC": "ENERGY", "BPCL": "ENERGY",
    "IOC": "ENERGY", "GAIL": "ENERGY", "PETRONET": "ENERGY",
    "ADANIENT": "ENERGY", "ADANIPORTS": "ENERGY",
    "ADANIGREEN": "ENERGY", "ADANIENSOL": "ENERGY", "ADANIPOWER": "ENERGY",
    # Metals & mining
    "TATASTEEL": "METALS", "JSWSTEEL": "METALS", "HINDALCO": "METALS",
    "VEDL": "METALS", "COALINDIA": "METALS", "NMDC": "METALS",
    "JINDALSTEL": "METALS", "SAIL": "METALS", "HINDZINC": "METALS",
    "VAML": "METALS",
    # Consumer
    "HINDUNILVR": "FMCG", "ITC": "FMCG", "NESTLEIND": "FMCG",
    "BRITANNIA": "FMCG", "TATACONSUM": "FMCG", "GODREJCP": "FMCG",
    "DMART": "FMCG", "VBL": "FMCG", "UNITDSPR": "FMCG",
    "TRENT": "FMCG", "TITAN": "FMCG", "PAGEIND": "FMCG",
    "ASIANPAINT": "FMCG",
    # Infra, construction & power
    "LT": "INFRA", "NTPC": "INFRA", "POWERGRID": "INFRA",
    "TATAPOWER": "INFRA", "ULTRACEMCO": "INFRA", "GRASIM": "INFRA",
    "SHREECEM": "INFRA", "AMBUJACEM": "INFRA", "DLF": "INFRA",
    "OBEROIRLTY": "INFRA", "LODHA": "INFRA",
    # Telecom
    "BHARTIARTL": "TELECOM", "TATACOMM": "TELECOM",
    "INDUSTOWER": "TELECOM", "IDEA": "TELECOM",
    # Capital goods
    "ABB": "CAPGOODS", "SIEMENS": "CAPGOODS", "HAL": "CAPGOODS",
    "BEL": "CAPGOODS", "CUMMINSIND": "CAPGOODS", "CGPOWER": "CAPGOODS",
    "BOSCHLTD": "CAPGOODS", "MAZDOCK": "CAPGOODS", "POLYCAB": "CAPGOODS",
    "PIDILITIND": "CAPGOODS", "SOLARINDS": "CAPGOODS", "POWERINDIA": "CAPGOODS",
    # Deliberately unbucketed (no peer group in the index)
    "INDIGO": "OTHER", "ETERNAL": "OTHER", "ENRIN": "OTHER",
    "INDHOTEL": "OTHER", "JUBLFOOD": "OTHER", "MRF": "OTHER",
    "BAJAJHLDNG": "OTHER",
}

SECTOR_LABELS: dict[str, str] = {
    "BANKING": "Banking",
    "FINANCE": "Financials",
    "IT": "IT",
    "PHARMA": "Healthcare",
    "AUTO": "Auto",
    "ENERGY": "Energy",
    "METALS": "Metals & Mining",
    "FMCG": "Consumer",
    "INFRA": "Infra & Power",
    "TELECOM": "Telecom",
    "CAPGOODS": "Capital Goods",
    "OTHER": "Other",
}


def sector_of(symbol: str) -> str:
    return SECTOR_MAP.get(symbol.strip().upper(), "OTHER")


def sector_label(bucket: str) -> str:
    return SECTOR_LABELS.get(bucket, bucket.title())
