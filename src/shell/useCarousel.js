/* 大屏轮播 —— 逐字移植旧 app.js 的 stopCarousel/startCarousel/carouselDlg。
   bar/chip 仍 append 到 document.body（Vue 树之外），页面切换走 location.hash，
   vue-router hash 模式原生监听 hashchange。 */
import { ROUTES, pageTitle } from './navModel.js';

const curKey = () => (location.hash.replace('#/', '') || 'situation').split('?')[0];

let carTimer = null, carTick = null;
const CAROUSEL_DEFAULT = ['situation', 'alarms', 'flights', 'punish'];

export function stopCarousel() {
  clearInterval(carTimer); clearInterval(carTick); carTimer = carTick = null;
  document.querySelectorAll('.carousel-bar,.carousel-chip').forEach(e => e.remove());
}

function startCarousel(pages, sec) {
  const UI = window.UI;
  stopCarousel();
  const bar = document.createElement('div'); bar.className = 'carousel-bar';
  const chip = document.createElement('div'); chip.className = 'carousel-chip';
  document.body.appendChild(bar); document.body.appendChild(chip);
  let i = Math.max(0, pages.indexOf(curKey()));
  let left = sec;
  const paint = () => {
    chip.innerHTML = `<span>轮播中 <b>${i + 1}/${pages.length}</b> · ${pageTitle(pages[i])}</span>
      <span style="color:var(--txt-3)">${left}s 后切换</span><button class="icon-btn x" type="button" title="停止轮播" aria-label="停止轮播">${UI.icon('close')}</button>`;
    chip.querySelector('.x').onclick = () => { stopCarousel(); UI.toast('已停止轮播'); };
    bar.style.width = ((sec - left) / sec * 100).toFixed(1) + '%';
  };
  location.hash = '#/' + pages[i]; paint();
  carTick = setInterval(() => { left--; if (left < 0) left = sec; paint(); }, 1000);
  carTimer = setInterval(() => {
    i = (i + 1) % pages.length; left = sec;
    location.hash = '#/' + pages[i]; paint();
  }, sec * 1000);
}

export function carouselDlg() {
  const UI = window.UI;
  if (carTimer) { stopCarousel(); UI.toast('已停止轮播'); return; }
  const all = Object.keys(ROUTES);
  UI.modal({
    title: '大屏轮播设置', width: '520px',
    body: `<div class="warnbox">用于指挥大厅无人值守展示：按设定间隔自动切换页面，随时可停止。</div>
      ${UI.field('切换间隔', UI.select('sec', [{ v: 10, t: '10 秒' }, { v: 15, t: '15 秒' }, { v: 30, t: '30 秒' }, { v: 60, t: '60 秒' }], 15))}
      <div style="margin:12px 0 6px;font-size:13px;color:var(--txt-2)">参与轮播的页面</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;max-height:230px;overflow:auto">
        ${all.map(k => `<label class="chk" style="margin:2px 0"><input type="checkbox" data-cp="${k}"
          ${CAROUSEL_DEFAULT.includes(k) ? 'checked' : ''}>${pageTitle(k)}</label>`).join('')}
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn pri" data-act="go">开始轮播</button>`,
    on: {
      go: el => {
        const pages = [...el.querySelectorAll('[data-cp]')].filter(c => c.checked).map(c => c.dataset.cp);
        if (!pages.length) return UI.toast('请至少选择一个页面', 'err');
        const sec = +el.querySelector('[data-f="sec"]').value;
        UI.closeModal();
        startCarousel(pages, sec);
        UI.toast(`轮播已开始：${pages.length} 个页面 · ${sec} 秒/页`, 'ok');
      }
    }
  });
}
