#!/usr/bin/env python3
"""Static site, exchange index proxy, and Tushare daily bars."""

import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
ALLOW = {
    ("sh1", "000001"): "https://yunhq.sse.com.cn:32042/v1/sh1/snap/000001",
    ("sz1", "399001"): "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399001",
    ("sz1", "399006"): "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399006",
    ("csi", "931071"): "https://yunhq.sse.com.cn:32042/v1/csi/snap/931071",
    ("sz1", "399363"): "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399363",
    ("sz1", "399997"): "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399997",
    ("csi", "931238"): "https://yunhq.sse.com.cn:32042/v1/csi/snap/931238",
    ("sz1", "980017"): "https://yunhq.sse.com.cn:32042/v1/sz1/snap/980017",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/kline":
            return self.do_kline(query)
        if parsed.path == "/api/daily":
            return self.do_daily(query)
        if parsed.path != "/api/snap":
            return super().do_GET()
        key = (query.get("channel", [""])[0], query.get("code", [""])[0])
        target = ALLOW.get(key)
        if not target:
            self.send_error(404)
            return
        done = subprocess.run(
            ["/usr/bin/curl", "-fsSL", "--max-time", "12", "-A", "Mozilla/5.0 (compatible; FeifeiBrief/0.3)", target],
            check=False,
            capture_output=True,
        )
        if done.returncode != 0 or not done.stdout.startswith(b"{"):
            self.send_error(502)
            return
        body = done.stdout
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_kline(self, query):
        token = tushare_token()
        if not token:
            return self.send_json(503, {"error": "token"})
        codes = []
        for part in query.get("codes", [""])[0].split(","):
            code = part.strip()
            if code in INDEX_TS and code not in codes:
                codes.append(code)
            if len(codes) == 8:
                break
        if not codes:
            return self.send_json(400, {"error": "code"})
        self.send_json(200, kline_body(token, codes))

    def do_daily(self, query):
        token = tushare_token()
        if not token:
            return self.send_json(503, {"error": "token"})
        codes = []
        for part in query.get("codes", [""])[0].split(","):
            mapped = ts_code(part.strip())
            if mapped and mapped not in codes:
                codes.append(mapped)
            if len(codes) == 6:
                break
        if not codes:
            return self.send_json(400, {"error": "code"})
        key = ",".join(codes)
        cached = DAILY_CACHE.get(key)
        if cached and time.time() - cached[0] < 600:
            return self.send_json(200, cached[1])
        payload = daily_payload(token, codes)
        done = subprocess.run(
            ["/usr/bin/curl", "-fsSL", "--max-time", "15", "-H", "Content-Type: application/json", "--data-binary", "@-", "https://api.tushare.pro"],
            input=payload.encode(),
            check=False,
            capture_output=True,
        )
        if done.returncode != 0 or not done.stdout.startswith(b"{"):
            return self.send_json(502, {"error": "upstream"})
        text = done.stdout.decode("utf-8", "replace")
        head = re.search(r'"code"\s*:\s*(-?\d+)', text)
        if not head or head.group(1) != "0":
            return self.send_json(502, {"error": "upstream"})
        body = {
            "sourceName": "Tushare",
            "sourceUrl": "https://tushare.pro/document/2?doc_id=27",
            "stocks": bars_for(text, set(codes)),
        }
        DAILY_CACHE[key] = (time.time(), body)
        self.send_json(200, body)

    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def tushare_token():
    env = os.environ.get("TUSHARE_TOKEN", "").strip()
    if env:
        return env
    path = ROOT / ".tushare-token"
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8").strip().splitlines()[0].strip()


def ts_code(raw):
    code = raw.upper().replace(" ", "")
    match = re.fullmatch(r"(\d{6})(?:\.(SH|SZ|BJ))?", code)
    if not match:
        return ""
    digits, suffix = match.group(1), match.group(2)
    if suffix:
        return f"{digits}.{suffix}"
    if digits.startswith("92") or digits[0] in "48":
        suffix = "BJ"
    elif digits[0] in "03":
        suffix = "SZ"
    elif digits[0] in "69":
        suffix = "SH"
    else:
        return ""
    return f"{digits}.{suffix}"


def daily_payload(token, codes):
    end = datetime.now(timezone(timedelta(hours=8)))
    start = end - timedelta(days=50)
    return json.dumps({
        "api_name": "daily",
        "token": token,
        "params": {
            "ts_code": ",".join(codes),
            "start_date": start.strftime("%Y%m%d"),
            "end_date": end.strftime("%Y%m%d"),
        },
        "fields": "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg",
    })


def item_blobs(text):
    match = re.search(r'"items"\s*:\s*\[', text)
    if not match:
        return []
    index = match.end()
    rows = []
    while index < len(text):
        while index < len(text) and text[index] in " \n\r\t,":
            index += 1
        if index >= len(text) or text[index] != "[":
            break
        start = index
        depth = 0
        quoted = False
        escaped = False
        while index < len(text):
            char = text[index]
            if quoted:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    quoted = False
            elif char == '"':
                quoted = True
            elif char == "[":
                depth += 1
            elif char == "]":
                depth -= 1
                if depth == 0:
                    index += 1
                    rows.append(text[start:index])
                    break
            index += 1
        else:
            break
    return rows


def row_tokens(row):
    body = row[1:-1]
    tokens = []
    index = 0
    while index < len(body):
        if body[index] in " \n\r\t,":
            index += 1
            continue
        if body[index] == '"':
            chars = []
            index += 1
            while index < len(body):
                if body[index] == "\\":
                    if index + 1 < len(body):
                        chars.append(body[index + 1])
                    index += 2
                    continue
                if body[index] == '"':
                    index += 1
                    break
                chars.append(body[index])
                index += 1
            tokens.append("".join(chars))
            continue
        end = index
        while end < len(body) and body[end] not in ", \n\r\t":
            end += 1
        tokens.append(body[index:end])
        index = end
    return tokens


def near(left, right, limit="0.05"):
    try:
        return abs(Decimal(left) - Decimal(right)) <= Decimal(limit)
    except InvalidOperation:
        return False


def valid_bar(fields):
    needed = ("ts_code", "trade_date", "open", "high", "low", "close", "pre_close", "change", "pct_chg")
    if any(fields.get(key) in (None, "", "null") for key in needed):
        return None
    if not re.fullmatch(r"20\d{6}", fields["trade_date"]):
        return None
    try:
        close, prev, change, pct = fields["close"], fields["pre_close"], fields["change"], fields["pct_chg"]
        high, low = fields["high"], fields["low"]
        if Decimal(high) + Decimal("0.05") < Decimal(low):
            return None
        if Decimal(close) > Decimal(high) + Decimal("0.05") or Decimal(close) < Decimal(low) - Decimal("0.05"):
            return None
        if Decimal(prev) == 0 or not near(str(Decimal(close) - Decimal(prev)), change):
            return None
        if not near(str((Decimal(change) / Decimal(prev)) * Decimal(100)), pct):
            return None
    except InvalidOperation:
        return None
    day = fields["trade_date"]
    return {
        "tradeDate": f"{day[0:4]}-{day[4:6]}-{day[6:8]}",
        "open": fields["open"],
        "high": high,
        "low": low,
        "close": close,
        "preClose": prev,
        "change": change,
        "pct": pct,
    }


def bars_for(text, wanted, limit=24):
    grouped = {code: [] for code in wanted}
    names = ["ts_code", "trade_date", "open", "high", "low", "close", "pre_close", "change", "pct_chg"]
    for blob in item_blobs(text):
        tokens = row_tokens(blob)
        if len(tokens) < len(names):
            continue
        fields = dict(zip(names, tokens[:len(names)]))
        if fields["ts_code"] not in wanted:
            continue
        bar = valid_bar(fields)
        if bar:
            grouped[fields["ts_code"]].append(bar)
    stocks = []
    for code in wanted:
        rows = sorted(grouped[code], key=lambda item: item["tradeDate"])[-limit:]
        stocks.append({"code": code, "bars": rows})
    return stocks


DAILY_CACHE = {}
INDEX_TS = {
    "000001": "000001.SH",
    "399001": "399001.SZ",
    "399006": "399006.SZ",
    "399363": "399363.SZ",
    "399997": "399997.SZ",
    "931071": "931071.CSI",
    "931238": "931238.CSI",
    "980017": "980017.SZ",
}
KLINE_PATH = ROOT / ".kline-cache.json"
KLINE = {}
LAST_KLINE = 0
NEXT_KLINE = 0


def load_kline_disk():
    global KLINE
    if not KLINE_PATH.is_file():
        return
    try:
        saved = json.loads(KLINE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if isinstance(saved, dict):
        KLINE = saved


def save_kline_disk():
    KLINE_PATH.write_text(json.dumps(KLINE, ensure_ascii=False), encoding="utf-8")


def index_payload(token, ts_code):
    end = datetime.now(timezone(timedelta(hours=8)))
    start = end - timedelta(days=160)
    return json.dumps({
        "api_name": "index_daily",
        "token": token,
        "params": {"ts_code": ts_code, "start_date": start.strftime("%Y%m%d"), "end_date": end.strftime("%Y%m%d")},
        "fields": "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg",
    })


def fetch_index(token, ts_code):
    done = subprocess.run(
        ["/usr/bin/curl", "-fsSL", "--max-time", "15", "-H", "Content-Type: application/json", "--data-binary", "@-", "https://api.tushare.pro"],
        input=index_payload(token, ts_code).encode(),
        check=False,
        capture_output=True,
    )
    if done.returncode != 0 or not done.stdout.startswith(b"{"):
        return None
    return done.stdout.decode("utf-8", "replace")


def kline_body(token, codes):
    global LAST_KLINE, NEXT_KLINE
    if not KLINE:
        load_kline_disk()
    now = time.time()

    def fresh(ts_code):
        entry = KLINE.get(ts_code) or {}
        bars = entry.get("bars") or []
        return bool(bars) and now - float(entry.get("at") or 0) < 6 * 3600

    missing = [code for code in codes if not fresh(INDEX_TS[code])]
    pending = False
    if missing:
        if now < NEXT_KLINE:
            pending = True
        else:
            code = missing[0]
            ts_code = INDEX_TS[code]
            LAST_KLINE = now
            text = fetch_index(token, ts_code)
            head = re.search(r'"code"\s*:\s*(-?\d+)', text or "")
            msg = re.search(r'"msg"\s*:\s*"([^"]*)"', text or "")
            if not text or not head or head.group(1) != "0":
                wait = 3660 if msg and "小时" in msg.group(1) else 65
                NEXT_KLINE = now + wait
                pending = True
            else:
                rows = bars_for(text, {ts_code}, 80)
                KLINE[ts_code] = {"at": now, "bars": rows[0]["bars"] if rows else []}
                save_kline_disk()
                NEXT_KLINE = now + 65
                pending = len(missing) > 1
    stocks = []
    for code in codes:
        entry = KLINE.get(INDEX_TS[code]) or {}
        stocks.append({"code": code, "bars": entry.get("bars") or []})
    return {
        "sourceName": "Tushare",
        "sourceUrl": "https://tushare.pro/document/2?doc_id=95",
        "stocks": stocks,
        "pending": pending,
        "retryAfter": max(1, int(NEXT_KLINE - now)) if pending else 0,
    }


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
