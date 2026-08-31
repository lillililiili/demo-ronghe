<script setup>
/* 外壳骨架 —— 与旧 index.html 的 #app 内部结构逐字对应：
   header.hdr + div.body ( nav.nav + main.main ( .crumb + .view ) )。 */
import HeaderBar from './HeaderBar.vue';
import NavSidebar from './NavSidebar.vue';
import Breadcrumb from './Breadcrumb.vue';
import PageHost from './PageHost.vue';
</script>

<template>
  <HeaderBar />
  <div class="body">
    <NavSidebar />
    <main class="main">
      <Breadcrumb />
      <PageHost />
    </main>
  </div>
</template>
