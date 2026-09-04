CREATE TABLE app_org (
    org_id          VARCHAR(36) PRIMARY KEY,
    parent_id       VARCHAR(36),
    org_code        VARCHAR(64) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version         BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_app_org_parent FOREIGN KEY (parent_id) REFERENCES app_org (org_id),
    CONSTRAINT uk_app_org_code UNIQUE (org_code),
    CONSTRAINT ck_app_org_code_not_blank CHECK (TRIM(org_code) <> ''),
    CONSTRAINT ck_app_org_name_not_blank CHECK (TRIM(name) <> ''),
    CONSTRAINT ck_app_org_not_self_parent CHECK (parent_id IS NULL OR parent_id <> org_id),
    CONSTRAINT ck_app_org_version CHECK (version >= 0)
);

CREATE INDEX idx_app_org_parent ON app_org (parent_id);

CREATE TABLE app_district (
    district_id     VARCHAR(36) PRIMARY KEY,
    parent_id       VARCHAR(36),
    district_code   VARCHAR(32) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version         BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_app_district_parent FOREIGN KEY (parent_id) REFERENCES app_district (district_id),
    CONSTRAINT uk_app_district_code UNIQUE (district_code),
    CONSTRAINT ck_app_district_code_not_blank CHECK (TRIM(district_code) <> ''),
    CONSTRAINT ck_app_district_name_not_blank CHECK (TRIM(name) <> ''),
    CONSTRAINT ck_app_district_not_self_parent CHECK (parent_id IS NULL OR parent_id <> district_id),
    CONSTRAINT ck_app_district_version CHECK (version >= 0)
);

CREATE INDEX idx_app_district_parent ON app_district (parent_id);

CREATE TABLE app_role (
    role_code       VARCHAR(32) PRIMARY KEY,
    name            VARCHAR(64) NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    system_role     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version         BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT uk_app_role_name UNIQUE (name),
    CONSTRAINT ck_app_role_name_not_blank CHECK (TRIM(name) <> ''),
    CONSTRAINT ck_app_role_version CHECK (version >= 0)
);

CREATE TABLE app_permission (
    permission_code VARCHAR(96) PRIMARY KEY,
    module_code     VARCHAR(48) NOT NULL,
    permission_kind VARCHAR(16) NOT NULL,
    action_code     VARCHAR(32) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_app_permission_tuple UNIQUE (module_code, permission_kind, action_code),
    CONSTRAINT ck_app_permission_code_not_blank CHECK (TRIM(permission_code) <> ''),
    CONSTRAINT ck_app_permission_module_not_blank CHECK (TRIM(module_code) <> ''),
    CONSTRAINT ck_app_permission_kind CHECK (permission_kind = 'ACTION'),
    CONSTRAINT ck_app_permission_action_not_blank CHECK (TRIM(action_code) <> ''),
    CONSTRAINT ck_app_permission_name_not_blank CHECK (TRIM(name) <> '')
);

CREATE TABLE app_role_permission (
    role_code       VARCHAR(32) NOT NULL,
    permission_code VARCHAR(96) NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role_code, permission_code),
    CONSTRAINT fk_role_permission_role FOREIGN KEY (role_code) REFERENCES app_role (role_code),
    CONSTRAINT fk_role_permission_permission FOREIGN KEY (permission_code)
        REFERENCES app_permission (permission_code)
);

CREATE INDEX idx_role_permission_permission
    ON app_role_permission (permission_code, role_code);

CREATE TABLE app_user_data_scope (
    user_id         VARCHAR(36) NOT NULL,
    org_id          VARCHAR(36) NOT NULL,
    district_id     VARCHAR(36) NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, org_id, district_id),
    CONSTRAINT fk_user_scope_user FOREIGN KEY (user_id) REFERENCES app_user (user_id),
    CONSTRAINT fk_user_scope_org FOREIGN KEY (org_id) REFERENCES app_org (org_id),
    CONSTRAINT fk_user_scope_district FOREIGN KEY (district_id) REFERENCES app_district (district_id)
);

CREATE INDEX idx_user_scope_tuple
    ON app_user_data_scope (org_id, district_id, user_id);

INSERT INTO app_role (role_code, name, enabled, system_role, created_at, updated_at, version)
SELECT role_code,
       CONCAT('Compatibility role [', role_code, ']'),
       FALSE,
       FALSE,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP,
       0
FROM (SELECT DISTINCT role_code FROM app_user) existing_role;

ALTER TABLE app_user
    ADD COLUMN scope_mode VARCHAR(16) NOT NULL DEFAULT 'NONE';

ALTER TABLE app_user
    ADD COLUMN permission_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE app_user
    ADD CONSTRAINT ck_app_user_scope_mode CHECK (scope_mode IN ('NONE', 'ASSIGNED', 'ALL'));

ALTER TABLE app_user
    ADD CONSTRAINT ck_app_user_permission_version CHECK (permission_version >= 0);

ALTER TABLE app_user
    ADD CONSTRAINT fk_app_user_role FOREIGN KEY (role_code) REFERENCES app_role (role_code);

CREATE INDEX idx_app_user_role_scope ON app_user (role_code, scope_mode);

INSERT INTO app_permission (
    permission_code,
    module_code,
    permission_kind,
    action_code,
    name,
    created_at
)
VALUES
    ('device:read', 'device', 'ACTION', 'read', 'Read devices', CURRENT_TIMESTAMP),
    ('target:read', 'target', 'ACTION', 'read', 'Read targets', CURRENT_TIMESTAMP),
    ('alarm:read', 'alarm', 'ACTION', 'read', 'Read alarms', CURRENT_TIMESTAMP);
