/* Motion adapted from the user-supplied React Bits AnimatedList and Dock.
   Native DOM keeps this static site and its WKWebView bundle dependency-free. */
window.FEIFEI_MOTION = (() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const calm = () => reduced.matches || document.body.classList.contains('quiet');
  const spring = CSS.supports('transition-timing-function', 'linear(0, 1)')
    ? 'linear(0, .0603, .2033, .3821, .5633, .7258, .8584, .9574, 1.0242, 1.0634, 1.0809, 1.0828, 1.0747, 1.0613, 1.046, 1.0313, 1.0186, 1.0085, 1.0012, .9965, .994, .9931, .9933, .9941, .9953, .9966, .9978, .9988, 1)'
    : 'cubic-bezier(.34, 1.4, .64, 1)';
  const active = new Map();
  function play(node, frames, options = {}) {
    if (!node) return;
    active.get(node)?.cancel();
    if (calm() || !node.animate) return;
    const animation = node.animate(frames, {duration: 560, easing: spring, ...options});
    active.set(node, animation);
    const release = () => {
      if (active.get(node) === animation) active.delete(node);
    };
    animation.finished.then(release, release);
  }
  const lists = new WeakMap();
  function list(box, selector, root, onSelect) {
    if (!box || !root) return;
    lists.get(box)?.();
    const rows = [...box.querySelectorAll(selector)];
    if (!rows.length) return;
    box.classList.add('motion-list');
    const ring = document.createElement('i');
    ring.className = 'list-ring';
    ring.setAttribute('aria-hidden', 'true');
    box.append(ring);
    let selected = -1;
    const highlight = (index) => {
      const row = rows[index];
      if (!row || !row.isConnected) return;
      if (selected >= 0) rows[selected].classList.remove('reading');
      selected = index;
      row.classList.add('reading');
      Object.assign(ring.style, {
        opacity: '1', width: `${row.offsetWidth}px`, height: `${row.offsetHeight}px`,
        transform: `translate3d(${row.offsetLeft}px,${row.offsetTop}px,0)`
      });
    };
    const hide = () => {
      if (box.contains(document.activeElement)) return;
      ring.style.opacity = '0';
      if (selected >= 0) rows[selected].classList.remove('reading');
      selected = -1;
    };
    const cleanup = [];
    rows.forEach((row, index) => {
      row.tabIndex = 0;
      const enter = () => highlight(index);
      const key = (event) => {
        if (event.target !== row || event.altKey || event.ctrlKey || event.metaKey) return;
        let next;
        if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
        if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = rows.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          rows[next].focus({preventScroll: true});
          rows[next].scrollIntoView({block: 'nearest', behavior: 'auto'});
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(index);
        }
      };
      const click = (event) => {
        if (event.target.closest('a,button') || window.getSelection()?.toString()) return;
        highlight(index);
        onSelect?.(index);
      };
      row.addEventListener('pointerenter', enter);
      row.addEventListener('focusin', enter);
      row.addEventListener('keydown', key);
      row.addEventListener('click', click);
      cleanup.push(() => {
        row.removeEventListener('pointerenter', enter);
        row.removeEventListener('focusin', enter);
        row.removeEventListener('keydown', key);
        row.removeEventListener('click', click);
      });
    });
    // Animate only a real viewport entry. Polling the market never replays news.
    let order = 0;
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      order = 0;
      entries.forEach(({target, isIntersecting}) => {
        if (!isIntersecting) {
          target.dataset.inView = 'false';
          return;
        }
        if (target.dataset.inView !== 'true') {
          play(target, [
            {opacity: 0, transform: 'translate3d(0,14px,0) scale(.97)'},
            {opacity: 1, transform: 'translate3d(0,0,0) scale(1)'}
          ], {delay: order++ * 45, fill: 'backwards'});
        }
        target.dataset.inView = 'true';
      });
    }, {root, threshold: .12});
    rows.forEach((row) => observer?.observe(row));
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (selected >= 0) highlight(selected);
    });
    resize?.observe(box);
    box.addEventListener('pointerleave', hide);
    box.addEventListener('focusout', hide);
    lists.set(box, () => {
      observer?.disconnect();
      resize?.disconnect();
      cleanup.forEach((off) => off());
      rows.forEach((row) => active.get(row)?.cancel());
      box.removeEventListener('pointerleave', hide);
      box.removeEventListener('focusout', hide);
      ring.remove();
    });
  }
  // JellyRadio: horizontal swell arrives before vertical swell; neighbours yield.
  function response(t, stiffness, mass, bounce) {
    if (t <= 0) return 0;
    const omega = Math.sqrt(stiffness / mass);
    const zeta = 1 - bounce;
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + zeta * omega / damped * Math.sin(damped * t));
  }
  function jellyIndices(name, animate = false) {
    const cards = [...document.querySelectorAll('.index-card')];
    const chosen = Math.max(0, cards.findIndex(card => card.querySelector('[data-pick]')?.dataset.pick === name));
    const push = (cards[chosen]?.offsetWidth || 220) * .1 / 2 + 6;
    cards.forEach((card, index) => {
      const hit = card.querySelector('[data-pick]');
      const selected = index === chosen;
      const far = Math.abs(index - chosen);
      const matrix = new DOMMatrixReadOnly(getComputedStyle(card).transform);
      const from = {x: matrix.m41, sx: matrix.a, sy: matrix.d};
      const to = {x: Math.sign(index - chosen) * push, sx: selected ? 1.1 : .97, sy: selected ? 1.1 : .97};
      const running = active.has(card);
      active.get(card)?.cancel();
      card.classList.toggle('focus', selected);
      hit?.setAttribute('aria-checked', String(selected));
      if (hit) hit.tabIndex = selected ? 0 : -1;
      const transform = p => `translateX(${p.x}px) scale(${p.sx},${p.sy})`;
      card.style.transform = transform(to);
      if (!animate || calm()) return;
      const delay = running ? 0 : far * .022;
      const k = 580 * (1 - .12 * Math.min(far, 3));
      const frames = Array.from({length: 55}, (_, frame) => {
        const t = frame / 54 * .9 - delay;
        const x = response(t, k, .9, .25);
        const sx = response(t, k * 1.24, .8, .55);
        const sy = response(t - .05, k * .86, .95, .25);
        return {transform: transform({x: from.x + (to.x - from.x) * x, sx: from.sx + (to.sx - from.sx) * sx, sy: from.sy + (to.sy - from.sy) * sy})};
      });
      frames[frames.length - 1] = {transform: transform(to)};
      play(card, frames, {duration: 900, easing: 'linear'});
    });
  }
  function selectIndex(name, update) {
    update();
    jellyIndices(name, true);
  }
  function stop() {
    if (!calm()) return;
    active.forEach((animation) => animation.cancel());
    active.clear();
  }
  // Scale is independent from transform, so list and JellyRadio motion still work.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button,a.button,a.nav-link,.side-download,input[role="switch"]');
    if (!button || button.disabled || button.id === 'floating-pig' || button.matches('.index-hit')) return;
    play(button, [{scale: '.94'}, {scale: '1.055', offset: .48}, {scale: '.99', offset: .76}, {scale: '1'}], {duration: 360, easing: 'ease-out'});
  }, true);
  reduced.addEventListener('change', stop);
  new MutationObserver(stop).observe(document.body, {attributes: true, attributeFilter: ['class']});
  return {list, selectIndex, jellyIndices};
})();
