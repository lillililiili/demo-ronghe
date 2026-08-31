/* =============================================================================
 * theme.js —— Naive UI 主题：运行时从 app.css 的 :root token 生成 themeOverrides。
 *
 * 原则：app.css 是颜色唯一真源（第二套 :root，约 601-632 行），这里不手抄色值 ——
 * getComputedStyle 读取，token 改了主题自动跟随，不存在双源漂移。
 * main.js 执行时 app.css 已经由 index.html 的 <link> 同步加载完毕，可安全读取。
 * darkTheme 打底（Naive 完整设计过的暗色，非亮色翻转），overrides 只做「对齐本站」。
 * ========================================================================== */
import { darkTheme } from 'naive-ui';

const css = getComputedStyle(document.documentElement);
const v = name => css.getPropertyValue(name).trim();

/* hex 提亮/压暗（Hover/Pressed 派生用）。amount ∈ (-1,1)，正=向白靠，负=向黑靠 */
function shade(hex, amount) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = x => {
    const t = amount >= 0 ? x + (255 - x) * amount : x * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(t)));
  };
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(ch)
    .map(x => x.toString(16).padStart(2, '0')).join('');
}

const blue = v('--blue') || '#4b9cff';
const red = v('--red') || '#ff5b61';
const green = v('--green') || '#41d49a';
const amber = v('--amber') || '#f1a43a';
const cyan = v('--cyan') || '#2dcfd0';

/* 字体栈照抄 app.css body 基线；行高 1.65（Naive 默认 1.6，必须显式覆盖） */
const fontFamily = getComputedStyle(document.body).fontFamily
  || `-apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;

export const theme = darkTheme;

export const themeOverrides = {
  common: {
    primaryColor: blue,
    primaryColorHover: shade(blue, 0.08),
    primaryColorPressed: shade(blue, -0.08),
    primaryColorSuppl: shade(blue, 0.08),
    infoColor: cyan,
    infoColorHover: shade(cyan, 0.08),
    infoColorPressed: shade(cyan, -0.08),
    successColor: green,
    successColorHover: shade(green, 0.08),
    successColorPressed: shade(green, -0.08),
    warningColor: amber,
    warningColorHover: shade(amber, 0.08),
    warningColorPressed: shade(amber, -0.08),
    errorColor: red,
    errorColorHover: shade(red, 0.08),
    errorColorPressed: shade(red, -0.08),

    bodyColor: v('--canvas') || '#07111f',
    /* 浮层用实色面：--panel 是半透明，弹窗/下拉叠在内容上会透出脏色 */
    cardColor: v('--surface-2') || '#0e1d30',
    modalColor: v('--surface-3') || '#12243a',
    popoverColor: v('--surface-3') || '#12243a',
    tableColor: v('--surface-1') || '#0b1727',
    inputColor: v('--surface-1') || '#0b1727',
    actionColor: v('--surface-2') || '#0e1d30',
    hoverColor: v('--surface-hover') || '#142a44',

    borderColor: v('--line') || 'rgba(125,165,210,.16)',
    dividerColor: v('--line-2') || 'rgba(125,165,210,.09)',

    textColorBase: v('--txt') || '#edf5ff',
    textColor1: v('--txt') || '#edf5ff',
    textColor2: v('--txt-2') || '#a7b7cb',
    textColor3: v('--txt-3') || '#71859e',
    placeholderColor: v('--txt-3') || '#71859e',

    borderRadius: v('--r') || '8px',
    borderRadiusSmall: '6px',            // 对齐 .sel/.ip 的现状圆角
    fontSize: '14px',
    fontSizeMedium: '14px',
    lineHeight: '1.65',
    fontFamily,
    boxShadow2: v('--shadow') || '0 12px 32px rgba(0,0,0,.22)'
  },
  Message: {
    /* 旧 .toast：实色深底 + 语义色描边，最大宽度防长文案撑爆 */
    maxWidth: '520px'
  },
  Pagination: {
    /* 对齐旧 .pg / .pg.on 的观感（方块页码、主色高亮） */
    itemBorderRadius: '5px'
  }
};

/* --page-accent 页面级强调色刻意不接入组件库：其消费者全在 B 类展示串与
   app.css 类里（detail-hero/sect/tabs），组件库 primaryColor 全局固定为 --blue。
   若未来某页需要组件级强调色，在 PageHost 嵌套第二层 n-config-provider 按路由
   覆盖 primaryColor —— 扩展点留此说明，本期不实现。 */
