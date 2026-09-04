package com.uav.lowaltitude.migration;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AccessSchemaMigrationTest {

    private JdbcTemplate jdbc;
    @BeforeEach
    void migrateLegacyUsersThroughAccessSchema() {
        String databaseUrl = "jdbc:h2:mem:access_" + UUID.randomUUID()
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1";
        DataSource dataSource = new DriverManagerDataSource(databaseUrl, "sa", "");
        jdbc = new JdbcTemplate(dataSource);

        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("2"))
                .load()
                .migrate();

        insertLegacyUser("legacy-duty", "ROLE-DUTY");
        insertLegacyUser("legacy-audit", "ROLE-AUDIT");

        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    @Test
    void createsTheSixAccessTablesWithContractColumns() {
        assertThat(tableNames()).contains(
                "app_org",
                "app_district",
                "app_role",
                "app_permission",
                "app_role_permission",
                "app_user_data_scope");

        assertThat(columnNames("app_org")).containsExactlyInAnyOrder(
                "org_id", "parent_id", "org_code", "name", "enabled",
                "created_at", "updated_at", "version");
        assertThat(columnNames("app_district")).containsExactlyInAnyOrder(
                "district_id", "parent_id", "district_code", "name",
                "created_at", "updated_at", "version");
        assertThat(columnNames("app_role")).containsExactlyInAnyOrder(
                "role_code", "name", "enabled", "system_role",
                "created_at", "updated_at", "version");
        assertThat(columnNames("app_permission")).containsExactlyInAnyOrder(
                "permission_code", "module_code", "permission_kind", "action_code", "name", "created_at");
        assertThat(columnNames("app_role_permission")).containsExactlyInAnyOrder(
                "role_code", "permission_code", "created_at");
        assertThat(columnNames("app_user_data_scope")).containsExactlyInAnyOrder(
                "user_id", "org_id", "district_id", "created_at");
    }

    @Test
    void extendsUsersWithDefaultDenyFieldsAndRoleForeignKey() {
        assertThat(columnNames("app_user")).contains("scope_mode", "permission_version");

        List<Map<String, Object>> users = jdbc.queryForList(
                "select account, scope_mode, permission_version from app_user order by account");
        assertThat(users).allSatisfy(user -> {
            assertThat(user.get("scope_mode")).isEqualTo("NONE");
            assertThat(((Number) user.get("permission_version")).longValue()).isZero();
        });

        assertThatThrownBy(() -> jdbc.update(
                "update app_user set scope_mode = 'INVALID' where account = 'legacy-duty'"))
                .isInstanceOf(Exception.class);
        assertThatThrownBy(() -> jdbc.update(
                "update app_user set permission_version = -1 where account = 'legacy-duty'"))
                .isInstanceOf(Exception.class);
        assertThatThrownBy(() -> insertLegacyUser("unknown-role", "ROLE-UNKNOWN"))
                .isInstanceOf(Exception.class);
    }

    @Test
    void createsDisabledCompatibilityRolesWithoutGrantingAccess() {
        List<Map<String, Object>> roles = jdbc.queryForList(
                "select role_code, name, enabled, system_role from app_role order by role_code");
        assertThat(roles).hasSize(2);
        assertThat(roles).allSatisfy(role -> {
            String roleCode = (String) role.get("role_code");
            String name = (String) role.get("name");
            assertThat(name).contains(roleCode).hasSizeLessThanOrEqualTo(64);
            assertThat(role.get("enabled")).isEqualTo(false);
            assertThat(role.get("system_role")).isEqualTo(false);
        });
        assertThat(roles).extracting(role -> role.get("name")).doesNotHaveDuplicates();

        assertThat(count("app_role_permission")).isZero();
        assertThat(count("app_user_data_scope")).isZero();
        assertThat(jdbc.queryForObject(
                "select count(*) from app_user where scope_mode <> 'NONE'", Integer.class)).isZero();
    }

    @Test
    void createsOnlyTheThreeReadPermissionCatalogRows() {
        List<Map<String, Object>> permissions = jdbc.queryForList(
                "select permission_code, module_code, permission_kind, action_code "
                        + "from app_permission order by permission_code");

        assertThat(permissions).containsExactly(
                Map.of(
                        "permission_code", "alarm:read",
                        "module_code", "alarm",
                        "permission_kind", "ACTION",
                        "action_code", "read"),
                Map.of(
                        "permission_code", "device:read",
                        "module_code", "device",
                        "permission_kind", "ACTION",
                        "action_code", "read"),
                Map.of(
                        "permission_code", "target:read",
                        "module_code", "target",
                        "permission_kind", "ACTION",
                        "action_code", "read"));
    }

    @Test
    void rejectsInvalidHierarchyAndBlankCatalogValues() {
        assertThat(tableNames()).contains("app_org", "app_district");

        assertThatThrownBy(() -> jdbc.update(
                "insert into app_org "
                        + "(org_id, parent_id, org_code, name, enabled, created_at, updated_at, version) "
                        + "values ('self', 'self', 'ORG', 'Org', true, current_timestamp, current_timestamp, 0)"))
                .isInstanceOf(Exception.class);
        assertThatThrownBy(() -> jdbc.update(
                "insert into app_district "
                        + "(district_id, district_code, name, created_at, updated_at, version) "
                        + "values ('district', '   ', 'District', current_timestamp, current_timestamp, 0)"))
                .isInstanceOf(Exception.class);
    }

    private void insertLegacyUser(String account, String roleCode) {
        jdbc.update(
                "insert into app_user "
                        + "(user_id, account, name, role_code, status, password_hash, fail_count) "
                        + "values (?, ?, ?, ?, '正常', 'hash', 0)",
                UUID.nameUUIDFromBytes(account.getBytes(StandardCharsets.UTF_8)).toString(),
                account,
                account,
                roleCode);
    }

    private List<String> tableNames() {
        return jdbc.queryForList(
                "select table_name from information_schema.tables where table_schema = 'public'",
                String.class);
    }

    private List<String> columnNames(String tableName) {
        return jdbc.queryForList(
                "select column_name from information_schema.columns "
                        + "where table_schema = 'public' and table_name = ? order by ordinal_position",
                String.class,
                tableName);
    }

    private int count(String tableName) {
        return jdbc.queryForObject("select count(*) from " + tableName, Integer.class);
    }
}
