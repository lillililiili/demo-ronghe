<script setup>
/* 固定分组导航：标题仅作分类，业务页面入口始终可见。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { NAV, routeKey } from '@/config/navModel.js';
import { useAppStore } from '@/stores/app.js';
import { canAccessRoute } from '@/services/accessControl.js';

const route = useRoute();
const store = useAppStore();
const cur = computed(() => routeKey(route));
const icon = name => window.UI.icon(name);
const visibleNav = computed(() => {
  store.accessRevision;
  return NAV.map(n => n.k
    ? (canAccessRoute(n.k) ? n : null)
    : Object.assign({}, n, { kids: n.kids.filter(c => canAccessRoute(c.k)) }))
    .filter(n => n && (n.k || n.kids.length));
});
</script>

<template>
  <nav class="nav" id="nav" aria-label="业务导航">
    <template v-for="n in visibleNav" :key="n.t">
      <a v-if="n.k" class="l1" :class="{ on: cur === n.k }" :href="'#/' + n.k" :data-k="n.k"
        :aria-label="n.t" :aria-current="cur === n.k ? 'page' : undefined">
        <i aria-hidden="true" v-html="icon(n.icon)"></i><span>{{ n.t }}</span>
      </a>
      <section v-else class="g1" :aria-label="n.t">
        <h2 class="grp">{{ n.t }}</h2>
        <a v-for="c in n.kids" :key="c.k" class="l1" :class="{ on: cur === c.k }" :href="'#/' + c.k" :data-k="c.k"
          :aria-label="c.t" :aria-current="cur === c.k ? 'page' : undefined">
          <i aria-hidden="true" v-html="icon(c.icon || n.icon)"></i><span>{{ c.t }}</span>
        </a>
      </section>
    </template>
  </nav>
</template>

<style scoped>
.nav { --nav-accent: var(--blue); }
.nav .g1 { flex: none; }
.nav .grp { margin: 0; padding: 14px 10px 6px; font-size: 11px; line-height: 1.5; font-weight: 500; letter-spacing: 1px; color: var(--txt-3); }
.nav .g1:first-child .grp { padding-top: 4px; }
.nav a.l1 { flex: none; }
.nav a.l1.on { border-color: color-mix(in srgb, var(--nav-accent) 70%, transparent); background: var(--nav-selected); box-shadow: inset 3px 0 var(--blue); color: var(--txt); }
.nav a.l1:focus-visible { outline: 2px solid var(--nav-accent); outline-offset: -2px; }
</style>
