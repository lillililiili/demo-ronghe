-- 运维管理运行库不再保留开发模拟台账。测试 profile 仍可由 LocalDeviceSeeder 注入隔离夹具。

DELETE FROM command_receipt
 WHERE command_id IN (
        SELECT command_id FROM device_command
         WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE));

DELETE FROM outbox_event
 WHERE payload IN (
        SELECT command_id FROM device_command
         WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE))
    OR payload IN (
        SELECT commission_id FROM commission_task
         WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE));

DELETE FROM device_command
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

UPDATE commission_task SET previous_task_id = NULL
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

DELETE FROM commission_task_event
 WHERE commission_id IN (
        SELECT commission_id FROM commission_task
         WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE));

DELETE FROM commission_task
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

DELETE FROM track_point
 WHERE track_id IN (
        SELECT track_id FROM track
         WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE));

DELETE FROM target_latest_state
 WHERE target_id IN (
        SELECT target_id FROM sensing_target
         WHERE primary_device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE));

DELETE FROM target_source_link
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE)
    OR target_id IN (
        SELECT target_id FROM sensing_target
         WHERE primary_device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE));

DELETE FROM track
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

DELETE FROM sensing_target
 WHERE primary_device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

DELETE FROM device_incident
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

DELETE FROM device_event_log
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

DELETE FROM device_state_history
 WHERE device_id IN (SELECT device_id FROM device WHERE source_mode = 'mock' AND simulated = TRUE);

DELETE FROM inbox_message
 WHERE source_id IN (SELECT source_id FROM integration_source WHERE source_mode = 'mock' AND simulated = TRUE)
    OR source = 'mock-device-adapter';

DELETE FROM device
 WHERE source_mode = 'mock' AND simulated = TRUE;

DELETE FROM integration_source
 WHERE source_mode = 'mock' AND simulated = TRUE;
