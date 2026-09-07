package com.uav.lowaltitude.modules.flight.infrastructure;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
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

/**
 * 飞行计划外部授权登记的持久化。只增：没有 update、没有 delete。
 * 可见性由调用方先用 flight:read 取到计划来决定——授权行本身不带范围列，它的范围就是所属计划的范围。
 */
@Repository
public class PlanAuthorizationRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public PlanAuthorizationRepository(JdbcTemplate jdbcTemplate) {
        this.jdbc = new NamedParameterJdbcTemplate(jdbcTemplate);
    }

    public List<AuthorizationRow> list(String planId) {
        return jdbc.query("SELECT a.authorization_id,a.plan_id,a.document_no,a.issuer,a.granted_from,a.granted_to,a.scope_note,"
                + "a.recorded_by,a.recorded_at,a.source_kind,u.name AS recorded_by_name"
                + " FROM flight_plan_authorization a LEFT JOIN app_user u ON u.user_id=a.recorded_by"
                + " WHERE a.plan_id=:plan_id ORDER BY a.granted_from DESC,a.authorization_id DESC",
                Map.of("plan_id", planId), PlanAuthorizationRepository::authorization);
    }

    public boolean documentNoExists(String planId, String documentNo) {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM flight_plan_authorization WHERE plan_id=:plan_id AND document_no=:document_no",
                Map.of("plan_id", planId, "document_no", documentNo), Long.class);
        return count != null && count > 0;
    }

    public void insert(AuthorizationRow row) {
        Map<String, Object> parameters = new HashMap<>();
        parameters.put("authorization_id", row.authorizationId());
        parameters.put("plan_id", row.planId());
        parameters.put("document_no", row.documentNo());
        parameters.put("issuer", row.issuer());
        parameters.put("granted_from", Timestamp.from(row.grantedFrom()));
        parameters.put("granted_to", Timestamp.from(row.grantedTo()));
        parameters.put("scope_note", row.scopeNote());
        parameters.put("recorded_by", row.recordedBy());
        parameters.put("recorded_at", Timestamp.from(row.recordedAt()));
        parameters.put("source_kind", row.sourceKind());
        jdbc.update("INSERT INTO flight_plan_authorization (authorization_id,plan_id,document_no,issuer,granted_from,granted_to,"
                + "scope_note,recorded_by,recorded_at,source_kind)"
                + " VALUES (:authorization_id,:plan_id,:document_no,:issuer,:granted_from,:granted_to,:scope_note,"
                + ":recorded_by,:recorded_at,:source_kind)", parameters);
    }

    private static AuthorizationRow authorization(ResultSet rs, int rowNum) throws SQLException {
        return new AuthorizationRow(rs.getString("authorization_id"), rs.getString("plan_id"), rs.getString("document_no"),
                rs.getString("issuer"), instant(rs, "granted_from"), instant(rs, "granted_to"), rs.getString("scope_note"),
                rs.getString("recorded_by"), instant(rs, "recorded_at"), rs.getString("source_kind"),
                rs.getString("recorded_by_name"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Object value = rs.getObject(column);
        if (value == null) return null;
        if (value instanceof OffsetDateTime time) return time.toInstant();
        if (value instanceof ZonedDateTime time) return time.toInstant();
        if (value instanceof Timestamp time) return time.toInstant();
        if (value instanceof LocalDateTime time) return time.toInstant(ZoneOffset.UTC);
        if (value instanceof Number time) return Instant.ofEpochMilli(time.longValue());
        return OffsetDateTime.parse(value.toString()).toInstant();
    }

    public record AuthorizationRow(String authorizationId, String planId, String documentNo, String issuer,
            Instant grantedFrom, Instant grantedTo, String scopeNote, String recordedBy, Instant recordedAt,
            String sourceKind, String recordedByName) { }
}
