/* 大屏轮播 —— 逐字移植旧 app.js 的 stopCarousel/startCarousel/carouselDlg。
   bar/chip 仍 append 到 document.body（Vue 树之外），页面切换走 location.hash，
   vue-router hash 模式原生监听 hashchange。 */
import { h } from 'vue';
import { pageTitle } from './navModel.js';
import { toast } from '../ui/nv.js';
import { openModal } from '../ui/modal.js';
import CarouselModal from '../ui/modals/CarouselModal.vue';

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
    chip.querySelector('.x').onclick = () => { stopCarousel(); toast('已停止轮播'); };
    bar.style.width = ((sec - left) / sec * 100).toFixed(1) + '%';
  };
  location.hash = '#/' + pages[i]; paint();
  carTick = setInterval(() => { left--; if (left < 0) left = sec; paint(); }, 1000);
  carTimer = setInterval(() => {
    i = (i + 1) % pages.length; left = sec;
    location.hash = '#/' + pages[i]; paint();
  }, sec * 1000);
}

/* P4b：受控表单版（样板），字段与校验见 src/ui/modals/CarouselModal.vue 头注释 */
export function carouselDlg() {
  if (carTimer) { stopCarousel(); toast('已停止轮播'); return; }
  openModal({
    title: '大屏轮播设置', width: '520px', footer: false,
    render: () => h(CarouselModal, {
      defaults: CAROUSEL_DEFAULT,
      onGo: (pages, sec) => {
        startCarousel(pages, sec);
        toast(`轮播已开始：${pages.length} 个页面 · ${sec} 秒/页`, 'ok');
      }
    })
  });
}
