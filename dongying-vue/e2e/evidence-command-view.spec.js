import { expect, test } from '@playwright/test';

// 隔离展示测试：挂载真实组件，夹具仅在浏览器中使用，不创建业务指令或回执。
const detail = {
  entry: { source_kind: 'COMMAND', source_id: 'fixture-command', source_mode: 'replay' }, links: [], attachments: [],
  command: { command_id: 'fixture-command', command_no: 'EO-FIXTURE-ONLY', command_type: 'EO_END_TRACK',
    device_name: '光电协议测试设备', reason: 'OPERATOR_END_TRACK', status: 'SUCCEEDED',
    created_at: 1790598871000, issued_at: 1790598872000, completed_at: 1790598872137,
    result_detail: JSON.stringify({ event: 'EndTracking', metadata: { codeStatus: 200, taskId: 'fixture-task' } }), receipts: [] },
};

async function mount(page) {
  await page.route('**/__evidence_command_view', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body><main id="fixture"></main><script type="module">
    import { createApp, h, reactive } from '/node_modules/.vite/deps/vue.js';
    import { createRouter, createMemoryHistory } from '/node_modules/.vite/deps/vue-router.js';
    import Component from '/src/components/evidence/EvidenceRecordDetail.vue';
    import '/src/assets/css/index.css';
    const detail = reactive(${JSON.stringify(detail)});
    window.setEvidence = value => { Object.assign(detail, value); };
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] });
    createApp({ render: () => h(Component, { detail }) }).use(router).mount('#fixture');
    </script><style>body{margin:0;padding:16px;overflow:auto;min-width:0}#fixture{width:min(100%,560px);margin-left:auto;padding:16px;border:1px solid var(--line);background:var(--surface-2);box-sizing:border-box}</style></body></html>` }));
  await page.goto('/__evidence_command_view');
  await expect(page.locator('.command-overview')).toBeVisible();
}

test('指令详情优先中文结论，原始记录可展开，窄栏不溢出', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mount(page);
  await expect(page.getByText('操作员手动结束跟踪', { exact: true })).toBeVisible();
  await expect(page.getByText('平台记录完成，结果待核对', { exact: true })).toBeVisible();
  await expect(page.getByText('回放数据，非现场实时执行。', { exact: true })).toBeVisible();
  await expect(page.getByText('OPERATOR_END_TRACK', { exact: true })).not.toBeVisible();
  await expect(page.locator('pre').first()).not.toBeVisible();
  await expect(page.getByText('尚未收到设备回执，不能据此认定执行成功或未执行。', { exact: true })).toHaveCount(0);
  for (const [width, height] of [[1280, 720], [1366, 768], [1440, 900], [375, 812]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('.command-result')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByText('查看指令编号、原始报文和关联日志', { exact: true }).click();
  await expect(page.getByText('OPERATOR_END_TRACK', { exact: true })).toBeVisible();
  await expect(page.locator('pre').first()).toHaveText(detail.command.result_detail);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByText('查看指令编号、原始报文和关联日志', { exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('command-summary.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('切换指令更新结果和来源，回执受理、完成、超时不会混淆', async ({ page }) => {
  await mount(page);
  const receipt = { receipt_id: 'fixture-receipt', receipt_kind: 'PROTOCOL_C', payload: JSON.parse(detail.command.result_detail), occurred_at: 1790598872137 };
  await page.evaluate(value => window.setEvidence(value), { command: { ...detail.command, receipts: [receipt] } });
  await expect(page.getByText('设备反馈执行完成', { exact: true })).toBeVisible();
  await expect(page.getByText('设备反馈：已结束光电跟踪', { exact: true })).toBeVisible();
  await page.getByText('查看指令编号、原始报文和关联日志', { exact: true }).click();
  await page.evaluate(value => window.setEvidence(value), {
    entry: { ...detail.entry, source_id: 'next-fixture', source_mode: 'mock' },
    command: { ...detail.command, command_id: 'next-fixture', status: 'ACCEPTED', result_detail: null, receipts: [{ receipt_kind: 'ACK' }] },
  });
  await expect(page.getByText('设备已接收，等待执行结果', { exact: true })).toBeVisible();
  await expect(page.getByText('模拟数据，不代表现场实际执行结果。', { exact: true })).toBeVisible();
  await expect(page.getByText('设备反馈执行完成', { exact: true })).toHaveCount(0);
  await expect(page.locator('details')).not.toHaveAttribute('open', '');
  await page.evaluate(value => window.setEvidence(value), { command: { ...detail.command, status: 'TIMED_OUT' } });
  await expect(page.getByText('设备反馈超时，结果待确认', { exact: true })).toBeVisible();
});
