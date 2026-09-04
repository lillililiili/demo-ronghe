<script setup>
import { h, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NConfigProvider, NIcon } from 'naive-ui';
import { EyeOffOutline, EyeOutline, LockClosedOutline, PersonOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5';
import UField from '@/components/form/UField.vue';
import UControl from '@/components/form/UControl.vue';
import UFormFooter from '@/components/form/UFormFooter.vue';
import { loginThemeOverrides } from '@/ui/theme.js';
import { openModal, closeModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import { DEMO_PASSWORD, forgetAccount, login, rememberedAccount } from '@/services/auth.js';
import { loginDestination } from '@/router/index.js';

const route = useRoute();
const router = useRouter();
const account = ref(rememberedAccount());
const password = ref('');
const remember = ref(!!account.value);
const passwordVisible = ref(false);
const busy = ref(false);
const error = ref('');
const invalidField = ref('');
const accountField = ref(null);
const passwordField = ref(null);

watch(remember, value => { if (!value) forgetAccount(); });
watch([account, password], () => { error.value = ''; invalidField.value = ''; });

function showHelp() {
  openModal({
    title: '忘记密码',
    width: '480px',
    render: () => h('div', { style: 'display:grid;gap:14px;line-height:1.8' }, [
      h('p', '密码请联系系统管理员重置。平台不会通过页面显示、邮件或短信返回原密码。'),
      h('p', ['本地超级管理员：', h('strong', 'admin1'), '　开发密码：', h('strong', DEMO_PASSWORD)]),
      h('p', '该账号和密码仅用于本地合成数据，禁止用于共享或生产环境。'),
      h('p', { style: 'font-size:13px;color:var(--txt-2)' }, '“记住账号”只在本机保存账号，不保存密码或登录令牌。')
    ])
  });
}

async function submit() {
  if (busy.value) return;
  error.value = '';
  invalidField.value = !account.value.trim() ? 'account' : !password.value ? 'password' : '';
  if (invalidField.value) {
    error.value = invalidField.value === 'account' ? '请输入登录账号。' : '请输入密码。';
    (invalidField.value === 'account' ? accountField : passwordField).value?.focus();
    return;
  }
  busy.value = true;
  try {
    const result = await login({ account: account.value, password: password.value, remember: remember.value });
    password.value = '';
    passwordVisible.value = false;
    if (!result.persisted) toast('浏览器不允许保存会话，刷新后需重新登录。');
    await router.replace(loginDestination(route.query.redirect));
  } catch (e) {
    error.value = e.message || '登录未完成，请重试。';
    invalidField.value = 'password';
  } finally {
    busy.value = false;
    if (error.value) { await nextTick(); passwordField.value?.focus(); }
  }
}

onBeforeUnmount(() => {
  password.value = '';
  closeModal();
});
</script>

<template>
  <NConfigProvider :theme-overrides="loginThemeOverrides" style="display:contents">
    <main class="login-page" aria-labelledby="login-title">
      <img class="login-background" src="/assets/img/login/coastal-dawn.png" alt="" aria-hidden="true"
        width="1586" height="992" fetchpriority="high">
      <section class="login-brand">
        <img class="login-logo" src="/assets/img/brand/logo-mark.png" alt="平台标志" width="1251" height="559">
        <h1 id="login-title"><span>东营无人机融合感知与</span><span>低空安全管理平台</span></h1>
      </section>

      <section class="login-card" aria-label="账号登录">
        <form class="login-form" @submit.prevent="submit" :aria-busy="busy" novalidate>
          <UField ref="accountField" id="login-account" v-model="account" label="登录账号" placeholder="登录账号" sr-only size="large"
            :disabled="busy" :status="invalidField === 'account' ? 'error' : undefined"
            :input-props="{ name: 'username', autocomplete: 'username', maxlength: 80, spellcheck: false, 'aria-required': true,
              'aria-invalid': invalidField === 'account', 'aria-describedby': error ? 'login-error' : undefined }">
            <template #prefix><NIcon class="login-field-icon" :size="24" :component="PersonOutline" aria-hidden="true" /></template>
          </UField>
          <UField ref="passwordField" id="login-password" v-model="password" label="密码" placeholder="密码" sr-only size="large"
            :type="passwordVisible ? 'text' : 'password'" :disabled="busy" :status="invalidField === 'password' ? 'error' : undefined"
            :input-props="{ name: 'password', autocomplete: 'current-password', maxlength: 128, 'aria-required': true,
              'aria-invalid': invalidField === 'password', 'aria-describedby': error ? 'login-error' : undefined }">
            <template #prefix><NIcon class="login-field-icon" :size="24" :component="LockClosedOutline" aria-hidden="true" /></template>
            <template #suffix>
              <button class="login-eye" type="button" :disabled="busy" :aria-label="passwordVisible ? '隐藏密码' : '显示密码'"
                :aria-pressed="passwordVisible" @click="passwordVisible = !passwordVisible">
                <NIcon :size="24" :component="passwordVisible ? EyeOutline : EyeOffOutline" aria-hidden="true" />
              </button>
            </template>
          </UField>
          <div class="login-options">
            <UControl v-model="remember" type="checkbox" box-label="记住账号" :disabled="busy" />
            <button class="login-forgot" type="button" :disabled="busy" @click="showHelp">忘记密码</button>
          </div>
          <p v-if="error" id="login-error" class="login-error" role="alert">{{ error }}</p>
          <UFormFooter class="login-submit" hide-cancel submit size="large" :loading="busy" :confirm-text="busy ? '正在登录…' : '登录'" />
        </form>
      </section>

      <footer class="login-organization">
        <NIcon :component="ShieldCheckmarkOutline" aria-hidden="true" />
        <span>东营市低空安全管理中心</span>
      </footer>
    </main>
  </NConfigProvider>
</template>

<style scoped>
.login-page {
  position: fixed;
  inset: 0;
  isolation: isolate;
  overflow: auto;
  color: var(--login-text);
  background: var(--canvas);
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
}
.login-background { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; z-index: -1; pointer-events: none; }
.login-brand { position: absolute; top: 10.6%; left: 4.3%; }
.login-logo { display: block; width: clamp(180px, 18vw, 320px); height: auto; margin-left: -1.2vw; }
.login-brand h1 { margin: 22px 0 18px; font-size: clamp(32px, 3.05vw, 60px); font-weight: 650; line-height: 1.4; letter-spacing: .035em; }
.login-brand h1 span { display: block; }
.login-card { position: absolute; width: clamp(420px, 31vw, 600px); right: 6.9%; top: 50%; transform: translateY(-50%); padding: clamp(36px, 2.8vw, 54px); border: 1px solid var(--login-line); border-radius: 10px; background: var(--login-card); box-shadow: var(--login-shadow); backdrop-filter: blur(18px); }
.login-form { display: flex; flex-direction: column; gap: 28px; }
.login-field-icon { color: var(--login-muted); margin-right: 6px; }
.login-eye { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; background: none; color: var(--login-muted); cursor: pointer; }
.login-options { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-height: 32px; }
.login-forgot { min-height: 44px; padding: 0; border: 0; background: none; color: var(--login-link); font: inherit; font-size: 16px; cursor: pointer; }
.login-forgot:hover { text-decoration: underline; text-underline-offset: 4px; }
.login-submit { margin: 12px 0 0; padding: 0; border: 0; }
.login-submit :deep(.n-button) { width: 100%; font-weight: 600; }
.login-error { margin: -8px 0; color: var(--login-error); font-size: 13px; line-height: 1.6; }
.login-organization { position: absolute; left: 4.3%; bottom: 7%; display: flex; align-items: center; gap: 14px; font-size: clamp(15px, 1.2vw, 21px); }
.login-organization .n-icon { font-size: 28px; color: var(--login-link); }
.login-page button:focus-visible { outline: 2px solid var(--login-link); outline-offset: 5px; border-radius: 4px; }
.login-page button:disabled { cursor: wait; }
.login-page :deep(.n-checkbox__label) { font-size: 16px; }
@media (max-width: 900px), (max-height: 590px) {
  .login-page { display: flex; flex-direction: column; align-items: center; padding: 36px 24px 24px; gap: 30px; }
  .login-brand, .login-card, .login-organization { position: static; }
  .login-brand { width: min(520px, 100%); }
  .login-logo { width: 166px; margin-left: -10px; }
  .login-brand h1 { font-size: clamp(23px, 4.5vw, 36px); margin: 16px 0 8px; }
  .login-card { width: min(520px, 100%); padding: 28px; transform: none; }
  .login-background { object-position: 60% center; }
  .login-organization { font-size: 14px; gap: 9px; margin-top: auto; }
}
@media (max-width: 400px) {
  .login-page { padding: 28px 20px 22px; gap: 24px; }
  .login-card { padding: 22px; }
  .login-form { gap: 20px; }
}
</style>
