#!/usr/bin/env python3
"""Fetch a sourced brief. A sentence is kept only when it is copied from the page text."""

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data"
CN = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (compatible; FeifeiBrief/0.3)"
HOSTS = {
    "www.stats.gov.cn",
    "www.pbc.gov.cn",
    "www.federalreserve.gov",
    "yunhq.sse.com.cn",
    "www.szse.cn",
}
BOILER = (
    "网站地图",
    "京ICP",
    "最佳分辨率",
    "法律声明",
    "Skip to",
    "official website",
    "Here's how you know",
    ".gov website",
    "Share sensitive",
    "打印本页",
    "关闭窗口",
    "设为首页",
    "加入收藏",
    "网站标识码",
)


class Paragraphs(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.buf = []
        self.paras = []

    def finish(self):
        text = re.sub(r"[ \t\r\f\v]+", " ", "".join(self.buf))
        text = re.sub(r"\n+", "", text).strip()
        self.buf = []
        if text:
            self.paras.append(text)

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        if tag in ("p", "div", "h1", "h2", "li", "tr", "br"):
            self.finish()

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self.skip:
            self.skip -= 1
        if tag in ("p", "div", "h1", "h2", "li", "tr"):
            self.finish()

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)


def fail(reason):
    print("skip:", reason)
    return None


def allowed(url):
    parsed = urlparse(url)
    return (
        parsed.scheme == "https"
        and parsed.hostname in HOSTS
        and not parsed.username
        and len(parsed.path) > 1
    )


def curl(url, referer=None):
    if not allowed(url):
        raise RuntimeError(f"host not allowed: {url}")
    fd, path = tempfile.mkstemp(prefix="feifei-")
    os.close(fd)
    cmd = [
        "/usr/bin/curl",
        "-fsSL",
        "--max-time",
        "30",
        "--retry",
        "1",
        "-A",
        UA,
        "-o",
        path,
        "-w",
        "%{url_effective}\n%{http_code}\n%{content_type}",
    ]
    if referer:
        cmd.extend(["-e", referer])
    cmd.append(url)
    try:
        done = subprocess.run(cmd, check=False, capture_output=True)
        if done.returncode != 0:
            raise RuntimeError(done.stderr.decode("utf-8", "replace")[:300] or f"curl {done.returncode}")
        lines = done.stdout.decode("utf-8", "replace").splitlines()
        final = lines[0].strip() if lines else ""
        status = lines[1].strip() if len(lines) > 1 else ""
        ctype = lines[2].strip() if len(lines) > 2 else ""
        if status and not status.startswith("2"):
            raise RuntimeError(f"HTTP {status}")
        if not allowed(final):
            raise RuntimeError(f"redirect left the source host: {final}")
        raw = Path(path).read_bytes()
        if len(raw) > 2_500_000:
            raise RuntimeError("page too large")
        if "pdf" in ctype.lower() or raw.startswith(b"%PDF"):
            raise RuntimeError("pdf body was not read")
        return final, raw
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def decode(raw):
    for enc in ("utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise RuntimeError("undecodable page")


def page_text(html):
    parser = Paragraphs()
    parser.feed(html)
    parser.finish()
    return parser.paras


def meta_content(html, name):
    patterns = (
        rf'<meta[^>]+name=["\']{name}["\'][^>]+content=["\']([^"\']*)["\']',
        rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']{name}["\']',
    )
    for pattern in patterns:
        found = re.search(pattern, html, re.I)
        if found:
            return unescape(found.group(1)).strip()
    return ""


def first_sentence(paragraph):
    if "。" in paragraph:
        sentence = paragraph.split("。", 1)[0].strip() + "。"
    else:
        parts = re.split(r"\.\s+", paragraph, maxsplit=1)
        sentence = parts[0].strip()
        if not sentence.endswith("."):
            sentence += "."
    sentence = re.sub(r"\s+", " ", sentence).strip()
    if not (40 <= len(sentence) <= 500):
        return ""
    return sentence


def excerpt(paras, title_key):
    started = False
    candidates = []
    for para in paras:
        if not started:
            if title_key and title_key in para:
                started = True
            continue
        if any(word in para for word in BOILER):
            continue
        if "。" not in para and ". " not in para and not para.endswith("."):
            continue
        if len(para) < 40:
            continue
        candidates.append(para)
    if not candidates:
        return ""
    for key in ("决定", "decided"):
        for para in candidates:
            if key in para:
                return first_sentence(para)
    for para in candidates:
        if re.search(r"\d", para):
            return first_sentence(para)
    return ""


def story(url, html, title, publisher, published_at, tag, checked_at):
    if not allowed(url):
        return fail(f"url rejected {url}")
    paras = page_text(html)
    blob = "\n".join(paras)
    if title not in blob and title not in html:
        return fail(f"title not on page: {title}")
    key = title[:12]
    sentence = excerpt(paras, key)
    if not sentence or sentence not in blob:
        return fail(f"no verbatim sentence: {title}")
    if any(word in sentence for word in BOILER):
        return fail(f"boilerplate sentence: {title}")
    print("keep:", title)
    print("    ", sentence)
    print("    ", url)
    return {
        "tag": tag,
        "title": title,
        "text": sentence,
        "evidence": sentence,
        "publisher": publisher,
        "publishedAt": published_at,
        "url": url,
        "checkedAt": checked_at,
        "status": "已与原文核对",
    }


def nbs_story(checked_at):
    list_url = "https://www.stats.gov.cn/sj/zxfb/"
    try:
        _, raw = curl(list_url)
        html = decode(raw)
    except Exception as exc:
        return fail(f"nbs list: {exc}")
    seen = set()
    chosen = None
    for match in re.finditer(r'href="(\./20\d{4}/t20\d+_\d+\.html)"[^>]*>([^<]+)', html):
        href = match.group(1)
        if href in seen:
            continue
        seen.add(href)
        label = re.sub(r"\s+", "", unescape(match.group(2)))
        if not label or label.endswith("..."):
            continue
        chosen = (label, urljoin(list_url, href))
        break
    if not chosen:
        return fail("nbs list had no article")
    label, url = chosen
    try:
        final, raw = curl(url)
        page = decode(raw)
    except Exception as exc:
        return fail(f"nbs article: {exc}")
    title = meta_content(page, "ArticleTitle") or label
    published = meta_content(page, "PubDate")
    if not published or published not in page:
        return fail("nbs date missing")
    if label[:8] not in title and title[:8] not in label:
        return fail("nbs title mismatch")
    return story(
        final,
        page,
        title,
        "国家统计局",
        f"{published.replace('/', '-')}（页面标注，未改时区）",
        "国内数据",
        checked_at,
    )


def pbc_stories(checked_at):
    list_url = "https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html"
    try:
        _, raw = curl(list_url)
        html = decode(raw)
    except Exception as exc:
        return fail(f"pbc list: {exc}") or []
    seen = set()
    items = []
    for match in re.finditer(
        r'href="(/goutongjiaoliu/113456/113469/\d+/index\.html)"[^>]*>([^<]+)',
        html,
    ):
        href, label = match.group(1), re.sub(r"\s+", "", unescape(match.group(2)))
        label = label.rstrip(".…")
        if href in seen or len(label) < 8:
            continue
        seen.add(href)
        if any(word in label for word in ("会见", "传达学习", "党委")):
            continue
        score = 0
        if "统计报告" in label:
            score = 5
        elif "设立" in label:
            score = 5
        elif "运行情况" in label:
            score = 4
        elif "公告" in label:
            score = 2
        if score:
            items.append((score, label, urljoin("https://www.pbc.gov.cn", href)))
    items.sort(key=lambda item: -item[0])
    kept = []
    for _, label, url in items[:2]:
        try:
            final, raw = curl(url)
            page = decode(raw)
        except Exception as exc:
            fail(f"pbc article: {exc}")
            continue
        found = re.search(r"文章来源：.*?(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})", page, re.S)
        if not found:
            fail(f"pbc date missing: {label}")
            continue
        title_match = re.search(r"<title>(.*?)</title>", page, re.S)
        title = re.sub(r"\s+", "", unescape(title_match.group(1))) if title_match else ""
        title = re.sub(r"_?中国人民银行$", "", title)
        if label[:8] not in title:
            fail(f"pbc title mismatch: {label}")
            continue
        tag = "政策" if ("设立" in title or "公告" in title) else "国内数据"
        item = story(
            final,
            page,
            title,
            "中国人民银行",
            f"{found.group(1)}（页面标注）",
            tag,
            checked_at,
        )
        if item:
            kept.append(item)
    return kept


def fed_story(checked_at):
    feed = "https://www.federalreserve.gov/feeds/press_all.xml"
    try:
        _, raw = curl(feed)
        text = decode(raw)
    except Exception as exc:
        return fail(f"fed feed: {exc}")
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        return fail(f"fed feed xml: {exc}")
    monetary = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        cats = [c.text or "" for c in item.findall("category")]
        if "Monetary Policy" in cats and link.startswith("https://www.federalreserve.gov/newsevents/pressreleases/"):
            monetary.append((title, link, pub))
    chosen = next((row for row in monetary if "FOMC statement" in row[0]), None)
    if not chosen and monetary:
        chosen = monetary[0]
    if not chosen:
        return fail("fed feed had no monetary policy release")
    title, link, pub = chosen
    try:
        published = parsedate_to_datetime(pub).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return fail("fed date missing")
    stamp = f"{published.strftime('%B')} {published.day}, {published.year}"
    shown = published.strftime("%Y-%m-%d %H:%M UTC")
    try:
        final, raw = curl(link)
        page = decode(raw)
    except Exception as exc:
        return fail(f"fed article: {exc}")
    if title not in page and title not in "\n".join(page_text(page)):
        return fail("fed title not on page")
    if stamp not in page and stamp not in "\n".join(page_text(page)):
        return fail("fed page date does not match the feed")
    return story(
        final,
        page,
        title,
        "Board of Governors of the Federal Reserve System",
        shown,
        "国际",
        checked_at,
    )


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


def quote_record(name, code, last, prev, change, pct, as_of, url, source, today, extra=""):
    last_d, prev_d, change_d, pct_d = money(last, "last"), money(prev, "prev"), money(change, "change"), money(pct, "pct")
    if prev_d == 0 or abs((last_d - prev_d) - change_d) > Decimal("0.02"):
        raise RuntimeError(f"{name} change does not match last-prev")
    if abs((change_d / prev_d) * Decimal(100) - pct_d) > Decimal("0.02"):
        raise RuntimeError(f"{name} percent does not match")
    if not allowed(url):
        raise RuntimeError("quote url rejected")
    print("quote:", name, last, change, pct, as_of)
    return {
        "name": name,
        "code": code,
        "last": last,
        "prevClose": prev,
        "change": change,
        "changePercent": pct,
        "asOf": as_of,
        "session": session_label(as_of, today),
        "sourceName": source,
        "sourceUrl": url,
        "note": "现价减前收等于涨跌额；涨跌额除以前收，与接口涨跌幅相差不超过 0.02 个百分点。" + extra,
    }


def sse_quote(today):
    url = "https://yunhq.sse.com.cn:32042/v1/sh1/snap/000001"
    final, raw = curl(url)
    text = decode(raw)
    found = re.search(
        r'"snap"\s*:\s*\[\s*"([^"]+)"\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)',
        text,
    )
    dated = re.search(r'"date"\s*:\s*(20\d{6})', text)
    timed = re.search(r'"time"\s*:\s*(\d{1,6})', text)
    if not found or not dated or not timed:
        raise RuntimeError("sse payload shape")
    name, prev, _open, high, low, last, change, pct = found.groups()
    if name != "上证指数":
        raise RuntimeError(f"unexpected sse name {name}")
    hi, lo, last_d = money(high, "high"), money(low, "low"), money(last, "last")
    if hi < lo or last_d > hi + Decimal("0.05") or last_d < lo - Decimal("0.05"):
        raise RuntimeError("sse last outside high/low")
    clock = int(timed.group(1))
    hh, mm, ss = clock // 10000, (clock // 100) % 100, clock % 100
    if not (0 <= hh <= 23 and 0 <= mm <= 59 and 0 <= ss <= 59):
        raise RuntimeError("sse clock")
    day = dated.group(1)
    as_of = f"{day[:4]}-{day[4:6]}-{day[6:8]} {hh:02d}:{mm:02d}:{ss:02d}"
    return quote_record(name, "000001", last, prev, change, pct, as_of, final, "上海证券交易所行情接口", today)


def sz_quote(code, expected, today):
    url = f"https://www.szse.cn/api/market/ssjjhq/getTimeData?marketId=1&code={code}"
    final, raw = curl(url, referer="https://www.szse.cn/")
    text = decode(raw)

    def grab(key):
        quoted = re.search(rf'"{key}"\s*:\s*"([^"]*)"', text)
        if quoted:
            return quoted.group(1).strip()
        bare = re.search(rf'"{key}"\s*:\s*(-?\d+(?:\.\d+)?)', text)
        return bare.group(1) if bare else ""

    name, prev, last, change, pct, as_of = (
        grab("name"),
        grab("close"),
        grab("now"),
        grab("delta"),
        grab("deltaPercent"),
        grab("marketTime"),
    )
    if name != expected:
        raise RuntimeError(f"unexpected szse name {name}")
    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", as_of):
        raise RuntimeError("szse clock")
    return quote_record(name, code, last, prev, change, pct, as_of, final, "深圳证券交易所行情接口", today, " 深交所字段 close 是前收，now 是现价。")


def main():
    previous = OUT_DIR / "brief.json"
    if previous.exists() and json.loads(previous.read_text()).get("source") == "scheduled-tech-finance-report":
        print("当前内容来自定时任务。请使用 import-daily-brief.py 导入下一期，已有正文保留。")
        return 0
    now = datetime.now(CN).replace(microsecond=0)
    checked = now.isoformat()
    today = now.strftime("%Y-%m-%d")
    stories = []
    for item in (nbs_story(checked),):
        if item:
            stories.append(item)
    stories.extend(pbc_stories(checked))
    fed = fed_story(checked)
    if fed:
        stories.append(fed)
    quotes = []
    for loader in (
        lambda: sse_quote(today),
        lambda: sz_quote("399001", "深证成指", today),
        lambda: sz_quote("399006", "创业板指", today),
    ):
        try:
            quotes.append(loader())
        except Exception as exc:
            fail(f"quote: {exc}")
    if not stories:
        print("no verified stories; previous brief left untouched")
        return 1
    payload = {
        "date": today, "generatedAt": checked,
        "timezone": "Asia/Shanghai", "status": "published",
        "activeEdition": "daily",
        "editions": {"daily": {
            "status": "published", "title": "科技与财经简报",
            "context": "每日一期", "overview": "", "stories": stories,
        }},
        "quotes": quotes,
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    encoded = encoded.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    encoded = encoded.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "brief.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT_DIR / "brief.js").write_text("window.FEIFEI_BRIEF = " + encoded + ";\n", encoding="utf-8")
    print(f"wrote {len(stories)} stories and {len(quotes)} quotes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
