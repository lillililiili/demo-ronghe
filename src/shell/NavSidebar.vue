<script setup>
/* 侧栏导航 —— 结构与 class 逐字对应旧 renderNav() 的输出（.g1/.l1/.l2/.gh/.ca/
   .on/.has/.open/.mini/.navfoot/.fold），CSS 原样命中。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { NAV, routeKey } from './navModel.js';
import { useAppStore } from '../stores/app.js';

const route = useRoute();
const store = useAppStore();
const cur = computed(() => routeKey(route));
const icon = name => window.UI.icon(name);

function toggleGrp(t) {
  store.openGrp = (store.openGrp === t) ? '' : t;
}
function fold() {
  store.navMini = !store.navMini;
  window.dispatchEvent(new Event('resize'));
}
</script>

<template>
  <nav class="nav" id="nav" :class="{ mini: store.navMini }">
    <template v-for="n in NAV" :key="n.t">
      <a v-if="n.k" class="l1" :class="{ on: cur === n.k }" :href="'#/' + n.k" :data-k="n.k">
        <i v-html="icon(n.icon)"></i><span>{{ n.t }}</span></a>
      <div v-else class="g1" :class="{ open: store.openGrp === n.t, has: n.kids.some(c => c.k === cur) }">
        <div class="l1 gh" :data-grp="n.t" @click="toggleGrp(n.t)"><i v-html="icon(n.icon)"></i><span>{{ n.t }}</span><b class="ca">›</b></div>
        <div class="l2"><a v-for="c in n.kids" :key="c.k" :class="{ on: cur === c.k }" :href="'#/' + c.k" :data-k="c.k"><em></em><span>{{ c.t }}</span></a></div>
      </div>
    </template>
    <div class="navfoot">
      <div class="fold" id="fold" @click="fold">{{ store.navMini ? '»' : '« 收起菜单' }}</div>
    </div>
  </nav>
</template>
