<script setup>
import { computed, nextTick, reactive, ref } from 'vue';
import { NForm } from 'naive-ui';
import { UField, UFormFooter } from '@/components/form/index.js';
import { validateTemporaryPassword } from '@/services/passwordPolicy.js';

const props = defineProps({
  mode: { type: String, required: true },
  user: { type: Object, default: null },
  roles: { type: Array, default: () => [] },
  organizations: { type: Array, default: () => [] },
  defaultOrgId: { type: String, default: null },
  onSubmit: { type: Function, required: true },
  onCancel: { type: Function, required: true }
});

const model = reactive({
  account: '', name: props.user?.name || '', phone: props.user?.phone || '',
  org_id: props.user?.org_id || props.defaultOrgId || null,
  role_code: props.user?.role_code || null, temporary_password: ''
});
const busy = ref(false);
const error = ref('');
const errorBox = ref(null);
const isCreate = computed(() => props.mode === 'create');
const isProfile = computed(() => props.mode === 'profile');
const isAdminUser = computed(() => props.user?.role_code === 'ROLE-ADMIN');
const roleChanged = computed(() => isProfile.value && !isAdminUser.value && model.role_code !== props.user?.role_code);
const roleOptions = computed(() => {
  const custom = props.roles.filter(x => x.enabled && x.role_code !== 'ROLE-ADMIN')
    .map(x => ({ value: x.role_code, label: x.name }));
  if (!isAdminUser.value) return custom;
  const admin = props.roles.find(x => x.role_code === 'ROLE-ADMIN');
  return admin ? [{ value: admin.role_code, label: admin.name }, ...custom] : custom;
});
const orgOptions = computed(() => props.organizations.filter(x => x.enabled).map(x => ({ value: x.org_id, label: x.name })));
const infoText = computed(() => {
  if (isCreate.value) return '创建后立即生效，并自动记录审计日志。';
  if (roleChanged.value) return '保存后立即生效；角色变化会撤销该用户的旧会话，并自动记录审计日志。';
  return '';
});

async function fail(message) {
  error.value = message;
  await nextTick();
  errorBox.value?.focus();
}

async function submit() {
  if (busy.value) return;
  error.value = '';
  if ((isCreate.value || isProfile.value) && (!model.name.trim() || !model.org_id)) return fail('姓名和所属组织为必填项。');
  if (isCreate.value && (!model.account.trim() || !model.temporary_password)) return fail('登录账号和临时密码为必填项。');
  if (isCreate.value) {
    const passwordError = validateTemporaryPassword(model.temporary_password, model.account.trim());
    if (passwordError) return fail(passwordError);
  }
  if (!isAdminUser.value && !model.role_code) return fail('角色为必填项。');
  busy.value = true;
  try {
    if (isCreate.value) {
      await props.onSubmit({
        account: model.account.trim(), name: model.name.trim(), phone: model.phone.trim(),
        org_id: model.org_id, role_code: model.role_code, temporary_password: model.temporary_password
      });
    } else {
      const payload = {
        name: model.name.trim(), phone: model.phone.trim(), org_id: model.org_id,
        expected_version: props.user.version
      };
      if (!isAdminUser.value) payload.role_code = model.role_code;
      await props.onSubmit(payload);
    }
  } catch (e) { await fail(e.message || '操作失败，请重试。'); }
  finally { busy.value = false; }
}
</script>

<template>
  <n-form class="user-editor" :show-feedback="false" @submit.prevent="submit">
    <p v-if="error" ref="errorBox" class="warnbox" tabindex="-1" role="alert">{{ error }}</p>
    <div class="user-editor-grid">
      <UField v-if="isCreate" v-model="model.account" label="登录账号" required placeholder="创建后不可修改" :disabled="busy" />
      <UField v-model="model.name" label="姓名" required :disabled="busy" />
      <UField v-model="model.phone" label="联系电话" :disabled="busy" />
      <UField v-model="model.org_id" label="所属组织" type="select" required :options="orgOptions" :disabled="busy" />
      <UField v-model="model.role_code" label="角色" type="select" required :options="roleOptions"
        :disabled="busy || isAdminUser" :help="isAdminUser ? '超级管理员角色不能修改。' : ''" />
      <UField v-if="isCreate" v-model="model.temporary_password" type="password" label="临时密码" required :disabled="busy"
        help="6–32 位，需包含大小写字母、数字和特殊字符。" :input-props="{ minlength: 6, maxlength: 32, autocomplete: 'new-password' }" />
    </div>
    <p v-if="infoText" class="info-line">{{ infoText }}</p>
    <UFormFooter :loading="busy" :confirm-text="busy ? '正在保存…' : (isProfile ? '保存资料' : '保存并立即生效')" @cancel="onCancel" @confirm="submit" />
  </n-form>
</template>

<style scoped>
.user-editor { display:grid; gap:18px; }
.user-editor-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px; }
@media (max-width:660px) { .user-editor-grid { grid-template-columns:1fr; } }
</style>
