(function (root) {
  'use strict';
  function viewModel(data = {}) {
    const enabled = data.video_config?.enabled === true;
    const active = ['RUNNING', 'PAUSED'].includes(data.phase);
    const devices = data.eo?.devices || [];
    const errors = devices.filter(d => d.video === 'FAILED');
    const publishing = devices.filter(d => d.video === 'PUBLISHING').length;
    let summary = '视频推流已关闭';
    if (active && typeof data.eo?.enabled === 'boolean' && data.eo.enabled !== enabled) {
      summary = enabled ? '视频推流开启中' : '视频推流停止中';
    } else if (enabled) {
      if (data.phase === 'PAUSED') summary = '视频已暂停，等待继续模拟';
      else if (data.phase !== 'RUNNING') summary = '视频已开启，等待开始模拟';
      else if (errors.length) summary = `视频推流失败 · ${errors.length} 台`;
      else if (publishing) summary = `正在推流 · ${publishing} 台 · 播放状态以业务前台为准`;
      else summary = devices.some(d => d.tracking === 'TRACKING') ? '正在准备视频推流' : '视频已开启，等待跟踪';
    }
    const available = data.video_control_available === true;
    return {
      label: enabled ? '停止视频推流' : '开启视频推流',
      summary: available ? summary : '视频开关尚未加载，请重启模拟器服务',
      error: errors.map(d => `${d.device}：${d.error || '请检查视频设置和媒体服务'}`).join('；'),
      disabled: !available || ['PREPARING', 'STOPPING'].includes(data.phase) || (!enabled && !data.connected),
      settingsDisabled: !available || enabled || !data.connected || ['PREPARING', 'STOPPING'].includes(data.phase)
    };
  }
  if (typeof module !== 'undefined') { module.exports = {viewModel}; return; }
  let busy = false, current = {}, requestError = '';
  const toggle = document.createElement('button');
  toggle.id = 'video-toggle'; toggle.type = 'button'; toggle.textContent = '开启视频推流';
  document.querySelector('#stop-button').before(toggle);
  const box = document.createElement('section');
  box.className = 'realtime-bar'; box.setAttribute('aria-label', '光电视频推流');
  box.innerHTML = '<div><strong>光电视频</strong><span id="video-summary" role="status"></span></div><div class="realtime-actions"><button id="video-settings" type="button">视频设置</button></div><div id="video-error" role="alert"></div>';
  document.querySelector('footer').before(box);
  function update(data) {
    current = data;
    const view = viewModel(data);
    toggle.textContent = view.label;
    toggle.disabled = busy || view.disabled;
    document.querySelector('#video-summary').textContent = view.summary;
    document.querySelector('#video-error').textContent = requestError || view.error;
    document.querySelector('#video-settings').disabled = busy || view.settingsDisabled;
  }
  function settings(enableAfterSave = false) {
    const c = current.video_config || {};
    openDialog('光电视频设置', `<form id="video-settings-form"><p class="field-note">本机测试视频；留空视频文件时使用动态测试图。</p>${field('FFmpeg 程序路径','ffmpeg',c.ffmpeg || 'ffmpeg')}${field('本机视频文件','source',c.source || '')}${field('推流入口（RTSP）','rtsp_base',c.rtsp_base || 'rtsp://127.0.0.1:8554')}${field('媒体推流账号','publisher_user',c.publisher_user || 'qa-publisher')}${field(c.publisher_password_set ? '媒体推流密码（留空保留）' : '媒体推流密码','publisher_password','','password','autocomplete="new-password"')}<p class="inline-error" role="alert"></p><button type="submit" class="primary">${enableAfterSave ? '保存并开启' : '保存设置'}</button></form>`);
    document.querySelector('#video-settings-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const form = event.currentTarget, config = formValues(form);
      if (!config.publisher_password) delete config.publisher_password;
      busy = true; update(current); form.querySelector('[type=submit]').disabled = true;
      try {
        const result = await api('video', {enabled: enableAfterSave, config});
        requestError = ''; form.reset(); closeDialog(); applyRuntime(result);
      } catch (error) { form.querySelector('.inline-error').textContent = error.message; }
      finally { busy = false; update(current); form.querySelector('[type=submit]').disabled = false; }
    });
  }
  document.querySelector('#video-settings').addEventListener('click', () => settings(false));
  toggle.addEventListener('click', async () => {
    if (busy) return;
    const enabled = current.video_config?.enabled !== true;
    busy = true; requestError = ''; update(current);
    try { applyRuntime(await api('video', {enabled})); }
    catch (error) { requestError = error.message; }
    finally { busy = false; update(current); }
  });
  root.VideoUI = {update};
})(globalThis);
