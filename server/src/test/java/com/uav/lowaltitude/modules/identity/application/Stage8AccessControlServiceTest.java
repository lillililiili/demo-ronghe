package com.uav.lowaltitude.modules.identity.application;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import com.uav.lowaltitude.modules.identity.domain.AccessDecision;
import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.modules.identity.domain.ScopeMode;
import com.uav.lowaltitude.platform.api.ApiException;
import com.uav.lowaltitude.platform.security.AuthContext;
import com.uav.lowaltitude.platform.security.AuthUser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

/** 阶段 8 融合动作权限、来源类型目录与融合配置：只登记不授权；配置以 DEMO 状态预置且恰有一个 ACTIVE。 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:stage8_access;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;"
                + "DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("test")
class Stage8AccessControlServiceTest {

    private static final String ROLE = "ROLE-STAGE8-DUTY";
    private static final String ORG = "stage8-org-a";
    private static final String DISTRICT = "stage8-district-a";
    private static final List<String> STAGE8_CODES = List.of("fusion:manage", "fusion:read", "fusion:revise");

    @Autowired AccessControlService accessControlService;
    @Autowired JdbcTemplate jdbc;

    String userId;

    @BeforeEach
    void createDefaultDeniedUser() {
        AuthContext.clear();
        userId = UUID.randomUUID().toString();
        jdbc.update("insert into app_role (role_code,name,description,builtin,enabled,created_at,updated_at,version,system_role) select ?,'Stage 8 duty role','',false,true,0,0,0,false where not exists (select 1 from app_role where role_code=?)", ROLE, ROLE);
        jdbc.update("delete from app_role_permission where role_code=?", ROLE);
        jdbc.update("insert into app_user (user_id,account,name,role_code,status,password_hash,fail_count,scope_mode,permission_version,created_at,updated_at,version) values (?,?,'Stage 8 operator',?,'ACTIVE','hash',0,'ASSIGNED',0,0,0,0)", userId, "stage8-" + userId, ROLE);
        jdbc.update("insert into app_org (org_id,org_code,name,enabled,created_at,updated_at,version) select ?,?,?,true,0,0,0 where not exists (select 1 from app_org where org_id=?)", ORG, "STAGE8-ORG-A", "STAGE8-ORG-A", ORG);
        jdbc.update("insert into app_district (district_id,district_code,name,enabled,created_at,updated_at,version) select ?,?,?,true,0,0,0 where not exists (select 1 from app_district where district_id=?)", DISTRICT, "STAGE8-DISTRICT-A", "STAGE8-DISTRICT-A", DISTRICT);
        AuthContext.set(new AuthUser(userId, "stage8", "Stage 8", "ROLE-ADMIN", 0, false, "ALL"));
    }

    @AfterEach
    void cleanup() {
        AuthContext.clear();
        jdbc.update("delete from app_user_data_scope where user_id=?", userId);
        jdbc.update("delete from app_user where user_id=?", userId);
        jdbc.update("delete from app_role_permission where role_code=?", ROLE);
    }

    @Test
    void catalogsStage8ActionsWithoutGrantingProductionRoles() {
        List<Map<String, Object>> rows = jdbc.queryForList("select permission_code, permission_kind, route_key from app_permission where permission_code in ('fusion:read','fusion:revise','fusion:manage') order by permission_code");
        assertThat(rows).extracting(row -> row.get("permission_code")).containsExactlyElementsOf(STAGE8_CODES);
        assertThat(rows).allSatisfy(row -> { assertThat(row.get("permission_kind")).isEqualTo("ACTION"); assertThat(row.get("route_key")).isNull(); });
        assertThat(jdbc.queryForObject("select count(*) from app_role_permission where permission_code in ('fusion:read','fusion:revise','fusion:manage') and role_code<>'ROLE-ADMIN'", Integer.class)).isZero();
        for (String code : STAGE8_CODES) assertThat(java.util.Arrays.stream(PermissionCode.values()).map(PermissionCode::value)).contains(code);
    }

    @Test
    void sourceTypeCatalogMarksOnlyRadarAsConfirmed() {
        List<Map<String, Object>> rows = jdbc.queryForList("select source_type, schema_status from source_type_catalog order by source_type");
        assertThat(rows).extracting(row -> row.get("source_type")).containsExactly("EO", "FIVE_G_A", "FUSION_BOX", "RADAR", "TDOA");
        // 只有雷达有协议资料（T02 v3.0.0）；其余三路及融合箱字段为 Demo，页面与文档必须标注待确认。
        assertThat(rows).filteredOn(row -> "RADAR".equals(row.get("source_type"))).extracting(row -> row.get("schema_status")).containsExactly("CONFIRMED");
        assertThat(rows).filteredOn(row -> !"RADAR".equals(row.get("source_type"))).allSatisfy(row -> assertThat(row.get("schema_status")).isEqualTo("DEMO"));
        assertThat(jdbc.queryForObject("select count(*) from information_schema.columns where lower(table_name)='integration_source' and lower(column_name)='source_type'", Integer.class)).isEqualTo(1);
    }

    @Test
    void fusionConfigHasExactlyOneActiveDemoVersionWithRequiredParameterGroups() {
        List<Map<String, Object>> active = jdbc.queryForList("select config_version, schema_status, params from fusion_config where status='ACTIVE'");
        assertThat(active).hasSize(1);
        assertThat(active.get(0).get("schema_status")).isEqualTo("DEMO");
        // H2 的 JSON 列读出来是带转义的字符串（\"filter\"），PostgreSQL 是原样 JSON；统一去掉反斜杠后按键名断言。
        Object raw = active.get(0).get("params");
        String params = String.valueOf(raw instanceof byte[] b ? new String(b, java.nio.charset.StandardCharsets.UTF_8) : raw).replace("\\", "");
        for (String group : List.of("\"filter\":", "\"association\":", "\"identity\":", "\"weights\":", "\"quality\":", "\"degradation\":")) assertThat(params).contains(group);
    }

    @Test
    void menuPermissionDoesNotGrantFusionActionsAndAssignedNeedsExactTuple() {
        jdbc.update("insert into app_role_permission (role_code,permission_code,permission_level,menu_enabled,created_at) values (?,?,'READ',false,current_timestamp)", ROLE, "sensing");
        assertForbidden(PermissionCode.FUSION_REVISE);
        jdbc.update("insert into app_role_permission (role_code,permission_code,permission_level,menu_enabled,created_at) values (?,?,'OP',false,current_timestamp)", ROLE, PermissionCode.FUSION_REVISE.value());
        assertForbidden(PermissionCode.FUSION_REVISE);
        jdbc.update("insert into app_user_data_scope (user_id,org_id,district_id,created_at) values (?,?,?,current_timestamp)", userId, ORG, DISTRICT);
        assertThat(accessControlService.require(PermissionCode.FUSION_REVISE)).isEqualTo(new AccessDecision(userId, ScopeMode.ASSIGNED));
        // 修订/合并动作不附带目标读权限；服务层分别校验 target:read。
        assertForbidden(PermissionCode.TARGET_READ);
        assertForbidden(PermissionCode.FUSION_MANAGE);
    }

    private void assertForbidden(PermissionCode permission) {
        ApiException error = catchThrowableOfType(ApiException.class, () -> accessControlService.require(permission));
        assertThat(error.getStatus()).isEqualTo(HttpStatus.FORBIDDEN);
    }
}
