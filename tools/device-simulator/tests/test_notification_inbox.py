"""The inbox reflects platform notification history without changing it."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from notification_inbox import read_inbox


class Platform:
    def __init__(self):
        self.calls = []

    def call(self, method, path):
        self.calls.append((method, path))
        if path == '/flight-plans?page=1&size=20':
            return {'items': [
                {'plan_id': 'mock-plan', 'plan_no': '模拟任务 01', 'source_mode': 'mock'},
                {'plan_id': 'live-plan', 'source_mode': 'live'},
            ], 'total': 2}
        if path == '/flight-plans/mock-plan/verifications':
            return {'feedback': [
                {'feedback_id': 'feedback-delivered', 'verification_id': 'v1', 'recipient_name': '报送单位',
                 'delivery_status': 'DELIVERED', 'receipt_status': 'PENDING', 'created_at': 10,
                 'delivered_at': 12, 'processing_result': None},
                {'feedback_id': 'feedback-pending', 'verification_id': 'v2', 'recipient_name': '报送单位',
                 'delivery_status': 'SUBMITTED', 'receipt_status': 'NOT_EXPECTED', 'created_at': 11},
            ], 'verifications': [
                {'verification_id': 'v1', 'conclusion': 'ABNORMAL', 'evidence': '设备状态异常'},
                {'verification_id': 'v2', 'conclusion': 'UNKNOWN', 'evidence': '缺少观测'},
            ]}
        if path == '/device-maintenance-tasks?status=ALL&page=1&size=20':
            return {'items': [
                {'task_id': 'task-1', 'plan_no': '任务甲', 'device_name': '雷达甲', 'reason': '离线',
                 'simulated': True, 'workflow_state': 'PROCESSING', 'notification_attempts': [
                     {'attempt_id': 'attempt-1', 'delivery_status': 'DELIVERED',
                      'receipt_status': 'ACKNOWLEDGED', 'requested_at': 20, 'delivered_at': 22,
                      'recipient_snapshot': {'recipient_name': '运维单位'}},
                     {'attempt_id': 'attempt-2', 'delivery_status': 'FAILED',
                      'receipt_status': 'NOT_EXPECTED', 'requested_at': 30, 'blocked_reason': '通道失败',
                      'recipient_snapshot': {'recipient_name': '运维单位'}},
                 ]},
                {'task_id': 'task-live', 'simulated': False, 'notification_attempts': [
                    {'attempt_id': 'live-attempt', 'delivery_status': 'DELIVERED'}]},
            ], 'total': 2}
        raise AssertionError(f'Unexpected platform read: {method} {path}')


class InboxTests(unittest.TestCase):
    def test_plan_feedback_uses_saved_delivery_and_verification_facts(self):
        platform = Platform()
        result = read_inbox(platform, 'plan_feedback')
        self.assertEqual(['feedback-delivered', 'feedback-pending'],
                         [row['id'] for row in result['items']])
        delivered, pending = result['items']
        self.assertEqual('设备状态异常', delivered['content'])
        self.assertTrue(delivered['received'])
        self.assertEqual('PENDING', delivered['receipt_status'])
        self.assertFalse(pending['received'])
        self.assertNotIn(('GET', '/flight-plans/live-plan/verifications'), platform.calls)
        self.assertTrue(all(method == 'GET' for method, _ in platform.calls))

    def test_maintenance_keeps_attempts_separate_and_does_not_claim_repair(self):
        platform = Platform()
        result = read_inbox(platform, 'device_maintenance')
        self.assertEqual(['attempt-2', 'attempt-1'], [row['id'] for row in result['items']])
        failed, delivered = result['items']
        self.assertFalse(failed['received'])
        self.assertEqual('通道失败', failed['reason'])
        self.assertTrue(delivered['received'])
        self.assertEqual('ACKNOWLEDGED', delivered['receipt_status'])
        self.assertIn('离线', delivered['content'])
        self.assertNotIn('已修复', delivered['content'])
        self.assertNotIn('live-attempt', [row['id'] for row in result['items']])
        self.assertTrue(all(method == 'GET' for method, _ in platform.calls))


if __name__ == '__main__':
    unittest.main()
