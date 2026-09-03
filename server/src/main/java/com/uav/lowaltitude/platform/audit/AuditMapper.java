package com.uav.lowaltitude.platform.audit;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface AuditMapper {

    @Insert("""
            INSERT INTO audit_log (audit_id, user_id, account, action, object_type, object_id, detail, occurred_at, ip)
            VALUES (#{auditId}, #{userId}, #{account}, #{action}, #{objectType}, #{objectId}, #{detail}, #{occurredAt}, #{ip})
            """)
    int insert(AuditLog log);
}
