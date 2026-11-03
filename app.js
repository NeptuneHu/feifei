/* Local brief. Remote sentences are inserted with textContent, never innerHTML. */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const native = !!window.webkit?.messageHandlers?.pet;
const petMode = new URLSearchParams(location.search).has('pet');
const bridge = (type, value = {}) => window.webkit?.messageHandlers?.pet?.postMessage({type, ...value});
let saved = {};
try { saved = JSON.parse(localStorage.getItem('feifei-preferences') || '{}') || {}; } catch {}
let prefs = {
  notify: typeof saved.notify === 'boolean' ? saved.notify : true,
  quiet: typeof saved.quiet === 'boolean' ? saved.quiet : false,
  float: typeof saved.float === 'boolean' ? saved.float : true,
  size: Math.max(75, Math.min(125, Number(saved.size) || 100)),
  position: saved.position && Number.isFinite(saved.position.x) && Number.isFinite(saved.position.y) ? saved.position : null,
  seen: typeof saved.seen === 'string' ? saved.seen : '',
  nudged: typeof saved.nudged === 'string' ? saved.nudged : '',
  dailyAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(saved.dailyAt) ? saved.dailyAt : '14:00',
  sectors: Array.isArray(saved.sectors) ? saved.sectors.filter((id) => typeof id === 'string') : [],
  stocks: Array.isArray(saved.stocks) ? saved.stocks.filter((code) => /^\d{6}$/.test(code)).slice(0, 6) : []
};
let mood = 'good', period = 'daily', activeView = 'today', isDesktop = false, toastTimer;
let focusIndex = '上证指数';
const moods = {
  good: {alt: '肥肥，市场偏暖', speech: '偏暖'},
  bad: {alt: '肥肥，市场偏冷', speech: '偏冷'},
  uncertain: {alt: '肥肥，涨跌互现', speech: '冷暖相间'}
};
const INDEX_FEED = [
  {name: '上证指数', channel: 'sh1', code: '000001'},
  {name: '深证成指', channel: 'sz1', code: '399001'},
  {name: '创业板指', channel: 'sz1', code: '399006'}
];
const liveByName = new Map();
const HOSTS = new Set(['www.stats.gov.cn', 'www.pbc.gov.cn', 'www.federalreserve.gov', 'yunhq.sse.com.cn', 'www.szse.cn']);
const QUOTE_NAMES = ['上证指数', '深证成指', '创业板指'];
const EASTMONEY_FLASH = 'https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=20&req_trace=1710315450384';
const FLASH_KEY = 'feifei-flash';
let brief = null;
let flashBrief = null;
let flashTimer = 0;
let tradeDates = null;
let sectors = [];

function allowedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && HOSTS.has(parsed.hostname) && parsed.pathname.length > 1 && !parsed.username;
  } catch {
    return false;
  }
}
function finite(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
function validStory(story) {
  if (!story) return false;
  const keys = ['title', 'text', 'evidence', 'publisher', 'publishedAt', 'url', 'checkedAt', 'status', 'tag'];
  if (!keys.every((key) => typeof story[key] === 'string' && story[key].trim())) return false;
  return story.text.length >= 40 && story.text.length <= 500 && story.text === story.evidence && story.status === '已与原文核对' && allowedUrl(story.url);
}
function validQuote(quote) {
  if (!quote) return false;
  const last = finite(quote.last), prev = finite(quote.prevClose), change = finite(quote.change), pct = finite(quote.changePercent);
  if (last == null || prev == null || change == null || pct == null || prev === 0) return false;
  if (Math.abs((last - prev) - change) > 0.05) return false;
  if (Math.abs((change / prev) * 100 - pct) > 0.05) return false;
  if (typeof quote.session !== 'string' || !quote.session.includes('快照')) return false;
  if (typeof quote.name !== 'string' || typeof quote.asOf !== 'string' || typeof quote.sourceName !== 'string') return false;
  return allowedUrl(quote.sourceUrl);
}
function acceptBrief(data) {
  if (!data || data.status !== 'published' || !data.editions) return null;
  const clean = (edition) => {
    if (!edition || (edition.status !== 'published' && edition.status !== 'not_published')) return null;
    const stories = Array.isArray(edition.stories) ? edition.stories.filter(validStory) : [];
    const markdown = typeof edition.markdown === 'string' ? edition.markdown.trim() : '';
    if (edition.status === 'published' && !stories.length && !markdown) return null;
    if (edition.status === 'not_published' && (stories.length || markdown)) return null;
    return {status: edition.status, title: String(edition.title || ''), context: String(edition.context || ''), overview: String(edition.overview || ''), stories, markdown};
  };
  const previous = data.editions.daily || data.editions[data.activeEdition] || data.editions.noon;
  const daily = clean(previous);
  if (!daily) return null;
  daily.title = '科技与财经简报';
  daily.context = data.editions.daily?.context || '每日一期';
  return {
    generatedAt: String(data.generatedAt || ''),
    date: String(data.date || data.generatedAt || '').slice(0, 10),
    activeEdition: 'daily',
    editions: {daily},
    quotes: Array.isArray(data.quotes) ? data.quotes.filter(validQuote) : []
  };
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function edition() {
  return brief ? brief.editions[period] : null;
}
function shownTime(value) {
  return String(value || '').replace(/（[^）]*）/g, '').trim();
}
function briefClock(iso) {
  const match = String(iso || '').match(/(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return match ? `${match[1]}.${match[2]} ${match[3]}:${match[4]}` : '';
}

function dayKey(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function clockMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function dueId(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const time = clockMinutes(prefs.dailyAt);
  if (time == null || minutes < time) return '';
  if (!brief || brief.date !== dayKey(now)) return '';
  return `${dayKey(now)}-daily`;
}
function paintClocks() {
  const text = `每天 ${prefs.dailyAt} 提醒`;
  $$('[data-clock-label]').forEach((node) => { node.textContent = text; });
  $$('[data-clock]').forEach((node) => {
    if (document.activeElement !== node) node.value = prefs.dailyAt;
  });
}
function persist() {
  try { localStorage.setItem('feifei-preferences', JSON.stringify(prefs)); } catch {}
  applyPrefs();
}
function applyPrefs() {
  document.body.classList.toggle('quiet', prefs.quiet);
  $$('[data-pref="notify"]').forEach((el) => { el.checked = prefs.notify; });
  $$('[data-pref="quiet"]').forEach((el) => { el.checked = prefs.quiet; });
  $$('[data-pref="float"]').forEach((el) => { el.checked = prefs.float; });
  $$('[data-pref="size"]').forEach((el) => { el.value = prefs.size; });
  $('#pet-widget').style.setProperty('--pet-scale', prefs.size / 100);
  const preview = $('#settings-pet-preview');
  if (preview) preview.style.setProperty('--pet-preview-scale', prefs.size / 100);
  const sizeLabel = $('#preview-size');
  if (sizeLabel) sizeLabel.textContent = `${prefs.size}%`;
  paintClocks();
  syncNative();
}
function syncNative() {
  if (!native) return;
  requestAnimationFrame(() => {
    const card = $('#pet-card');
    const open = !card.hidden;
    bridge('metrics', {
      size: prefs.size,
      open,
      float: prefs.float,
      cardHeight: open ? Math.ceil(card.getBoundingClientRect().height) : 0
    });
  });
}
function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3200);
}
function dialog(title, body, label = '信息说明') {
  $('#dialog-title').textContent = title;
  $('#dialog-label').textContent = label;
  const box = $('#dialog-body');
  box.replaceChildren();
  if (typeof body === 'string') box.innerHTML = body;
  else box.append(body);
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
function sourceLink(url, label) {
  const link = el('a', 'text-button', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
function showStory(index) {
  const story = edition()?.stories[index];
  if (!story) return;
  const body = el('div');
  body.append(el('p', null, story.text));
  body.append(el('p', null, `${story.publisher} · ${shownTime(story.publishedAt)}`));
  body.append(sourceLink(story.url, '打开原文 ↗'));
  dialog(story.title, body, story.publisher);
}
function shownIndex(name) {
  return liveByName.get(name) || brief?.quotes.find((item) => item.name === name) || null;
}
function showQuote(name) {
  const quote = shownIndex(name);
  if (!quote) return;
  const body = el('div');
  body.append(el('p', null, `${quote.name}（${quote.code || ''}）`));
  body.append(el('p', null, `现价 ${quote.last}，前收 ${quote.prevClose}，涨跌额 ${quote.change}，涨跌幅 ${quote.changePercent}%。`));
  body.append(el('p', null, `更新时间：${quote.asOf}`));
  body.append(el('p', null, quote.session));
  body.append(el('p', null, quote.sourceName));
  body.append(sourceLink(quote.sourceUrl, '打开交易所数据 ↗'));
  dialog(quote.name, body, '行情快照');
}
function quoteCard(label, sub, quote, pick, source) {
  const cell = el('div', `index-card${pick === focusIndex ? ' focus' : ''}`);
  const hit = el('button', 'index-hit');
  hit.type = 'button';
  hit.dataset.pick = pick;
  hit.setAttribute('role', 'radio');
  hit.setAttribute('aria-checked', pick === focusIndex ? 'true' : 'false');
  hit.tabIndex = pick === focusIndex ? 0 : -1;
  hit.append(el('span', null, label));
  if (sub) hit.append(el('small', 'index-name', sub));
  if (!quote) {
    hit.append(el('strong', null, '暂不可用'), el('b', null, '稍后更新'));
  } else {
    const change = finite(quote.change);
    const sign = change > 0 ? '+' : '';
    const tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    hit.append(el('strong', tone, String(quote.last)));
    hit.append(el('b', tone, `${sign}${quote.change}  ${sign}${quote.changePercent}%`));

  }
  cell.append(hit);
  if (quote && source) {
    const button = el('button', 'text-button', '来源');
    button.type = 'button';
    if (source.quote) button.dataset.quote = source.quote;
    if (source.sector) button.dataset.sectorQuote = source.sector;
    cell.append(button);
  }
  return cell;
}
function renderQuotes() {
  const box = $('#index-board');
  if (!box) return;
  box.replaceChildren();
  let shown = 0;
  QUOTE_NAMES.forEach((name) => {
    const quote = shownIndex(name);
    if (quote) shown += 1;
    box.append(quoteCard(name, '', quote, name, quote ? {quote: name} : null));
  });
  box.classList.toggle('waiting', shown === 0);
  window.FEIFEI_MOTION?.jellyIndices(focusIndex);
}
function loadSectors() {
  const rows = Array.isArray(window.FEIFEI_SECTORS?.sectors) ? window.FEIFEI_SECTORS.sectors : [];
  sectors = rows.filter((item) => item && typeof item.id === 'string' && typeof item.label === 'string' && validQuote(item));
  const known = new Set(sectors.map((item) => item.id));
  prefs.sectors = prefs.sectors.filter((id) => known.has(id));
}
function showSector(id) {
  const quote = sectors.find((item) => item.id === id);
  if (!quote) return;
  const body = el('div');
  const title = quote.name === quote.label ? `${quote.name}（${quote.code}）` : `${quote.label} · ${quote.name}（${quote.code}）`;
  body.append(el('p', null, title));
  body.append(el('p', null, `现价 ${quote.last}，前收 ${quote.prevClose}，涨跌额 ${quote.change}，涨跌幅 ${quote.changePercent}%。`));
  body.append(el('p', null, `更新时间：${quote.asOf}`));
  body.append(el('p', null, quote.session));
  body.append(el('p', null, quote.sourceName));
  body.append(sourceLink(quote.sourceUrl, '打开交易所数据 ↗'));
  dialog(quote.label, body, '行情快照');
}
function renderSectors() {
  const picks = $('#sector-picks');
  const box = $('#sector-quotes');
  const empty = $('#sector-empty');
  if (picks) {
    picks.replaceChildren();
    sectors.forEach((item) => {
      const on = prefs.sectors.includes(item.id);
      const button = el('button', on ? 'selected' : '');
      button.type = 'button';
      button.dataset.sector = item.id;
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.textContent = item.label;
      picks.append(button);
    });
  }
  if (empty) {
    empty.hidden = sectors.length > 0;
    empty.textContent = sectors.length ? '' : '板块行情暂不可用。';
  }
  if (!box) return;
  box.replaceChildren();
  const chosen = sectors.filter((item) => prefs.sectors.includes(item.id));
  if (!chosen.length) return;
  chosen.forEach((quote) => {
    box.append(quoteCard(quote.label, quote.name !== quote.label ? quote.name : '', quote, quote.name, {sector: quote.id}));
  });
  window.FEIFEI_MOTION?.jellyIndices(focusIndex);
}
function renderStories(stories) {
  const box = $('#stories');
  box.replaceChildren();
  stories.forEach((story, index) => {
    const article = el('article', 'story');
    const top = el('div', 'story-top');
    top.append(el('span', 'story-number', String(index + 1).padStart(2, '0')), el('span', 'story-tag', story.tag));
    const bottom = el('div', 'story-bottom');
    const actions = el('div', 'story-actions');
    const record = el('button', 'text-button', '查看来源 ↗');
    record.type = 'button';
    record.dataset.source = String(index);
    actions.append(sourceLink(story.url, '查看原文 ↗'), record);
    bottom.append(el('span', null, `${story.publisher} · ${shownTime(story.publishedAt)}`), actions);
    article.append(top, el('h3', null, story.title), el('p', null, story.text), bottom);
    box.append(article);
  });
  window.FEIFEI_MOTION?.list(box, '.story', box.closest('.brief-panel'), showStory);
}
function eastmoneyHref(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'finance.eastmoney.com') return '';
    if (parsed.username || parsed.password || !/^\/a\/\d+\.html$/.test(parsed.pathname)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}
function showFlash(index) {
  const item = flashBrief?.items?.[index];
  if (!item) return;
  const body = el('div');
  const title = item.title || item.summary || '财经快讯';
  if (item.summary && item.summary !== title) body.append(el('p', null, item.summary));
  body.append(el('p', null, `东方财富 · ${item.published_at || ''}`));
  const href = eastmoneyHref(item.url);
  if (href) body.append(sourceLink(href, '打开原文 ↗'));
  dialog(title, body, '东方财富');
}
function renderFlashStories(items) {
  const box = $('#stories');
  box.replaceChildren();
  items.forEach((item, index) => {
    const article = el('article', 'story');
    const top = el('div', 'story-top');
    const title = item.title || item.summary || '财经快讯';
    top.append(el('span', 'story-number', String(index + 1).padStart(2, '0')), el('span', 'story-tag', '快讯'));
    const bottom = el('div', 'story-bottom');
    const actions = el('div', 'story-actions');
    const href = eastmoneyHref(item.url);
    if (href) actions.append(sourceLink(href, '查看原文 ↗'));
    bottom.append(el('span', null, `东方财富 · ${item.published_at || ''}`), actions);
    article.append(top, el('h3', null, title));
    if (item.summary && item.summary !== title) article.append(el('p', null, item.summary));
    article.append(bottom);
    box.append(article);
  });
  window.FEIFEI_MOTION?.list(box, '.story', box.closest('.brief-panel'), showFlash);
}
function renderFlashPet(items) {
  const box = $('#pet-items');
  box.replaceChildren();
  items.forEach((item, index) => {
    const node = el('div', 'pet-item');
    const title = item.title || item.summary || '财经快讯';
    const record = el('button', null, '查看');
    record.type = 'button';
    record.dataset.source = String(index);
    node.append(el('b', null, title));
    if (item.summary && item.summary !== title) node.append(el('p', null, item.summary));
    node.append(el('span', null, `东方财富 · ${item.published_at || ''}`));
    const href = eastmoneyHref(item.url);
    if (href) node.append(sourceLink(href, '查看原文'));
    node.append(record);
    box.append(node);
  });
  window.FEIFEI_MOTION?.list(box, '.pet-item', box.closest('.pet-scroll'), showFlash);
}
function paintFlash() {
  const box = $('#stories');
  const pet = $('#pet-items');
  if (!box || !pet) return;
  $('#brief-title').textContent = '财经快讯';
  $('#pet-title').textContent = '财经快讯';
  $('#pet-demo').textContent = '东方财富';
  if (!flashBrief) {
    $('#brief-context').textContent = '正在读取';
    $('#brief-stamp').textContent = '';
    $('#issue-mark').replaceChildren(document.createTextNode('—'), el('small', null, '条'));
    box.replaceChildren(el('p', 'story-empty', '正在读取财经快讯。'));
    pet.replaceChildren(el('p', 'story-empty', '正在读取财经快讯。'));
    return;
  }
  const items = Array.isArray(flashBrief.items) ? flashBrief.items.filter((item) => item && (item.title || item.summary)).slice(0, 7) : [];
  if (!flashBrief.ok || !items.length) {
    const message = flashBrief.message || '财经快讯暂不可用。';
    $('#brief-context').textContent = '东方财富';
    $('#brief-stamp').textContent = '';
    $('#issue-mark').replaceChildren(document.createTextNode('0'), el('small', null, '条'));
    box.replaceChildren(el('p', 'story-empty', message));
    pet.replaceChildren(el('p', 'story-empty', message));
    return;
  }
  const when = String(flashBrief.as_of || '').replace('T', ' ').slice(0, 16);
  $('#brief-context').textContent = flashBrief.from_cache ? '本地缓存' : '东方财富';
  $('#brief-stamp').textContent = when ? `${when} 更新` : '';
  $('#issue-mark').replaceChildren(document.createTextNode(String(items.length)), el('small', null, '条'));
  renderFlashStories(items);
  renderFlashPet(items);
}
function shanghaiToday() {
  const bj = beijingParts();
  return `${bj.y}-${String(bj.m).padStart(2, '0')}-${String(bj.d).padStart(2, '0')}`;
}
function readFlashCache() {
  try {
    const data = JSON.parse(localStorage.getItem(FLASH_KEY) || '');
    return data && Array.isArray(data.items) ? data : null;
  } catch {
    return null;
  }
}
function writeFlashCache(data) {
  try { localStorage.setItem(FLASH_KEY, JSON.stringify(data)); } catch {}
}
async function loadTradeDates() {
  if (tradeDates) return tradeDates;
  try {
    const res = await fetch('data/trade-dates.json', {cache: 'force-cache'});
    const data = await res.json();
    tradeDates = new Set(Array.isArray(data.dates) ? data.dates : []);
  } catch {
    tradeDates = new Set();
  }
  return tradeDates;
}
function isTradingDay(day) {
  const weekday = beijingParts().weekday;
  if (weekday === 0 || weekday === 6) return false;
  if (!tradeDates || !tradeDates.size) return true;
  let covers = false;
  for (const item of tradeDates) {
    if (String(item).startsWith(day.slice(0, 4))) { covers = true; break; }
  }
  return covers ? tradeDates.has(day) : true;
}
function flashItems(list) {
  const items = [];
  for (const row of list) {
    const title = String(row?.title || '').trim();
    const summary = String(row?.summary || '').trim();
    const code = String(row?.code || '').trim();
    if (!title && !summary) continue;
    items.push({
      title,
      summary,
      published_at: String(row?.showTime || '').trim(),
      url: /^\d+$/.test(code) ? `https://finance.eastmoney.com/a/${code}.html` : ''
    });
    if (items.length >= 7) break;
  }
  return items;
}
async function fetchEastMoney(today) {
  const res = await fetch(EASTMONEY_FLASH, {cache: 'no-store'});
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  const items = flashItems(data?.data?.fastNewsList || []);
  if (!items.length) throw new Error('empty');
  const saved = {ok: true, fetched_on: today, as_of: new Date().toISOString(), from_cache: false, items};
  writeFlashCache(saved);
  return saved;
}
async function loadFlash() {
  clearTimeout(flashTimer);
  const today = shanghaiToday();
  await loadTradeDates();
  const cached = readFlashCache();
  const trading = isTradingDay(today);
  if (cached?.items?.length && (!trading || cached.fetched_on === today)) {
    flashBrief = {...cached, ok: true, from_cache: true};
  } else if (!trading) {
    flashBrief = {ok: false, items: [], message: '今天不是交易日，还没有快讯缓存。'};
  } else {
    try {
      flashBrief = await fetchEastMoney(today);
    } catch {
      flashBrief = cached?.items?.length
        ? {...cached, ok: true, from_cache: true}
        : {ok: false, items: [], message: '财经快讯暂不可用。'};
    }
  }
  render();
  flashTimer = setTimeout(loadFlash, flashBrief.ok ? 3600000 : 20000);
}
// Preserve the scheduled report's words and links without interpreting HTML.
function renderDailyMarkdown(box, markdown, pet = false) {
  box.replaceChildren();
  let article;
  const openSection = (title) => {
    article = el('article', pet ? 'pet-item' : 'story');
    if (title) article.append(el('h3', null, title));
    box.append(article);
  };
  const inline = (node, text) => {
    const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
    let end = 0;
    for (const match of text.matchAll(pattern)) {
      node.append(document.createTextNode(text.slice(end, match.index).replace(/\*\*/g, '')));
      const url = match[2] || match[3];
      try {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        const link = el('a', 'text-button', match[1] || url);
        link.href = parsed.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        node.append(link);
      } catch { node.append(document.createTextNode(match[0])); }
      end = match.index + match[0].length;
    }
    node.append(document.createTextNode(text.slice(end).replace(/\*\*/g, '')));
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line || /^---+$/.test(line)) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      openSection(heading[2].replace(/\*\*/g, ''));
      if (heading[1].length <= 2 || heading[1].length >= 4) article.classList.add('brief-group');
      continue;
    }
    if (!article) openSection('');
    const photo = line.match(/^!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)$/);
    if (photo) {
      try {
        const parsed = new URL(photo[2]);
        if (parsed.username || parsed.password) throw new Error();
        const img = el('img', 'brief-photo');
        img.alt = photo[1] || '新闻配图';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.src = parsed.href;
        img.addEventListener('error', () => img.replaceWith(el('p', 'muted', '配图暂不可用，请查看图片出处。')), {once: true});
        article.append(img);
        continue;
      } catch {}
    }
    const paragraph = el('p');
    inline(paragraph, line);
    article.append(paragraph);
  }
  window.FEIFEI_MOTION?.list(box, pet ? '.pet-item' : '.story', box.closest(pet ? '.pet-scroll' : '.brief-panel'), (index) => {
    const row = box.querySelectorAll('article')[index];
    if (row) dialog(row.querySelector('h3')?.textContent || '科技与财经简报', row.cloneNode(true), brief.date);
  });
}
function signedPct(quote) {
  const pct = finite(quote.changePercent);
  return `${pct > 0 ? '+' : ''}${quote.changePercent}%`;
}
function shortIndex(name) {
  return {上证指数: '上证', 深证成指: '深成', 创业板指: '创业板'}[name] || name;
}
function marketSentence() {
  const rows = QUOTE_NAMES.map((name) => shownIndex(name)).filter(validQuote);
  if (!rows.length) return '指数暂不可用。';
  const parts = rows.map((quote) => `${shortIndex(quote.name)} ${signedPct(quote)}`);
  const pcts = rows.map((quote) => finite(quote.changePercent));
  let shape = '';
  if (rows.length >= 2 && pcts.every((value) => value > 0.05)) shape = '主要指数都在涨';
  else if (rows.length >= 2 && pcts.every((value) => value < -0.05)) shape = '主要指数都在跌';
  else if (rows.length >= 2 && pcts.every((value) => Math.abs(value) <= 0.05)) shape = '主要指数基本持平';
  else if (rows.length >= 2) shape = '涨跌不一';
  const stamp = rows.map((quote) => quote.asOf).sort().at(-1) || '';
  const clock = stamp.slice(11, 16);
  const session = rows.find((quote) => quote.asOf === stamp)?.session || rows[0].session;
  const head = clock ? `${clock} ${session}` : session;
  const body = shape ? `${parts.join('，')}，${shape}` : parts.join('，');
  return `${head}：${body}。`;
}
function renderPetMarket() {
  const line = $('#pet-line');
  const dash = $('#dash-line');
  const text = marketSentence();
  if (line) line.textContent = text;
  if (dash) dash.textContent = text;
  const box = $('#pet-quotes');
  if (!box) return;
  const rows = QUOTE_NAMES.map((name) => ({label: name, quote: shownIndex(name), quoteName: name}));
  sectors.filter((item) => prefs.sectors.includes(item.id)).forEach((item) => {
    rows.push({label: item.label, quote: validQuote(item) ? item : null, sectorId: item.id});
  });
  const key = rows.map(row => `${row.label}:${!!row.quote}`).join('|');
  const rebuild = box.dataset.rows !== key;
  if (rebuild) {
    box.replaceChildren();
    box.dataset.rows = key;
  }
  rows.forEach((row, index) => {
    const cell = rebuild ? el('button', 'pet-quote') : box.querySelectorAll('.pet-quote')[index];
    cell.type = 'button';
    cell.replaceChildren(el('span', null, row.label));
    if (!row.quote) {
      cell.append(el('b', null, '暂不可用'));
      cell.disabled = true;
    } else {
      const change = finite(row.quote.change);
      const tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      cell.append(el('strong', tone, String(row.quote.last)));
      cell.append(el('b', tone, signedPct(row.quote)));
      if (row.quoteName) cell.dataset.quote = row.quoteName;
      if (row.sectorId) cell.dataset.sectorQuote = row.sectorId;
    }
    if (rebuild) box.append(cell);
  });
  if (rebuild) window.FEIFEI_MOTION?.list(box, '.pet-quote:not(:disabled)', box.closest('.pet-scroll'), (index) => {
    box.querySelectorAll('.pet-quote:not(:disabled)')[index]?.click();
  });
}

function renderPet(current) {
  const box = $('#pet-items');
  box.replaceChildren();
  if (!current || current.status !== 'published') {
    box.append(el('p', 'story-empty', current?.overview || '这一期还没有消息。'));
    return;
  }
  if (current.markdown) { renderDailyMarkdown(box, current.markdown, true); return; }
  current.stories.forEach((story, index) => {
    const item = el('div', 'pet-item');
    const record = el('button', null, '查看来源');
    record.type = 'button';
    record.dataset.source = String(index);
    item.append(el('b', null, story.title), el('p', null, story.text), el('span', null, `${story.publisher} · ${shownTime(story.publishedAt)}`), sourceLink(story.url, '查看原文'), record);
    box.append(item);
  });
  window.FEIFEI_MOTION?.list(box, '.pet-item', box.closest('.pet-scroll'), showStory);
}
function renderArchive() {
  const list = $('#archive-list');
  if (!list) return;
  list.replaceChildren();
  const intro = $('#archive-intro');
  if (!brief) {
    if (intro) intro.textContent = '暂无往期。';
    return;
  }
  if (intro) intro.textContent = '已发布期次。';
  const day = brief.date.replaceAll('-', '.');
  ['daily'].forEach((key) => {
    const item = brief.editions[key];
    if (!item || item.status !== 'published') return;
    const button = el('button', 'archive-row');
    button.type = 'button';
    button.dataset.archive = key;
    const label = el('span');
    label.append(document.createTextNode(day), el('small', null, '科技与财经简报'));
    button.append(label, el('b', null, `${item.title} ↗`));
    list.append(button);
  });
}
function render() {
  const current = edition();
  const note = $('#brief-note');
  if (!brief || !current) {
    $('#brief-title').textContent = '简报还在准备。';
    $('#brief-context').textContent = '';
    $('#brief-stamp').textContent = '';
    $('#paper-date').textContent = '今天';
    $('#issue-mark').replaceChildren(document.createTextNode('—'), el('small', null, '简报'));
    $('#story-count').textContent = '';
    $('#pet-title').textContent = '简报还在准备。';
    $('#pet-demo').textContent = '';
    $('#pet-caption').textContent = '肥肥财经';
    if (note) note.hidden = true;
    renderQuotes();
    renderSectors();
  } else {
    const published = current.status === 'published';
    const clock = briefClock(brief.generatedAt);
    $('#brief-title').textContent = current.title;
    $('#brief-context').textContent = current.context;
    $('#brief-stamp').textContent = published ? `${brief.date} · ${clock.slice(6)} 更新` : current.context;
    $('#paper-date').textContent = clock.slice(0, 5);
    $('#issue-mark').replaceChildren(document.createTextNode('每日'), el('small', null, '一期'));
    $('#story-count').textContent = '';
    $('#pet-title').textContent = current.title;
    $('#pet-demo').textContent = '每日一期';
    $('#pet-caption').textContent = '肥肥财经';
    if (note) note.hidden = true;
    renderQuotes();
    renderSectors();
  }
  paintFlash();
  renderPetMarket();
  renderArchive();
  $$('[data-period]').forEach((node) => {
    const selected = node.dataset.period === period;
    node.classList.toggle('selected', selected);
    if (node.getAttribute('role') === 'tab') node.setAttribute('aria-selected', String(selected));
  });
  syncNative();
}
function setMood(value) {
  if (!moods[value]) return;
  mood = value;
  $$('.pig-image').forEach((img) => { img.src = `assets/pig/${value}.png?v=original-1`; img.alt = moods[value].alt; });
  $$('[data-mood]').forEach((btn) => btn.classList.toggle('selected', btn.dataset.mood === value));
  if (!$('#pet-widget').classList.contains('has-pending')) {
    const speech = $('#preview-speech');
    if (speech) speech.textContent = moods[value].speech;
    const bubble = $('#pet-bubble');
    if (bubble) bubble.textContent = moods[value].speech;
  }
}
function setFloat(on) {
  prefs.float = !!on;
  persist();
}
function view(value) {
  activeView = value;
  $$('.view').forEach((node) => { node.hidden = node.id !== `view-${value}`; });
  $$('[data-view]').forEach((node) => node.classList.toggle('active', node.dataset.view === value));
  window.scrollTo(0, 0);
}
function markSeen() {
  const id = dueId();
  if (!id) return;
  prefs.seen = id;
  $('#pet-widget').classList.remove('has-pending');
  persist();
}
function toggleCard(open) {
  $('#pet-card').hidden = !open;
  $('#pet-bubble').hidden = open;
  if (open) {
    markSeen();
    renderPetMarket();
    refreshLive();
  }
  bridge('card', {open});
  syncNative();
  if (open && !native) requestAnimationFrame(clampPet);
}
function nudge(text) {
  const speech = $('#preview-speech');
  if (speech) speech.textContent = text;
  const bubble = $('#pet-bubble');
  if (bubble) bubble.textContent = text;
  if ((isDesktop || petMode) && $('#pet-card').hidden) {
    $('#pet-bubble').hidden = false;
    $('#pet-widget').classList.add('delivering');
    setTimeout(() => $('#pet-widget').classList.remove('delivering'), 1700);
  }
}
function checkReminder() {
  const id = dueId();
  const widget = $('#pet-widget');
  if (!id || prefs.seen === id || !prefs.notify) {
    widget.classList.remove('has-pending');
    return;
  }
  widget.classList.add('has-pending');
  if (prefs.quiet || prefs.nudged === id) return;
  prefs.nudged = id;
  try { localStorage.setItem('feifei-preferences', JSON.stringify(prefs)); } catch {}
  period = 'daily';
  render();
  nudge('科技与财经简报已更新');
}
function clampPet() {
  if (!isDesktop || native) return;
  const widget = $('#pet-widget');
  const card = $('#pet-card');
  const cardOpen = !card.hidden;
  if (cardOpen) card.style.maxHeight = `${Math.max(160, innerHeight - 90 - widget.offsetHeight - 65)}px`;
  const petRect = widget.getBoundingClientRect();
  const content = cardOpen ? card : $('#pet-bubble');
  const contentRect = content.getBoundingClientRect();
  const minX = Math.min(petRect.left, contentRect.left);
  const maxX = Math.max(petRect.right, contentRect.right);
  const minY = Math.min(petRect.top, contentRect.top);
  const maxY = Math.max(petRect.bottom, contentRect.bottom);
  let dx = 0, dy = 0;
  if (maxX > innerWidth - 15) dx = innerWidth - 15 - maxX;
  if (minX + dx < 15) dx += 15 - (minX + dx);
  if (maxY > innerHeight - 60) dy = innerHeight - 60 - maxY;
  if (minY + dy < 85) dy += 85 - (minY + dy);
  widget.style.left = `${petRect.left + dx}px`;
  widget.style.top = `${petRect.top + dy}px`;
  widget.style.right = 'auto';
  widget.style.bottom = 'auto';
}
function desktop(on) {
  isDesktop = on;
  $('#website').hidden = on;
  $('#desktop').hidden = !on;
  $('#pet-widget').hidden = !on;
  if (on) {
    toggleCard(false);
    if (prefs.position) {
      $('#pet-widget').style.left = `${prefs.position.x}px`;
      $('#pet-widget').style.top = `${prefs.position.y}px`;
      $('#pet-widget').style.right = 'auto';
      $('#pet-widget').style.bottom = 'auto';
    }
    requestAnimationFrame(clampPet);
  }
}
function resetPet() {
  prefs.size = 100;
  delete prefs.position;
  $('#pet-widget').style.left = '';
  $('#pet-widget').style.top = '';
  $('#pet-widget').style.right = '';
  $('#pet-widget').style.bottom = '';
  persist();
  bridge('reset');
  toast('已恢复肥肥的默认位置与大小。');
}
window.onLoginResult = (ok, on) => {
  const box = $('#pet-login');
  if (box) box.checked = !!ok && !!on;
  if (!ok) toast('开机启动没有打开。可以在系统设置的登录项里允许肥肥。');
};

document.addEventListener('click', (e) => {
  const sectorLink = e.target.closest('a[href="#sectors"]');
  if (sectorLink) view('today');
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.mood) setMood(btn.dataset.mood);
  if (btn.dataset.period) { period = btn.dataset.period; render(); }
  if (btn.dataset.view) view(btn.dataset.view);
  if (btn.dataset.pick) selectIndex(btn.dataset.pick);
  if (btn.dataset.archive) { period = btn.dataset.archive; render(); view('today'); }
  if (btn.dataset.source !== undefined) showFlash(Number(btn.dataset.source));
  if (btn.dataset.quote) showQuote(btn.dataset.quote);
  if (btn.dataset.sector) {
    const id = btn.dataset.sector;
    prefs.sectors = prefs.sectors.includes(id) ? prefs.sectors.filter((item) => item !== id) : prefs.sectors.concat(id);
    persist();
    renderSectors();
    refreshLive();
  }
  if (btn.dataset.sectorQuote) showSector(btn.dataset.sectorQuote);
  if (btn.id === 'pet-settings-toggle') {
    const panel = $('#pet-settings');
    panel.hidden = !panel.hidden;
    btn.textContent = panel.hidden ? '桌宠设置' : '收起设置';
    syncNative();
  }
});
document.querySelector('.index-row')?.addEventListener('keydown', (event) => {
  const hit = event.target.closest('[data-pick]');
  if (!hit || event.altKey || event.ctrlKey || event.metaKey) return;
  const hits = [...document.querySelectorAll('.index-hit[data-pick]')];
  const at = hits.indexOf(hit);
  let next;
  if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (at + 1) % hits.length;
  if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (at - 1 + hits.length) % hits.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = hits.length - 1;
  if (next == null) return;
  event.preventDefault();
  selectIndex(hits[next].dataset.pick);
  hits[next].focus({preventScroll:true});
  hits[next].scrollIntoView({block:'nearest', inline:'nearest', behavior:'auto'});
});
document.addEventListener('change', (e) => {
  const clock = e.target.dataset && e.target.dataset.clock;
  if (clock === 'dailyAt') {
    if (clockMinutes(e.target.value) == null) {
      e.target.value = prefs.dailyAt;
      return;
    }
    prefs.dailyAt = e.target.value;
    persist();
    checkReminder();
    return;
  }
  const key = e.target.dataset && e.target.dataset.pref;
  if (!key || e.target.type !== 'checkbox') return;
  if (key === 'login') { bridge('login', {on: e.target.checked}); return; }
  prefs[key] = e.target.checked;
  persist();
  if (key === 'quiet' || key === 'notify') checkReminder();
});
document.addEventListener('input', (e) => {
  if (!e.target.dataset || e.target.dataset.pref !== 'size') return;
  prefs.size = Number(e.target.value);
  persist();
});
$('#source-policy').onclick = () => dialog('来源说明', '<p>每条消息标注发布机构、时间与原文。外文保留原文。</p><p>指数来自交易所，标注更新时间。打开后按交易所快照刷新。</p>', '来源');
$('#close-dialog').onclick = $('#dialog-done').onclick = () => $('#detail-dialog').close();
$('#detail-dialog').addEventListener('click', (e) => {
  if (e.target === $('#detail-dialog')) {
    const rect = e.target.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) e.target.close();
  }
});
$('#enter-desktop').onclick = () => desktop(true);
$('#leave-desktop').onclick = () => desktop(false);
const previewPig = $('#preview-pig');
if (previewPig) previewPig.onclick = () => { desktop(true); toggleCard(true); };
$('#close-card').onclick = () => toggleCard(false);
$('#pet-full').onclick = () => { if (native) { bridge('web', {period}); return; } desktop(false); view('today'); };
const demoUpdate = $('#demo-update');
if (demoUpdate) demoUpdate.onclick = () => {
  if (prefs.quiet || !prefs.notify) { toast('已保持安静：你仍可以点击肥肥主动查看。'); return; }
  desktop(true);
  nudge('简报已更新');
};
$('#reset-pet').onclick = resetPet;
$('#pet-reset').onclick = resetPet;
let drag = null;
const pig = $('#floating-pig');
pig.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const rect = $('#pet-widget').getBoundingClientRect();
  drag = {x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false};
  pig.setPointerCapture(e.pointerId);
  bridge('dragStart');
});
pig.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 5) drag.moved = true;
  if (!drag.moved) return;
  if (native) { bridge('dragMove'); return; }
  const widget = $('#pet-widget');
  widget.style.left = `${drag.left + dx}px`;
  widget.style.top = `${drag.top + dy}px`;
  widget.style.right = 'auto';
  widget.style.bottom = 'auto';
  clampPet();
});
pig.addEventListener('pointerup', () => {
  if (!drag) return;
  if (!drag.moved) toggleCard($('#pet-card').hidden);
  else if (!native) {
    const rect = $('#pet-widget').getBoundingClientRect();
    prefs.position = {x: rect.left, y: rect.top};
    persist();
  }
  drag = null;
  bridge('dragEnd');
});
pig.addEventListener('pointercancel', () => { drag = null; bridge('dragEnd'); });
pig.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard($('#pet-card').hidden); }
});
window.addEventListener('resize', clampPet);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#detail-dialog').open) return;
  if (!$('#pet-card').hidden) toggleCard(false);
  else if (isDesktop && !native) desktop(false);
});
function beijingParts(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
}
function sessionLabel(asOf) {
  const bj = beijingParts();
  const today = `${bj.y}-${String(bj.m).padStart(2, '0')}-${String(bj.d).padStart(2, '0')}`;
  if (String(asOf).slice(0, 10) !== today) return '历史快照';
  return Number(String(asOf).slice(11, 13)) < 15 ? '交易时段快照' : '15:00 后快照';
}
function snapUrl(channel, code) {
  return `https://yunhq.sse.com.cn:32042/v1/${channel}/snap/${code}`;
}
function parseSnap(text, expect, channel, code) {
  const found = String(text).match(/"snap"\s*:\s*\[\s*"([^"]+)"\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  const dated = String(text).match(/"date"\s*:\s*(20\d{6})/);
  const timed = String(text).match(/"time"\s*:\s*(\d{1,6})/);
  if (!found || !dated || !timed || found[1] !== expect) return null;
  const clock = Number(timed[1]);
  const hh = Math.floor(clock / 10000);
  const mm = Math.floor(clock / 100) % 100;
  const ss = clock % 100;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const day = dated[1];
  const asOf = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const quote = {
    name: found[1],
    code,
    last: found[6],
    prevClose: found[2],
    change: found[7],
    changePercent: found[8],
    asOf,
    session: sessionLabel(asOf),
    sourceName: '上海证券交易所行情接口',
    sourceUrl: snapUrl(channel, code)
  };
  const high = finite(found[4]);
  const low = finite(found[5]);
  const last = finite(quote.last);
  if (high == null || low == null || last == null || high < low || last > high + 0.05 || last < low - 0.05) return null;
  return validQuote(quote) ? quote : null;
}
function upsertIndex(quote) {
  liveByName.set(quote.name, quote);
  if (!brief) return;
  const index = brief.quotes.findIndex((item) => item.name === quote.name);
  if (index >= 0) brief.quotes[index] = quote;
  else brief.quotes.push(quote);
}
function upsertSector(id, quote) {
  const item = sectors.find((row) => row.id === id);
  if (!item) return;
  Object.assign(item, quote, {id: item.id, label: item.label});
}
function sectorFeed(item) {
  const match = String(item.sourceUrl || '').match(/\/v1\/(sh1|sz1|csi)\/snap\/(\d+)$/);
  if (!match || match[2] !== item.code) return null;
  return {id: item.id, name: item.name, channel: match[1], code: item.code};
}
function wantedFeeds() {
  const rows = INDEX_FEED.map((item) => ({...item, kind: 'index'}));
  sectors.filter((item) => prefs.sectors.includes(item.id)).forEach((item) => {
    const feed = sectorFeed(item);
    if (feed) rows.push({...feed, kind: 'sector'});
  });
  return rows;
}
function paintLive() {
  const node = $('#quote-live');
  if (!node) return;
  const stamps = QUOTE_NAMES.map((name) => shownIndex(name)).filter(validQuote).map((quote) => quote.asOf);
  if (!stamps.length) {
    node.textContent = '等待交易所';
    return;
  }
  const asOf = stamps.sort().at(-1);
  const quote = QUOTE_NAMES.map((name) => shownIndex(name)).find((item) => item && item.asOf === asOf);
  node.textContent = `${asOf.slice(11)} · ${quote ? quote.session : ''}`.trim();
}
function applyMarketMood() {
  const rows = QUOTE_NAMES.map((name) => shownIndex(name)).filter(validQuote);
  const word = $('#temp-word');
  const detail = $('#temp-detail');
  if (rows.length < 2) {
    if (word) { word.textContent = '—'; word.className = ''; }
    if (detail) detail.textContent = '';
    return;
  }
  const pcts = rows.map((quote) => finite(quote.changePercent));
  const avg = pcts.reduce((sum, value) => sum + value, 0) / pcts.length;
  const up = pcts.filter((value) => value > 0.05).length;
  const down = pcts.filter((value) => value < -0.05).length;
  let tone = 'uncertain';
  let label = '平';
  if (avg >= 0.3 || (up >= 2 && avg > 0)) { tone = 'good'; label = '暖'; }
  else if (avg <= -0.3 || (down >= 2 && avg < 0)) { tone = 'bad'; label = '冷'; }
  if (word) { word.textContent = label; word.className = tone; }
  if (detail) {
    detail.textContent = rows.map((quote) => {
      const short = {上证指数: '上证', 深证成指: '深成', 创业板指: '创业'}[quote.name] || quote.name;
      const pct = finite(quote.changePercent);
      return `${short} ${pct > 0 ? '+' : ''}${quote.changePercent}%`;
    }).join('  ');
  }
  setMood(tone);
}
function takeSnap(job, text) {
  const quote = parseSnap(text, job.name, job.channel, job.code);
  if (!quote) return;
  if (job.kind === 'sector') upsertSector(job.id, quote);
  else upsertIndex(quote);
}
let liveWait = null;
function finishLive() {
  renderQuotes();
  renderSectors();
  renderPetMarket();
  applyMarketMood();
  paintLive();
  if (!$('#pet-card').hidden) syncNative();
  if (liveWait) { liveWait(); liveWait = null; }
}
async function pullHttp() {
  await Promise.all(wantedFeeds().map(async (job) => {
    try {
      const res = await fetch(`/api/snap?channel=${job.channel}&code=${job.code}`, {cache: 'no-store'});
      if (!res.ok) return;
      takeSnap(job, await res.text());
    } catch {}
  }));
  finishLive();
}
window.onLiveQuotes = (rows) => {
  const feeds = wantedFeeds();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const job = feeds.find((item) => item.code === row.code);
    if (job && typeof row.body === 'string') takeSnap(job, row.body);
  });
  finishLive();
};
function refreshLive() {
  if (native) {
    if (liveWait) return;
    liveWait = () => {};
    bridge('quotes', {codes: wantedFeeds().map((item) => item.code)});
    setTimeout(() => { if (liveWait) finishLive(); }, 8000);
    return;
  }
  pullHttp();
}
function pollDelay() {
  const bj = beijingParts();
  const minutes = bj.hh * 60 + bj.mm;
  const trading = bj.weekday >= 1 && bj.weekday <= 5 && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 5;
  return trading ? 15000 : 60000;
}
function scheduleLive() {
  refreshLive();
  setTimeout(scheduleLive, pollDelay());
}

if (location.protocol === 'file:') $$('.download').forEach((link) => { link.hidden = true; });
if (petMode) {
  document.body.classList.add('native');
  $('#website').hidden = true;
  $('#desktop').hidden = true;
  $('#pet-widget').hidden = false;
  isDesktop = true;
}
brief = acceptBrief(window.FEIFEI_BRIEF);
loadSectors();
applyPrefs();
render();
const entryView = new URLSearchParams(location.search).get('view');
if (['history', 'settings'].includes(entryView)) view(entryView);
if (!petMode && new URLSearchParams(location.search).has('desktop')) desktop(true);
loadFlash();
applyMarketMood();
paintLive();
checkReminder();
setInterval(checkReminder, 20000);
scheduleLive();

function selectIndex(name) {
  if (name === focusIndex) return;
  const update = () => { focusIndex = name; };
  if (window.FEIFEI_MOTION) window.FEIFEI_MOTION.selectIndex(name, update);
  else {
    update();
    renderQuotes();
    renderSectors();
  }
}
