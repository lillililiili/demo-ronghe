/* 风险通知由飞行任务和融合感知共用；只提交通知，不隐式执行人工核验。 */
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { openFormModal } from './formModal.js';
import { closeModal } from './modal.js';
import { toast } from './nv.js';

const pendingKeys = new Map();
const messageOf = error => error.status === 401 ? '登录已失效，请重新登录。'
  : error.status === 403 ? '当前账号没有提交或查看交接的权限。' : error.message || '提交通知失败';

export function openRiskNotification({ risk, refresh, onDone, onExisting } = {}) {
  if (!risk?.risk_id || risk.state !== 'PENDING_NOTIFICATION' || !hasPermission('handoff:create')) return false;
  const id = risk.risk_id, expectedVersion = Number(risk.version);
  if (!pendingKeys.has(id)) pendingKeys.set(id, newHandoffIdempotencyKey());
  openFormModal({
    title: '通知上级', width: '560px', fields: [], confirmText: '提交通知',
    warning: '提交后，请在通知记录中查看是否送达，并等待对方回执。显示“已回执”表示本次风险通知流程完成；签收不代表风险已经解除。对方如另附处理结果，会显示在同一条回执里。',
    onSubmit: async () => {
      let created;
      try {
        created = await handoffApi.createHandoff({ source_kind: 'RISK', source_id: id,
          handoff_type: 'RISK_NOTICE', expected_version: expectedVersion }, pendingKeys.get(id));
      } catch (error) {
        if (['HANDOFF_ALREADY_EXISTS', 'IDEMPOTENCY_REPLAY'].includes(error.code)) {
          pendingKeys.delete(id); closeModal();
          await refresh?.(); onExisting?.();
          toast('该风险已经提交过通知，请在通知与回执中核对。', 'err'); return;
        }
        if (['VERSION_CONFLICT', 'INVALID_TRANSITION', 'RECIPIENT_NOT_CONFIGURED', 'RECIPIENT_NOT_FOUND'].includes(error.code)) {
          pendingKeys.set(id, newHandoffIdempotencyKey()); await refresh?.();
          throw new Error(`提交被拒绝，已刷新当前状态：${messageOf(error)}`);
        }
        if (isUncertainOutcome(error)) {
          await refresh?.();
          throw new Error(`提交结果未确认，请刷新核对：${messageOf(error)}`);
        }
        pendingKeys.delete(id); throw new Error(messageOf(error));
      }
      pendingKeys.delete(id); closeModal();
      // 通知已成功提交时，读回失败不能被当成提交失败后重新发送。
      try { await refresh?.(); }
      catch (error) { toast(`通知已提交，但刷新失败：${messageOf(error)}`, 'err'); }
      onDone?.(created);
    }
  });
  return true;
}
