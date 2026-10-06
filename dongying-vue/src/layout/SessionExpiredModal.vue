<script setup>
/* 登录过期时就地重新登录（ZT-29）。会话被服务端拒绝后不卸载业务外壳：当前页面、开着的表单弹窗和已填内容都保留，
   重新登录后可以再提交。公共弹窗（src/ui/modal.js）是单例，打开新弹窗会关掉用户正在填写的表单，
   所以这里单独用 NModal 叠在最上层，层级高于旧 mask 100 / drawer 150 / toast 200 / carousel 300。 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NModal } from 'naive-ui';
import UField from '@/components/form/UField.vue';
import UFormFooter from '@/components/form/UFormFooter.vue';
import { authExpired, authExpiredWhileSubmitting, authUser, logout, needsPasswordChange, registerReloginHost, relogin } from '@/services/auth.js';
import { toast } from '@/ui/nv.js';

const route = useRoute();
const router = useRouter();
const unregister = registerReloginHost();
onBeforeUnmount(unregister);

const password = ref('');
const error = ref('');
const busy = ref(false);
const passwordField = ref(null);
const show = computed(() => authExpired.value && !!authUser.value);
const account = computed(() => authUser.value?.account || '');

watch(show, async value => {
  password.value = '';
  error.value = '';
  if (value) { await nextTick(); passwordField.value?.focus(); }
});
watch(password, () => { error.value = ''; });

async function submit() {
  if (busy.value) return;
  if (!password.value) { error.value = '请输入密码。'; passwordField.value?.focus(); return; }
  const resubmit = authExpiredWhileSubmitting.value;
  busy.value = true;
  error.value = '';
  try {
    const { sameUser } = await relogin(password.value);
    password.value = '';
    if (needsPasswordChange()) await router.replace('/change-password');
    else if (!sameUser) await router.replace('/');
    else toast(resubmit ? '已重新登录，请再提交一次刚才的内容。' : '已重新登录，可以继续操作。', 'ok');
  } catch (e) {
    error.value = e.message || '重新登录没有完成，请重试。';
    await nextTick();
    passwordField.value?.focus();
  } finally { busy.value = false; }
}

async function switchAccount() {
  if (busy.value) return;
  const redirect = route.fullPath;
  await logout();
  await router.replace({ path: '/login', query: { redirect } });
}
</script>

<template>
  <n-modal :show="show" preset="card" title="登录已过期" :closable="false" :mask-closable="false" :close-on-esc="false"
    :auto-focus="false" :z-index="400" class="session-expired-modal" style="width:440px;max-width:94vw">
    <form class="session-expired" :aria-busy="busy" novalidate @submit.prevent="submit">
      <p v-if="authExpiredWhileSubmitting" class="warnbox session-expired__note" role="alert">
        刚才的提交没有保存。页面上已填写的内容都还在，重新登录后请再提交一次。
      </p>
      <p v-else class="info-line session-expired__note" role="alert">
        为了账号安全，请重新输入密码。当前页面和已填写的内容都还在，重新登录后可以继续操作。
      </p>
      <UField :model-value="account" label="账号" disabled />
      <UField ref="passwordField" v-model="password" type="password" label="密码" required :disabled="busy"
        :status="error ? 'error' : undefined" :input-props="{ autocomplete: 'current-password', maxlength: 128 }" />
      <p v-if="error" class="session-expired__error" role="alert">{{ error }}</p>
      <UFormFooter submit cancel-text="换个账号登录" :loading="busy" :confirm-text="busy ? '正在登录' : '重新登录'" @cancel="switchAccount" />
    </form>
  </n-modal>
</template>

<style scoped>
.session-expired{display:grid;gap:16px}
.session-expired__note{margin:0;padding:9px 11px;line-height:1.7}
.session-expired__error{margin:-6px 0 0;color:var(--red);font-size:13px;line-height:1.6}
</style>
