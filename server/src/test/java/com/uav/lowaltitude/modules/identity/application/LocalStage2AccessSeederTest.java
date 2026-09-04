package com.uav.lowaltitude.modules.identity.application;

import java.util.List;
import java.util.UUID;

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

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@ActiveProfiles("test")
class LocalStage2AccessSeederTest {

    @Autowired
    LocalStage2AccessSeeder seeder;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    AccessService legacyAccessService;

    @Test
    void localSeedExplicitlyGrantsOnlyTheSyntheticAdministrator() {
        assertThat(actionGrants(jdbc)).containsExactly(
                "ROLE-ADMIN:alarm:read",
                "ROLE-ADMIN:device:read",
                "ROLE-ADMIN:target:read");
        assertThat(jdbc.queryForObject(
                "select scope_mode from app_user where account='admin1'", String.class))
                .isEqualTo("ALL");
        assertThat(legacyAccessService.permissionCodes("ROLE-ADMIN"))
                .noneMatch(code -> code.contains(":"));

        seeder.run(new DefaultApplicationArguments(new String[0]));
        seeder.run(new DefaultApplicationArguments(new String[0]));
        assertThat(actionGrants(jdbc)).hasSize(3);
    }

    @Test
    void disabledSeedLeavesActionPermissionsUnassigned() {
        String database = "stage2_seed_disabled_" + UUID.randomUUID();
        try (ConfigurableApplicationContext context = new SpringApplicationBuilder(Application.class)
                .web(WebApplicationType.NONE)
                .run(
                        "--spring.profiles.active=test",
                        "--spring.datasource.url=jdbc:h2:mem:" + database
                                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1",
                        "--app.dev-seed.enabled=false")) {
            assertThat(context.getBeansOfType(LocalStage2AccessSeeder.class)).isEmpty();
            assertThat(actionGrants(context.getBean(JdbcTemplate.class))).isEmpty();
        }
    }

    @Test
    void productionProfileCannotEnableTheStage2AccessSeeder() {
        String database = "stage2_seed_production_" + UUID.randomUUID();
        try (ConfigurableApplicationContext context = new SpringApplicationBuilder(Application.class)
                .web(WebApplicationType.NONE)
                .run(
                        "--spring.profiles.active=production",
                        "--spring.datasource.url=jdbc:h2:mem:" + database
                                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1",
                        "--spring.datasource.username=sa",
                        "--spring.datasource.password=",
                        "--spring.datasource.driver-class-name=org.h2.Driver",
                        "--spring.flyway.locations=classpath:db/migration",
                        "--app.dev-seed.enabled=true",
                        "--app.dev-seed.password=Stage2ProductionGuard-9!")) {
            assertThat(context.getBeansOfType(LocalStage2AccessSeeder.class)).isEmpty();
            assertThat(actionGrants(context.getBean(JdbcTemplate.class))).isEmpty();
        }
    }

    private static List<String> actionGrants(JdbcTemplate template) {
        return template.queryForList("""
                select role_code || ':' || permission_code
                from app_role_permission
                where permission_code in ('device:read', 'target:read', 'alarm:read')
                order by role_code, permission_code
                """, String.class);
    }
}
