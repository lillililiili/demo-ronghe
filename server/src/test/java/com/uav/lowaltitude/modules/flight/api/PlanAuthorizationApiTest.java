package com.uav.lowaltitude.modules.flight.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * 外部授权登记：登记的是别处已经批下来的文号，不是本平台的审批流。
 * 因此它只增、同计划同文号只能登记一次，并且**不改变** flight_plan.status_code。
 * 不套测试事务：只增与幂等占位都要求业务事务真正提交。
 */
@SpringBootTest(properties = "app.dev-seed.enabled=false")
@AutoConfigureMockMvc
@ActiveProfiles("test")
class PlanAuthorizationApiTest {
    private static final Instant T0 = Instant.parse("2026-09-05T12:00:00Z");

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    private String suffix, orgId, district, routeId, routeVersionId, planId, sourceId;
    private String session, readOnlySession, userId;

    @BeforeEach
    void fixture() {
        suffix = UUID.randomUUID().toString().substring(0, 8);
        orgId = "org-9p-" + suffix; district = "dist-9p-" + suffix;
        jdbc.update("insert into app_org (org_id,org_code,name,enabled,created_at,updated_at,version) values (?,?,?,true,0,0,0)",
                orgId, "ORG-9P-" + suffix, "授权登记测试机构");
        jdbc.update("insert into app_district (district_id,district_code,name,enabled,created_at,updated_at,version) values (?,?,?,true,0,0,0)",
                district, "DIST-9P-" + suffix, "授权登记测试区域");
        userId = UUID.randomUUID().toString();
        session = user(userId, "flight:read", "flight:authorize");
        readOnlySession = user(UUID.randomUUID().toString(), "flight:read");

        sourceId = UUID.randomUUID().toString();
        jdbc.update("insert into integration_source (source_id,source_code,name,enabled,source_mode,source_type,created_at,updated_at,version)"
                + " values (?,?,?,true,'mock','RADAR',?,?,0)", sourceId, "SRC-9P-" + suffix, "授权登记测试来源", ts(T0), ts(T0));
        routeId = UUID.randomUUID().toString(); routeVersionId = UUID.randomUUID().toString();
        jdbc.update("insert into route (route_id,route_no,name,enabled,source_mode,owner_org_id,district_id,created_at,updated_at,version)"
                + " values (?,?,?,true,'mock',?,?,?,?,0)", routeId, "RT-9P-" + suffix, "授权登记测试航线", orgId, district, ts(T0), ts(T0));
        jdbc.update("insert into route_version (route_version_id,route_id,version_no,centerline,corridor_width_m,min_altitude_m,max_altitude_m,"
                + "altitude_datum,valid_from,valid_to,created_at)"
                + " values (?,?,1,GEOMETRY 'SRID=4326;LINESTRING (118.5 37.3,118.6 37.4)',100,50,150,'AMSL',?,null,?)",
                routeVersionId, routeId, ts(T0), ts(T0));
        planId = UUID.randomUUID().toString();
        jdbc.update("insert into flight_plan (plan_id,plan_no,status_code,source_id,source_mode,uav_sn,start_at,end_at,route_version_id,"
                + "owner_org_id,district_id,created_at,updated_at,version) values (?,?,'PENDING',?,'mock','UAV-9P',?,?,?,?,?,?,?,0)",
                planId, "PL-9P-" + suffix, sourceId, ts(T0), ts(T0.plusSeconds(7200)), routeVersionId, orgId, district, ts(T0), ts(T0));
    }

    @AfterEach
    void cleanup() {
        jdbc.update("delete from flight_plan_authorization where plan_id=?", planId);
        jdbc.update("delete from audit_log where account like 'auth-9p-%'");
        jdbc.update("delete from idempotency_request where user_id in (select user_id from app_user where account like 'auth-9p-%')");
        jdbc.update("delete from flight_plan where owner_org_id=?", orgId);
        jdbc.update("delete from route_version where route_id=?", routeId);
        jdbc.update("delete from route where route_id=?", routeId);
        jdbc.update("delete from integration_source where source_id=?", sourceId);
        jdbc.update("delete from app_session where user_id in (select user_id from app_user where account like 'auth-9p-%')");
        jdbc.update("delete from app_user_data_scope where user_id in (select user_id from app_user where account like 'auth-9p-%')");
        jdbc.update("delete from app_user where account like 'auth-9p-%'");
        jdbc.update("delete from app_role_permission where role_code like 'ROLE-9P-%'");
        jdbc.update("delete from app_role where role_code like 'ROLE-9P-%'");
        jdbc.update("delete from app_district where district_id=?", district);
        jdbc.update("delete from app_org where org_id=?", orgId);
    }

    @Test
    void permissionIsCheckedBeforeTheBodyIsParsed() throws Exception {
        // 403 必须先于 400：否则可以用报错差异探测这个计划是否存在、字段叫什么。
        mvc.perform(post("/api/v1/flight-plans/" + planId + "/authorizations").header("Authorization", "Bearer " + readOnlySession)
                        .header("Idempotency-Key", key()).contentType(MediaType.APPLICATION_JSON).content("{not-json"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        assertThat(count("flight_plan_authorization where plan_id=?", planId)).isZero();
    }

    @Test
    void badRequestBodiesAreRejectedBeforeAnythingIsWritten() throws Exception {
        record("", "东营市空管办", T0, T0.plusSeconds(3600), null)
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // 授权区间必须真的有长度：零长度或倒挂说不清"哪段时间被授权了"。
        record("SW-2026-101", "东营市空管办", T0.plusSeconds(3600), T0, null)
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("INVALID_VALIDITY"));
        record("SW-2026-102", "东营市空管办", T0, T0, null)
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("INVALID_VALIDITY"));
        mvc.perform(request(session, key(), "{\"document_no\":\"SW-2026-103\",\"issuer\":\"东营市空管办\",\"granted_from\":"
                        + T0.toEpochMilli() + ",\"granted_to\":" + T0.plusSeconds(3600).toEpochMilli() + ",\"status_code\":\"APPROVED\"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("UNKNOWN_FIELD"));
        assertThat(count("flight_plan_authorization where plan_id=?", planId)).isZero();
    }

    @Test
    void recordingAnAuthorizationLeavesThePlanStatusUntouched() throws Exception {
        record("SW-2026-001", "东营市空管办", T0, T0.plusSeconds(7200), "限于航线走廊内")
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.plan_id").value(planId))
                .andExpect(jsonPath("$.data.authorization_id").isNotEmpty());

        assertThat(count("flight_plan_authorization where plan_id=? and document_no='SW-2026-001' and source_kind='MANUAL'", planId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select recorded_by from flight_plan_authorization where plan_id=?", String.class, planId)).isEqualTo(userId);
        // 登记外部授权不是审批：计划状态与乐观锁版本都不能被它改动。
        assertThat(jdbc.queryForObject("select status_code from flight_plan where plan_id=?", String.class, planId)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("select version from flight_plan where plan_id=?", Long.class, planId)).isZero();
        assertThat(count("audit_log where action='plan_authorization_recorded' and object_id=? and result='SUCCESS'", planId)).isEqualTo(1);

        JsonNode items = list(session).path("items");
        assertThat(items).hasSize(1);
        assertThat(items.get(0).path("document_no").asText()).isEqualTo("SW-2026-001");
        assertThat(items.get(0).path("issuer").asText()).isEqualTo("东营市空管办");
        assertThat(items.get(0).path("scope_note").asText()).isEqualTo("限于航线走廊内");
    }

    @Test
    void theSameDocumentNumberCannotBeRecordedTwiceOnOnePlan() throws Exception {
        record("SW-2026-002", "东营市空管办", T0, T0.plusSeconds(7200), null).andExpect(status().isCreated());
        // 同一份授权重复登记不是新事实：不同幂等键也必须被唯一约束挡住。
        record("SW-2026-002", "另一个签发单位", T0, T0.plusSeconds(3600), null)
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("AUTHORIZATION_EXISTS"));
        assertThat(count("flight_plan_authorization where plan_id=?", planId)).isEqualTo(1);
    }

    @Test
    void replayingTheSameIdempotencyKeyDoesNotCreateASecondRow() throws Exception {
        String idempotencyKey = key();
        String body = body("SW-2026-003", "东营市空管办", T0, T0.plusSeconds(7200), null);
        mvc.perform(request(session, idempotencyKey, body)).andExpect(status().isCreated());
        mvc.perform(request(session, idempotencyKey, body))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("IDEMPOTENCY_REPLAY"));
        assertThat(count("flight_plan_authorization where plan_id=?", planId)).isEqualTo(1);
    }

    @Test
    void authorizationsOfAPlanOutsideTheAssignedScopeAreNotFound() throws Exception {
        String otherOrg = "org-9p-o-" + suffix, otherDistrict = "dist-9p-o-" + suffix;
        String otherRoute = UUID.randomUUID().toString(), otherVersion = UUID.randomUUID().toString(), otherPlan = UUID.randomUUID().toString();
        jdbc.update("insert into app_org (org_id,org_code,name,enabled,created_at,updated_at,version) values (?,?,?,true,0,0,0)", otherOrg, "ORG-9PO-" + suffix, "越权机构");
        jdbc.update("insert into app_district (district_id,district_code,name,enabled,created_at,updated_at,version) values (?,?,?,true,0,0,0)", otherDistrict, "DIST-9PO-" + suffix, "越权区域");
        jdbc.update("insert into route (route_id,route_no,name,enabled,source_mode,owner_org_id,district_id,created_at,updated_at,version)"
                + " values (?,?,?,true,'mock',?,?,?,?,0)", otherRoute, "RT-9PO-" + suffix, "越权航线", otherOrg, otherDistrict, ts(T0), ts(T0));
        jdbc.update("insert into route_version (route_version_id,route_id,version_no,centerline,corridor_width_m,min_altitude_m,max_altitude_m,"
                + "altitude_datum,valid_from,valid_to,created_at)"
                + " values (?,?,1,GEOMETRY 'SRID=4326;LINESTRING (118.5 37.3,118.6 37.4)',100,50,150,'AMSL',?,null,?)", otherVersion, otherRoute, ts(T0), ts(T0));
        jdbc.update("insert into flight_plan (plan_id,plan_no,status_code,source_id,source_mode,uav_sn,start_at,end_at,route_version_id,"
                + "owner_org_id,district_id,created_at,updated_at,version) values (?,?,'PENDING',?,'mock','UAV-9PO',?,?,?,?,?,?,?,0)",
                otherPlan, "PL-9PO-" + suffix, sourceId, ts(T0), ts(T0.plusSeconds(7200)), otherVersion, otherOrg, otherDistrict, ts(T0), ts(T0));
        try {
            mvc.perform(get("/api/v1/flight-plans/" + otherPlan + "/authorizations").header("Authorization", "Bearer " + session))
                    .andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("FLIGHT_PLAN_NOT_FOUND"));
            mvc.perform(request(session, key(), body("SW-2026-004", "东营市空管办", T0, T0.plusSeconds(3600), null), otherPlan))
                    .andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("FLIGHT_PLAN_NOT_FOUND"));
            assertThat(count("flight_plan_authorization where plan_id=?", otherPlan)).isZero();
        } finally {
            jdbc.update("delete from flight_plan_authorization where plan_id=?", otherPlan);
            jdbc.update("delete from flight_plan where plan_id=?", otherPlan);
            jdbc.update("delete from route_version where route_id=?", otherRoute);
            jdbc.update("delete from route where route_id=?", otherRoute);
            jdbc.update("delete from app_district where district_id=?", otherDistrict);
            jdbc.update("delete from app_org where org_id=?", otherOrg);
        }
    }

    private JsonNode list(String token) throws Exception {
        String body = mvc.perform(get("/api/v1/flight-plans/" + planId + "/authorizations").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        return json.readTree(body).path("data");
    }

    private ResultActions record(String documentNo, String issuer, Instant from, Instant to, String note) throws Exception {
        return mvc.perform(request(session, key(), body(documentNo, issuer, from, to, note)));
    }

    private MockHttpServletRequestBuilder request(String token, String idempotencyKey, String body) {
        return request(token, idempotencyKey, body, planId);
    }

    /** 幂等键显式传入：重放必须用同一个键，不能靠追加第二个同名请求头。 */
    private MockHttpServletRequestBuilder request(String token, String idempotencyKey, String body, String plan) {
        return post("/api/v1/flight-plans/" + plan + "/authorizations").header("Authorization", "Bearer " + token)
                .header("Idempotency-Key", idempotencyKey).contentType(MediaType.APPLICATION_JSON).content(body);
    }

    private static String body(String documentNo, String issuer, Instant from, Instant to, String note) {
        return "{\"document_no\":\"" + documentNo + "\",\"issuer\":\"" + issuer + "\",\"granted_from\":" + from.toEpochMilli()
                + ",\"granted_to\":" + to.toEpochMilli() + (note == null ? "" : ",\"scope_note\":\"" + note + "\"") + "}";
    }

    private String user(String id, String... permissions) {
        String tag = UUID.randomUUID().toString().substring(0, 8), role = "ROLE-9P-" + tag, token = UUID.randomUUID().toString();
        jdbc.update("insert into app_role (role_code,name,description,builtin,enabled,created_at,updated_at,version,system_role) values (?,?,'',false,true,0,0,0,false)", role, role);
        for (String permission : permissions) {
            jdbc.update("insert into app_role_permission (role_code,permission_code,permission_level,menu_enabled,created_at) values (?,?,'OP',false,current_timestamp)", role, permission);
        }
        jdbc.update("insert into app_user (user_id,account,name,role_code,status,password_hash,fail_count,scope_mode,permission_version,created_at,updated_at,version)"
                + " values (?,?,?,?,'ACTIVE','unused',0,'ASSIGNED',0,0,0,0)", id, "auth-9p-" + tag, "授权登记员", role);
        jdbc.update("insert into app_user_data_scope (user_id,org_id,district_id) values (?,?,?)", id, orgId, district);
        jdbc.update("insert into app_session (session_id,user_id,expire_at,ip,permission_version) values (?,?,?,'127.0.0.1',0)",
                token, id, System.currentTimeMillis() + 3_600_000L);
        return token;
    }

    private long count(String fromWhere, Object... args) {
        return jdbc.queryForObject("select count(*) from " + fromWhere, Long.class, args);
    }

    private static String key() { return "plan-auth-" + UUID.randomUUID(); }

    private static Timestamp ts(Instant value) { return Timestamp.from(value); }
}
