package com.uav.lowaltitude.integration.mock;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import com.uav.lowaltitude.Application;

import static org.assertj.core.api.Assertions.assertThat;

class ProductionDevSeedIsolationTest {

    @Test
    void productionCannotEnableAnyDevelopmentSeeder() {
        assertProductionIsolation("production");
    }

    @Test
    void productionWinsWhenLocalIsAlsoActiveForEveryDevelopmentSeeder() {
        assertProductionIsolation("production,local");
    }

    private static void assertProductionIsolation(String profiles) {
        String database = "production_dev_seed_isolation_" + UUID.randomUUID();
        try (ConfigurableApplicationContext context = start(database, profiles)) {
            assertThat(context.containsBean("localUserSeeder")).isFalse();
            assertThat(context.containsBean("localDeviceSeeder")).isFalse();
            assertThat(context.containsBean("localStage2AccessSeeder")).isFalse();
            assertThat(context.containsBean("localStage2TargetSeeder")).isFalse();

            JdbcTemplate jdbc = context.getBean(JdbcTemplate.class);
            assertThat(count(jdbc, "select count(*) from app_user where account='admin1'")).isZero();
            assertThat(count(jdbc, "select count(*) from app_org where org_code='ORG-DEV'")).isZero();
            assertThat(count(jdbc, "select count(*) from app_district where district_code='DIST-DEV'")).isZero();
            assertThat(count(jdbc, "select count(*) from ops_integration_source where source_code='LOCAL-MOCK'")).isZero();
            assertThat(count(jdbc, "select count(*) from ops_device where device_no like 'DEV-MOCK-%'")).isZero();
            assertThat(count(jdbc, "select count(*) from target where target_id like 'seed-target-%'")).isZero();
        }
    }

    private static ConfigurableApplicationContext start(String database, String profiles) {
        return new SpringApplicationBuilder(Application.class)
                .web(WebApplicationType.NONE)
                .run(
                        "--spring.profiles.active=" + profiles,
                        "--spring.datasource.url=jdbc:h2:mem:" + database
                                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1",
                        "--spring.datasource.username=sa",
                        "--spring.datasource.password=",
                        "--spring.datasource.driver-class-name=org.h2.Driver",
                        "--spring.flyway.locations=classpath:db/migration",
                        "--app.dev-seed.enabled=true",
                        "--app.dev-seed.password=ProductionMustNotSeed-9!",
                        "--app.live-device.enabled=false");
    }

    private static int count(JdbcTemplate jdbc, String sql) {
        Integer value = jdbc.queryForObject(sql, Integer.class);
        return value == null ? 0 : value;
    }
}
