# 每日科技与财经简报

每天北京时间14:00一期，窗口为前日14:00（不含）至当日14:00（含）。

## 整理流程

1. 查询前七期 `data/daily/*.json`，按稳定的事件标识去重。旧事件只有发生实质进展才重新收录，并填写进展。
2. 覆盖国内外，按人工智能与科技、商业与财经、国际政治局势整理合计20—25条。每领域附总结与分析。
3. 优先读取政府、企业公告、研究原文，以可靠媒体补充。逐条核对事件与报道日期、金额单位、同比环比；区分确认事实、单方声明、匿名消息与分析预测。来源不可访问时省略该条并写清限制。
4. 每条检索真实照片；检查图片出处、拍摄日期与事件对应关系。资料图明确标注。可靠图片缺失时填写原因，禁止生成图片代替新闻照片。
5. 每条包括标题、事实摘要、为什么值得关注、配图或缺图说明、具体原文链接。
6. 不足20条时填写具体原因；禁止旧闻、拆条补数。三领域不平衡、国内外覆盖不足、核实受阻时说明缺失。
7. 将结果保存为下述JSON并导入。原文事实核对由整理任务负责，脚本仅验证数据结构、时间、来源字段与去重，不替代事实核实。

## 导入格式

保存为 `data/incoming/YYYY-MM-DD.json`，不要用模板冒充当天新闻。

顶层字段：`date`、`windowStart`、`windowEnd`（带+08:00时区）、`sections`（依次为三个领域）、`shortfall`（不足20条必填）、`limitations`、`coverageLimit`（国内外覆盖不足必填）。

每个领域：`name`、`items`、`analysis`；缺条领域还需 `emptyReason`。

每条 `items` 字段：

- `eventId`：跨日保持一致的事件标识；`materialUpdate`：旧闻或重复事件的新进展。
- `title`、`summary`、`whyItMatters`。
- `scope`：domestic / international。
- `eventAt`、`publishedAt`：带时区的ISO时间，分别记录事件与报道日期。
- `certainty`：confirmed / statement / anonymous / analysis。
- `sources`：数组，每项有 `publisher`、`url`、`tier`（primary / reliable_media）、`verified`（核对后为true）。
- `image`：可靠图片可填对象，包含 `url`、`sourceUrl`、`caption`、`credit`、`capturedAt`、`archival`、`verified`；缺图则为null，并填 `imageMissingReason`。

导入：

```sh
python3 scripts/import-daily-brief.py data/incoming/YYYY-MM-DD.json --date YYYY-MM-DD
```

检查失败保留上一期。相同日期重复导入修正同一期，归档保留当天原文与JSON。旧的 `fetch-brief.py` 在导入任务正文后停止覆盖。

## 当前连接状态

- 网页与桌宠：每天一期；用户可选择一次提醒的时间，默认14:00。
- 日线：已移除，首页保留当前指数和每日简报。
- 网页发布：本地预览，未重新部署。
- 原ChatGPT定时任务：正文读取遇到验证页；未修改或复制该任务，尚未实现任务结果自动写入本项目。
- 待连通后：定时任务应在完成核实后执行导入；检索受阻时只报告缺失，不发布未经核实的内容。
