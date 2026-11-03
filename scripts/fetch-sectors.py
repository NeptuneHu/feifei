#!/usr/bin/env python3
"""Sector index snapshots from SSE and SZSE. A row is kept only when the exchange name matches."""

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data"
CN = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (compatible; FeifeiBrief/0.3)"
HOSTS = {"yunhq.sse.com.cn", "www.szse.cn"}
# Labels are the sectors a reader can follow. expect is the name the exchange payload must carry.
CATALOG = [
    {"id": "ai", "label": "人工智能", "channel": "csi", "code": "931071", "expect": "人工智能"},
    {"id": "compute", "label": "算力", "channel": "sz1", "code": "399363", "expect": "国证算力"},
    {"id": "liquor", "label": "白酒", "channel": "sz1", "code": "399997", "expect": "中证白酒"},
    {"id": "gold", "label": "黄金", "channel": "csi", "code": "931238", "expect": "SSH黄金股票"},
    {"id": "chip", "label": "芯片", "channel": "sz1", "code": "980017", "expect": "国证芯片"},
]


def allowed(url):
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in HOSTS and not parsed.username and len(parsed.path) > 1


def curl(url, referer=None):
    if not allowed(url):
        raise RuntimeError(f"host not allowed: {url}")
    fd, path = tempfile.mkstemp(prefix="feifei-sector-")
    os.close(fd)
    cmd = ["/usr/bin/curl", "-fsSL", "--max-time", "30", "--retry", "1", "-A", UA, "-o", path, "-w", "%{url_effective}"]
    if referer:
        cmd.extend(["-e", referer])
    cmd.append(url)
    try:
        done = subprocess.run(cmd, check=False, capture_output=True)
        if done.returncode != 0:
            raise RuntimeError(done.stderr.decode("utf-8", "replace")[:300] or f"curl {done.returncode}")
        final = done.stdout.decode("utf-8", "replace").strip().splitlines()[-1]
        raw = Path(path).read_bytes()
    finally:
        Path(path).unlink(missing_ok=True)
    if not allowed(final):
        raise RuntimeError(f"redirect rejected: {final}")
    return final, raw.decode("utf-8")


def money(raw, label):
    try:
        return Decimal(raw)
    except InvalidOperation:
        raise RuntimeError(f"bad number for {label}")


def session_label(clock, today):
    if clock[:10] != today:
        return "历史快照"
    hour = int(clock[11:13])
    return "交易时段快照" if hour < 15 else "15:00 后快照"


def quote_record(spec, name, last, prev, change, pct, as_of, url, source, today, high=None, low=None):
    if name != spec["expect"]:
        raise RuntimeError(f"{spec['id']} name {name}")
    last_d, prev_d, change_d, pct_d = money(last, "last"), money(prev, "prev"), money(change, "change"), money(pct, "pct")
    if prev_d == 0 or abs((last_d - prev_d) - change_d) > Decimal("0.02"):
        raise RuntimeError(f"{name} change does not match last-prev")
    if abs((change_d / prev_d) * Decimal(100) - pct_d) > Decimal("0.02"):
        raise RuntimeError(f"{name} percent does not match")
    if high is not None and low is not None:
        hi, lo = money(high, "high"), money(low, "low")
        if hi < lo or last_d > hi + Decimal("0.05") or last_d < lo - Decimal("0.05"):
            raise RuntimeError(f"{name} last outside high/low")
    print("sector:", spec["label"], name, last, change, pct, as_of)
    return {
        "id": spec["id"],
        "label": spec["label"],
        "name": name,
        "code": spec["code"],
        "last": last,
        "prevClose": prev,
        "change": change,
        "changePercent": pct,
        "asOf": as_of,
        "session": session_label(as_of, today),
        "sourceName": source,
        "sourceUrl": url,
        "note": "现价减前收等于涨跌额；涨跌额除以前收，与接口涨跌幅相差不超过 0.02 个百分点。",
    }


def snap_quote(spec, today):
    url = f"https://yunhq.sse.com.cn:32042/v1/{spec['channel']}/snap/{spec['code']}"
    final, text = curl(url)
    found = re.search(
        r'"snap"\s*:\s*\[\s*"([^"]+)"\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)',
        text,
    )
    dated = re.search(r'"date"\s*:\s*(20\d{6})', text)
    timed = re.search(r'"time"\s*:\s*(\d{1,6})', text)
    if not found or not dated or not timed:
        raise RuntimeError("snap payload shape")
    name, prev, _open, high, low, last, change, pct = found.groups()
    clock = int(timed.group(1))
    hh, mm, ss = clock // 10000, (clock // 100) % 100, clock % 100
    if not (0 <= hh <= 23 and 0 <= mm <= 59 and 0 <= ss <= 59):
        raise RuntimeError("snap clock")
    day = dated.group(1)
    as_of = f"{day[:4]}-{day[4:6]}-{day[6:8]} {hh:02d}:{mm:02d}:{ss:02d}"
    return quote_record(spec, name, last, prev, change, pct, as_of, final, "上海证券交易所行情接口", today, high, low)


def main():
    now = datetime.now(CN).replace(microsecond=0)
    today = now.strftime("%Y-%m-%d")
    rows = []
    for spec in CATALOG:
        last_error = None
        for attempt in range(3):
            try:
                rows.append(snap_quote(spec, today))
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                print("retry:", spec["id"], attempt + 1, exc)
        if last_error:
            print("skip:", spec["id"], last_error)
    if len(rows) != len(CATALOG):
        print("incomplete sector set; previous file left untouched")
        return 1
    payload = {"generatedAt": now.isoformat(), "timezone": "Asia/Shanghai", "sectors": rows}
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    for src, dst in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026")):
        encoded = encoded.replace(src, dst)
    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "sectors.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT_DIR / "sectors.js").write_text("window.FEIFEI_SECTORS = " + encoded + ";\n", encoding="utf-8")
    print(f"wrote {len(rows)} sectors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
