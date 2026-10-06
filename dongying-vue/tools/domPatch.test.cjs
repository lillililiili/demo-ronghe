#!/usr/bin/env node
/* 就地更新（src/ui/domPatch.js）：内容没变不动节点；行按 data-row 对齐，增删换序时其余行保持原节点；
   按钮改文字、改属性仍是原节点；<details> 的展开状态由用户决定。用最小的假 DOM 记录每次改动。 */
let passed = 0;
let failed = 0;
function ok(name, condition) {
  if (condition) { passed++; return; }
  failed++;
  console.error(`✗ ${name}`);
}
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n  期望 ${JSON.stringify(expected)}\n  实到 ${JSON.stringify(actual)}`);
}

let mutations = 0;
class FakeNode {
  constructor(nodeType, nodeName) { this.nodeType = nodeType; this.nodeName = nodeName; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  insertBefore(node, ref) {
    mutations++;
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    const index = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (index < 0) throw new Error('参照节点不在父节点下');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    mutations++;
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('要删除的节点不在父节点下');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
}
class FakeText extends FakeNode {
  constructor(text) { super(3, '#text'); this.value = text; }
  get nodeValue() { return this.value; }
  set nodeValue(text) { mutations++; this.value = text; }
}
class FakeElement extends FakeNode {
  constructor(tag, attrs = {}) { super(1, tag.toUpperCase()); this.attrs = new Map(Object.entries(attrs)); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { mutations++; this.attrs.set(name, String(value)); }
  removeAttribute(name) { mutations++; this.attrs.delete(name); }
}
function h(tag, attrs, ...children) {
  const node = new FakeElement(tag, attrs || {});
  children.forEach(child => {
    const item = typeof child === 'string' ? new FakeText(child) : child;
    node.childNodes.push(item);
    item.parentNode = node;
  });
  return node;
}
const fragment = (...children) => h('fragment', null, ...children);
function html(node) {
  if (node.nodeType === 3) return node.nodeValue;
  const attrs = node.attributes.map(a => ` ${a.name}="${a.value}"`).join('');
  return `<${node.nodeName.toLowerCase()}${attrs}>${node.childNodes.map(html).join('')}</${node.nodeName.toLowerCase()}>`;
}
const row = (id, text, cls = '') => h('tr', { 'data-row': id, class: cls }, h('td', null, text));
const table = (...rows) => h('div', { class: 'table-scroll' }, h('table', null, h('tbody', null, ...rows)));

async function main() {
  const { patchChildren } = await import('../src/ui/domPatch.js');

  // 内容没变：一个节点都不改。
  const host = fragment(table(row('a', '告警 A'), row('b', '告警 B')), h('button', { 'data-al': 'verify' }, '核实事件事实'));
  const scroll = host.childNodes[0];
  const button = host.childNodes[1];
  const rowA = scroll.firstChild.firstChild.childNodes[0];
  const rowB = scroll.firstChild.firstChild.childNodes[1];
  mutations = 0;
  patchChildren(host, fragment(table(row('a', '告警 A'), row('b', '告警 B')), h('button', { 'data-al': 'verify' }, '核实事件事实')));
  check('内容没变时不改动节点', mutations, 0);
  ok('内容没变时滚动容器和按钮仍是原节点', host.childNodes[0] === scroll && host.childNodes[1] === button);

  // 一行的状态变了：只改这一行的文字和 class，行和按钮都还是原节点。
  mutations = 0;
  patchChildren(host, fragment(table(row('a', '告警 A'), row('b', '告警 B 已确认', 'on')), h('button', { 'data-al': 'verify' }, '核实事件事实')));
  ok('变化的行原地更新', scroll.firstChild.firstChild.childNodes[1] === rowB && rowB.getAttribute('class') === 'on');
  check('变化的行文字已更新', html(rowB), '<tr data-row="b" class="on"><td>告警 B 已确认</td></tr>');
  ok('其余行和按钮保持原节点', scroll.firstChild.firstChild.childNodes[0] === rowA && host.childNodes[1] === button);
  check('只改了变化的部分', mutations, 2);

  // 新告警插到最前、旧行删掉、其余换序：保留的行仍是原节点，顺序与新内容一致。
  const tbody = scroll.firstChild.firstChild;
  patchChildren(host, fragment(table(row('c', '告警 C'), row('b', '告警 B 已确认', 'on')), h('button', { 'data-al': 'verify' }, '核实事件事实')));
  check('行顺序与新内容一致', tbody.childNodes.map(node => node.getAttribute('data-row')), ['c', 'b']);
  ok('保留的行仍是原节点', tbody.childNodes[1] === rowB);
  ok('删掉的行已移出', rowA.parentNode === null);
  patchChildren(host, fragment(table(row('b', '告警 B 已确认', 'on'), row('c', '告警 C')), h('button', { 'data-al': 'verify' }, '核实事件事实')));
  check('换序后顺序正确', tbody.childNodes.map(node => node.getAttribute('data-row')), ['b', 'c']);
  ok('换序时行仍是原节点', tbody.childNodes[0] === rowB);

  // 按钮改文字、改属性、去掉属性：仍是原节点。
  patchChildren(host, fragment(table(row('b', '告警 B 已确认', 'on'), row('c', '告警 C')), h('button', { 'data-al': 'verify', disabled: '' }, '正在核实')));
  ok('按钮改文字和属性仍是原节点', host.childNodes[1] === button && button.hasAttribute('disabled') && html(button).includes('正在核实'));
  patchChildren(host, fragment(table(row('b', '告警 B 已确认', 'on'), row('c', '告警 C')), h('button', { 'data-al': 'verify' }, '核实事件事实')));
  ok('去掉的属性已移除', !button.hasAttribute('disabled'));

  // 列表上方插入、再去掉刷新失败提示：表格滚动容器保持原节点。
  patchChildren(host, fragment(h('div', { id: 'alRefreshNote' }, '自动刷新失败'), table(row('b', '告警 B 已确认', 'on'), row('c', '告警 C'))));
  ok('插入提示后表格仍是原节点', host.childNodes[1] === scroll && host.childNodes[0].getAttribute('id') === 'alRefreshNote');
  ok('新内容里没有的按钮已移出', button.parentNode === null);
  patchChildren(host, fragment(table(row('b', '告警 B 已确认', 'on'), row('c', '告警 C'))));
  ok('去掉提示后表格仍是原节点', host.childNodes.length === 1 && host.childNodes[0] === scroll);

  // 结构完全不同（读取中 → 表格）：结果与新内容一致。
  const loading = fragment(h('div', { class: 'empty' }, '正在读取告警列表'));
  patchChildren(loading, fragment(table(row('x', '告警 X')), h('p', null, '说明')));
  check('结构不同时结果与新内容一致', loading.childNodes.map(html),
    ['<div class="table-scroll"><table><tbody><tr data-row="x" class=""><td>告警 X</td></tr></tbody></table></div>', '<p>说明</p>']);

  // <details> 的展开由用户决定：新内容不带 open 也不替用户收起，带 open 也不替用户展开。
  const detailsHost = fragment(h('details', null, h('summary', null, '证据链'), '内容'));
  const details = detailsHost.firstChild;
  details.setAttribute('open', '');
  patchChildren(detailsHost, fragment(h('details', null, h('summary', null, '证据链'), '内容（已更新）')));
  ok('用户展开的 details 保持展开', detailsHost.firstChild === details && details.hasAttribute('open'));
  details.removeAttribute('open');
  patchChildren(detailsHost, fragment(h('details', { open: '' }, h('summary', null, '证据链'), '内容（已更新）')));
  ok('用户收起的 details 保持收起', !details.hasAttribute('open'));

  console.log(`domPatch: ${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
