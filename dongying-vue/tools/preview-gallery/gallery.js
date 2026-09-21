// Gallery controls only. This site never calls business APIs.
const cards = [...document.querySelectorAll('.card')];
const search = document.querySelector('#search');
let selected = '全部';
let selectedSystem = '全部系统';
function filterPages() {
  const query = (search?.value || '').trim().toLocaleLowerCase();
  let count = 0;
  for (const card of cards) {
    card.hidden = !((selectedSystem === '全部系统' || card.dataset.system === selectedSystem) && (selected === '全部' || card.dataset.category === selected) && card.dataset.search.toLocaleLowerCase().includes(query));
    if (!card.hidden) count++;
  }
  document.querySelectorAll('[data-system-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.systemFilter === selectedSystem)));
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === selected)));
  document.querySelectorAll('[data-group]').forEach(link => link.classList.toggle('active', link.dataset.group === selected));
  if (document.querySelector('#result-count')) document.querySelector('#result-count').textContent = `${selectedSystem} / ${selected} · ${count} 个展示项`;
  if (document.querySelector('#empty')) document.querySelector('#empty').hidden = count > 0;
}
function readGroup() {
  const params = new URLSearchParams(location.hash.slice(1));
  const group = params.get('group');
  selectedSystem = ['业务前台','管理后台'].includes(params.get('system')) ? params.get('system') : '全部系统';
  const available = [...document.querySelectorAll('[data-filter]')].map(button=>button.dataset.filter);
  selected = available.includes(group) ? group : '全部';
  filterPages();
}
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{
  selected=button.dataset.filter;
  history.replaceState(null,'','#group='+encodeURIComponent(selected)+'&system='+encodeURIComponent(selectedSystem));
  filterPages();
}));
document.querySelectorAll('[data-system-filter]').forEach(button=>button.addEventListener('click',()=>{
  selectedSystem=button.dataset.systemFilter;
  selected='全部';
  history.replaceState(null,'','#system='+encodeURIComponent(selectedSystem));
  filterPages();
}));
search?.addEventListener('input',filterPages);
addEventListener('hashchange',readGroup);
if (cards.length) readGroup();
document.querySelector('#relations-toggle')?.addEventListener('click',event=>{
  const panel=document.querySelector('#relations');
  panel.hidden=!panel.hidden;
  event.currentTarget.setAttribute('aria-pressed',String(!panel.hidden));
});
document.querySelector('#actual-size')?.addEventListener('click',event=>{
  const image=document.querySelector('#detail-image');
  const expanded=image.classList.toggle('actual');
  event.currentTarget.setAttribute('aria-pressed',String(expanded));
  event.currentTarget.textContent=expanded?'适应宽度':'原始尺寸';
});
