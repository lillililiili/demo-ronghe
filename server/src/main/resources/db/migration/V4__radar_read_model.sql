CREATE TABLE integration_source (
    source_id           VARCHAR(36) PRIMARY KEY,
    source_code         VARCHAR(64) NOT NULL UNIQUE,
    name                VARCHAR(128) NOT NULL,
    protocol_code       VARCHAR(64),
    protocol_version    VARCHAR(64),
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    credential_ref      VARCHAR(256),
    source_mode         VARCHAR(8) NOT NULL,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    version             BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_integration_source_code_nonblank CHECK (TRIM(source_code) <> ''),
    CONSTRAINT ck_integration_source_name_nonblank CHECK (TRIM(name) <> ''),
    CONSTRAINT ck_integration_source_protocol_code_nonblank
        CHECK (protocol_code IS NULL OR TRIM(protocol_code) <> ''),
    CONSTRAINT ck_integration_source_protocol_version_nonblank
        CHECK (protocol_version IS NULL OR TRIM(protocol_version) <> ''),
    CONSTRAINT ck_integration_source_credential_ref_nonblank
        CHECK (credential_ref IS NULL OR TRIM(credential_ref) <> ''),
    CONSTRAINT ck_integration_source_mode CHECK (source_mode IN ('mock', 'replay', 'live')),
    CONSTRAINT ck_integration_source_version CHECK (version >= 0)
);

CREATE INDEX idx_integration_source_mode_enabled_code
    ON integration_source (source_mode, enabled, source_code);

ALTER TABLE inbox_message ADD COLUMN source_id VARCHAR(36);
ALTER TABLE inbox_message ADD COLUMN payload_hash VARCHAR(64);
ALTER TABLE inbox_message ADD COLUMN payload JSONB;
ALTER TABLE inbox_message ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'RECEIVED';
ALTER TABLE inbox_message ADD COLUMN processed_at BIGINT;
ALTER TABLE inbox_message ADD COLUMN last_error TEXT;
ALTER TABLE inbox_message ADD COLUMN lease_token VARCHAR(36);
ALTER TABLE inbox_message ADD COLUMN lease_until BIGINT;

ALTER TABLE inbox_message ADD CONSTRAINT fk_inbox_source
    FOREIGN KEY (source_id) REFERENCES integration_source (source_id) ON DELETE RESTRICT;
ALTER TABLE inbox_message ADD CONSTRAINT ck_inbox_payload_hash
    CHECK (payload_hash IS NULL OR CHAR_LENGTH(payload_hash) = 64);
ALTER TABLE inbox_message ADD CONSTRAINT ck_inbox_status
    CHECK (status IN ('RECEIVED', 'PROCESSING', 'DONE', 'FAILED'));
ALTER TABLE inbox_message ADD CONSTRAINT ck_inbox_processed_at
    CHECK (
        (status IN ('RECEIVED', 'PROCESSING') AND processed_at IS NULL)
        OR (status IN ('DONE', 'FAILED') AND processed_at IS NOT NULL)
    );
ALTER TABLE inbox_message ADD CONSTRAINT ck_inbox_lease_pair
    CHECK (
        (lease_token IS NULL AND lease_until IS NULL)
        OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)
    );

CREATE INDEX idx_inbox_source_status_received
    ON inbox_message (source_id, status, received_at, inbox_id);
CREATE INDEX idx_inbox_status_lease
    ON inbox_message (status, lease_until);

CREATE TABLE device (
    device_id           VARCHAR(36) PRIMARY KEY,
    source_id           VARCHAR(36),
    external_device_id  VARCHAR(128),
    device_no           VARCHAR(64) NOT NULL UNIQUE,
    name                VARCHAR(128) NOT NULL,
    device_type_code    VARCHAR(32),
    model               VARCHAR(128),
    vendor              VARCHAR(128),
    location            GEOMETRY(POINT, 4326),
    altitude_m          NUMERIC(10, 2),
    altitude_datum      VARCHAR(16),
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    source_mode         VARCHAR(8) NOT NULL,
    owner_org_id        VARCHAR(36),
    district_id         VARCHAR(36),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    version             BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_device_source FOREIGN KEY (source_id)
        REFERENCES integration_source (source_id) ON DELETE RESTRICT,
    CONSTRAINT fk_device_owner_org FOREIGN KEY (owner_org_id)
        REFERENCES app_org (org_id) ON DELETE RESTRICT,
    CONSTRAINT fk_device_district FOREIGN KEY (district_id)
        REFERENCES app_district (district_id) ON DELETE RESTRICT,
    CONSTRAINT ck_device_external_source_pair CHECK (
        (source_id IS NULL AND external_device_id IS NULL)
        OR (source_id IS NOT NULL AND external_device_id IS NOT NULL)
    ),
    CONSTRAINT ck_device_number_nonblank CHECK (TRIM(device_no) <> ''),
    CONSTRAINT ck_device_name_nonblank CHECK (TRIM(name) <> ''),
    CONSTRAINT ck_device_external_id_nonblank
        CHECK (external_device_id IS NULL OR TRIM(external_device_id) <> ''),
    CONSTRAINT ck_device_altitude_pair CHECK (
        (altitude_m IS NULL AND altitude_datum IS NULL)
        OR (altitude_m IS NOT NULL AND altitude_datum IS NOT NULL)
    ),
    CONSTRAINT ck_device_altitude_datum
        CHECK (altitude_datum IS NULL OR altitude_datum IN ('AGL', 'AMSL')),
    CONSTRAINT ck_device_source_mode CHECK (source_mode IN ('mock', 'replay', 'live')),
    CONSTRAINT ck_device_version CHECK (version >= 0)
);

CREATE INDEX idx_device_scope_number
    ON device (owner_org_id, district_id, device_no, device_id);
CREATE INDEX idx_device_source_type_enabled
    ON device (source_id, device_type_code, enabled, device_id);

CREATE TABLE device_state (
    device_id           VARCHAR(36) PRIMARY KEY,
    connectivity        VARCHAR(16) NOT NULL,
    work_state_code     VARCHAR(32),
    has_alarm           BOOLEAN,
    health_code         VARCHAR(32),
    observed_at         TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at         TIMESTAMP WITH TIME ZONE NOT NULL,
    last_heartbeat_at   TIMESTAMP WITH TIME ZONE,
    source_seq          BIGINT,
    metrics             JSONB,
    unknown_reason      VARCHAR(64),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    version             BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_device_state_device FOREIGN KEY (device_id)
        REFERENCES device (device_id) ON DELETE RESTRICT,
    CONSTRAINT ck_device_state_connectivity
        CHECK (connectivity IN ('ONLINE', 'OFFLINE', 'DEGRADED', 'UNKNOWN')),
    CONSTRAINT ck_device_state_unknown_reason CHECK (
        (connectivity = 'UNKNOWN' AND unknown_reason IS NOT NULL AND TRIM(unknown_reason) <> '')
        OR (connectivity <> 'UNKNOWN' AND unknown_reason IS NULL)
    ),
    CONSTRAINT ck_device_state_version CHECK (version >= 0)
);

CREATE INDEX idx_device_state_connectivity_received
    ON device_state (connectivity, received_at DESC, device_id);

CREATE TABLE device_state_history (
    state_id            VARCHAR(36) PRIMARY KEY,
    device_id           VARCHAR(36) NOT NULL,
    inbox_id            VARCHAR(36),
    connectivity        VARCHAR(16) NOT NULL,
    observed_at         TIMESTAMP WITH TIME ZONE,
    received_at         TIMESTAMP WITH TIME ZONE NOT NULL,
    snapshot            JSONB NOT NULL,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT fk_device_state_history_device FOREIGN KEY (device_id)
        REFERENCES device (device_id) ON DELETE RESTRICT,
    CONSTRAINT fk_device_state_history_inbox FOREIGN KEY (inbox_id)
        REFERENCES inbox_message (inbox_id) ON DELETE RESTRICT,
    CONSTRAINT ck_device_state_history_connectivity
        CHECK (connectivity IN ('ONLINE', 'OFFLINE', 'DEGRADED', 'UNKNOWN'))
);

CREATE INDEX idx_device_state_history_inbox
    ON device_state_history (inbox_id);

CREATE TABLE target (
    target_id           VARCHAR(36) PRIMARY KEY,
    target_no           VARCHAR(64) NOT NULL UNIQUE,
    object_type_code    VARCHAR(32),
    subtype             VARCHAR(64),
    uav_sn              VARCHAR(128),
    first_seen_at       TIMESTAMP WITH TIME ZONE,
    last_seen_at        TIMESTAMP WITH TIME ZONE,
    source_mode         VARCHAR(8) NOT NULL,
    owner_org_id        VARCHAR(36),
    district_id         VARCHAR(36),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    version             BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_target_owner_org FOREIGN KEY (owner_org_id)
        REFERENCES app_org (org_id) ON DELETE RESTRICT,
    CONSTRAINT fk_target_district FOREIGN KEY (district_id)
        REFERENCES app_district (district_id) ON DELETE RESTRICT,
    CONSTRAINT ck_target_number_nonblank CHECK (TRIM(target_no) <> ''),
    CONSTRAINT ck_target_seen_range CHECK (
        (first_seen_at IS NULL AND last_seen_at IS NULL)
        OR (first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL AND first_seen_at <= last_seen_at)
    ),
    CONSTRAINT ck_target_source_mode CHECK (source_mode IN ('mock', 'replay', 'live')),
    CONSTRAINT ck_target_version CHECK (version >= 0)
);

CREATE INDEX idx_target_scope_last_seen
    ON target (owner_org_id, district_id, last_seen_at DESC NULLS LAST, target_id ASC);
CREATE INDEX idx_target_type_last_seen
    ON target (object_type_code, last_seen_at DESC NULLS LAST, target_id ASC);

CREATE TABLE target_source_link (
    link_id                 VARCHAR(36) PRIMARY KEY,
    target_id               VARCHAR(36) NOT NULL,
    source_id               VARCHAR(36) NOT NULL,
    device_id               VARCHAR(36),
    source_session_key      VARCHAR(128) NOT NULL,
    external_target_id      VARCHAR(128) NOT NULL,
    protocol_version        VARCHAR(64),
    created_at              TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT fk_target_source_link_target FOREIGN KEY (target_id)
        REFERENCES target (target_id) ON DELETE RESTRICT,
    CONSTRAINT fk_target_source_link_source FOREIGN KEY (source_id)
        REFERENCES integration_source (source_id) ON DELETE RESTRICT,
    CONSTRAINT fk_target_source_link_device FOREIGN KEY (device_id)
        REFERENCES device (device_id) ON DELETE RESTRICT,
    CONSTRAINT uq_target_source_link_source_identity
        UNIQUE (source_id, source_session_key, external_target_id),
    CONSTRAINT ck_target_source_link_session_nonblank CHECK (TRIM(source_session_key) <> ''),
    CONSTRAINT ck_target_source_link_external_id_nonblank CHECK (TRIM(external_target_id) <> '')
);

CREATE INDEX idx_target_source_link_target
    ON target_source_link (target_id, link_id);

CREATE TABLE target_latest_state (
    target_id                   VARCHAR(36) PRIMARY KEY,
    location                    GEOMETRY(POINT, 4326),
    altitude_amsl_m             NUMERIC(10, 2),
    height_agl_m                NUMERIC(10, 2),
    speed_mps                   NUMERIC(10, 3),
    heading_deg                 NUMERIC(6, 2),
    classification_confidence   NUMERIC(6, 5),
    fusion_confidence           NUMERIC(6, 5),
    observed_at                 TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at                 TIMESTAMP WITH TIME ZONE NOT NULL,
    unknown_fields              JSONB NOT NULL DEFAULT '[]',
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL,
    version                     BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_target_latest_state_target FOREIGN KEY (target_id)
        REFERENCES target (target_id) ON DELETE RESTRICT,
    CONSTRAINT ck_target_latest_state_speed CHECK (speed_mps IS NULL OR speed_mps >= 0),
    CONSTRAINT ck_target_latest_state_heading
        CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
    CONSTRAINT ck_target_latest_state_classification_confidence
        CHECK (classification_confidence IS NULL
            OR (classification_confidence >= 0 AND classification_confidence <= 1)),
    CONSTRAINT ck_target_latest_state_fusion_confidence
        CHECK (fusion_confidence IS NULL OR (fusion_confidence >= 0 AND fusion_confidence <= 1)),
    CONSTRAINT ck_target_latest_state_version CHECK (version >= 0)
);

CREATE TABLE track (
    track_id            VARCHAR(36) PRIMARY KEY,
    target_id           VARCHAR(36) NOT NULL,
    link_id             VARCHAR(36) NOT NULL,
    external_track_id   VARCHAR(128) NOT NULL,
    started_at          TIMESTAMP WITH TIME ZONE,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT fk_track_target FOREIGN KEY (target_id)
        REFERENCES target (target_id) ON DELETE RESTRICT,
    CONSTRAINT fk_track_link FOREIGN KEY (link_id)
        REFERENCES target_source_link (link_id) ON DELETE RESTRICT,
    CONSTRAINT uq_track_link_external_id UNIQUE (link_id, external_track_id),
    CONSTRAINT ck_track_external_id_nonblank CHECK (TRIM(external_track_id) <> '')
);

CREATE INDEX idx_track_target_started
    ON track (target_id, started_at DESC NULLS LAST, track_id ASC);

CREATE TABLE track_point (
    point_id            VARCHAR(36) PRIMARY KEY,
    track_id            VARCHAR(36) NOT NULL,
    inbox_id            VARCHAR(36),
    point_seq           BIGINT NOT NULL,
    observed_at         TIMESTAMP WITH TIME ZONE,
    received_at         TIMESTAMP WITH TIME ZONE NOT NULL,
    location            GEOMETRY(POINT, 4326) NOT NULL,
    altitude_amsl_m     NUMERIC(10, 2),
    height_agl_m        NUMERIC(10, 2),
    raw_position        JSONB,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT fk_track_point_track FOREIGN KEY (track_id)
        REFERENCES track (track_id) ON DELETE RESTRICT,
    CONSTRAINT fk_track_point_inbox FOREIGN KEY (inbox_id)
        REFERENCES inbox_message (inbox_id) ON DELETE RESTRICT,
    CONSTRAINT uq_track_point_sequence UNIQUE (track_id, point_seq),
    CONSTRAINT ck_track_point_sequence CHECK (point_seq >= 0)
);

CREATE INDEX idx_track_point_inbox
    ON track_point (inbox_id);

CREATE TABLE alarm (
    alarm_id            VARCHAR(36) PRIMARY KEY,
    target_id           VARCHAR(36),
    source_id           VARCHAR(36) NOT NULL,
    source_alarm_id     VARCHAR(128) NOT NULL,
    alarm_type          VARCHAR(64) NOT NULL,
    severity            VARCHAR(16) NOT NULL,
    occurred_at         TIMESTAMP WITH TIME ZONE,
    received_at         TIMESTAMP WITH TIME ZONE NOT NULL,
    inbox_id            VARCHAR(36),
    detail              JSONB,
    source_mode         VARCHAR(8) NOT NULL,
    owner_org_id        VARCHAR(36),
    district_id         VARCHAR(36),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT fk_alarm_target FOREIGN KEY (target_id)
        REFERENCES target (target_id) ON DELETE RESTRICT,
    CONSTRAINT fk_alarm_source FOREIGN KEY (source_id)
        REFERENCES integration_source (source_id) ON DELETE RESTRICT,
    CONSTRAINT fk_alarm_inbox FOREIGN KEY (inbox_id)
        REFERENCES inbox_message (inbox_id) ON DELETE RESTRICT,
    CONSTRAINT fk_alarm_owner_org FOREIGN KEY (owner_org_id)
        REFERENCES app_org (org_id) ON DELETE RESTRICT,
    CONSTRAINT fk_alarm_district FOREIGN KEY (district_id)
        REFERENCES app_district (district_id) ON DELETE RESTRICT,
    CONSTRAINT uq_alarm_source_identity UNIQUE (source_id, source_alarm_id),
    CONSTRAINT ck_alarm_source_id_nonblank CHECK (TRIM(source_alarm_id) <> ''),
    CONSTRAINT ck_alarm_type_nonblank CHECK (TRIM(alarm_type) <> ''),
    CONSTRAINT ck_alarm_severity
        CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN')),
    CONSTRAINT ck_alarm_source_mode CHECK (source_mode IN ('mock', 'replay', 'live'))
);

CREATE INDEX idx_alarm_scope_received
    ON alarm (owner_org_id, district_id, received_at DESC, alarm_id ASC);
CREATE INDEX idx_alarm_target_received
    ON alarm (target_id, received_at DESC, alarm_id ASC);
CREATE INDEX idx_alarm_inbox
    ON alarm (inbox_id);
