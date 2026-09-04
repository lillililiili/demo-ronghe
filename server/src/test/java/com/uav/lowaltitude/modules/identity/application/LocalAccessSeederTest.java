package com.uav.lowaltitude.modules.identity.application;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import com.uav.lowaltitude.Application;
import com.uav.lowaltitude.modules.identity.infrastructure.UserMapper;
import com.uav.lowaltitude.platform.config.AppProperties;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:local_access_enabled;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;"
                + "DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("test")
class LocalAccessSeederTest {

    private static final String ORG_ID = "00000000-0000-0000-0000-00000000d001";
    private static final String DISTRICT_ID = "00000000-0000-0000-0000-00000000d002";

    @Autowired
    LocalAccessSeeder localAccessSeeder;

    @Autowired
    JdbcTemplate jdbc;

    @BeforeEach
    void restoreSyntheticAccess() {
        localAccessSeeder.run(new DefaultApplicationArguments(new String[0]));
    }

    @Test
    void enabledSeedGrantsOnlyDutyReadPermissionsAndOneExactTuple() {
        assertThat(jdbc.queryForList(
                "select role_code from app_role where enabled = true order by role_code",
                String.class)).containsExactly("ROLE-DUTY");

        assertThat(jdbc.queryForList(
                "select permission_code from app_role_permission "
                        + "where role_code = 'ROLE-DUTY' order by permission_code",
                String.class)).containsExactly("alarm:read", "device:read", "target:read");
        assertThat(jdbc.queryForObject(
                "select count(*) from app_role_permission where role_code <> 'ROLE-DUTY'",
                Integer.class)).isZero();

        Map<String, Object> duty = jdbc.queryForMap(
                "select user_id, scope_mode from app_user where account = 'duty1'");
        assertThat(duty.get("scope_mode")).isEqualTo("ASSIGNED");
        assertThat(jdbc.queryForList(
                "select org_id, district_id from app_user_data_scope where user_id = ?",
                duty.get("user_id"))).containsExactly(Map.of(
                        "org_id", ORG_ID,
                        "district_id", DISTRICT_ID));

        assertThat(jdbc.queryForObject(
                "select count(*) from app_user where scope_mode = 'ALL'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject(
                "select count(*) from app_user where account <> 'duty1' and scope_mode <> 'NONE'",
                Integer.class)).isZero();
    }

    @Test
    void repeatedRunsAreIdempotent() {
        Map<String, Integer> before = accessCounts();
        Long permissionVersion = jdbc.queryForObject(
                "select permission_version from app_user where account = 'duty1'", Long.class);

        localAccessSeeder.run(new DefaultApplicationArguments(new String[0]));
        localAccessSeeder.run(new DefaultApplicationArguments(new String[0]));

        assertThat(accessCounts()).isEqualTo(before);
        assertThat(jdbc.queryForObject(
                "select permission_version from app_user where account = 'duty1'", Long.class))
                .isEqualTo(permissionVersion);
    }

    @Test
    void repairsPartialSyntheticAccessEvenWhenUsersAlreadyExist() {
        String dutyUserId = jdbc.queryForObject(
                "select user_id from app_user where account = 'duty1'", String.class);
        jdbc.update(
                "delete from app_role_permission where role_code = 'ROLE-DUTY' "
                        + "and permission_code = 'alarm:read'");
        jdbc.update("delete from app_user_data_scope where user_id = ?", dutyUserId);
        jdbc.update("update app_role set enabled = false where role_code = 'ROLE-DUTY'");
        jdbc.update("update app_user set scope_mode = 'NONE' where user_id = ?", dutyUserId);

        localAccessSeeder.run(new DefaultApplicationArguments(new String[0]));

        assertThat(jdbc.queryForObject(
                "select enabled from app_role where role_code = 'ROLE-DUTY'", Boolean.class)).isTrue();
        assertThat(jdbc.queryForList(
                "select permission_code from app_role_permission "
                        + "where role_code = 'ROLE-DUTY' order by permission_code",
                String.class)).containsExactly("alarm:read", "device:read", "target:read");
        assertThat(jdbc.queryForObject(
                "select scope_mode from app_user where user_id = ?", String.class, dutyUserId))
                .isEqualTo("ASSIGNED");
        assertThat(jdbc.queryForObject(
                "select count(*) from app_user_data_scope where user_id = ?",
                Integer.class,
                dutyUserId)).isEqualTo(1);
    }

    @Test
    void disabledSeedLeavesProductionStyleDatabaseDefaultDeny() {
        String databaseName = "local_access_disabled_" + UUID.randomUUID();
        try (ConfigurableApplicationContext context = new SpringApplicationBuilder(Application.class)
                .web(WebApplicationType.SERVLET)
                .run(
                        "--spring.profiles.active=test",
                        "--server.port=0",
                        "--spring.datasource.url=jdbc:h2:mem:" + databaseName
                                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1",
                        "--app.dev-seed.enabled=false")) {
            assertThat(context.getBeansOfType(LocalUserSeeder.class)).isEmpty();
            assertThat(context.getBeansOfType(LocalAccessSeeder.class)).isEmpty();

            JdbcTemplate disabledJdbc = context.getBean(JdbcTemplate.class);
            assertThat(disabledJdbc.queryForList(
                    "select permission_code from app_permission order by permission_code",
                    String.class)).containsExactly("alarm:read", "device:read", "target:read");
            assertThat(disabledJdbc.queryForObject(
                    "select count(*) from app_role_permission", Integer.class)).isZero();
            assertThat(disabledJdbc.queryForObject(
                    "select count(*) from app_user_data_scope", Integer.class)).isZero();
            assertThat(disabledJdbc.queryForObject(
                    "select count(*) from app_user where scope_mode = 'ALL'", Integer.class)).isZero();
        }
    }

    @Test
    void enabledSeedRequiresPasswordEvenWhenUsersAlreadyExist() {
        UserMapper userMapper = mock(UserMapper.class);
        when(userMapper.count()).thenReturn(1);
        AppProperties properties = new AppProperties();
        properties.getDevSeed().setEnabled(true);
        properties.getDevSeed().setPassword(" ");
        LocalUserSeeder localUserSeeder = new LocalUserSeeder(
                userMapper,
                mock(JdbcTemplate.class),
                mock(org.springframework.security.crypto.password.PasswordEncoder.class),
                properties);

        assertThatThrownBy(() -> localUserSeeder.run(new DefaultApplicationArguments(new String[0])))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("app.dev-seed.password must be set when development seed is enabled");
    }

    private Map<String, Integer> accessCounts() {
        return Map.of(
                "orgs", count("app_org"),
                "districts", count("app_district"),
                "enabled_roles", jdbc.queryForObject(
                        "select count(*) from app_role where enabled = true", Integer.class),
                "role_permissions", count("app_role_permission"),
                "scopes", count("app_user_data_scope"));
    }

    private int count(String tableName) {
        return jdbc.queryForObject("select count(*) from " + tableName, Integer.class);
    }
}
