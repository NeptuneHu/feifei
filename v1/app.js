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
  nudged: typeof saved.nudged === 'string' ? saved.nudged : ''
};
const initialPeriod = new URLSearchParams(location.search).get('period');
let mood = 'good', period = initialPeriod === 'evening' ? 'evening' : 'noon', activeView = 'today', isDesktop = false, toastTimer;
const moods = {
  good: {alt: '开心的肥肥猪', speech: '重点我整理好啦，点我看看？'},
  bad: {alt: '委屈的肥肥猪', speech: '波动的时候，我们先把事实看清楚。'},
  uncertain: {alt: '思考中的肥肥猪', speech: '看不清就慢一点，先读消息原文。'}
};
const HOSTS = new Set(['www.stats.gov.cn', 'www.pbc.gov.cn', 'www.federalreserve.gov', 'yunhq.sse.com.cn', 'www.szse.cn']);
const QUOTE_NAMES = ['上证指数', '深证成指', '创业板指'];
let brief = null;

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
  if (typeof quote.session !== 'string' || !quote.session.includes('不是收盘')) return false;
  if (typeof quote.name !== 'string' || typeof quote.asOf !== 'string' || typeof quote.sourceName !== 'string') return false;
  return allowedUrl(quote.sourceUrl);
}
function acceptBrief(data) {
  if (!data || data.status !== 'published' || !data.editions) return null;
  const clean = (edition) => {
    if (!edition || (edition.status !== 'published' && edition.status !== 'not_published')) return null;
    const stories = Array.isArray(edition.stories) ? edition.stories.filter(validStory) : [];
    if (edition.status === 'published' && !stories.length) return null;
    if (edition.status === 'not_published' && stories.length) return null;
    return {status: edition.status, title: String(edition.title || ''), context: String(edition.context || ''), overview: String(edition.overview || ''), stories};
  };
  const editions = {noon: clean(data.editions.noon), evening: clean(data.editions.evening)};
  if (!editions.noon || !editions.evening) return null;
  return {
    generatedAt: String(data.generatedAt || ''),
    activeEdition: data.activeEdition === 'evening' ? 'evening' : 'noon',
    editions,
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
function dueId(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const day = dayKey(now);
  if (minutes >= 20 * 60 + 30) return `${day}-evening`;
  if (minutes >= 12 * 60) return `${day}-noon`;
  return '';
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
function showQuote(name) {
  const quote = brief?.quotes.find((item) => item.name === name);
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
function renderQuotes() {
  const box = $('.indices');
  box.replaceChildren();
  let shown = 0;
  QUOTE_NAMES.forEach((name) => {
    const quote = brief?.quotes.find((item) => item.name === name);
    const cell = el('div');
    cell.append(el('span', null, name));
    if (!quote) {
      cell.append(el('strong', null, '暂不可用'), el('b', null, '稍后更新'));
    } else {
      shown += 1;
      const change = finite(quote.change);
      const sign = change > 0 ? '+' : '';
      cell.append(el('strong', null, String(quote.last)));
      cell.append(el('b', change > 0 ? 'up' : change < 0 ? 'down' : 'flat', `${sign}${quote.change}  ${sign}${quote.changePercent}%`));
      cell.append(el('small', 'asof', quote.asOf));
      const button = el('button', 'text-button', '来源 ↗');
      button.type = 'button';
      button.dataset.quote = name;
      cell.append(button);
    }
    box.append(cell);
  });
  box.classList.toggle('waiting', shown === 0);
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
}
function renderPet(current) {
  const box = $('#pet-items');
  box.replaceChildren();
  if (!current || current.status !== 'published') {
    box.append(el('p', 'story-empty', current?.overview || '这一期还没有消息。'));
    return;
  }
  current.stories.forEach((story, index) => {
    const item = el('div', 'pet-item');
    const record = el('button', null, '查看来源');
    record.type = 'button';
    record.dataset.source = String(index);
    item.append(document.createTextNode(story.title), el('span', null, `${story.publisher} · ${shownTime(story.publishedAt)}`), sourceLink(story.url, '查看原文'), record);
    box.append(item);
  });
}
function renderArchive() {
  const list = $('#archive-list');
  if (!list) return;
  list.replaceChildren();
  const intro = $('#archive-intro');
  if (!brief) {
    if (intro) intro.textContent = '还没有可以回看的简报。';
    return;
  }
  if (intro) intro.textContent = '这里是已经发出的简报。';
  const day = brief.generatedAt.slice(0, 10).replaceAll('-', '.');
  ['evening', 'noon'].forEach((key) => {
    const item = brief.editions[key];
    if (!item || item.status !== 'published') return;
    const button = el('button', 'archive-row');
    button.type = 'button';
    button.dataset.archive = key;
    const label = el('span');
    label.append(document.createTextNode(day), el('small', null, key === 'noon' ? '午间简报' : '晚间简报'));
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
    $('#stories').replaceChildren(el('p', 'story-empty', '今天的简报还在准备。'));
    renderPet(null);
  } else {
    const published = current.status === 'published';
    const clock = briefClock(brief.generatedAt);
    $('#brief-title').textContent = current.title;
    $('#brief-context').textContent = current.context;
    $('#brief-stamp').textContent = published ? `${clock} 更新` : current.context;
    $('#paper-date').textContent = clock.slice(0, 5);
    $('#issue-mark').replaceChildren(document.createTextNode(published ? String(current.stories.length).padStart(2, '0') : '—'), el('small', null, period === 'noon' ? '午间' : '晚间'));
    $('#story-count').textContent = published ? `${current.stories.length} 条` : '';
    $('#pet-title').textContent = current.title;
    $('#pet-demo').textContent = period === 'noon' ? '午间简报' : '晚间简报';
    $('#pet-caption').textContent = '肥肥财经';
    if (note) note.hidden = true;
    renderQuotes();
    if (published) renderStories(current.stories);
    else $('#stories').replaceChildren(el('p', 'story-empty', current.overview));
    renderPet(current);
  }
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
  $$('.pig-image').forEach((img) => { img.src = `assets/pig/${value}.png`; img.alt = moods[value].alt; });
  $$('[data-mood]').forEach((btn) => btn.classList.toggle('selected', btn.dataset.mood === value));
  if (!$('#pet-widget').classList.contains('has-pending')) {
    $('#preview-speech').textContent = moods[value].speech;
    $('#pet-bubble').textContent = moods[value].speech;
  }
}
function setFloat(on) {
  prefs.float = !!on;
  persist();
}
function view(value) {
  activeView = value;
  $$('.view').forEach((el) => { el.hidden = el.id !== `view-${value}`; });
  $$('[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === value));
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
  if (open) markSeen();
  bridge('card', {open});
  syncNative();
  if (open && !native) requestAnimationFrame(clampPet);
}
function nudge(text) {
  $('#preview-speech').textContent = text;
  $('#pet-bubble').textContent = text;
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
  const evening = id.endsWith('evening');
  period = evening ? 'evening' : 'noon';
  render();
  nudge(evening ? '晚间时间到了，点我看看。' : '午间简报可以看了，点我。');
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
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.mood) setMood(btn.dataset.mood);
  if (btn.dataset.period) { period = btn.dataset.period; render(); }
  if (btn.dataset.view) view(btn.dataset.view);
  if (btn.dataset.archive) { period = btn.dataset.archive; render(); view('today'); }
  if (btn.dataset.source !== undefined) showStory(Number(btn.dataset.source));
  if (btn.dataset.quote) showQuote(btn.dataset.quote);
  if (btn.id === 'pet-settings-toggle') {
    const panel = $('#pet-settings');
    panel.hidden = !panel.hidden;
    btn.textContent = panel.hidden ? '桌宠设置' : '收起设置';
    syncNative();
  }
});
document.addEventListener('change', (e) => {
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
$('#source-policy').onclick = () => dialog('消息从哪来。', '<p>每条消息都写着发布机构和时间，可以打开原文。外文按原文保留。</p><p>指数来自交易所，标的是更新时间，不是收盘价。打开页面之后，数字不会自己跳动。</p>', '来源');
$('#close-dialog').onclick = $('#dialog-done').onclick = () => $('#detail-dialog').close();
$('#detail-dialog').addEventListener('click', (e) => {
  if (e.target === $('#detail-dialog')) {
    const rect = e.target.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) e.target.close();
  }
});
$('#enter-desktop').onclick = () => desktop(true);
$('#leave-desktop').onclick = () => desktop(false);
$('#preview-pig').onclick = () => { desktop(true); toggleCard(true); };
$('#close-card').onclick = () => toggleCard(false);
$('#pet-full').onclick = () => { if (native) { bridge('web', {period}); return; } desktop(false); view('today'); };
$('#demo-update').onclick = () => {
  if (prefs.quiet || !prefs.notify) { toast('已保持安静：你仍可以点击肥肥主动查看。'); return; }
  desktop(true);
  nudge('这一期在这里，点我看原文。');
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
if (location.protocol === 'file:') $$('.download').forEach((link) => { link.hidden = true; });
if (petMode) {
  document.body.classList.add('native');
  $('#website').hidden = true;
  $('#desktop').hidden = true;
  $('#pet-widget').hidden = false;
  isDesktop = true;
}
brief = acceptBrief(window.FEIFEI_BRIEF);
if (brief && initialPeriod !== 'noon' && initialPeriod !== 'evening') {
  period = brief.editions[brief.activeEdition]?.status === 'published' ? brief.activeEdition : 'noon';
}
applyPrefs();
render();
setMood('good');
checkReminder();
setInterval(checkReminder, 20000);
