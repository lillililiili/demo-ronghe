package com.uav.lowaltitude.platform.worker;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.device.application.DeviceOperationsProcessor;
import com.uav.lowaltitude.modules.device.infrastructure.DeviceRepository;
import com.uav.lowaltitude.platform.time.AppClock;

/**
 * 同应用 Worker：通过条件更新领取到期 Outbox。处理器以业务 ID 幂等，服务重启后可继续扫描。
 */
@Component
public class OutboxWorker {

    private static final Logger log = LoggerFactory.getLogger(OutboxWorker.class);

    private final DeviceRepository repository;
    private final DeviceOperationsProcessor processor;
    private final AppClock clock;

    public OutboxWorker(DeviceRepository repository, DeviceOperationsProcessor processor, AppClock clock) {
        this.repository = repository;
        this.processor = processor;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${app.outbox.poll-millis:400}")
    public void poll() {
        long now = clock.nowMillis();
        processor.expireCommands(now);
        List<Map<String, Object>> rows = repository.dueOutbox(now, 20);
        for (Map<String, Object> row : rows) {
            String id = String.valueOf(row.get("outbox_id"));
            long availableAt = ((Number) row.get("available_at")).longValue();
            if (repository.claimOutbox(id, availableAt, now + 30_000L) != 1) continue;
            try {
                processor.process(String.valueOf(row.get("topic")), String.valueOf(row.get("payload")));
                repository.completeOutbox(id, clock.nowMillis());
            } catch (Exception ex) {
                int attempts = row.get("attempt_count") instanceof Number n ? n.intValue() + 1 : 1;
                if (attempts >= 6) {
                    String detail = "适配器连续重试失败：" + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
                    processor.timeout(String.valueOf(row.get("topic")), String.valueOf(row.get("payload")), detail);
                    repository.completeOutbox(id, clock.nowMillis());
                } else {
                    long delay = Math.min(60_000L, 1_000L << Math.min(attempts, 6));
                    repository.failOutbox(id, clock.nowMillis() + delay, ex.getMessage());
                }
                log.warn("outbox processing failed: id={}, topic={}, attempt={}", id, row.get("topic"), attempts);
            }
        }
    }
}
