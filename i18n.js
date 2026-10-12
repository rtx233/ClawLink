import english from './locales/en.js';

let locale = 'zh-CN';
export function setLocale(value) {
  locale = value === 'en' ? 'en' : 'zh-CN';
  document.documentElement.lang = locale;
}
export function t(source, ...values) {
  const translated = locale === 'en' ? english[source] ?? source : source;
  return String(translated ?? '').replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
}
export function msg(parts, ...values) {
  return t(parts.reduce((source, part, index) => source + part + (index < values.length ? `{${index}}` : ''), ''), ...values);
}
function translateFragment(source) {
  const values = [];
  const key = source.trim().replace(/__CL_VALUE_\d+__/g, value => `{${values.push(value) - 1}}`);
  return source.replace(source.trim(), t(key, ...values));
}
// Translate only source literals. Interpolated names, paths, message text and
// escaped HTML are substituted afterwards and never enter the dictionary.
export function html(parts, ...values) {
  const source = typeof parts === 'string' ? parts : parts.reduce((text, part, index) => text + part + (index < values.length ? `__CL_VALUE_${index}__` : ''), '');
  const translated = source.split(/(<[^>]*>)/g).map(part => part.startsWith('<')
    ? part.replace(/\b(aria-label|placeholder|alt|title)="([^"]*)"/g, (_, name, value) => `${name}="${translateFragment(value)}"`)
    : translateFragment(part)).join('');
  return translated.replace(/__CL_VALUE_(\d+)__/g, (_, index) => String(values[index]));
}

// Capture the initial static document once, before dynamic data is rendered.
// Stored source text makes switching in either direction lossless.
let staticSources;
export function localizeStatic() {
  if (!staticSources) {
    staticSources = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.closest('script, style') && node.textContent.trim()) staticSources.push([node, null, node.textContent]);
    }
    for (const node of document.querySelectorAll('[aria-label], [placeholder], [alt], [title]')) {
      for (const name of ['aria-label', 'placeholder', 'alt', 'title']) if (node.hasAttribute(name)) staticSources.push([node, name, node.getAttribute(name)]);
    }
  }
  for (const [node, attribute, source] of staticSources) {
    if (!node.isConnected) continue;
    const translated = translateFragment(source);
    if (attribute) node.setAttribute(attribute, translated); else node.textContent = translated;
  }
}
