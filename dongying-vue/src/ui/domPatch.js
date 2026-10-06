/* 旧页面仍用 HTML 字符串绘制。定时或实时刷新时整块替换 innerHTML，会把行和按钮换成新节点：
   用户正要点的按钮在按下的瞬间被替换，点击落空，焦点、滚动位置和展开状态也会丢（BUG-06）。
   patchHtml 把新内容就地合并进已有节点：没变的节点原样保留，变了的只改文字和属性；
   带 data-row / data-key / id 的节点按标识对齐，列表增删、换序时其余行不受影响。
   用户操作出来的状态不被覆盖：<details> 的展开收起、输入框里已经改过的值都保持原样。 */

function keyOf(node) {
  if (node.nodeType !== 1) return null;
  const row = node.getAttribute('data-row');
  if (row) return `row:${row}`;
  const key = node.getAttribute('data-key');
  if (key) return `key:${key}`;
  const id = node.getAttribute('id');
  return id ? `id:${id}` : null;
}

const sameType = (node, want) => node.nodeType === want.nodeType && node.nodeName === want.nodeName;

function syncAttributes(node, want) {
  // <details> 的展开由用户决定，刷新不替用户收起或展开。
  const userOpen = name => name === 'open' && node.nodeName === 'DETAILS';
  for (const { name } of [...node.attributes]) {
    if (!userOpen(name) && !want.hasAttribute(name)) node.removeAttribute(name);
  }
  for (const { name, value } of [...want.attributes]) {
    if (!userOpen(name) && node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
}

function patchNode(node, want) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== want.nodeValue) node.nodeValue = want.nodeValue;
    return;
  }
  syncAttributes(node, want);
  patchChildren(node, want);
}

/** 让 parent 的子节点与 source 的子节点一致；source 的节点可能被移入 parent，调用后不要再用 source。 */
export function patchChildren(parent, source) {
  const wanted = [...source.childNodes];
  const wantedKeys = new Set(wanted.map(keyOf).filter(Boolean));
  const keyed = new Map();
  for (const node of [...parent.childNodes]) {
    const key = keyOf(node);
    if (!key) continue;
    // 新内容里已经没有的行先拿掉，剩下的节点大多能原地对上，不必挪动（挪动会丢滚动位置和焦点）。
    if (wantedKeys.has(key) && !keyed.has(key)) keyed.set(key, node);
    else parent.removeChild(node);
  }
  // cursor 之前是已经对齐的节点，之后是尚未处理的旧节点。
  let cursor = parent.firstChild;
  for (const want of wanted) {
    const key = keyOf(want);
    let match = null;
    if (key) {
      const found = keyed.get(key);
      if (found && sameType(found, want)) { match = found; keyed.delete(key); }
    } else if (cursor && !keyOf(cursor) && sameType(cursor, want)) {
      match = cursor;
    }
    if (!match) { parent.insertBefore(want, cursor); continue; }
    patchNode(match, want);
    if (match === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(match, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}

/** 用 html 就地更新 host 的内容；内容没变时不改动任何节点。 */
export function patchHtml(host, html) {
  if (!host) return;
  const template = host.ownerDocument.createElement('template');
  template.innerHTML = html;
  patchChildren(host, template.content);
}
