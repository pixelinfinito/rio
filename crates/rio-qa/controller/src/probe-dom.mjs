// Runs in the browser. Keep this function self-contained: it is serialized into
// each frame, with no repository JavaScript or harness-supplied expressions.
export function measureDom({ mobile = false, failedImages = [] } = {}) {
  const viewportWidth = document.documentElement.clientWidth || innerWidth;
  const viewportHeight = document.documentElement.clientHeight || innerHeight;
  const result = { candidates: [], eligible: {}, focus: [], hover: [], offscreenFocus: [], gaps: [] };
  const elements = [];
  const walk = root => { for (const el of root.querySelectorAll('*')) { elements.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const style = el => getComputedStyle(el);
  const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  const shown = el => { const s = style(el), r = rect(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.visibility !== 'collapse' && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); };
  const path = el => {
    const parts = [];
    while (el?.nodeType === 1) {
      const index = [...(el.parentNode?.children || [])].filter(sibling => sibling.localName === el.localName).indexOf(el) + 1;
      parts.unshift(`${CSS.escape(el.localName)}:nth-of-type(${index})`);
      if (el.parentNode instanceof ShadowRoot) return path(el.parentNode.host) + ' >>> ' + parts.join(' > ');
      el = el.parentElement;
    }
    return parts.join(' > ');
  };
  const signature = el => ({ tag: el.localName, role: el.getAttribute('role') || ({ button: 'button', a: 'link', input: 'textbox', select: 'combobox', textarea: 'textbox', img: 'img' }[el.localName] || 'generic'), type: el.getAttribute('type') || undefined,
    name: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => el.getRootNode().getElementById(id)?.textContent || '').join(' ') || [...(el.labels || [])].map(label => label.textContent).join(' ') || el.getAttribute('alt') || (el.matches('button,a,summary,[role=button],[role=link]') ? el.textContent.trim() : '') });
  const eligible = (rule, list) => { result.eligible[rule] = list.map(path); };
  const add = (rule, el, measurements, related = []) => result.candidates.push({ rule_id: rule, element_path: path(el), role_signature: signature(el), measurements, related_paths: related.map(path) });
  const visible = elements.filter(shown);
  const area = viewportWidth * viewportHeight;
  const fraction = el => { const r = rect(el); return r.width * r.height / area; };
  const sections = visible.filter(el => !['img', 'canvas'].includes(el.localName));
  eligible('ui/gradient-background', sections);
  for (const el of sections) if (fraction(el) > .25 && /(?:linear|radial|conic)-gradient\(/.test(style(el).backgroundImage)) add('ui/gradient-background', el, { background_image: style(el).backgroundImage, area_ratio: fraction(el), box: rect(el) });
  const cards = visible.filter(el => {
    const s = style(el), ratio = fraction(el);
    return ratio >= .05 && ratio <= .6 && (['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].some(key => parseFloat(s[key]) > 0) || s.boxShadow !== 'none');
  });
  eligible('ui/accent-border-card', cards);
  for (const el of cards) {
    const s = style(el);
    if (parseFloat(s.borderLeftWidth) >= 3 && [s.borderTopColor, s.borderRightColor, s.borderBottomColor].every(color => color !== s.borderLeftColor)) add('ui/accent-border-card', el, { border_left_width: parseFloat(s.borderLeftWidth), border_left_color: s.borderLeftColor, other_border_colors: [s.borderTopColor, s.borderRightColor, s.borderBottomColor], area_ratio: fraction(el) });
  }
  const primitives = visible.filter(el => el.matches('button,input,select,textarea'));
  eligible('ui/raw-primitive', primitives);
  if (primitives.length) {
    // A separate blank document gives the actual Chromium UA defaults at the
    // current scheme/zoom, unaffected by author selectors and inherited fonts.
    const reference = document.createElement('iframe'); reference.style.cssText = 'position:fixed!important;left:-10000px!important;width:1px!important;height:1px!important;visibility:hidden!important';
    document.documentElement.append(reference);
    try {
      const doc = reference.contentDocument;
      doc.documentElement.style.colorScheme = style(document.documentElement).colorScheme;
      const properties = ['appearance', 'backgroundColor', 'backgroundImage', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', ...['Top','Right','Bottom','Left'].flatMap(side => [`border${side}Width`, `border${side}Style`, `border${side}Color`])];
      const raw = new Map();
      for (const el of primitives) {
        const sample = doc.createElement(el.localName);
        if (el.hasAttribute('type')) sample.setAttribute('type', el.getAttribute('type'));
        doc.body.append(sample);
        const actual = style(el), defaults = reference.contentWindow.getComputedStyle(sample);
        raw.set(el, actual.appearance === 'auto' && properties.every(key => actual[key] === defaults[key]));
        sample.remove();
      }
      for (const el of primitives) {
        const peers = primitives.filter(peer => peer.localName === el.localName);
        const styledRatio = peers.filter(peer => !raw.get(peer)).length / peers.length;
        if (raw.get(el) && styledRatio >= .8) add('ui/raw-primitive', el, { appearance: 'auto', ua_defaults_equal: true, styled_ratio: styledRatio, same_tag_count: peers.length });
      }
    } finally { reference.remove(); }
  }
  const spacingProps = ['marginTop','marginRight','marginBottom','marginLeft','paddingTop','paddingRight','paddingBottom','paddingLeft'];
  const spacing = new Map(visible.map(el => [el, spacingProps.map(key => parseFloat(style(el)[key])).filter(Number.isFinite)]));
  const counts = new Map();
  for (const values of spacing.values()) for (const value of values) if (value > 0) counts.set(value, (counts.get(value) || 0) + 1);
  const base = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const blocks = visible.filter(el => ['block', 'flex', 'grid', 'flow-root', 'list-item'].includes(style(el).display));
  const groups = new Map();
  for (const el of blocks) { const parent = el.parentNode; if (!groups.has(parent)) groups.set(parent, []); groups.get(parent).push(el); }
  const siblings = [...groups.values()].filter(group => group.length >= 3);
  eligible('ui/spacing-scale', siblings.flat());
  if (base) for (const group of siblings) for (const el of group) {
    const anomalies = spacing.get(el).filter(value => value > 0 && Math.abs(value / base - Math.round(value / base)) > .01 && group.filter(peer => peer !== el).every(peer => spacing.get(peer).every(other => Math.abs(other - value) > 2)));
    if (anomalies.length) add('ui/spacing-scale', el, { base_unit: base, values: [...new Set(anomalies)], sibling_count: group.length });
  }
  const text = visible.filter(el => [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()));
  const textCount = el => [...el.childNodes].filter(node => node.nodeType === 3 && node.textContent.trim()).length;
  const sizes = new Map(); let total = 0;
  for (const el of text) { const size = parseFloat(style(el).fontSize), count = textCount(el); sizes.set(size, (sizes.get(size) || 0) + count); total += count; }
  eligible('ui/type-scale', text);
  const common = [...sizes].filter(([, count]) => count / total >= .02).map(([size]) => size);
  for (const el of text) {
    const size = parseFloat(style(el).fontSize), ratio = sizes.get(size) / total;
    const nearest = common.toSorted((a, b) => Math.abs(a - size) - Math.abs(b - size) || b - a)[0];
    if (ratio < .02 && Math.abs(nearest - size) < 2) add('ui/type-scale', el, { font_size: size, nearest_common_size: nearest, usage_ratio: ratio, text_nodes: total });
  }
  const color = value => {
    // Computed sRGB values can be composed exactly. Other color spaces and
    // image/gradient backdrops require pixel evidence, never a guessed ratio.
    const match = /^rgba?\(([^)]+)\)$/.exec(value);
    if (!match) return undefined;
    const parts = match[1].split(/[,\s/]+/).map(Number);
    return parts.length >= 3 && parts.every(Number.isFinite) ? [...parts.slice(0, 3), parts[3] ?? 1] : undefined;
  };
  const over = (fg, bg) => [...fg.slice(0, 3).map((value, i) => value * fg[3] + bg[i] * (1 - fg[3])), 1];
  const luminance = rgba => rgba.slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  for (const el of text) {
    const layers = []; let cursor = el, uncertain = false, opaque = false;
    while (cursor) {
      const s = style(cursor), c = color(s.backgroundColor);
      if ((!opaque && (!c || s.backgroundImage !== 'none')) || Number(s.opacity) < 1 || s.mixBlendMode !== 'normal' || s.filter !== 'none' || s.backdropFilter !== 'none') { uncertain = true; break; }
      if (!opaque) { layers.push(c); opaque = c[3] === 1; }
      cursor = cursor.parentElement || cursor.getRootNode().host;
    }
    const foreground = color(style(el).color);
    if (uncertain || !foreground) { result.gaps.push({ rule_id: 'ui/low-contrast', element_path: path(el), reason: 'non_uniform_or_unresolved_background' }); continue; }
    let background = [255, 255, 255, 1];
    for (const layer of layers.reverse()) background = over(layer, background);
    const effective = over(foreground, background), light = [luminance(effective), luminance(background)].sort((a, b) => b - a);
    const ratio = (light[0] + .05) / (light[1] + .05), size = parseFloat(style(el).fontSize), weight = parseInt(style(el).fontWeight);
    const threshold = size >= 24 || (size >= 19 && weight >= 700) ? 3 : 4.5;
    if (ratio < threshold) add('ui/low-contrast', el, { ratio, threshold, foreground: effective.slice(0, 3), background: background.slice(0, 3), font_size: size, font_weight: weight });
  }
  const scrolling = document.scrollingElement;
  if (scrolling && scrolling.scrollWidth - viewportWidth > 2) add('ui/horizontal-overflow', scrolling, { scroll_width: scrolling.scrollWidth, viewport_width: viewportWidth, excess: scrolling.scrollWidth - viewportWidth });
  for (const el of visible) {
    if (el.localName === 'img' && el.complete && el.naturalWidth === 0) add('ui/broken-image', el, { source: el.currentSrc || el.src, complete: true, natural_width: 0 });
    const background = style(el).backgroundImage;
    const failed = failedImages.filter(url => background.includes(JSON.stringify(url)) || background.includes(`url(${url})`));
    if (failed.length) add('ui/broken-image', el, { failed_background_requests: failed });
  }
  const interactive = visible.filter(el => el.matches('button,a[href],input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=true],[role=button],[role=link]') && !el.matches(':disabled,[inert],[tabindex="-1"]') && !el.closest('[inert]'));
  result.focus = interactive.map(el => ({ element_path: path(el), role_signature: signature(el) }));
  if (mobile) {
    for (const el of interactive) {
      const box = rect(el), nearby = interactive.filter(other => {
        if (other === el || el.contains(other) || other.contains(el)) return false;
        const b = rect(other), dx = Math.max(0, box.x - b.right, b.x - box.right), dy = Math.max(0, box.y - b.bottom, b.y - box.bottom);
        return Math.hypot(dx, dy) < 8;
      });
      if (box.width < 44 || box.height < 44 || nearby.length) add('mobile/tap-target', el, { box, minimum_size: 44, minimum_gap: 8, basis: 'touch_target_heuristic' }, nearby);
    }
    const meta = document.querySelector('meta[name="viewport" i]');
    if (!meta || !/(?:^|[,;\s])width\s*=\s*device-width(?:$|[,;\s])/i.test(meta.content)) add('mobile/viewport-meta', document.documentElement, { content: meta?.content || null });
    for (const el of interactive.filter(el => el.matches('textarea,input:not([type]),input:is([type=text],[type=email],[type=password],[type=search],[type=tel],[type=url],[type=number])'))) {
      if (parseFloat(style(el).fontSize) < 16) add('mobile/input-zoom', el, { font_size: parseFloat(style(el).fontSize), minimum: 16, basis: 'input_font_heuristic', safari_zoom_reproduced: false });
    }
    const intersects = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
    for (const el of visible.filter(el => ['fixed', 'sticky'].includes(style(el).position))) {
      const box = rect(el), covers = interactive.filter(target => !el.contains(target) && intersects(box, rect(target)) && (() => {
        const b = rect(target), x = (Math.max(0, b.x, box.x) + Math.min(viewportWidth, b.right, box.right)) / 2, y = (Math.max(0, b.y, box.y) + Math.min(viewportHeight, b.bottom, box.bottom)) / 2;
        const stack = document.elementsFromPoint(x, y);
        return stack.some(top => top === el || el.contains(top)) && stack.findIndex(top => top === el || el.contains(top)) < stack.indexOf(target);
      })());
      const visibleArea = Math.max(0, Math.min(viewportWidth, box.right) - Math.max(0, box.x)) * Math.max(0, Math.min(viewportHeight, box.bottom) - Math.max(0, box.y)) / area;
      if (covers.length || visibleArea > .3) add('mobile/fixed-overlap', el, { box, viewport_coverage: visibleArea }, covers);
    }
    const unreachable = el => {
      // Project through each scrollport without scrolling the application.
      // Below-the-fold content and carousel items remain reachable; hidden or
      // clipped overflow and negative, unscrollable offsets do not.
      let box = { ...rect(el) }, fixed = style(el).position === 'fixed';
      for (let parent = el.parentElement || el.getRootNode().host; parent; parent = parent.parentElement || parent.getRootNode().host) {
        const root = parent === document.documentElement, css = style(parent), bounds = rect(parent);
        const left = root ? 0 : bounds.x + parent.clientLeft, top = root ? 0 : bounds.y + parent.clientTop;
        const width = root ? viewportWidth : parent.clientWidth, height = root ? viewportHeight : parent.clientHeight;
        for (const axis of ['x', 'y']) {
          const horizontal = axis === 'x', end = horizontal ? 'right' : 'bottom';
          const start = horizontal ? left : top, size = horizontal ? width : height;
          let overflow = horizontal ? css.overflowX : css.overflowY;
          if (root && overflow === 'visible' && document.body) overflow = horizontal ? style(document.body).overflowX : style(document.body).overflowY;
          if (!root && !['auto', 'scroll', 'hidden', 'clip'].includes(overflow)) continue;
          const canScroll = !(root && fixed) && (['auto', 'scroll'].includes(overflow) || root && overflow === 'visible');
          const offset = canScroll ? horizontal ? parent.scrollLeft : parent.scrollTop : 0;
          const extent = canScroll ? horizontal ? parent.scrollWidth : parent.scrollHeight : size;
          const lower = horizontal && css.direction === 'rtl' ? start + size - extent - offset : start - offset;
          const upper = lower + extent;
          if (box[axis] < lower - 1 || box[end] > upper + 1) return { axis, clip_path: path(parent), scrollable: canScroll, reachable_start: lower, reachable_end: upper };
          if (canScroll) {
            box[axis] = Math.max(start, box[axis] - (upper - start - size));
            box[end] = Math.min(start + size, box[end] + (start - lower));
          }
        }
        fixed ||= css.position === 'fixed';
      }
    };
    for (const el of new Set([...text, ...interactive])) {
      const box = rect(el), s = style(el);
      const clipping = unreachable(el);
      if (clipping) {
        add('mobile/offscreen-content', el, { box, viewport_width: viewportWidth, viewport_height: viewportHeight, ...clipping });
        // Verify the exception using forced CSS focus, never application event
        // handlers. An offscreen fragment link is not exempt merely by name.
        if (interactive.includes(el) && el.matches('a[href^="#"]') && el.hash.length > 1 && el.getRootNode().getElementById(el.hash.slice(1))) result.offscreenFocus.push(path(el));
      }
      if ((s.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 1 || s.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 1) && s.textOverflow !== 'ellipsis') add('mobile/text-truncation', el, { scroll_width: el.scrollWidth, client_width: el.clientWidth, scroll_height: el.scrollHeight, client_height: el.clientHeight, text_overflow: s.textOverflow });
    }
    const inspectRules = rules => { for (const rule of rules) {
      if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
      if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
      if (rule.cssRules) inspectRules(rule.cssRules);
      if (!rule.selectorText?.includes(':hover')) continue;
      for (const selector of rule.selectorText.split(',')) {
        // Complex functional selectors cannot be rewritten safely; keep a
        // coverage gap instead of inventing a static_proven hover violation.
        if (/:(?:is|where|not|has)\(/.test(selector)) { result.gaps.push({ rule_id: 'mobile/hover-only', reason: 'complex_hover_selector', selector }); continue; }
        const hoverIndex = selector.indexOf(':hover');
        if (hoverIndex < 0) continue;
        const triggerSelector = selector.slice(0, hoverIndex) || '*';
        try {
          for (const trigger of document.querySelectorAll(triggerSelector)) result.hover.push({ trigger_path: path(trigger), target_selector: selector.replaceAll(':hover', ''), selector });
        } catch { result.gaps.push({ rule_id: 'mobile/hover-only', reason: 'unsupported_hover_selector', selector }); }
      }
    } };
    for (const sheet of document.styleSheets) { try { inspectRules(sheet.cssRules); } catch { result.gaps.push({ rule_id: 'mobile/hover-only', reason: 'inaccessible_stylesheet' }); } }
  }
  return result;
}

export function inspectElement({ path, selector }) {
  const find = path => { let root = document; const parts = path.split(' >>> '); for (let i = 0; i < parts.length; i++) { const el = root.querySelector(parts[i]); if (!el) return; if (i === parts.length - 1) return el; root = el.shadowRoot; if (!root) return; } };
  const elements = selector ? [...document.querySelectorAll(selector)] : [find(path)].filter(Boolean);
  return elements.map(el => {
    const s = getComputedStyle(el), box = el.getBoundingClientRect();
    let unclipped = s.clipPath === 'none' && s.clip === 'auto';
    for (let parent = el.parentElement || el.getRootNode().host; parent; parent = parent.parentElement || parent.getRootNode().host) {
      const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (css.clipPath !== 'none' || css.clip !== 'auto'
        || ['hidden', 'clip'].includes(css.overflowX) && (box.x < bounds.x + parent.clientLeft || box.right > bounds.x + parent.clientLeft + parent.clientWidth)
        || ['hidden', 'clip'].includes(css.overflowY) && (box.y < bounds.y + parent.clientTop || box.bottom > bounds.y + parent.clientTop + parent.clientHeight)) unclipped = false;
    }
    return { visible: el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
      in_viewport: unclipped && box.x >= 0 && box.y >= 0 && box.right <= document.documentElement.clientWidth && box.bottom <= document.documentElement.clientHeight,
      focused: el.matches(':focus'),
      styles: Object.fromEntries([...s].filter(key => !key.startsWith('--')).map(key => [key, s.getPropertyValue(key)])) };
  });
}
