#!/usr/bin/env node
const { pathToFileURL } = require('node:url');

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n  期望 ${JSON.stringify(expected)}\n  实到 ${JSON.stringify(actual)}`);
}
function overlaps(position, layout, height, obstacle) {
  return position.left < obstacle.right && position.left + layout.width > obstacle.left
    && position.top < obstacle.bottom && position.top + height > obstacle.top;
}

async function main() {
  const module = await import(pathToFileURL(require('node:path').resolve(__dirname, '../src/pages/situation/selectionLayout.js')).href);
  const layout = { left: 100, right: 900, top: 40, bottom: 700, width: 260 };
  const obstacle = { left: 430, right: 570, top: 290, bottom: 410 };
  const position = module.selectionPopupPosition(layout, [500, 350], 180, obstacle);
  check('弹窗避开选中对象范围', overlaps(position, layout, 180, obstacle), false);
  check('弹窗仍在可见区域内', position.left >= layout.left && position.left + layout.width <= layout.right
    && position.top >= layout.top && position.top + 180 <= layout.bottom, true);
  const narrow = { left: 100, right: 500, top: 40, bottom: 420, width: 260 };
  const fallback = module.selectionPopupPosition(narrow, [300, 220], 180);
  check('没有避让范围时仍能按锚点定位', fallback.left >= narrow.left && fallback.left + narrow.width <= narrow.right
    && fallback.top >= narrow.top && fallback.top + 180 <= narrow.bottom, true);
  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exit(1); });
