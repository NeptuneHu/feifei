"""Publication checks for the daily report. Evidence is verified by its author;
these checks enforce dates, provenance fields and deduplication, not factual truth."""
from datetime import datetime, time, timedelta, timezone
from urllib.parse import urlparse

CN = timezone(timedelta(hours=8))
DOMAINS = ('人工智能与科技', '商业与财经', '国际政治局势')
CERTAINTY = {'confirmed': '已确认', 'statement': '单方声明', 'anonymous': '匿名消息', 'analysis': '分析预测'}


def required(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'缺少 {name}')
    return value.strip()


def url(value):
    parsed = urlparse(required(value, '来源链接'))
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('来源需要完整 HTTPS 原文链接')
    return value


def moment(value):
    parsed = datetime.fromisoformat(required(value, '时间').replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('时间需要包含时区')
    return parsed


def prepare(report, day, previous_ids=()):
    end = datetime.combine(day, time(14), CN)
    start = end - timedelta(days=1)
    if moment(report.get('windowStart')) != start or moment(report.get('windowEnd')) != end:
        raise ValueError('新闻窗口应为北京时间前日14:00至当日14:00')
    sections = report.get('sections', [])
    if [section.get('name') for section in sections] != list(DOMAINS):
        raise ValueError('需要按顺序包含科技、财经、国际政治三个领域')
    stories = [item for section in sections for item in section.get('items', [])]
    total = len(stories)
    if total > 25:
        raise ValueError('精选消息最多25条')
    shortfall = report.get('shortfall', '').strip()
    if total < 20:
        required(shortfall, '可靠新消息不足20条的具体说明')
    if total == 0:
        raise ValueError('没有可发布的已核实消息，保留上一期')
    seen = set()
    scopes = set()
    lines = [f'# 科技与财经简报 · {day}', '',
             f'北京时间 {start:%m-%d %H:%M}—{end:%m-%d %H:%M} · {total}条', '']
    if shortfall:
        lines.extend([f'本期说明：{shortfall}', ''])
    for section in sections:
        lines.extend([f'## {section["name"]}', ''])
        if not section.get('items'):
            lines.extend([required(section.get('emptyReason'), '该领域缺少可靠新消息的说明'), ''])
        for item in section.get('items', []):
            event = required(item.get('eventId'), '稳定事件标识')
            if event in seen:
                raise ValueError('同一事件应合并，不能重复拆条')
            seen.add(event)
            published = moment(item.get('publishedAt'))
            happened = moment(item.get('eventAt'))
            if not start < published <= end or happened > end:
                raise ValueError('报道超出24小时窗口，或事件发生在截止时间之后')
            update = item.get('materialUpdate', '').strip()
            if (event in previous_ids or happened <= start) and not update:
                raise ValueError('重复事件或旧事件需要实质进展说明')
            if item.get('scope') not in ('domestic', 'international'):
                raise ValueError('每条需要标明国内或国际')
            scopes.add(item['scope'])
            certainty = CERTAINTY.get(item.get('certainty'))
            if not certainty:
                raise ValueError('需要区分已确认、单方声明、匿名消息或分析预测')
            sources = item.get('sources', [])
            if not sources:
                raise ValueError('每条消息都需要具体原文')
            lines.extend([f'### {required(item.get("title"), "标题")}', '',
                          f'[{certainty}] {required(item.get("summary"), "事实摘要")}', '',
                          f'关注点：{required(item.get("whyItMatters"), "关注点")}', '',
                          f'事件时间：{happened.isoformat()}；报道时间：{published.isoformat()}。', ''])
            if update:
                lines.extend([f'最新进展：{update}', ''])
            image = item.get('image')
            if image:
                if image.get('verified') is not True:
                    raise ValueError('配图尚未核对')
                caption = required(image.get('caption'), '图片说明')
                credit = required(image.get('credit'), '图片出处')
                captured = required(image.get('capturedAt'), '拍摄时间或资料图日期说明')
                archival = '资料图 · ' if image.get('archival') else ''
                lines.extend([f'![{caption}]({url(image.get("url"))})',
                              f'{archival}{caption} · {captured} · 摄影/供图：{credit} · [图片出处]({url(image.get("sourceUrl"))})', ''])
            else:
                lines.extend([f'配图：{required(item.get("imageMissingReason"), "缺图说明")}', ''])
            for source in sources:
                if source.get('verified') is not True or source.get('tier') not in ('primary', 'reliable_media'):
                    raise ValueError('原文需由整理者核对，并标明官方原文或可靠媒体')
                lines.extend([f'来源：[{required(source.get("publisher"), "发布机构")}]({url(source.get("url"))})', ''])
        lines.extend(['#### 领域观察', '', required(section.get('analysis'), '领域总结与分析'), ''])
    if scopes != {'domestic', 'international'}:
        required(report.get('coverageLimit'), '国内外覆盖不足说明')
        lines.extend(['覆盖说明：' + report['coverageLimit'], ''])
    limitations = report.get('limitations', '').strip()
    if limitations:
        lines.extend(['核实限制：' + limitations, ''])
    return '\n'.join(lines).strip(), total
