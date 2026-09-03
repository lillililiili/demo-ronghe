package com.uav.lowaltitude.platform.audit;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuditService {

    private final AuditMapper auditMapper;

    public AuditService(AuditMapper auditMapper) {
        this.auditMapper = auditMapper;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void record(String userId, String account, String action, String objectType, String objectId, String detail, String ip) {
        AuditLog log = new AuditLog();
        log.setAuditId(UUID.randomUUID().toString());
        log.setUserId(userId);
        log.setAccount(account);
        log.setAction(action);
        log.setObjectType(objectType);
        log.setObjectId(objectId);
        log.setDetail(detail);
        log.setOccurredAt(System.currentTimeMillis());
        log.setIp(ip);
        auditMapper.insert(log);
    }

    @Transactional
    public void recordStandalone(String userId, String account, String action, String objectType, String objectId, String detail, String ip) {
        record(userId, account, action, objectType, objectId, detail, ip);
    }
}
