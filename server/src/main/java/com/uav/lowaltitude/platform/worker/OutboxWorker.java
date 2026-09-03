package com.uav.lowaltitude.platform.worker;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 同应用 Worker：扫描 outbox_event。本轮只占位，不引入 Kafka。
 */
@Component
public class OutboxWorker {

    private static final Logger log = LoggerFactory.getLogger(OutboxWorker.class);

    @Scheduled(fixedDelay = 5000)
    public void poll() {
        log.trace("outbox poll placeholder");
    }
}
