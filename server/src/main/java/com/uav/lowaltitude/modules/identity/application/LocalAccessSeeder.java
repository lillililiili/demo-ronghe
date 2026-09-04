package com.uav.lowaltitude.modules.identity.application;

import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.uav.lowaltitude.modules.identity.domain.PermissionCode;

@Component
@ConditionalOnProperty(prefix = "app.dev-seed", name = "enabled", havingValue = "true")
@Order(200)
public class LocalAccessSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(LocalAccessSeeder.class);
    private static final String DUTY_ROLE = "ROLE-DUTY";
    private static final String DUTY_ACCOUNT = "duty1";
    private static final String ORG_ID = "00000000-0000-0000-0000-00000000d001";
    private static final String DISTRICT_ID = "00000000-0000-0000-0000-00000000d002";

    private final JdbcTemplate jdbcTemplate;

    public LocalAccessSeeder(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        String dutyUserId = requireDutyUserId();
        ensureOrganization();
        ensureDistrict();

        boolean roleAccessChanged = enableDutyRole();
        for (PermissionCode permission : PermissionCode.values()) {
            roleAccessChanged |= ensureRolePermission(permission);
        }
        if (roleAccessChanged) {
            jdbcTemplate.update(
                    "update app_user set permission_version = permission_version + 1 where role_code = ?",
                    DUTY_ROLE);
        }

        boolean scopeInserted = ensureDutyScope(dutyUserId);
        int scopeModeChanged = jdbcTemplate.update(
                "update app_user set scope_mode = 'ASSIGNED', "
                        + "permission_version = permission_version + 1 "
                        + "where user_id = ? and scope_mode <> 'ASSIGNED'",
                dutyUserId);
        if (scopeInserted && scopeModeChanged == 0) {
            jdbcTemplate.update(
                    "update app_user set permission_version = permission_version + 1 where user_id = ?",
                    dutyUserId);
        }

        log.info("seeded isolated synthetic read access for duty1");
    }

    private String requireDutyUserId() {
        List<String> userIds = jdbcTemplate.queryForList(
                "select user_id from app_user where account = ?", String.class, DUTY_ACCOUNT);
        if (userIds.size() != 1) {
            throw new IllegalStateException("synthetic duty1 user must exist before access seeding");
        }
        return userIds.get(0);
    }

    private void ensureOrganization() {
        jdbcTemplate.update(
                """
                INSERT INTO app_org (
                    org_id, org_code, name, enabled, created_at, updated_at, version
                )
                SELECT ?, 'SYNTHETIC-REGULATOR', 'Synthetic Regulator', TRUE,
                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0
                WHERE NOT EXISTS (SELECT 1 FROM app_org WHERE org_id = ?)
                """,
                ORG_ID,
                ORG_ID);
        jdbcTemplate.update(
                "update app_org set enabled = true, updated_at = current_timestamp, version = version + 1 "
                        + "where org_id = ? and enabled = false",
                ORG_ID);
    }

    private void ensureDistrict() {
        jdbcTemplate.update(
                """
                INSERT INTO app_district (
                    district_id, district_code, name, created_at, updated_at, version
                )
                SELECT ?, 'SYNTHETIC-DISTRICT', 'Synthetic District',
                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0
                WHERE NOT EXISTS (SELECT 1 FROM app_district WHERE district_id = ?)
                """,
                DISTRICT_ID,
                DISTRICT_ID);
    }

    private boolean enableDutyRole() {
        return jdbcTemplate.update(
                "update app_role set enabled = true, updated_at = current_timestamp, version = version + 1 "
                        + "where role_code = ? and enabled = false",
                DUTY_ROLE) > 0;
    }

    private boolean ensureRolePermission(PermissionCode permission) {
        return jdbcTemplate.update(
                """
                INSERT INTO app_role_permission (role_code, permission_code, created_at)
                SELECT ?, ?, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (
                    SELECT 1 FROM app_role_permission
                    WHERE role_code = ? AND permission_code = ?
                )
                """,
                DUTY_ROLE,
                permission.value(),
                DUTY_ROLE,
                permission.value()) > 0;
    }

    private boolean ensureDutyScope(String dutyUserId) {
        return jdbcTemplate.update(
                """
                INSERT INTO app_user_data_scope (user_id, org_id, district_id, created_at)
                SELECT ?, ?, ?, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (
                    SELECT 1 FROM app_user_data_scope
                    WHERE user_id = ? AND org_id = ? AND district_id = ?
                )
                """,
                dutyUserId,
                ORG_ID,
                DISTRICT_ID,
                dutyUserId,
                ORG_ID,
                DISTRICT_ID) > 0;
    }
}
