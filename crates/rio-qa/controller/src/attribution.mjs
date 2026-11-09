/** Development metadata is advisory. The host resolves it against the captured
 * snapshot and requires exactly one file; no repository path is opened here. */
export function elementAttribution(paths) {
  const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
  const parse = value => {
    if (typeof value !== 'string') return null;
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(value);
    return match ? { path: match[1], line: Number(match[2]) } : { path: value, line: 1 };
  };
  const find = path => {
    let root = document, element;
    for (const part of path.split(' >>> ')) { element = root?.querySelector(part); root = element?.shadowRoot; }
    return element;
  };
  return paths.map(path => {
    const el = find(path), annotations = [];
    if (!el) return { annotations, text: [], classes: [] };
    for (const name of ['data-vite-dev-id', 'data-v-inspector', 'data-source', 'data-source-location', 'data-svelte-source']) {
      const hint = parse(el.getAttribute(name)); if (hint) annotations.push(hint);
    }
    for (const key of Object.getOwnPropertyNames(el)) if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      let fiber = own(el, key);
      for (let depth = 0; fiber && depth < 30; depth++, fiber = own(fiber, 'return')) {
        const source = own(fiber, '_debugSource');
        if (own(source, 'fileName')) { annotations.push({ path: source.fileName, line: source.lineNumber || 1 }); break; }
      }
    }
    const vue = own(el, '__vueParentComponent'), type = own(vue, 'type');
    if (own(type, '__file')) annotations.push({ path: type.__file, line: 1 });
    const svelte = own(own(el, '__svelte_meta'), 'loc');
    if (own(svelte, 'file')) annotations.push({ path: svelte.file, line: (svelte.line || 0) + 1 });
    return { annotations, text: el.textContent.trim() ? [el.textContent.trim().slice(0, 1024)] : [], classes: [...el.classList] };
  });
}

export function stackHints(events) {
  const hints = [];
  for (const event of events.filter(event => event.kind === 'error')) {
    if (event.location?.url) hints.push({ path: event.location.url, line: event.location.lineNumber + 1 });
    for (const match of (event.stack || event.text || '').matchAll(/(?:\bat\s+(?:[^\s(]+\s+\()?|@)([^\s()]+?):(\d+)(?::\d+)?\)?/g)) hints.push({ path: match[1], line: Number(match[2]) });
  }
  return hints;
}

/** Resolve selectors inside the browser. Selector spelling, model descriptions,
 * layout measurements and viewport names never become target identity. */
export function observationTargets(paths) {
  const find = path => {
    let root = document, element;
    for (const part of path.split(' >>> ')) { element = root?.querySelector(part); root = element?.shadowRoot; }
    return element;
  };
  const elements = Array.isArray(paths) ? [...new Set(paths.map(find).filter(Boolean))] : [paths];
  const signature = el => {
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => el.getRootNode().getElementById?.(id)?.textContent || '').join(' ').trim()
      || (['button', 'a', 'label', 'option'].includes(tag) ? el.textContent : '') || '';
    return { tag, role: el.getAttribute('role') || ({ button: 'button', a: 'link', main: 'main', input: 'input' }[tag] || tag),
      name: name.replace(/\s+/g, ' ').trim().slice(0, 256), key: el.id || el.getAttribute('name') || '' };
  };
  const target = el => {
    const value = signature(el), key = JSON.stringify(value), root = el.getRootNode();
    const peers = [...root.querySelectorAll(el.tagName)].filter(peer => JSON.stringify(signature(peer)) === key);
    return { ...value, ordinal: peers.indexOf(el), ...(root.host ? { scope: target(root.host) } : {}) };
  };
  // Prefer the specific affected region over an ancestor supplied alongside it.
  // Ordinals and shadow-host scope distinguish controls with identical names.
  return elements.filter(el => !elements.some(other => other !== el && el.contains(other)))
    .map(target).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
