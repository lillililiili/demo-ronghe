package com.uav.lowaltitude.migration;

import java.io.IOException;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.PropertySourcesPropertyResolver;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RadarSchemaMigrationTest {

    private static final Set<String> RADAR_TABLES = Set.of(
            "integration_source",
            "device",
            "device_state",
            "device_state_history",
            "target",
            "target_source_link",
            "target_latest_state",
            "track",
            "track_point",
            "alarm");

    JdbcTemplate jdbc;

    DataSource dataSource;

    @BeforeEach
    void migrateRadarSchema() {
        String databaseUrl = "jdbc:h2:mem:radar_" + UUID.randomUUID()
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1";
        dataSource = new DriverManagerDataSource(databaseUrl, "sa", "");
        jdbc = new JdbcTemplate(dataSource);

        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    @Test
    void createsTheTenRadarReadModelTables() throws SQLException {
        assertThat(tableNames()).containsAll(RADAR_TABLES);
    }

    @Test
    void extendsInboxWithoutReplacingItsOriginalIdentityAndUniqueKey() throws SQLException {
        assertTableExists("integration_source");

        assertThat(columnNames("inbox_message")).contains(
                "inbox_id", "source", "source_msg_id", "received_at",
                "source_id", "payload_hash", "payload", "status",
                "processed_at", "last_error", "lease_token", "lease_until");

        insertSource("source-inbox", "source-inbox");
        jdbc.update("""
                insert into inbox_message (
                    inbox_id, source, source_msg_id, received_at, source_id,
                    payload_hash, payload, status
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                "inbox-1", "replay:source-inbox:dataset", "1", 1L, "source-inbox",
                "a".repeat(64), "{}", "RECEIVED");

        assertThatThrownBy(() -> jdbc.update("""
                insert into inbox_message (inbox_id, source, source_msg_id, received_at)
                values (?, ?, ?, ?)
                """, "inbox-2", "replay:source-inbox:dataset", "1", 2L))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> jdbc.update("""
                insert into inbox_message (
                    inbox_id, source, source_msg_id, received_at, lease_token
                ) values (?, ?, ?, ?, ?)
                """, "inbox-lease", "replay:source-inbox:dataset", "lease", 3L, "lease-token"))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> jdbc.update("""
                insert into inbox_message (inbox_id, source, source_msg_id, received_at, status)
                values (?, ?, ?, ?, ?)
                """, "inbox-status", "replay:source-inbox:dataset", "status", 4L, "UNSUPPORTED"))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void enforcesPortableDeviceAndStateConstraints() throws SQLException {
        assertTableExists("device_state");
        insertOwnership("org-radar", "district-radar");
        insertSource("source-device", "source-device");

        assertThatThrownBy(() -> insertDevice(
                "device-source-only", "source-device", null, null, null, "replay",
                "org-radar", "district-radar"))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insertDevice(
                "device-altitude-only", null, null, "12.50", null, "replay",
                "org-radar", "district-radar"))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insertDevice(
                "device-invalid-mode", null, null, null, null, "invalid",
                "org-radar", "district-radar"))
                .isInstanceOf(DataIntegrityViolationException.class);

        insertDevice(
                "device-valid", "source-device", "radar-001", null, null, "replay",
                "org-radar", "district-radar");
        assertThat(queryNullable("device", "location", "device_id", "device-valid")).isNull();

        assertThatThrownBy(() -> jdbc.update("""
                insert into device_state (
                    device_id, connectivity, observed_at, received_at, created_at, updated_at, version
                ) values (?, ?, current_timestamp, current_timestamp, current_timestamp, current_timestamp, 0)
                """, "device-valid", "ABNORMAL"))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> jdbc.update("""
                insert into device_state (
                    device_id, connectivity, observed_at, received_at,
                    unknown_reason, created_at, updated_at, version
                ) values (?, ?, current_timestamp, current_timestamp, ?, current_timestamp, current_timestamp, 0)
                """, "device-valid", "UNKNOWN", null))
                .isInstanceOf(DataIntegrityViolationException.class);

        jdbc.update("""
                insert into device_state (
                    device_id, connectivity, has_alarm, observed_at, received_at,
                    unknown_reason, created_at, updated_at, version
                ) values (?, ?, ?, current_timestamp, current_timestamp, ?, current_timestamp, current_timestamp, 0)
                """, "device-valid", "UNKNOWN", null, "NOT_REPORTED");
        assertThat(queryNullable("device_state", "has_alarm", "device_id", "device-valid")).isNull();
        assertThat(columnDefault("device_state", "connectivity")).isNull();
        assertThat(columnDefault("device_state", "has_alarm")).isNull();
    }

    @Test
    void enforcesTargetTrackAndAlarmIntegrityWithoutGeneratingAlarms() throws SQLException {
        assertTableExists("target");
        insertOwnership("org-target", "district-target");
        insertSource("source-target", "source-target");
        insertDevice(
                "device-target", "source-target", "radar-target", null, null, "replay",
                "org-target", "district-target");

        jdbc.update("""
                insert into target (
                    target_id, target_no, source_mode, owner_org_id, district_id,
                    created_at, updated_at, version
                ) values (?, ?, ?, ?, ?, current_timestamp, current_timestamp, 0)
                """, "target-1", "TARGET-1", "replay", "org-target", "district-target");
        assertThat(queryNullable("target", "first_seen_at", "target_id", "target-1")).isNull();
        assertThat(queryNullable("target", "last_seen_at", "target_id", "target-1")).isNull();
        assertThat(jdbc.queryForObject("select count(*) from alarm", Integer.class)).isZero();

        assertThatThrownBy(() -> jdbc.update("""
                insert into target (
                    target_id, target_no, first_seen_at, last_seen_at, source_mode,
                    owner_org_id, district_id, created_at, updated_at, version
                ) values (?, ?, current_timestamp, current_timestamp - interval '1' day, ?, ?, ?,
                    current_timestamp, current_timestamp, 0)
                """, "target-reversed", "TARGET-REVERSED", "replay", "org-target", "district-target"))
                .isInstanceOf(DataIntegrityViolationException.class);

        jdbc.update("""
                insert into target_source_link (
                    link_id, target_id, source_id, device_id, source_session_key,
                    external_target_id, created_at
                ) values (?, ?, ?, ?, ?, ?, current_timestamp)
                """, "link-1", "target-1", "source-target", "device-target", "dataset-1", "42");
        jdbc.update("""
                insert into track (
                    track_id, target_id, link_id, external_track_id, created_at
                ) values (?, ?, ?, ?, current_timestamp)
                """, "track-1", "target-1", "link-1", "42");

        assertThatThrownBy(() -> jdbc.update("""
                insert into track_point (
                    point_id, track_id, point_seq, received_at, location, created_at
                ) values (?, ?, ?, current_timestamp, null, current_timestamp)
                """, "point-no-location", "track-1", 1L))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> jdbc.update("""
                insert into alarm (
                    alarm_id, source_id, source_alarm_id, alarm_type, severity,
                    received_at, source_mode, owner_org_id, district_id, created_at
                ) values (?, null, ?, ?, ?, current_timestamp, ?, ?, ?, current_timestamp)
                """, "alarm-no-source", "alarm-1", "RADAR", "UNKNOWN", "replay",
                "org-target", "district-target"))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThat(columnNames("alarm")).doesNotContain("uav_event_id");
    }

    @Test
    void declaresOwnershipForeignKeysAndCriticalUniqueKeys() throws SQLException {
        assertTableExists("alarm");

        assertThat(importedKeys("device")).contains(
                "source_id->integration_source.source_id",
                "owner_org_id->app_org.org_id",
                "district_id->app_district.district_id");
        assertThat(importedKeys("target")).contains(
                "owner_org_id->app_org.org_id",
                "district_id->app_district.district_id");
        assertThat(importedKeys("alarm")).contains(
                "source_id->integration_source.source_id",
                "owner_org_id->app_org.org_id",
                "district_id->app_district.district_id");

        insertOwnership("org-unique", "district-unique");
        insertSource("source-unique", "source-unique-code");
        assertThatThrownBy(() -> insertSource("source-duplicate", "source-unique-code"))
                .isInstanceOf(DataIntegrityViolationException.class);
        insertDevice(
                "device-unique", null, null, null, null, "replay",
                "org-unique", "district-unique");
        assertThatThrownBy(() -> jdbc.update("""
                insert into device (
                    device_id, device_no, name, source_mode, owner_org_id, district_id,
                    created_at, updated_at, version
                ) values (?, ?, ?, ?, ?, ?, current_timestamp, current_timestamp, 0)
                """, "device-duplicate", "device-unique", "Duplicate", "replay",
                "org-unique", "district-unique"))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void separatesPostgresOnlyFlywayLocationFromTheH2TestProfile() throws IOException {
        PropertySourcesPropertyResolver production = yamlProperties("application.yml");
        PropertySourcesPropertyResolver test = yamlProperties("application-test.yml");

        assertThat(production.getProperty("spring.flyway.locations[0]"))
                .isEqualTo("classpath:db/migration");
        assertThat(production.getProperty("spring.flyway.locations[1]"))
                .isEqualTo("classpath:db/postgresql");
        assertThat(test.getProperty("spring.flyway.locations[0]"))
                .isEqualTo("classpath:db/migration");
        assertThat(test.getProperty("spring.flyway.locations[1]")).isNull();
    }

    @Test
    void definesAnIsolatedPostgresTestProfileWithoutAutomaticMigrationOrSeeds() throws IOException {
        ClassPathResource resource = new ClassPathResource("application-postgres-test.yml");
        assertThat(resource.exists()).isTrue();

        PropertySourcesPropertyResolver postgresTest = yamlProperties("application-postgres-test.yml");
        assertThat(yamlRawProperty("application-postgres-test.yml", "spring.datasource.url"))
                .isEqualTo("${POSTGRES_TEST_URL}");
        assertThat(yamlRawProperty("application-postgres-test.yml", "spring.datasource.username"))
                .isEqualTo("${POSTGRES_TEST_USER}");
        assertThat(yamlRawProperty("application-postgres-test.yml", "spring.datasource.password"))
                .isEqualTo("${POSTGRES_TEST_PASSWORD}");
        assertThat(postgresTest.getProperty("spring.flyway.enabled", Boolean.class)).isFalse();
        assertThat(postgresTest.getProperty("app.dev-seed.enabled", Boolean.class)).isFalse();
    }

    private void assertTableExists(String tableName) throws SQLException {
        assertThat(tableNames())
                .as("V4 table %s must exist", tableName)
                .contains(tableName);
    }

    private Set<String> tableNames() throws SQLException {
        Set<String> names = new HashSet<>();
        try (Connection connection = dataSource.getConnection();
                ResultSet tables = connection.getMetaData().getTables(null, null, "%", new String[] {"TABLE"})) {
            while (tables.next()) {
                names.add(tables.getString("TABLE_NAME").toLowerCase(Locale.ROOT));
            }
        }
        return names;
    }

    private Set<String> columnNames(String tableName) {
        return new HashSet<>(jdbc.queryForList("""
                select lower(column_name)
                from information_schema.columns
                where lower(table_name) = ?
                """, String.class, tableName));
    }

    private String columnDefault(String tableName, String columnName) {
        return jdbc.queryForObject("""
                select column_default
                from information_schema.columns
                where lower(table_name) = ? and lower(column_name) = ?
                """, String.class, tableName, columnName);
    }

    private Set<String> importedKeys(String tableName) throws SQLException {
        Set<String> keys = new HashSet<>();
        try (Connection connection = dataSource.getConnection()) {
            DatabaseMetaData metadata = connection.getMetaData();
            try (ResultSet imported = metadata.getImportedKeys(null, null, tableName)) {
                while (imported.next()) {
                    keys.add((imported.getString("FKCOLUMN_NAME") + "->"
                            + imported.getString("PKTABLE_NAME") + "."
                            + imported.getString("PKCOLUMN_NAME")).toLowerCase(Locale.ROOT));
                }
            }
        }
        return keys;
    }

    private PropertySourcesPropertyResolver yamlProperties(String resource) throws IOException {
        YamlPropertySourceLoader loader = new YamlPropertySourceLoader();
        List<PropertySource<?>> loaded = loader.load(resource, new ClassPathResource(resource));
        MutablePropertySources sources = new MutablePropertySources();
        loaded.forEach(sources::addLast);
        return new PropertySourcesPropertyResolver(sources);
    }

    private Object yamlRawProperty(String resource, String key) throws IOException {
        List<PropertySource<?>> loaded = new YamlPropertySourceLoader()
                .load(resource, new ClassPathResource(resource));
        return loaded.stream()
                .map(source -> source.getProperty(key))
                .filter(java.util.Objects::nonNull)
                .findFirst()
                .orElse(null);
    }

    private void insertOwnership(String orgId, String districtId) {
        jdbc.update("""
                insert into app_org (
                    org_id, org_code, name, created_at, updated_at, version
                ) values (?, ?, ?, current_timestamp, current_timestamp, 0)
                """, orgId, orgId, orgId);
        jdbc.update("""
                insert into app_district (
                    district_id, district_code, name, created_at, updated_at, version
                ) values (?, ?, ?, current_timestamp, current_timestamp, 0)
                """, districtId, districtId, districtId);
    }

    private void insertSource(String sourceId, String sourceCode) {
        jdbc.update("""
                insert into integration_source (
                    source_id, source_code, name, enabled, source_mode,
                    created_at, updated_at, version
                ) values (?, ?, ?, false, 'replay', current_timestamp, current_timestamp, 0)
                """, sourceId, sourceCode, sourceCode);
    }

    private void insertDevice(
            String deviceId,
            String sourceId,
            String externalDeviceId,
            String altitude,
            String altitudeDatum,
            String sourceMode,
            String ownerOrgId,
            String districtId) {
        jdbc.update("""
                insert into device (
                    device_id, source_id, external_device_id, device_no, name,
                    altitude_m, altitude_datum, source_mode, owner_org_id, district_id,
                    created_at, updated_at, version
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp, current_timestamp, 0)
                """, deviceId, sourceId, externalDeviceId, deviceId, deviceId,
                altitude, altitudeDatum, sourceMode, ownerOrgId, districtId);
    }

    private Object queryNullable(String table, String column, String idColumn, String id) {
        return jdbc.queryForObject(
                "select " + column + " from " + table + " where " + idColumn + " = ?",
                (resultSet, rowNumber) -> resultSet.getObject(1),
                id);
    }
}
