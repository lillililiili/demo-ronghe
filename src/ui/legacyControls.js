import { createApp, h, reactive, ref } from 'vue';
import { NConfigProvider, NInput, NSelect } from 'naive-ui';
import { theme, themeOverrides } from './theme.js';

const instances = new Map();
const selector = 'input.ip, textarea.ip, select.ip, select.sel';

function dispatch(nativeEl, type) {
  nativeEl.dispatchEvent(new Event(type, { bubbles: true }));
}

function proxyField(nativeEl, state, componentRef) {
  Object.defineProperty(nativeEl, 'value', {
    configurable: true,
    get: () => state.value == null ? '' : state.value,
    set: value => { state.value = value == null ? '' : String(value); }
  });
  Object.defineProperty(nativeEl, 'disabled', {
    configurable: true,
    get: () => state.disabled,
    set: value => { state.disabled = !!value; }
  });
  nativeEl.focus = () => componentRef.value?.focus?.();
}

function createHost(nativeEl) {
  const host = document.createElement('div');
  host.className = 'naive-control-bridge';
  host.style.cssText = nativeEl.getAttribute('style') || '';
  nativeEl.before(host);
  nativeEl.classList.add('native-control-proxy');
  nativeEl.dataset.naiveUpgraded = '1';
  return host;
}

function mountInput(nativeEl) {
  const host = createHost(nativeEl);
  const state = reactive({ value: nativeEl.value || '', disabled: nativeEl.disabled });
  const componentRef = ref(null);
  proxyField(nativeEl, state, componentRef);
  const type = nativeEl.tagName === 'TEXTAREA' ? 'textarea' : nativeEl.type === 'password' ? 'password' : 'text';
  const app = createApp({
    render: () => h(NConfigProvider, { theme, themeOverrides }, {
      default: () => h(NInput, {
        ref: componentRef,
        value: state.value,
        type,
        disabled: state.disabled,
        readonly: nativeEl.readOnly,
        placeholder: nativeEl.getAttribute('placeholder') || '',
        clearable: nativeEl.hasAttribute('data-clearable'),
        autosize: type === 'textarea' ? { minRows: 3, maxRows: 8 } : false,
        'onUpdate:value': value => { state.value = value; dispatch(nativeEl, 'input'); },
        onBlur: () => dispatch(nativeEl, 'change')
      })
    })
  });
  app.mount(host);
  instances.set(nativeEl, { app, host });
}

function mountSelect(nativeEl) {
  const host = createHost(nativeEl);
  const options = Array.from(nativeEl.options).map(option => ({
    label: option.textContent,
    value: option.value,
    disabled: option.disabled
  }));
  const state = reactive({ value: nativeEl.value || options[0]?.value || null, disabled: nativeEl.disabled });
  const componentRef = ref(null);
  proxyField(nativeEl, state, componentRef);
  const app = createApp({
    render: () => h(NConfigProvider, { theme, themeOverrides }, {
      default: () => h(NSelect, {
        ref: componentRef,
        value: state.value,
        options,
        disabled: state.disabled,
        clearable: false,
        placeholder: nativeEl.getAttribute('data-placeholder') || '请选择',
        'onUpdate:value': value => {
          state.value = value;
          dispatch(nativeEl, 'input');
          dispatch(nativeEl, 'change');
        }
      })
    })
  });
  app.mount(host);
  instances.set(nativeEl, { app, host });
}

export function upgradeLegacyControls(root) {
  if (!root?.querySelectorAll) return;
  const candidates = [];
  if (root.matches?.(selector)) candidates.push(root);
  candidates.push(...root.querySelectorAll(selector));
  candidates.forEach(nativeEl => {
    if (nativeEl.dataset.naiveUpgraded || instances.has(nativeEl)) return;
    const type = nativeEl.type || '';
    if (nativeEl.tagName === 'INPUT' && ['checkbox', 'radio', 'range', 'hidden', 'file', 'button', 'submit'].includes(type)) return;
    nativeEl.tagName === 'SELECT' ? mountSelect(nativeEl) : mountInput(nativeEl);
  });
}

export function teardownLegacyControls(root) {
  if (!root) return;
  for (const [nativeEl, instance] of instances) {
    if (root === nativeEl || root === instance.host || root.contains?.(nativeEl) || root.contains?.(instance.host)) {
      instance.app.unmount();
      instances.delete(nativeEl);
    }
  }
}

export function installLegacyControlObserver(root = document.body) {
  upgradeLegacyControls(root);
  const observer = new MutationObserver(records => records.forEach(record => {
    record.removedNodes.forEach(node => node.nodeType === 1 && teardownLegacyControls(node));
    record.addedNodes.forEach(node => node.nodeType === 1 && upgradeLegacyControls(node));
  }));
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    teardownLegacyControls(root);
  };
}
