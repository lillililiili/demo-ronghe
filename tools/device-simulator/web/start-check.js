(function (root) {
  'use strict';
  /* 点“开始模拟”时先问服务端（start_check.py）：有没有一定会失败的设置（挡住，什么都不发），
     有没有悄悄不生效的设置（提醒，由人决定）。这里只管怎么给人看、怎么一键改好；检查本身只读。 */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const REPORTING_KINDS = ['radar', 'tdoa', '5ga'];

  /* 把服务端点名的停用设备从草稿里去掉（页面上没有别的地方能删设备）。
     用它们上报的目标改用场景里第一台还能报目标的设备，没有就清空，让人重新选；整组设备都被删光的设备组一并去掉。 */
  function removeRetiredDevices(scene, devices, reportingKinds = REPORTING_KINDS) {
    const gone = new Set((devices || []).map(item => `${item.site_id}|${item.device_id}`));
    const result = {removed: [], emptiedSites: [], retargeted: [], unassigned: []};
    const ids = new Set(), emptied = new Set();
    for (const site of scene.sites || []) {
      const before = (site.devices || []).length;
      site.devices = (site.devices || []).filter(device => {
        if (!gone.has(`${site.id}|${device.id}`)) return true;
        result.removed.push({site: site.name, device: device.name});
        ids.add(device.id);
        return false;
      });
      if (before && !site.devices.length) { emptied.add(site); result.emptiedSites.push(site.name); }
    }
    scene.sites = (scene.sites || []).filter(site => !emptied.has(site));
    const remaining = scene.sites.flatMap(site => site.devices);
    const reporting = remaining.find(device => reportingKinds.includes(device.kind));
    for (const target of scene.targets || []) {
      if (ids.has(target.secondaryDeviceId)) target.secondaryDeviceId = '';
      if (!ids.has(target.deviceId)) continue;
      target.deviceId = reporting?.id || '';
      (reporting ? result.retargeted : result.unassigned).push(reporting ? {target: target.name, to: reporting.name} : target.name);
    }
    for (const risk of scene.risks || []) if (ids.has(risk.deviceId)) risk.deviceId = reporting?.id || remaining[0]?.id || '';
    return result;
  }

  /* 删完以后告诉她改了什么、还要她看哪里。 */
  function removalSummary(result) {
    const lines = [];
    if (result.removed.length) lines.push('已从草稿里删掉：' + result.removed.map(item => `“${item.device}”（${item.site}）`).join('、') + '。');
    if (result.emptiedSites.length) lines.push('设备全被删光的设备组也去掉了：' + result.emptiedSites.join('、') + '。');
    if (result.retargeted.length) lines.push('这些目标原来用被删掉的设备上报，已改成：' + result.retargeted.map(item => `“${item.target}”→“${item.to}”`).join('、') + '。');
    if (result.unassigned.length) lines.push('这些目标现在没有可用的上报设备，请在右边“上报设备”里重新选一台：' + result.unassigned.map(name => `“${name}”`).join('、') + '。');
    return lines;
  }

  /* 把这些任务的时段改成从现在起一小时。 */
  function applyNowWindow(scene, planIds, ms, planTime = root.PlanTime) {
    const window = planTime.nowWindow(ms), ids = new Set(planIds || []), changed = [];
    for (const plan of scene.plans || []) if (ids.has(plan.id)) { Object.assign(plan, window); changed.push(plan.name || plan.id); }
    return {window, changed};
  }

  /* 提醒里的“按建议改”要做哪几件事，主按钮怎么写；服务端说现在改不了的（can_fix 为 false，比如收发端还开着、改不了模式）不提供一键改。 */
  function fixesFor(result) {
    const codes = new Set((result.notices || []).filter(item => item.can_fix !== false).map(item => item.code));
    const fixes = [];
    if (codes.has('NORMAL_MODE_IGNORES')) fixes.push({code: 'MODE', label: '改成“异常”模式'});
    if (codes.has('PLAN_OUTSIDE_WINDOW')) fixes.push({code: 'WINDOW', label: '把任务改成从现在起一小时'});
    const primary = fixes.length > 1 ? '两项都按建议改好并开始' : fixes.length ? `${fixes[0].label}并开始` : '开始';
    return {fixes, primary};
  }

  const block = item => `<section class="start-check-block"><h3>${esc(item.title)}</h3><p>${esc(item.message)}</p>`
    + (item.items?.length ? `<ul class="start-check-list">${item.items.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : '') + '</section>';

  if (typeof module !== 'undefined' && module.exports) { module.exports = {removeRetiredDevices, removalSummary, applyNowWindow, fixesFor, block}; return; }

  let busy = false;
  const fail = error => { const note = document.querySelector('#dialog .inline-error'); if (note) note.textContent = error.message; };

  function showBlocking(result) {
    const retired = result.blocking.find(item => item.code === 'RETIRED_DEVICE');
    openDialog('现在还不能开始', `<div class="start-check">${result.blocking.map(block).join('')}
      <p class="field-note">这次什么都没有发出去。${retired ? '点下面的按钮可以直接把这些设备从草稿里删掉，也可以回去自己处理。' : ''}</p>
      <p class="inline-error" role="alert"></p>
      <div class="form-actions">${btn('close-dialog', '回去修改')}${retired ? '<button type="button" class="primary" data-start-check="remove">把这些设备从草稿里删掉</button>' : ''}</div></div>`);
    if (!retired) return;
    document.querySelector('[data-start-check=remove]').addEventListener('click', () => {
      const done = removeRetiredDevices(state, retired.devices);
      dirty(); render(); window.SimulatorMap?.fit(scenePoints());
      openDialog('已处理', `<div class="start-check">${removalSummary(done).map(line => `<p>${esc(line)}</p>`).join('')}
        <p class="field-note">改动只在这个草稿里，还没有开始模拟。检查一下目标和设备，再点“开始模拟”。</p>
        <div class="form-actions">${btn('close-dialog', '知道了', 'primary')}</div></div>`);
    });
  }

  function showNotices(result, deps) {
    const {fixes, primary} = fixesFor(result), codes = new Set(fixes.map(fix => fix.code));
    openDialog('开始前请确认', `<div class="start-check">${result.notices.map(block).join('')}
      <p class="inline-error" role="alert"></p>
      <div class="form-actions">${btn('close-dialog', '取消，回去修改')}<button type="button" data-start-check="plain">不改，照样开始</button>${fixes.length ? `<button type="button" class="primary" data-start-check="fix">${esc(primary)}</button>` : ''}</div></div>`);
    const guard = work => async event => {
      if (busy) return;
      const button = event.currentTarget;  // await 之后 event.currentTarget 就是 null 了，先存下来
      busy = true; button.disabled = true;
      try { await work(); closeDialog(); deps.onStart(); }
      catch (error) { fail(error); button.disabled = false; }
      finally { busy = false; }
    };
    document.querySelector('[data-start-check=plain]').addEventListener('click', guard(async () => {}));
    document.querySelector('[data-start-check=fix]')?.addEventListener('click', guard(async () => {
      if (codes.has('MODE')) {
        const config = await api('realtime/config');
        await api('realtime/config', {...config, mode: 'abnormal'});
      }
      if (codes.has('WINDOW')) {
        const plans = result.notices.find(item => item.code === 'PLAN_OUTSIDE_WINDOW').plans;
        applyNowWindow(state, plans, result.checked_at);
        dirty(); render();
      }
    }));
  }

  /* 点“开始模拟”后的入口：有要挡的就挡，有要提醒的就问；都没有返回 false，由调用方直接开始。 */
  function show(result, deps) {
    if (result.blocking?.length) { showBlocking(result); return true; }
    if (result.notices?.length) { showNotices(result, deps); return true; }
    return false;
  }
  root.StartCheck = {show, removeRetiredDevices, applyNowWindow, fixesFor};
})(typeof window !== 'undefined' ? window : globalThis);
