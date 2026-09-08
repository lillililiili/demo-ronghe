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

import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.platform.api.ApiException;
import com.uav.lowaltitude.platform.security.AuthContext;
import com.uav.lowaltitude.platform.security.AuthUser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:stage3_access;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;"
                + "DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("test")
class Stage3AccessControlServiceTest {

    private static final String ROLE = "ROLE-STAGE3-DUTY";

    private static final List<PermissionCode> STAGE3_READ_PERMISSIONS = List.of(
            PermissionCode.FLIGHT_READ,
            PermissionCode.ROUTE_READ,
            PermissionCode.AIRSPACE_READ,
            PermissionCode.ASSESSMENT_READ);

    @Autowired
    AccessControlService accessControlService;

    @Autowired
    JdbcTemplate jdbc;

    String userId;

    @BeforeEach
    void createDefaultDeniedUser() {
        AuthContext.clear();
        userId = UUID.randomUUID().toString();
        jdbc.update("""
                insert into app_role (
                    role_code, name, description, builtin, enabled,
                    created_at, updated_at, version, system_role
                ) select ?, 'Stage 3 duty role', '', false, true, 0, 0, 0, false
                where not exists (select 1 from app_role where role_code=?)
                """, ROLE, ROLE);
        jdbc.update("delete from app_role_permission where role_code=?", ROLE);
        jdbc.update("""
                insert into app_user (
                    user_id, account, name, role_code, status, password_hash, fail_count,
                    scope_mode, permission_version, created_at, updated_at, version
                ) values (?, ?, 'Stage 3 reader', ?, 'ACTIVE', 'hash', 0, 'ALL', 0, 0, 0, 0)
                """, userId, "stage3-" + userId, ROLE);
        AuthContext.set(new AuthUser(
                userId,
                "stage3",
                "Stage 3",
                "ROLE-ADMIN",
                0,
                false,
                "ALL"));
    }

    @AfterEach
    void cleanup() {
        AuthContext.clear();
        jdbc.update("delete from app_user_data_scope where user_id=?", userId);
        jdbc.update("delete from app_user where user_id=?", userId);
        jdbc.update("delete from app_role_permission where role_code=?", ROLE);
    }

    @Test
    void catalogsEveryStage3ReadPermissionAsAnActionWithoutProductionRoleGrants() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                select permission_code, module_code, permission_kind, action_code, route_key
                from app_permission
                where permission_code in ('flight:read', 'route:read', 'airspace:read', 'assessment:read')
                order by permission_code
                """);

        assertThat(rows).hasSize(4);
        assertThat(rows)
                .allSatisfy(row -> {
                    assertThat(row.get("permission_kind")).isEqualTo("ACTION");
                    assertThat(row.get("action_code")).isEqualTo("read");
                    assertThat(row.get("route_key")).isNull();
                });
        assertThat(rows).extracting(row -> row.get("permission_code"))
                .containsExactly("airspace:read", "assessment:read", "flight:read", "route:read");
        assertThat(rows).extracting(row -> row.get("module_code"))
                .containsExactly("airspace", "assessment", "flight", "route");
        assertThat(jdbc.queryForObject("""
                select count(*) from app_role_permission
                where permission_code in ('flight:read', 'route:read', 'airspace:read', 'assessment:read')
                  and role_code not in ('ROLE-ADMIN', 'ROLE-DEMO-REVIEWER')
                """, Integer.class)).isZero();   // 演示复核员是 local/test 种子角色（15-34），不是生产角色
        // 演示复核员在这组码里只许持四个 READ（15-34）：按名放行之外再钉死内容，种子将来多授一个也会红。
        assertThat(jdbc.queryForList("""
                select permission_code || '=' || permission_level from app_role_permission
                where permission_code in ('flight:read', 'route:read', 'airspace:read', 'assessment:read')
                  and role_code = 'ROLE-DEMO-REVIEWER' order by permission_code
                """, String.class)).containsExactly("airspace:read=READ", "assessment:read=READ", "flight:read=READ", "route:read=READ");
    }

    @Test
    void deniesEveryStage3ReadActionWhenTheStoredRoleHasNoGrant() {
        for (PermissionCode permission : STAGE3_READ_PERMISSIONS) {
            ApiException error = catchThrowableOfType(
                    ApiException.class,
                    () -> accessControlService.require(permission));

            assertThat(error.getStatus()).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(error.getCode()).isEqualTo("FORBIDDEN");
        }
    }
}
