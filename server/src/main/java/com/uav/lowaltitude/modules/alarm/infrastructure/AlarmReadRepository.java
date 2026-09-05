package com.uav.lowaltitude.modules.alarm.infrastructure;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import com.uav.lowaltitude.modules.identity.domain.AccessDecision;
import com.uav.lowaltitude.modules.identity.domain.ScopeMode;

/** 告警范围以 alarm 自身完整组织/区域元组为真源，event 不能借目标的范围扩大可见性。 */
@Repository
public class AlarmReadRepository {
    private final NamedParameterJdbcTemplate jdbc;

    public AlarmReadRepository(JdbcTemplate jdbcTemplate) { this.jdbc = new NamedParameterJdbcTemplate(jdbcTemplate); }

    public long count(AlarmQuery query, AccessDecision access) {
        Where where = where(query, access);
        Long total = jdbc.queryForObject("SELECT COUNT(*)" + from() + where.sql, where.parameters, Long.class);
        return total == null ? 0 : total;
    }

    public List<AlarmRow> list(AlarmQuery query, AccessDecision access, int offset, int size) {
        Where where = where(query, access);
        where.parameters.put("offset", offset);
        where.parameters.put("size", size);
        return jdbc.query(select() + from() + where.sql
                + " ORDER BY a.received_at DESC,a.alarm_id DESC OFFSET :offset ROWS FETCH NEXT :size ROWS ONLY",
                where.parameters, AlarmReadRepository::alarm);
    }

    public AlarmRow find(String alarmId, AccessDecision access) {
        Where where = where(AlarmQuery.empty(), access);
        where.sql.append(" AND a.alarm_id=:alarm_id");
        where.parameters.put("alarm_id", alarmId);
        List<AlarmRow> rows = jdbc.query(select() + from() + where.sql, where.parameters, AlarmReadRepository::alarm);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public boolean targetVisible(String targetId, String alarmOrgId, String alarmDistrictId, AccessDecision access) {
        if (targetId == null) return false;
        Map<String, Object> parameters = new HashMap<>();
        parameters.put("target_id", targetId);
        StringBuilder sql = new StringBuilder("SELECT COUNT(*) FROM target t WHERE t.target_id=:target_id AND t.owner_org_id IS NOT NULL AND t.district_id IS NOT NULL");
        // ALL 只是不受用户 grant 限制，不能绕过已停用或不存在的组织、区域目录记录。
        sql.append(" AND EXISTS (SELECT 1 FROM app_org o WHERE o.org_id=t.owner_org_id AND o.enabled=TRUE)");
        sql.append(" AND EXISTS (SELECT 1 FROM app_district d WHERE d.district_id=t.district_id AND d.enabled=TRUE)");
        if (alarmOrgId != null && alarmDistrictId != null) {
            parameters.put("alarm_org_id", alarmOrgId); parameters.put("alarm_district_id", alarmDistrictId);
            sql.append(" AND t.owner_org_id=:alarm_org_id AND t.district_id=:alarm_district_id");
        }
        if (access.scopeMode() == ScopeMode.ASSIGNED) {
            // 目标引用单独按目标完整元组校验，不能借已可见 alarm 的范围跨域泄露 target_id。
            sql.append(" AND EXISTS (SELECT 1 FROM app_user_data_scope ds JOIN app_org o ON o.org_id=ds.org_id AND o.enabled=TRUE JOIN app_district d ON d.district_id=ds.district_id AND d.enabled=TRUE WHERE ds.user_id=:target_scope_user_id AND ds.org_id=t.owner_org_id AND ds.district_id=t.district_id)");
            parameters.put("target_scope_user_id", access.userId());
        }
        Long count = jdbc.queryForObject(sql.toString(), parameters, Long.class);
        return count != null && count > 0;
    }

    public boolean targetReadable(String targetId, AccessDecision access) { return targetVisible(targetId, null, null, access); }

    private static String from() {
        return " FROM alarm a JOIN integration_source s ON s.source_id=a.source_id LEFT JOIN uav_event e ON e.alarm_id=a.alarm_id";
    }

    private static String select() {
        return "SELECT a.alarm_id,a.target_id,a.alarm_type,a.severity,a.occurred_at,a.received_at,a.source_mode,a.owner_org_id,a.district_id,s.source_code,e.event_id,e.state_code";
    }

    private static Where where(AlarmQuery query, AccessDecision access) {
        StringBuilder sql = new StringBuilder(" WHERE a.owner_org_id IS NOT NULL AND a.district_id IS NOT NULL");
        Map<String, Object> parameters = new HashMap<>();
        // 目录启用性是对象可见性的共同前提；ALL 仅跳过 grant，不得读取失效归属的数据。
        sql.append(" AND EXISTS (SELECT 1 FROM app_org o WHERE o.org_id=a.owner_org_id AND o.enabled=TRUE)");
        sql.append(" AND EXISTS (SELECT 1 FROM app_district d WHERE d.district_id=a.district_id AND d.enabled=TRUE)");
        if (access.scopeMode() == ScopeMode.ASSIGNED) {
            // EXISTS 让同一条授权记录同时绑定 org/district，禁止两条 grant 笛卡尔拼接。
            sql.append(" AND EXISTS (SELECT 1 FROM app_user_data_scope ds JOIN app_org o ON o.org_id=ds.org_id AND o.enabled=TRUE JOIN app_district d ON d.district_id=ds.district_id AND d.enabled=TRUE WHERE ds.user_id=:scope_user_id AND ds.org_id=a.owner_org_id AND ds.district_id=a.district_id)");
            parameters.put("scope_user_id", access.userId());
        }
        add(sql, parameters, "e.state_code", "state", query.state());
        add(sql, parameters, "a.severity", "severity", query.severity());
        add(sql, parameters, "a.target_id", "target_id", query.targetId());
        add(sql, parameters, "a.owner_org_id", "owner_org_id", query.ownerOrgId());
        add(sql, parameters, "a.district_id", "district_id", query.districtId());
        add(sql, parameters, "a.source_mode", "source_mode", query.sourceMode());
        if (query.targetId() != null) {
            // filter 也只接受与每条 alarm 同域的目标，错连 target 不能影响列表 total。
            sql.append(" AND EXISTS (SELECT 1 FROM target filter_target WHERE filter_target.target_id=a.target_id AND filter_target.target_id=:target_id AND filter_target.owner_org_id=a.owner_org_id AND filter_target.district_id=a.district_id)");
        }
        if (query.occurredFrom() != null) {
            sql.append(" AND a.occurred_at IS NOT NULL AND a.occurred_at>=:occurred_from AND a.occurred_at<:occurred_to");
            parameters.put("occurred_from", query.occurredFrom());
            parameters.put("occurred_to", query.occurredTo());
        }
        return new Where(sql, parameters);
    }

    private static void add(StringBuilder sql, Map<String, Object> parameters, String column, String name, String value) {
        if (value == null) return;
        sql.append(" AND ").append(column).append("=:").append(name);
        parameters.put(name, value);
    }

    private static AlarmRow alarm(ResultSet rs, int ignored) throws SQLException {
        return new AlarmRow(rs.getString("alarm_id"), rs.getString("target_id"), rs.getString("event_id"),
                rs.getString("state_code"), rs.getString("alarm_type"), rs.getString("severity"),
                time(rs, "occurred_at"), time(rs, "received_at"), rs.getString("source_code"),
                rs.getString("source_mode"), rs.getString("owner_org_id"), rs.getString("district_id"));
    }

    private static OffsetDateTime time(ResultSet rs, String column) throws SQLException {
        Object value = rs.getObject(column);
        if (value == null) return null;
        if (value instanceof OffsetDateTime time) return time;
        if (value instanceof ZonedDateTime time) return time.toOffsetDateTime();
        if (value instanceof Timestamp time) return time.toInstant().atOffset(ZoneOffset.UTC);
        if (value instanceof LocalDateTime time) return time.atOffset(ZoneOffset.UTC);
        return OffsetDateTime.parse(value.toString());
    }

    private record Where(StringBuilder sql, Map<String, Object> parameters) { }
    public record AlarmQuery(String state, String severity, String targetId, OffsetDateTime occurredFrom,
            OffsetDateTime occurredTo, String ownerOrgId, String districtId, String sourceMode) {
        public static AlarmQuery empty() { return new AlarmQuery(null, null, null, null, null, null, null, null); }
    }
    public record AlarmRow(String alarmId, String targetId, String eventId, String state, String alarmType,
            String severity, OffsetDateTime occurredAt, OffsetDateTime receivedAt, String sourceCode,
            String sourceMode, String ownerOrgId, String districtId) { }
}
