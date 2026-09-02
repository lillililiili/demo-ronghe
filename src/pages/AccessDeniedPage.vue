<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { routeKey, pageTitle } from '@/config/navModel.js';
import { accessBlocker } from '@/services/accessControl.js';

const route = useRoute();
const key = computed(() => routeKey(route));
const title = computed(() => pageTitle(key.value));
const reason = computed(() => accessBlocker(key.value));
const shieldIcon = window.UI.icon('shield');
</script>

<template>
  <div class="view access-denied-view">
    <section class="panel access-denied" role="alert" aria-live="polite">
      <span class="access-denied__icon" aria-hidden="true" v-html="shieldIcon"></span>
      <h2>无法访问“{{ title }}”</h2>
      <p>{{ reason }}。如需访问，请联系系统管理员调整角色权限。</p>
      <a class="btn pri" href="#/workbench">返回我的工作台</a>
    </section>
  </div>
</template>
