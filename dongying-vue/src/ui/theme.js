/* =============================================================================
 * theme.js —— Naive UI 主题：运行时从 tokens.css 的 :root 生成 themeOverrides。
 *
 * 原则：src/assets/css/tokens.css 是颜色唯一真源，这里不手抄色值 ——
 * getComputedStyle 读取，token 改了主题自动跟随，不存在双源漂移。
 * main.js 必须先 import '@/assets/css/index.css'，再求值本模块。
 * darkTheme 打底（Naive 完整设计过的暗色，非亮色翻转），overrides 只做「对齐本站」。
 * ========================================================================== */
import '@/assets/css/index.css';
import { darkTheme, dateZhCN, zhCN } from 'naive-ui';

export { dateZhCN, zhCN };

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

/* 字体栈照抄 reset.css body 基线；行高 1.65（Naive 默认 1.6，必须显式覆盖） */
const fontFamily = getComputedStyle(document.body).fontFamily
  || `-apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;

export const theme = darkTheme;

/* 登录页局部组件主题，依然只从 tokens.css 读取，不影响业务表单。 */
export const loginThemeOverrides = {
  Input: {
    heightLarge: '60px', fontSizeLarge: '18px', paddingLarge: '0 18px',
    color: v('--login-input'), colorFocus: v('--login-input'),
    textColor: v('--login-text'), placeholderColor: v('--login-muted'),
    caretColor: v('--login-text'), border: `1px solid ${v('--login-line')}`,
    borderHover: `1px solid ${v('--login-link')}`, borderFocus: `1px solid ${v('--login-link')}`,
    boxShadowFocus: `0 0 0 3px ${v('--line')}`
  },
  Checkbox: { textColor: v('--login-muted'), border: `1px solid ${v('--login-line')}`, color: v('--login-input') },
  Button: {
    heightLarge: '60px', fontSizeLarge: '20px', textColorPrimary: v('--login-text'),
    colorPrimary: v('--login-action'), colorHoverPrimary: v('--login-action-hover'),
    colorPressedPrimary: v('--login-action-pressed'),
    borderPrimary: `1px solid ${v('--login-action')}`,
    borderHoverPrimary: `1px solid ${v('--login-action-hover')}`,
    borderPressedPrimary: `1px solid ${v('--login-action-pressed')}`
  }
};

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
  Select: {
    peers: {
      InternalSelectMenu: {
        optionHeightMedium: '34px',
        optionHeightSmall: '32px'
      }
    }
  },
  Pagination: {
    /* 对齐旧 .pg / .pg.on 的观感（方块页码、主色高亮） */
    itemBorderRadius: '5px'
  },
  DataTable: {
    thColor: v('--surface-2') || '#0e1d30',
    thColorHover: v('--surface-hover') || '#142a44',
    tdColor: v('--surface-1') || '#0b1727',
    tdColorHover: v('--surface-hover') || '#142a44',
    tdColorStriped: v('--surface-2') || '#0e1d30',
    thTextColor: v('--txt-2') || '#a7b7cb',
    tdTextColor: v('--txt-2') || '#a7b7cb',
    borderColor: v('--line') || 'rgba(125,165,210,.16)',
    thFontWeight: '600'
  },
  Dialog: {
    titleFontSize: '16px',
    padding: '20px 24px 22px',
    contentMargin: '14px 0 22px',
    actionSpace: '10px',
    borderRadius: '10px',
    closeMargin: '20px 22px 0 0'
  }
};

/* --page-accent 页面级强调色刻意不接入组件库：其消费者全在 B 类展示串与
   全局样式类里（detail-hero/sect/tabs），组件库 primaryColor 全局固定为 --blue。
   若未来某页需要组件级强调色，在 PageHost 嵌套第二层 n-config-provider 按路由
   覆盖 primaryColor —— 扩展点留此说明，本期不实现。 */
