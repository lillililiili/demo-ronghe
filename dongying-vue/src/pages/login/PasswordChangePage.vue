<script setup>
import { nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NConfigProvider, NIcon } from 'naive-ui';
import { LockClosedOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5';
import UField from '@/components/form/UField.vue';
import UFormFooter from '@/components/form/UFormFooter.vue';
import { authUser, changePassword } from '@/services/auth.js';
import { validatePassword } from '@/services/passwordPolicy.js';
import { loginThemeOverrides } from '@/ui/theme.js';

const router = useRouter();
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const busy = ref(false);
const error = ref('');
const errorBox = ref(null);

async function submit() {
  if (busy.value) return;
  error.value = '';
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) error.value = '请完整填写当前密码、新密码和确认密码。';
  else if (newPassword.value !== confirmPassword.value) error.value = '两次输入的新密码不一致。';
  else error.value = validatePassword(newPassword.value, authUser.value?.account, '新密码');
  if (error.value) { await nextTick(); errorBox.value?.focus(); return; }
  busy.value = true;
  try {
    await changePassword(currentPassword.value, newPassword.value);
    await router.replace('/login');
  } catch (e) {
    error.value = e.message || '密码修改失败，请重试。';
    await nextTick();
    errorBox.value?.focus();
  } finally { busy.value = false; }
}
</script>

<template>
  <NConfigProvider :theme-overrides="loginThemeOverrides" style="display:contents">
    <main class="password-page" aria-labelledby="password-title">
      <img class="password-background" src="/assets/img/login/coastal-dawn.png" alt="" aria-hidden="true">
      <section class="password-card">
        <div class="password-heading">
          <NIcon :component="ShieldCheckmarkOutline" aria-hidden="true" />
          <div><h1 id="password-title">首次登录，请修改密码</h1><p>修改成功后当前会话会安全退出，请使用新密码重新登录。</p></div>
        </div>
        <form class="password-form" :aria-busy="busy" novalidate @submit.prevent="submit">
          <p v-if="error" ref="errorBox" class="password-error" tabindex="-1" role="alert">{{ error }}</p>
          <UField v-model="currentPassword" type="password" label="当前临时密码" required :disabled="busy"
            :input-props="{ autocomplete: 'current-password', maxlength: 128 }">
            <template #prefix><NIcon :component="LockClosedOutline" /></template>
          </UField>
          <UField v-model="newPassword" type="password" label="新密码" required :disabled="busy"
            help="6–32 位，包含大小写字母、数字和特殊字符，且不能包含账号。"
            :input-props="{ autocomplete: 'new-password', minlength: 6, maxlength: 32 }" />
          <UField v-model="confirmPassword" type="password" label="确认新密码" required :disabled="busy"
            :input-props="{ autocomplete: 'new-password', minlength: 6, maxlength: 32 }" />
          <UFormFooter hide-cancel submit :loading="busy" :confirm-text="busy ? '正在修改…' : '修改密码并重新登录'" />
        </form>
      </section>
    </main>
  </NConfigProvider>
</template>

<style scoped>
.password-page { position:fixed; inset:0; display:grid; place-items:center; padding:24px; overflow:auto; color:var(--login-text); }
.password-background { position:fixed; inset:0; z-index:-1; width:100%; height:100%; object-fit:cover; }
.password-card { width:min(560px, 100%); padding:36px; border:1px solid var(--login-line); border-radius:12px; background:var(--login-card); box-shadow:var(--login-shadow); backdrop-filter:blur(18px); }
.password-heading { display:flex; gap:16px; align-items:flex-start; margin-bottom:28px; }
.password-heading > .n-icon { flex:none; font-size:34px; color:var(--login-link); }
.password-heading h1 { margin:0 0 8px; font-size:24px; }
.password-heading p { margin:0; color:var(--login-muted); line-height:1.7; }
.password-form { display:grid; gap:20px; }
.password-error { margin:0; padding:10px 12px; border:1px solid color-mix(in srgb, var(--login-error), transparent 55%); border-radius:6px; color:var(--login-error); background:color-mix(in srgb, var(--login-error), transparent 90%); }
@media (max-width:560px) { .password-card { padding:26px 22px; } }
</style>
