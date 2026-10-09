<script setup>
// A single Naive Tooltip serves Vue cells, legacy HTML tables and teleported dialogs.
// Only visibly truncated text activates it; content is read as text, never HTML.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { NConfigProvider, NTooltip } from 'naive-ui';
import { theme, themeOverrides } from '@/ui/theme.js';

const route = useRoute();
const shown = ref(false);
const text = ref('');
const x = ref(0);
const y = ref(0);
let active = null;
let timer;
let observer;
let resizeObserver;
let previousDescription = null;
let nativeTitles = [];
const tooltipId = 'table-overflow-tooltip';
const cellOf = node => node instanceof Element
  ? node.closest('.table-text') || (node.matches('button,a') ? node.querySelector('.table-text') : null)
    || node.closest('table.tb td:not([colspan])') : null;
const inTooltip = node => node instanceof Element && !!node.closest(`#${tooltipId}`);

function isTruncated(cell) {
  return [cell, ...cell.querySelectorAll('*')].some(el =>
    el.clientWidth > 0 && getComputedStyle(el).textOverflow === 'ellipsis'
      && el.scrollWidth > el.clientWidth + 1);
}
function close() {
  clearTimeout(timer);
  observer?.disconnect();
  resizeObserver?.disconnect();
  if (active) {
    if (previousDescription === null) active.removeAttribute('aria-describedby');
    else active.setAttribute('aria-describedby', previousDescription);
  }
  for (const [node, title] of nativeTitles) {
    if (!node.hasAttribute('title')) node.setAttribute('title', title);
  }
  nativeTitles = [];
  active = null;
  shown.value = false;
}
function open(cell) {
  clearTimeout(timer);
  if (cell === active) return;
  close();
  if (!cell?.isConnected || !isTruncated(cell)) return;
  const content = cell.innerText.trim();
  if (!content) return;
  active = cell;
  // Avoid stacking the browser's native title over the Naive tooltip; restore it on close.
  const titled = [...cell.querySelectorAll('[title]')];
  for (let node = cell; node && node.tagName !== 'TR'; node = node.parentElement) {
    if (node.hasAttribute('title')) titled.push(node);
  }
  nativeTitles = titled.map(node => [node, node.getAttribute('title')]);
  nativeTitles.forEach(([node]) => node.removeAttribute('title'));
  text.value = content;
  const rect = cell.getBoundingClientRect();
  x.value = rect.left + rect.width / 2;
  y.value = rect.bottom;
  previousDescription = cell.getAttribute('aria-describedby');
  cell.setAttribute('aria-describedby', [previousDescription, tooltipId].filter(Boolean).join(' '));
  shown.value = true;
  // Polling, pagination and v-html replacement must never leave the previous row's tooltip.
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  resizeObserver.observe(cell);
}
function enter(event) {
  if (inTooltip(event.target)) { clearTimeout(timer); return; }
  const cell = cellOf(event.target);
  if (cell === cellOf(event.relatedTarget)) return;
  if (!cell) return;
  clearTimeout(timer);
  timer = setTimeout(() => open(cell), 180);
}
function leave(event) {
  const from = cellOf(event.target);
  if (!from && !inTooltip(event.target)) return;
  if (from && cellOf(event.relatedTarget) === from) return;
  if ((active && cellOf(event.relatedTarget) === active) || inTooltip(event.relatedTarget)) return;
  clearTimeout(timer);
  timer = setTimeout(close, 160);
}
function focus(event) { open(cellOf(event.target)); }
function blur(event) {
  if ((active && cellOf(event.relatedTarget) === active) || inTooltip(event.relatedTarget)) return;
  close();
}
function keydown(event) { if (event.key === 'Escape') close(); }
function scroll(event) { if (!inTooltip(event.target)) close(); }
watch(() => route.fullPath, close);
onMounted(() => {
  observer = new MutationObserver(() => {
    if (active && (!active.isConnected || active.innerText.trim() !== text.value)) close();
  });
  resizeObserver = new ResizeObserver(() => {
    if (active && !isTruncated(active)) close();
  });
  document.addEventListener('pointerover', enter);
  document.addEventListener('pointerout', leave);
  document.addEventListener('focusin', focus);
  document.addEventListener('focusout', blur);
  document.addEventListener('keydown', keydown);
  document.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', close);
});
onBeforeUnmount(() => {
  close();
  document.removeEventListener('pointerover', enter);
  document.removeEventListener('pointerout', leave);
  document.removeEventListener('focusin', focus);
  document.removeEventListener('focusout', blur);
  document.removeEventListener('keydown', keydown);
  document.removeEventListener('scroll', scroll, true);
  window.removeEventListener('resize', close);
});
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides" style="display:contents">
    <NTooltip trigger="manual" :show="shown" :x="x" :y="y" placement="bottom" :show-arrow="false" :animated="false" :z-index="3000">
      <div :id="tooltipId" role="tooltip" class="table-tooltip-content">{{ text }}</div>
    </NTooltip>
  </NConfigProvider>
</template>

<style scoped>
.table-tooltip-content { max-width: min(480px, calc(100vw - 48px)); max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
</style>
