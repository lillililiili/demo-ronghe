package com.uav.lowaltitude.modules.identity.application;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.uav.lowaltitude.platform.config.AppProperties;

@Component
@Order(30)
public class SuperAdminIntegrityInitializer implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SuperAdminIntegrityInitializer.class);
    private static final String MIGRATED_ADMIN_ROLE = "ROLE-MIGRATED-ADMIN";

    private final JdbcTemplate jdbcTemplate;
    private final AppProperties properties;

    public SuperAdminIntegrityInitializer(JdbcTemplate jdbcTemplate, AppProperties properties) {
        this.jdbcTemplate = jdbcTemplate;
        this.properties = properties;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        if (count("SELECT COUNT(*) FROM app_user") == 0) return;
        String account = normalized(properties.getSuperAdmin().getAccount());
        if (account.isEmpty()) {
            throw new IllegalStateException("APP_SUPER_ADMIN_ACCOUNT must identify the unique super administrator");
        }
        List<Map<String, Object>> selected = jdbcTemplate.queryForList(
                "SELECT user_id, role_code, status, scope_mode FROM app_user WHERE account = ?", account);
        if (selected.size() != 1) {
            throw new IllegalStateException("APP_SUPER_ADMIN_ACCOUNT does not identify an existing unique account");
        }

        List<String> extras = jdbcTemplate.queryForList(
                "SELECT user_id FROM app_user WHERE role_code = 'ROLE-ADMIN' AND account <> ?", String.class, account);
        if (!extras.isEmpty()) {
            ensureMigrationRole();
            jdbcTemplate.update("""
                    UPDATE app_user
                    SET role_code = ?, status = 'DISABLED', scope_mode = 'NONE', must_change_password = TRUE,
                        permission_version = permission_version + 1, updated_at = ?, version = version + 1
                    WHERE role_code = 'ROLE-ADMIN' AND account <> ?
                    """, MIGRATED_ADMIN_ROLE, System.currentTimeMillis(), account);
            jdbcTemplate.update("""
                    UPDATE app_session SET expire_at = 0
                    WHERE user_id IN (SELECT user_id FROM app_user WHERE role_code = ?)
                    """, MIGRATED_ADMIN_ROLE);
            log.warn("demoted and disabled {} extra legacy administrator account(s)", extras.size());
        }

        Map<String, Object> current = selected.get(0);
        boolean changed = !"ROLE-ADMIN".equals(current.get("role_code"))
                || !"ACTIVE".equals(current.get("status")) || !"ALL".equals(current.get("scope_mode"));
        if (changed) {
            jdbcTemplate.update("""
                    UPDATE app_user
                    SET role_code = 'ROLE-ADMIN', status = 'ACTIVE', scope_mode = 'ALL',
                        permission_version = permission_version + 1, updated_at = ?, version = version + 1
                    WHERE account = ?
                    """, System.currentTimeMillis(), account);
            jdbcTemplate.update("""
                    UPDATE app_session SET expire_at = 0
                    WHERE user_id = (SELECT user_id FROM app_user WHERE account = ?)
                    """, account);
        }
        jdbcTemplate.update("""
                DELETE FROM app_user_data_scope
                WHERE user_id = (SELECT user_id FROM app_user WHERE account = ?)
                """, account);
        jdbcTemplate.update("""
                UPDATE app_role_permission
                SET permission_level = 'AUTH',
                    menu_enabled = CASE WHEN permission_code IN
                        (SELECT permission_code FROM app_permission WHERE route_key IS NOT NULL)
                        THEN TRUE ELSE FALSE END
                WHERE role_code = 'ROLE-ADMIN'
                """);
        jdbcTemplate.update("""
                UPDATE app_role_permission SET permission_level = 'NONE', menu_enabled = FALSE
                WHERE role_code <> 'ROLE-ADMIN'
                  AND permission_code IN ('users', 'roles', 'audit', 'countermeasure')
                """);
        int holders = count("SELECT COUNT(*) FROM app_user WHERE role_code = 'ROLE-ADMIN'");
        if (holders != 1) throw new IllegalStateException("the system must have exactly one ROLE-ADMIN account");
    }

    private void ensureMigrationRole() {
        if (count("SELECT COUNT(*) FROM app_role WHERE role_code = '" + MIGRATED_ADMIN_ROLE + "'") == 0) {
            long now = System.currentTimeMillis();
            jdbcTemplate.update("""
                    INSERT INTO app_role
                      (role_code, name, description, builtin, enabled, created_at, updated_at, version)
                    VALUES (?, '迁移角色-原管理员', '由多管理员版本迁移而来，账号已停用且权限已清空', FALSE, TRUE, ?, ?, 0)
                    """, MIGRATED_ADMIN_ROLE, now, now);
            jdbcTemplate.update("""
                    INSERT INTO app_role_permission (role_code, permission_code, permission_level, menu_enabled)
                    SELECT ?, permission_code, 'NONE', FALSE FROM app_permission
                    """, MIGRATED_ADMIN_ROLE);
        }
    }

    private int count(String sql) {
        Integer value = jdbcTemplate.queryForObject(sql, Integer.class);
        return value == null ? 0 : value;
    }

    private static String normalized(String value) {
        return value == null ? "" : value.trim();
    }
}
