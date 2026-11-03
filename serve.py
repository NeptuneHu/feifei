#!/usr/bin/env python3
"""肥肥财经桌宠后端：东方财富财经快讯。

只提供一个接口：

    GET /api/brief

返回快讯前 7 条。交易日成功拉取过之后，当天不再请求；
周六、周日和节假日直接读本地缓存，避免重复打东方财富。

安装（清华镜像）：

    python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple flask flask-cors akshare

启动：

    python3 serve.py

本机当前没有 python 命令，所以用 python3。页面如果开在别的端口，
已打开 CORS，前端可以直接 fetch 这个接口。
"""

import json
import socket
import threading
import traceback
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import akshare as ak
from flask import Flask, jsonify
from flask_cors import CORS

# 东方财富接口偶发卡住时，不要让桌宠一直等。
socket.setdefaulttimeout(20)

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "data" / "cache"
BRIEF_PATH = CACHE_DIR / "brief.json"
CALENDAR_PATH = CACHE_DIR / "trade_dates.json"
TZ = ZoneInfo("Asia/Shanghai")
LIMIT = 7
# macOS 的隔空播放经常占用 5000，所以不用 Flask 默认端口。
HOST = "127.0.0.1"
PORT = 5050
SOURCE_PAGE = "https://kuaixun.eastmoney.com/7_24.html"

app = Flask(__name__)
app.json.ensure_ascii = False
CORS(app)

# 同一时刻只允许一个请求去判断缓存和拉数据，避免连点打出两次上游请求。
LOCK = threading.Lock()


def now_shanghai():
    return datetime.now(TZ)


def text_of(value):
    """把表格里的空值收成空字符串。pandas 的空单元格字符串化后会变成 nan。"""
    if value is None:
        return ""
    try:
        import pandas as pd

        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    if text.lower() == "nan":
        return ""
    return text


def read_json(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def is_weekend(day):
    return day.weekday() >= 5


def date_text(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    return str(value)[:10]


def load_trade_dates(today):
    """返回 (交易日集合, 提示)。

    日历本身也缓存。同一天只向上游要一次；已经覆盖今天及以后、
    并且 7 天内更新过的日历直接复用。周末不会进到这里。
    """
    cached = read_json(CALENDAR_PATH) or {}
    dates = set(cached.get("dates") or [])
    fetched_on = cached.get("fetched_on")
    if fetched_on == today.isoformat():
        return dates, cached.get("notice") or ""

    newest = max(dates) if dates else ""
    age = None
    if fetched_on:
        try:
            age = (today - date.fromisoformat(fetched_on)).days
        except ValueError:
            age = None
    if dates and newest >= today.isoformat() and age is not None and 0 <= age <= 7:
        return dates, ""

    print("拉取交易日历…", flush=True)
    notice = ""
    try:
        frame = ak.tool_trade_date_hist_sina()
        dates = {date_text(value) for value in frame["trade_date"].tolist()}
        dates.discard("")
        newest = max(dates) if dates else ""
        if newest < today.isoformat():
            notice = f"交易日历最新只到 {newest}，还没覆盖今天。工作日先按交易日处理，快讯当天只拉一次。"
    except Exception as exc:
        notice = f"交易日历拉取失败，工作日先按交易日处理：{exc}"
        print(notice, flush=True)

    # 失败也记下今天，避免一次失败后每个请求都去打新浪。
    write_json(
        CALENDAR_PATH,
        {
            "version": 1,
            "fetched_on": today.isoformat(),
            "notice": notice,
            "dates": sorted(dates),
        },
    )
    return dates, notice


def is_trading_day(today, dates):
    """日历覆盖到今天或更晚时，不在名单里就是节假日。

    日历缺失或落后于今天时，工作日先当成交易日，避免节假日误判把快讯卡住。
    真正的请求次数仍由当天快讯缓存卡住，一天最多一次。
    """
    key = today.isoformat()
    if not dates:
        return True
    if key in dates:
        return True
    newest = max(dates)
    if newest >= key:
        return False
    return True


def fetch_news():
    """东方财富全球财经快讯。akshare 这一次会取回一页，这里只留前 7 条。"""
    print("拉取东方财富财经快讯…", flush=True)
    frame = ak.stock_info_global_em()
    items = []
    for record in frame.to_dict(orient="records"):
        title = text_of(record.get("标题"))
        summary = text_of(record.get("摘要"))
        published_at = text_of(record.get("发布时间"))
        url = text_of(record.get("链接"))
        if not title and not summary:
            continue
        items.append(
            {
                "title": title,
                "summary": summary,
                "published_at": published_at,
                "url": url,
            }
        )
        if len(items) >= LIMIT:
            break
    return items


def response_of(today, cached, trading_day, reason, from_cache, notice=""):
    items = list((cached or {}).get("items") or [])[:LIMIT]
    message = ""
    if not items and reason == "weekend":
        message = "今天是周末，本地还没有快讯缓存。"
    elif not items and reason == "holiday":
        message = "今天不是交易日，本地还没有快讯缓存。"
    elif not items and reason == "empty":
        message = "东方财富这次没有返回可用快讯。"
    body = {
        "ok": bool(items),
        "title": "财经快讯",
        "source": "东方财富",
        "source_page": SOURCE_PAGE,
        "date": today.isoformat(),
        "fetched_on": (cached or {}).get("fetched_on") or "",
        "as_of": (cached or {}).get("fetched_at") or "",
        "trading_day": trading_day,
        "from_cache": from_cache,
        "reason": reason,
        "count": len(items),
        "items": items,
    }
    if message:
        body["message"] = message
    if notice:
        body["notice"] = notice
    status = 200 if items or reason in ("weekend", "holiday") else 503
    return body, status


def build_brief():
    today = now_shanghai().date()
    cached = read_json(BRIEF_PATH)

    if is_weekend(today):
        return response_of(today, cached, False, "weekend", bool(cached and cached.get("items")))

    dates, notice = load_trade_dates(today)
    trading = is_trading_day(today, dates)
    if not trading:
        return response_of(
            today,
            cached,
            False,
            "holiday",
            bool(cached and cached.get("items")),
            notice,
        )

    if cached and cached.get("fetched_on") == today.isoformat() and cached.get("items"):
        return response_of(today, cached, True, "cache_today", True, notice)

    try:
        items = fetch_news()
    except Exception as exc:
        print(f"快讯拉取失败：{exc}", flush=True)
        traceback.print_exc()
        if cached and cached.get("items"):
            return response_of(
                today,
                cached,
                True,
                "upstream_failed",
                True,
                f"本次拉取失败，返回上一次缓存：{exc}",
            )
        return {
            "ok": False,
            "title": "财经快讯",
            "source": "东方财富",
            "source_page": SOURCE_PAGE,
            "date": today.isoformat(),
            "trading_day": True,
            "from_cache": False,
            "reason": "upstream_failed",
            "count": 0,
            "items": [],
            "message": f"快讯拉取失败：{exc}",
        }, 503

    if not items:
        if cached and cached.get("items"):
            return response_of(today, cached, True, "upstream_failed", True, "本次没有解析出快讯，返回上一次缓存。")
        return response_of(today, None, True, "empty", False, notice)

    saved = {
        "version": 1,
        "fetched_on": today.isoformat(),
        "fetched_at": now_shanghai().isoformat(timespec="seconds"),
        "items": items,
    }
    write_json(BRIEF_PATH, saved)
    return response_of(today, saved, True, "fetched", False, notice)


@app.get("/api/brief")
def api_brief():
    with LOCK:
        body, status = build_brief()
    return jsonify(body), status


if __name__ == "__main__":
    print(f"肥肥财经快讯服务：http://{HOST}:{PORT}/api/brief", flush=True)
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
