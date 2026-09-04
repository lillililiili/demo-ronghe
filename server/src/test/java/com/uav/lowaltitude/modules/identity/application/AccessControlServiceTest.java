package com.uav.lowaltitude.modules.identity.application;

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

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:access_service;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;"
                + "DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("test")
class AccessControlServiceTest {

    private static final String ROLE_CODE = "ROLE-DUTY";
    private static final String ORG_ID = "00000000-0000-0000-0000-000000000101";
    private static final String DISTRICT_ID = "00000000-0000-0000-0000-000000000201";

    @Autowired
    AccessControlService accessControlService;

    @Autowired
    JdbcTemplate jdbc;

    String userId;

    @BeforeEach
    void resetAccessFacts() {
        AuthContext.clear();
        userId = jdbc.queryForObject(
                "select user_id from app_user where account = 'duty1'", String.class);
        jdbc.update("delete from app_user_data_scope where user_id = ?", userId);
        jdbc.update("delete from app_role_permission where role_code = ?", ROLE_CODE);
        jdbc.update(
                "update app_user set status = '正常', role_code = ?, scope_mode = 'NONE', "
                        + "permission_version = 0 where user_id = ?",
                ROLE_CODE,
                userId);
        jdbc.update("update app_role set enabled = true where role_code = ?", ROLE_CODE);
        jdbc.update(
                "insert into app_org "
                        + "(org_id, org_code, name, enabled, created_at, updated_at, version) "
                        + "select ?, 'TEST-ORG', 'Test Org', true, current_timestamp, current_timestamp, 0 "
                        + "where not exists (select 1 from app_org where org_id = ?)",
                ORG_ID,
                ORG_ID);
        jdbc.update("update app_org set enabled = true where org_id = ?", ORG_ID);
        jdbc.update(
                "insert into app_district "
                        + "(district_id, district_code, name, created_at, updated_at, version) "
                        + "select ?, 'TEST-DISTRICT', 'Test District', current_timestamp, current_timestamp, 0 "
                        + "where not exists (select 1 from app_district where district_id = ?)",
                DISTRICT_ID,
                DISTRICT_ID);
    }

    @AfterEach
    void clearCurrentUser() {
        AuthContext.clear();
    }

    @Test
    void rejectsMissingSessionAsUnauthenticated() {
        ApiException error = catchThrowableOfType(
                ApiException.class,
                () -> accessControlService.require(PermissionCode.DEVICE_READ));

        assertThat(error.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(error.getCode()).isEqualTo("UNAUTHENTICATED");
    }

    @Test
    void rejectsDisabledUser() {
        grant(PermissionCode.DEVICE_READ);
        jdbc.update("update app_user set status = '停用', scope_mode = 'ALL' where user_id = ?", userId);
        authenticate();

        assertForbidden(PermissionCode.DEVICE_READ);
    }

    @Test
    void rejectsMissingRole() {
        grant(PermissionCode.DEVICE_READ);
        jdbc.update("update app_user set scope_mode = 'ALL' where user_id = ?", userId);
        authenticate();

        jdbc.execute("set referential_integrity false");
        jdbc.update("delete from app_role where role_code = ?", ROLE_CODE);
        try {
            assertForbidden(PermissionCode.DEVICE_READ);
        } finally {
            restoreDutyRole();
            jdbc.execute("set referential_integrity true");
        }
    }

    @Test
    void rejectsDisabledRole() {
        grant(PermissionCode.DEVICE_READ);
        jdbc.update("update app_user set scope_mode = 'ALL' where user_id = ?", userId);
        jdbc.update("update app_role set enabled = false where role_code = ?", ROLE_CODE);
        authenticate();

        assertForbidden(PermissionCode.DEVICE_READ);
    }

    @Test
    void rejectsMissingPermissionMapping() {
        jdbc.update("update app_user set scope_mode = 'ALL' where user_id = ?", userId);
        authenticate();

        assertForbidden(PermissionCode.DEVICE_READ);
    }

    @Test
    void rejectsNoneScope() {
        grant(PermissionCode.DEVICE_READ);
        authenticate();

        assertForbidden(PermissionCode.DEVICE_READ);
    }

    @Test
    void rejectsAssignedScopeWithoutAnActiveExactTuple() {
        grant(PermissionCode.DEVICE_READ);
        jdbc.update("update app_user set scope_mode = 'ASSIGNED' where user_id = ?", userId);
        authenticate();

        assertForbidden(PermissionCode.DEVICE_READ);

        addScope();
        jdbc.update("update app_org set enabled = false where org_id = ?", ORG_ID);
        assertForbidden(PermissionCode.DEVICE_READ);
    }

    @Test
    void rejectsAssignedScopeWhoseDistrictNoLongerExists() {
        grant(PermissionCode.DEVICE_READ);
        addScope();
        jdbc.update("update app_user set scope_mode = 'ASSIGNED' where user_id = ?", userId);
        authenticate();

        jdbc.execute("set referential_integrity false");
        jdbc.update("delete from app_district where district_id = ?", DISTRICT_ID);
        try {
            assertForbidden(PermissionCode.DEVICE_READ);
        } finally {
            restoreDistrict();
            jdbc.execute("set referential_integrity true");
        }
    }

    @Test
    void returnsAssignedDecisionForAnActiveExactTuple() {
        grant(PermissionCode.TARGET_READ);
        addScope();
        jdbc.update("update app_user set scope_mode = 'ASSIGNED' where user_id = ?", userId);
        authenticateWithUntrustedRoleCode();

        AccessDecision decision = accessControlService.require(PermissionCode.TARGET_READ);

        assertThat(decision).isEqualTo(new AccessDecision(userId, ScopeMode.ASSIGNED));
    }

    @Test
    void returnsAllDecisionOnlyWhenExplicitlyStored() {
        grant(PermissionCode.ALARM_READ);
        jdbc.update("update app_user set scope_mode = 'ALL' where user_id = ?", userId);
        authenticate();

        AccessDecision decision = accessControlService.require(PermissionCode.ALARM_READ);

        assertThat(decision).isEqualTo(new AccessDecision(userId, ScopeMode.ALL));
    }

    @Test
    void readsPermissionAndScopeChangesFromTheDatabaseOnEveryCall() {
        grant(PermissionCode.DEVICE_READ);
        addScope();
        jdbc.update("update app_user set scope_mode = 'ASSIGNED' where user_id = ?", userId);
        authenticate();

        assertThat(accessControlService.require(PermissionCode.DEVICE_READ).scopeMode())
                .isEqualTo(ScopeMode.ASSIGNED);

        jdbc.update(
                "delete from app_role_permission where role_code = ? and permission_code = ?",
                ROLE_CODE,
                PermissionCode.DEVICE_READ.value());
        assertForbidden(PermissionCode.DEVICE_READ);

        grant(PermissionCode.DEVICE_READ);
        jdbc.update("delete from app_user_data_scope where user_id = ?", userId);
        jdbc.update(
                "update app_user set scope_mode = 'ALL', permission_version = permission_version + 1 "
                        + "where user_id = ?",
                userId);
        assertThat(accessControlService.require(PermissionCode.DEVICE_READ).scopeMode())
                .isEqualTo(ScopeMode.ALL);

        jdbc.update(
                "update app_user set scope_mode = 'NONE', permission_version = permission_version + 1 "
                        + "where user_id = ?",
                userId);
        assertForbidden(PermissionCode.DEVICE_READ);
    }

    private void grant(PermissionCode permission) {
        jdbc.update(
                "insert into app_role_permission (role_code, permission_code, created_at) "
                        + "values (?, ?, current_timestamp)",
                ROLE_CODE,
                permission.value());
    }

    private void addScope() {
        jdbc.update(
                "insert into app_user_data_scope (user_id, org_id, district_id, created_at) "
                        + "values (?, ?, ?, current_timestamp)",
                userId,
                ORG_ID,
                DISTRICT_ID);
    }

    private void authenticate() {
        AuthContext.set(new AuthUser(userId, "duty1", "Duty User", ROLE_CODE));
    }

    private void authenticateWithUntrustedRoleCode() {
        AuthContext.set(new AuthUser(userId, "duty1", "Duty User", "ROLE-ADMIN"));
    }

    private void assertForbidden(PermissionCode permission) {
        ApiException error = catchThrowableOfType(
                ApiException.class, () -> accessControlService.require(permission));
        assertThat(error.getStatus()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(error.getCode()).isEqualTo("FORBIDDEN");
    }

    private void restoreDutyRole() {
        jdbc.update(
                "insert into app_role "
                        + "(role_code, name, enabled, system_role, created_at, updated_at, version) "
                        + "values (?, 'Synthetic ROLE-DUTY', true, false, current_timestamp, current_timestamp, 0)",
                ROLE_CODE);
    }

    private void restoreDistrict() {
        jdbc.update(
                "insert into app_district "
                        + "(district_id, district_code, name, created_at, updated_at, version) "
                        + "values (?, 'TEST-DISTRICT', 'Test District', current_timestamp, current_timestamp, 0)",
                DISTRICT_ID);
    }
}
