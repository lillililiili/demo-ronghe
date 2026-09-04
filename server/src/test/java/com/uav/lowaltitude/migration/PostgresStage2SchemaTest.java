package com.uav.lowaltitude.migration;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@EnabledIfEnvironmentVariable(named = "POSTGRES_TEST_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "POSTGRES_TEST_USER", matches = ".+")
@EnabledIfEnvironmentVariable(named = "POSTGRES_TEST_PASSWORD", matches = ".*")
class PostgresStage2SchemaTest {

    private static final String COMMON_LOCATION = "classpath:db/migration";
    private static final String POSTGRES_LOCATION = "classpath:db/postgresql";
    private static final String SCHEMA_PREFIX = "stage2_";

    DataSource dataSource;

    @BeforeEach
    void connectToIsolatedPostgres() {
        dataSource = new DriverManagerDataSource(
                System.getenv("POSTGRES_TEST_URL"),
                System.getenv("POSTGRES_TEST_USER"),
                System.getenv("POSTGRES_TEST_PASSWORD"));
    }

    @Test
    void migratesAnEmptySchemaAndEnforcesPostgresOnlyFeatures() throws Exception {
        withRandomSchema(schema -> {
            assertPostgresAndPostgisVersions();

            Flyway flyway = stage2Flyway(schema);
            MigrateResult first = flyway.migrate();
            assertThat(first.migrationsExecuted).isEqualTo(5);

            withSchemaJdbc(schema, jdbc -> {
                assertPostgresColumnTypes(jdbc, schema);
                assertPostgresIndexes(jdbc, schema);
                assertPostgresConstraints(jdbc, schema);
                assertIllegalSamplesAreRejected(jdbc);
                executePostgresRepeatableAgain(jdbc);
            });

            MigrateResult second = flyway.migrate();
            assertThat(second.migrationsExecuted).isZero();
        });
    }

    @Test
    void upgradesAV1V2SchemaBeforeApplyingV3V4AndTheRepeatable() throws Exception {
        withRandomSchema(schema -> {
            Flyway legacy = Flyway.configure()
                    .dataSource(dataSource)
                    .schemas(schema)
                    .defaultSchema(schema)
                    .createSchemas(false)
                    .cleanDisabled(true)
                    .locations(COMMON_LOCATION)
                    .target(MigrationVersion.fromVersion("2"))
                    .load();
            assertThat(legacy.migrate().migrationsExecuted).isEqualTo(2);

            Flyway upgrade = stage2Flyway(schema);
            assertThat(upgrade.migrate().migrationsExecuted).isEqualTo(3);
            assertThat(upgrade.migrate().migrationsExecuted).isZero();

            withSchemaJdbc(schema, jdbc -> {
                assertThat(tableNames(jdbc, schema)).contains(
                        "app_user", "app_permission", "integration_source", "device", "alarm");
                assertThat(indexDefinitions(jdbc, schema))
                        .containsKeys("idx_device_location_gist", "idx_device_source_external_unique");
            });
        });
    }

    private Flyway stage2Flyway(String schema) {
        return Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .defaultSchema(schema)
                .createSchemas(false)
                .cleanDisabled(true)
                .locations(COMMON_LOCATION, POSTGRES_LOCATION)
                .load();
    }

    private void assertPostgresAndPostgisVersions() {
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String serverVersion = jdbc.queryForObject("show server_version", String.class);
        String postgisVersion = jdbc.queryForObject(
                "select extversion from pg_extension where extname = 'postgis'",
                String.class);
        assertThat(serverVersion).startsWith("16.");
        assertThat(postgisVersion).startsWith("3.5");
    }

    private void assertPostgresColumnTypes(JdbcTemplate jdbc, String schema) {
        assertThat(formatType(jdbc, schema, "device", "location"))
                .isEqualTo("geometry(Point,4326)");
        assertThat(formatType(jdbc, schema, "target_latest_state", "location"))
                .isEqualTo("geometry(Point,4326)");
        assertThat(formatType(jdbc, schema, "track_point", "location"))
                .isEqualTo("geometry(Point,4326)");

        assertThat(dataType(jdbc, schema, "inbox_message", "payload")).isEqualTo("jsonb");
        assertThat(dataType(jdbc, schema, "device_state_history", "snapshot")).isEqualTo("jsonb");
        assertThat(dataType(jdbc, schema, "device_state", "observed_at"))
                .isEqualTo("timestamp with time zone");
        assertThat(dataType(jdbc, schema, "alarm", "received_at"))
                .isEqualTo("timestamp with time zone");
    }

    private void assertPostgresIndexes(JdbcTemplate jdbc, String schema) {
        Map<String, String> indexes = indexDefinitions(jdbc, schema);

        assertThat(indexes.get("idx_device_location_gist")).containsIgnoringCase("using gist");
        assertThat(indexes.get("idx_target_latest_state_location_gist")).containsIgnoringCase("using gist");
        assertThat(indexes.get("idx_track_point_location_gist")).containsIgnoringCase("using gist");
        assertThat(indexes.get("idx_device_source_external_unique"))
                .containsIgnoringCase("create unique index")
                .containsIgnoringCase("where")
                .containsIgnoringCase("source_id is not null");
        assertThat(indexes.get("idx_target_source_link_device"))
                .containsIgnoringCase("where")
                .containsIgnoringCase("device_id is not null");
        assertThat(indexes.get("idx_device_state_history_display_time"))
                .containsIgnoringCase("coalesce(observed_at, received_at)");
        assertThat(indexes.get("idx_track_point_display_time"))
                .containsIgnoringCase("coalesce(observed_at, received_at)");
    }

    private void assertPostgresConstraints(JdbcTemplate jdbc, String schema) {
        List<String> constraints = jdbc.queryForList("""
                select con.conname
                from pg_constraint con
                join pg_class rel on rel.oid = con.conrelid
                join pg_namespace ns on ns.oid = rel.relnamespace
                where ns.nspname = ?
                """, String.class, schema);
        assertThat(constraints).contains(
                "ck_device_location_wgs84",
                "ck_target_latest_state_location_wgs84",
                "ck_track_point_location_wgs84");

        List<String> triggers = jdbc.queryForList("""
                select trigger_name
                from information_schema.triggers
                where trigger_schema = ?
                """, String.class, schema);
        assertThat(triggers).contains(
                "trg_app_org_prevent_cycle",
                "trg_app_district_prevent_cycle");
    }

    private void assertIllegalSamplesAreRejected(JdbcTemplate jdbc) {
        assertThatThrownBy(() -> jdbc.update("""
                insert into device (
                    device_id, device_no, name, location, source_mode,
                    created_at, updated_at, version
                ) values (
                    'device-out-of-range', 'OUT-OF-RANGE', 'Out of range',
                    ST_SetSRID(ST_MakePoint(181, 0), 4326), 'replay',
                    current_timestamp, current_timestamp, 0
                )
                """))
                .isInstanceOf(DataIntegrityViolationException.class);

        jdbc.update("""
                insert into integration_source (
                    source_id, source_code, name, enabled, source_mode,
                    created_at, updated_at, version
                ) values (
                    'source-pg', 'source-pg', 'Postgres source', false, 'replay',
                    current_timestamp, current_timestamp, 0
                )
                """);
        jdbc.update("""
                insert into device (
                    device_id, source_id, external_device_id, device_no, name, source_mode,
                    created_at, updated_at, version
                ) values (
                    'device-pg-1', 'source-pg', 'external-1', 'DEVICE-PG-1', 'Device one', 'replay',
                    current_timestamp, current_timestamp, 0
                )
                """);

        assertThatThrownBy(() -> jdbc.update("""
                insert into device (
                    device_id, source_id, external_device_id, device_no, name, source_mode,
                    created_at, updated_at, version
                ) values (
                    'device-pg-2', 'source-pg', 'external-1', 'DEVICE-PG-2', 'Device two', 'replay',
                    current_timestamp, current_timestamp, 0
                )
                """))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> jdbc.update("""
                insert into device_state (
                    device_id, connectivity, observed_at, received_at,
                    created_at, updated_at, version
                ) values (
                    'device-pg-1', 'ABNORMAL', current_timestamp, current_timestamp,
                    current_timestamp, current_timestamp, 0
                )
                """))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> jdbc.update("""
                insert into alarm (
                    alarm_id, source_id, source_alarm_id, alarm_type, severity,
                    received_at, source_mode, created_at
                ) values (
                    'alarm-invalid-fk', 'missing-source', 'alarm-1', 'RADAR', 'UNKNOWN',
                    current_timestamp, 'replay', current_timestamp
                )
                """))
                .isInstanceOf(DataIntegrityViolationException.class);

        jdbc.update("""
                insert into app_org (org_id, org_code, name)
                values ('org-parent', 'ORG-PARENT', 'Org parent')
                """);
        jdbc.update("""
                insert into app_org (org_id, parent_id, org_code, name)
                values ('org-child', 'org-parent', 'ORG-CHILD', 'Org child')
                """);
        assertThatThrownBy(() -> jdbc.update(
                "update app_org set parent_id = 'org-child' where org_id = 'org-parent'"))
                .isInstanceOf(DataIntegrityViolationException.class);

        jdbc.update("""
                insert into app_district (district_id, district_code, name)
                values ('district-parent', 'DISTRICT-PARENT', 'District parent')
                """);
        jdbc.update("""
                insert into app_district (district_id, parent_id, district_code, name)
                values ('district-child', 'district-parent', 'DISTRICT-CHILD', 'District child')
                """);
        assertThatThrownBy(() -> jdbc.update(
                "update app_district set parent_id = 'district-child' where district_id = 'district-parent'"))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    private void executePostgresRepeatableAgain(JdbcTemplate jdbc) throws IOException {
        ClassPathResource repeatable = new ClassPathResource(
                "db/postgresql/R__stage2_postgres_constraints_and_indexes.sql");
        assertThat(repeatable.exists()).isTrue();
        String sql = repeatable.getContentAsString(StandardCharsets.UTF_8);
        jdbc.execute(sql);
    }

    private String formatType(
            JdbcTemplate jdbc,
            String schema,
            String table,
            String column) {
        return jdbc.queryForObject("""
                select format_type(attribute.atttypid, attribute.atttypmod)
                from pg_attribute attribute
                join pg_class relation on relation.oid = attribute.attrelid
                join pg_namespace namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = ?
                  and relation.relname = ?
                  and attribute.attname = ?
                  and attribute.attnum > 0
                  and not attribute.attisdropped
                """, String.class, schema, table, column);
    }

    private String dataType(
            JdbcTemplate jdbc,
            String schema,
            String table,
            String column) {
        return jdbc.queryForObject("""
                select data_type
                from information_schema.columns
                where table_schema = ? and table_name = ? and column_name = ?
                """, String.class, schema, table, column);
    }

    private Map<String, String> indexDefinitions(JdbcTemplate jdbc, String schema) {
        return jdbc.query("""
                select indexname, indexdef
                from pg_indexes
                where schemaname = ?
                """, resultSet -> {
                    java.util.LinkedHashMap<String, String> indexes = new java.util.LinkedHashMap<>();
                    while (resultSet.next()) {
                        indexes.put(resultSet.getString("indexname"), resultSet.getString("indexdef"));
                    }
                    return indexes;
                }, schema);
    }

    private List<String> tableNames(JdbcTemplate jdbc, String schema) {
        return jdbc.queryForList("""
                select table_name
                from information_schema.tables
                where table_schema = ?
                """, String.class, schema);
    }

    private void withRandomSchema(ThrowingConsumer<String> action) throws Exception {
        String schema = SCHEMA_PREFIX + UUID.randomUUID().toString().replace("-", "");
        assertSafeSchema(schema);
        try (Connection connection = dataSource.getConnection();
                Statement statement = connection.createStatement()) {
            statement.execute("create schema " + schema);
        }
        try {
            action.accept(schema);
        } finally {
            assertSafeSchema(schema);
            try (Connection connection = dataSource.getConnection();
                    Statement statement = connection.createStatement()) {
                statement.execute("drop schema " + schema + " cascade");
            }
        }
    }

    private void withSchemaJdbc(String schema, ThrowingConsumer<JdbcTemplate> action) throws Exception {
        assertSafeSchema(schema);
        try (Connection connection = dataSource.getConnection()) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("set search_path to " + schema + ", public");
            }
            SingleConnectionDataSource schemaDataSource = new SingleConnectionDataSource(connection, true);
            action.accept(new JdbcTemplate(schemaDataSource));
        }
    }

    private void assertSafeSchema(String schema) {
        assertThat(schema).matches("^stage2_[a-f0-9]{32}$");
    }

    @FunctionalInterface
    private interface ThrowingConsumer<T> {
        void accept(T value) throws Exception;
    }
}
