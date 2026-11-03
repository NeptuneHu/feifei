#!/usr/bin/env python3
"""Import the scheduled report verbatim; retain its date, wording and source links."""
import argparse
import json
import re
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from daily_report import prepare, CN

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--date', required=True, type=date.fromisoformat)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'data')
    args = parser.parse_args()
    raw = args.report.read_text(encoding='utf-8').strip()
    report = None
    count = None
    target = args.output_dir
    if args.report.suffix.lower() == '.json':
        try:
            report = json.loads(raw)
            if report.get('date') != args.date.isoformat():
                raise ValueError('简报日期与导入日期不一致')
            prior_ids = set()
            for path in (target / 'daily').glob('*.json'):
                if path.stem < args.date.isoformat() and path.stem >= (args.date - timedelta(days=7)).isoformat():
                    previous_report = json.loads(path.read_text())
                    for section in previous_report.get('sections', []):
                        prior_ids.update(item['eventId'] for item in section.get('items', []))
            markdown, count = prepare(report, args.date, prior_ids)
        except (ValueError, TypeError, KeyError) as exc:
            parser.error(str(exc))
    else:
        markdown = raw
    if not markdown or not re.search(r'https?://[^\s)<>]+', markdown):
        parser.error('正文需要包含原始来源链接；原文件和现有简报均未更改。')
    previous = target / 'brief.json'
    payload = json.loads(previous.read_text()) if previous.exists() else {}
    payload.update({
        'date': args.date.isoformat(),
        'generatedAt': datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds'),
        'timezone': 'Asia/Shanghai', 'status': 'published',
        'source': 'scheduled-tech-finance-report', 'activeEdition': 'daily',
        'editions': {'daily': {
            'title': '科技与财经简报', 'status': 'published', 'context': '每日一期',
            'overview': '', 'stories': [], 'markdown': markdown,
        }},
    })
    if report:
        payload['editions']['daily']['context'] = f"{report['windowStart'][:16].replace('T', ' ')}—{report['windowEnd'][:16].replace('T', ' ')} · 北京时间"
        payload['editions']['daily']['itemCount'] = count
    target.mkdir(parents=True, exist_ok=True)
    # One named issue per day. Reimporting corrects that issue rather than creating a second.
    archive = target / 'daily'
    archive.mkdir(exist_ok=True)
    (archive / f'{args.date}.md').write_text(markdown + '\n', encoding='utf-8')
    if report:
        (archive / f'{args.date}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    encoded = json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    for name, body in [('brief.json', serialized), ('brief.js', 'window.FEIFEI_BRIEF = ' + encoded + ';\n')]:
        temp = target / (name + '.tmp')
        temp.write_text(body, encoding='utf-8')
        temp.replace(target / name)
    print(f'已导入 {args.date} 科技与财经简报，保留正文和原始链接。')


if __name__ == '__main__':
    main()
