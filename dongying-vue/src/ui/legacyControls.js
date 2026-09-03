import { createApp, h, reactive, ref } from 'vue';
import { NCheckbox, NConfigProvider, NInput, NRadio, NSelect } from 'naive-ui';
import { SELECT_DROPDOWN, selectMenuMinWidth, selectMenuProps } from '@/components/form/selectProps.js';
import { theme, themeOverrides } from './theme.js';

const instances = new Map();
const selector = 'input.ip, textarea.ip, select.ip, select.sel, input[type="checkbox"], input[type="radio"]';
const skipInside = '.naive-control-bridge, .n-checkbox, .n-radio, .n-input, .n-select, .n-input-number, .n-checkbox-group, .n-radio-group';
const nativeChecked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
let paused = 0;

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

function createHost(nativeEl, kind) {
  const host = document.createElement('div');
  host.className = 'naive-control-bridge' + (kind ? ' is-' + kind : '');
  if (kind !== 'check') host.style.cssText = nativeEl.getAttribute('style') || '';
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
  host.style.minWidth = selectMenuMinWidth(options) + 'px';
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
        consistentMenuWidth: SELECT_DROPDOWN.consistentMenuWidth,
        menuProps: selectMenuProps(options),
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

function syncRadioGroup(name) {
  if (!name) return;
  document.querySelectorAll('input[type="radio"][name="' + name.replace(/"/g, '\\"') + '"]').forEach(el => {
    const inst = instances.get(el);
    if (inst && inst.syncFromNative) inst.syncFromNative();
  });
}

function mountCheckable(nativeEl) {
  const isRadio = nativeEl.type === 'radio';
  const host = createHost(nativeEl, 'check');
  const state = reactive({ checked: !!nativeEl.checked, disabled: nativeEl.disabled });
  const syncFromNative = () => { state.checked = !!nativeChecked.get.call(nativeEl); };
  Object.defineProperty(nativeEl, 'checked', {
    configurable: true,
    get: () => nativeChecked.get.call(nativeEl),
    set: value => {
      nativeChecked.set.call(nativeEl, value);
      state.checked = !!value;
      if (isRadio && value) syncRadioGroup(nativeEl.name);
    }
  });
  nativeEl.addEventListener('change', () => {
    state.checked = !!nativeChecked.get.call(nativeEl);
    if (isRadio) syncRadioGroup(nativeEl.name);
  });
  host.addEventListener('click', e => e.stopPropagation());
  const label = nativeEl.closest('label');
  if (label && !label.dataset.naiveLabelBound) {
    label.dataset.naiveLabelBound = '1';
    label.addEventListener('click', e => {
      if (e.target.closest('.naive-control-bridge')) return;
      const control = label.querySelector('input[type="checkbox"],input[type="radio"]');
      if (!control || control.disabled) return;
      e.preventDefault();
      if (control.type === 'radio') control.checked = true;
      else control.checked = !control.checked;
      dispatch(control, 'input');
      dispatch(control, 'change');
    });
  }
  const Comp = isRadio ? NRadio : NCheckbox;
  const app = createApp({
    render: () => h(NConfigProvider, { theme, themeOverrides }, {
      default: () => h(Comp, {
        checked: state.checked,
        disabled: state.disabled,
        size: nativeEl.closest('td.ck, th.ck') ? 'small' : 'medium',
        'onUpdate:checked': value => {
          if (isRadio && !value) return;
          nativeEl.checked = value;
          dispatch(nativeEl, 'input');
          dispatch(nativeEl, 'change');
        }
      })
    })
  });
  app.mount(host);
  instances.set(nativeEl, { app, host, syncFromNative });
}

function shouldSkip(nativeEl) {
  if (!nativeEl || nativeEl.dataset.naiveUpgraded || instances.has(nativeEl)) return true;
  if (nativeEl.closest(skipInside)) return true;
  const type = nativeEl.type || '';
  return nativeEl.tagName === 'INPUT' && ['range', 'hidden', 'file', 'button', 'submit'].includes(type);
}

export function upgradeLegacyControls(root) {
  if (paused || !root?.querySelectorAll) return;
  const candidates = [];
  if (root.matches?.(selector)) candidates.push(root);
  candidates.push(...root.querySelectorAll(selector));
  paused++;
  try {
    candidates.forEach(nativeEl => {
      if (shouldSkip(nativeEl)) return;
      const type = nativeEl.type || '';
      if (type === 'checkbox' || type === 'radio') mountCheckable(nativeEl);
      else if (nativeEl.tagName === 'SELECT') mountSelect(nativeEl);
      else mountInput(nativeEl);
    });
  } finally { paused--; }
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
