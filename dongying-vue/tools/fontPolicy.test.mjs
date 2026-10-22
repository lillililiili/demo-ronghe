import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => readFileSync(path.join(root, relative), 'utf8');

test('Naive 正文和等宽字体使用共用 token，保持字号和行高', () => {
  for (const tokenAvailable of [true, false]) {
    const context = {
      darkTheme: {},
      document: { documentElement: {} },
      getComputedStyle: () => ({
        getPropertyValue: name => tokenAvailable ? ({
          '--app-font-sans': '"Noto Sans SC"',
          '--app-font-mono': '"Noto Sans Mono", "Noto Sans SC"'
        })[name] || '' : ''
      })
    };
    const source = read('src/ui/theme.js')
      .replace(/^import .*;$/gm, '')
      .replace(/^export \{.*\};$/gm, '')
      .replace(/\bexport (?=(?:const|function)\b)/g, '');
    vm.runInNewContext(`${source}\nglobalThis.result = createThemeOverrides();`, context);
    assert.equal(context.result.common.fontFamily, '"Noto Sans SC"');
    assert.equal(context.result.common.fontFamilyMono, '"Noto Sans Mono", "Noto Sans SC"');
    assert.equal(context.result.common.fontSize, '14px');
    assert.equal(context.result.common.lineHeight, '1.65');
  }
});

function charts() {
  const calls = [];
  let initializations = 0;
  const instance = {
    setOption(option, config) { calls.push({ option, config }); },
    resize() {},
    isDisposed() { return false; },
    dispose() {}
  };
  const context = {
    window: {},
    document: { documentElement: {} },
    getComputedStyle() {
      return { getPropertyValue: name => ({
        '--app-font-sans': '"Noto Sans SC"',
        '--app-font-mono': '"Noto Sans Mono", "Noto Sans SC"'
      })[name] || '#123456' };
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    echarts: {
      getInstanceByDom() { return null; },
      init() { initializations += 1; return instance; }
    }
  };
  vm.runInNewContext(read('public/assets/js/charts.js'), context);
  return { CH: context.window.CH, calls, get initializations() { return initializations; } };
}

test('图表首次绘制和复用更新都显式提供开源字体并保留原始文字样式', () => {
  const harness = charts();
  const element = { isConnected: true };
  for (const color of ['#102030', '#abcdef']) {
    harness.CH.make(element, { textStyle: { color }, series: [{ data: [1, 2] }] });
    const { option } = harness.calls.at(-1);
    assert.equal(option.textStyle.fontFamily, '"Noto Sans SC"');
    assert.equal(option.textStyle.color, color);
    assert.equal(Object.hasOwn(option, 'tooltip'), false);
  }
  assert.equal(harness.initializations, 1);
  assert.equal(harness.calls[1].config.notMerge, true);
});

test('自定义浮层首次和复用更新都使用开源字体并保留显隐及格式设置', () => {
  const harness = charts();
  const element = { isConnected: true };
  const formatter = row => `${row.name}: ${row.value}`;
  for (const show of [true, false]) {
    const tooltip = {
      show,
      trigger: 'axis',
      formatter,
      textStyle: { color: '#abcdef', fontSize: 13, fontFamily: 'previous-font' }
    };
    harness.CH.make(element, { tooltip, series: [{ data: [5, 9] }] });
    const actual = harness.calls.at(-1).option.tooltip;
    assert.equal(actual.textStyle.fontFamily, '"Noto Sans SC"');
    assert.equal(actual.show, show);
    assert.equal(actual.trigger, 'axis');
    assert.equal(actual.formatter, formatter);
    assert.equal(actual.textStyle.color, '#abcdef');
    assert.equal(actual.textStyle.fontSize, 13);
    assert.equal(tooltip.textStyle.fontFamily, 'previous-font');
  }
  assert.equal(harness.initializations, 1);
});

test('不同容器尺寸的环图正文、浮层及数字富文本均使用开源字体', () => {
  for (const width of [280, 520]) {
    const harness = charts();
    harness.CH.donut({ isConnected: true, clientWidth: width, clientHeight: 220 }, {
      data: [{ name: '第一类', value: 3 }, { name: '邻近样例', value: 7 }]
    });
    const { option } = harness.calls[0];
    assert.equal(option.textStyle.fontFamily, '"Noto Sans SC"');
    assert.equal(option.tooltip.textStyle.fontFamily, '"Noto Sans SC"');
    assert.equal(option.series[1].label.rich.b.fontFamily, '"Noto Sans Mono", "Noto Sans SC"');
  }
});
