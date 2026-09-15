<script setup>
/* 侧栏导航 —— 结构与 class 逐字对应旧 renderNav() 的输出（.g1/.l1/.l2/.gh/.ca/
   .on/.has/.open/.mini/.navfoot/.fold），CSS 原样命中。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { NAV, PAGE_THEME, routeKey } from '@/config/navModel.js';
import { useAppStore } from '@/stores/app.js';
import { canAccessRoute } from '@/services/accessControl.js';

const route = useRoute();
const store = useAppStore();
const cur = computed(() => routeKey(route));
const moduleColor = n => ({ sensing: 'cyan', flight: 'indigo', incident: 'orange', analytics: 'purple' }[PAGE_THEME[n.k || n.kids?.[0]?.k]] || 'blue');
const icon = name => window.UI.icon(name);
const visibleNav = computed(() => {
  store.accessRevision;
  return NAV.map(n => n.k
    ? (canAccessRoute(n.k) ? n : null)
    : Object.assign({}, n, { kids: n.kids.filter(c => canAccessRoute(c.k)) }))
    .filter(n => n && (n.k || n.kids.length));
});

function toggleGrp(t) {
  store.closedNavGroups = store.closedNavGroups.includes(t)
    ? store.closedNavGroups.filter(group => group !== t)
    : [...store.closedNavGroups, t];
}
function fold() {
  store.navMini = !store.navMini;
  window.dispatchEvent(new Event('resize'));
}
</script>

<template>
  <nav class="nav" id="nav" :class="{ mini: store.navMini }">
    <template v-for="n in visibleNav" :key="n.t">
      <a v-if="n.k" class="l1" :class="{ on: cur === n.k }" :href="'#/' + n.k" :data-k="n.k"
        :title="store.navMini ? n.t : undefined" :aria-label="n.t">
        <i v-html="icon(n.icon)"></i><span>{{ n.t }}</span></a>
      <div v-else class="g1" :style="{ '--nav-accent': `var(--${moduleColor(n)})` }" :class="{ open: !store.closedNavGroups.includes(n.t), has: n.kids.some(c => c.k === cur) }">
        <div class="l1 gh" role="button" tabindex="0" :aria-expanded="!store.closedNavGroups.includes(n.t)" @keydown.enter.prevent="toggleGrp(n.t)" @keydown.space.prevent="toggleGrp(n.t)" :title="store.navMini ? n.t : undefined" :aria-label="n.t" :data-grp="n.t" @click="toggleGrp(n.t)"><i v-html="icon(n.icon)"></i><span>{{ n.t }}</span><b class="ca">›</b></div>
        <div class="l2"><a v-for="c in n.kids" :key="c.k" :class="{ on: cur === c.k }" :href="'#/' + c.k" :data-k="c.k" :title="store.navMini ? c.t : undefined" :aria-label="c.t"><em></em><span>{{ c.t }}</span></a></div>
      </div>
    </template>
    <div class="navfoot">
      <div class="fold" id="fold" :title="store.navMini ? '展开菜单' : undefined" @click="fold">{{ store.navMini ? '»' : '« 收起菜单' }}</div>
    </div>
  </nav>
</template>
