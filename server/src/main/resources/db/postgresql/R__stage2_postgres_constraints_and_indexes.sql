CREATE UNIQUE INDEX IF NOT EXISTS idx_device_source_external_unique
    ON device (source_id, external_device_id)
    WHERE source_id IS NOT NULL AND external_device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_target_source_link_device
    ON target_source_link (device_id, target_id)
    WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_location_gist
    ON device USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_target_latest_state_location_gist
    ON target_latest_state USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_track_point_location_gist
    ON track_point USING GIST (location);

CREATE INDEX IF NOT EXISTS idx_device_state_history_display_time
    ON device_state_history (
        device_id,
        (COALESCE(observed_at, received_at)) DESC,
        received_at DESC,
        state_id ASC
    );

CREATE INDEX IF NOT EXISTS idx_track_point_display_time
    ON track_point (
        track_id,
        (COALESCE(observed_at, received_at)) ASC,
        point_seq ASC,
        point_id ASC
    );

DO $$
BEGIN
    ALTER TABLE device DROP CONSTRAINT IF EXISTS ck_device_location_wgs84;
    ALTER TABLE device ADD CONSTRAINT ck_device_location_wgs84 CHECK (
        location IS NULL
        OR (
            NOT ST_IsEmpty(location)
            AND ST_SRID(location) = 4326
            AND ST_X(location) BETWEEN -180 AND 180
            AND ST_Y(location) BETWEEN -90 AND 90
        )
    );
END
$$;

DO $$
BEGIN
    ALTER TABLE target_latest_state DROP CONSTRAINT IF EXISTS ck_target_latest_state_location_wgs84;
    ALTER TABLE target_latest_state ADD CONSTRAINT ck_target_latest_state_location_wgs84 CHECK (
        location IS NULL
        OR (
            NOT ST_IsEmpty(location)
            AND ST_SRID(location) = 4326
            AND ST_X(location) BETWEEN -180 AND 180
            AND ST_Y(location) BETWEEN -90 AND 90
        )
    );
END
$$;

DO $$
BEGIN
    ALTER TABLE track_point DROP CONSTRAINT IF EXISTS ck_track_point_location_wgs84;
    ALTER TABLE track_point ADD CONSTRAINT ck_track_point_location_wgs84 CHECK (
        NOT ST_IsEmpty(location)
        AND ST_SRID(location) = 4326
        AND ST_X(location) BETWEEN -180 AND 180
        AND ST_Y(location) BETWEEN -90 AND 90
    );
END
$$;

CREATE OR REPLACE FUNCTION prevent_app_org_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    has_cycle BOOLEAN;
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(current_database() || ':' || TG_TABLE_SCHEMA || ':' || TG_TABLE_NAME, 0)
    );

    WITH RECURSIVE ancestors(org_id, parent_id) AS (
        SELECT org_id, parent_id
        FROM app_org
        WHERE org_id = NEW.parent_id
        UNION
        SELECT parent.org_id, parent.parent_id
        FROM app_org parent
        JOIN ancestors child ON parent.org_id = child.parent_id
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE org_id = NEW.org_id)
    INTO has_cycle;

    IF has_cycle THEN
        RAISE EXCEPTION 'app_org hierarchy cycle is not allowed'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_app_org_prevent_cycle ON app_org;
CREATE TRIGGER trg_app_org_prevent_cycle
BEFORE INSERT OR UPDATE OF parent_id ON app_org
FOR EACH ROW
EXECUTE FUNCTION prevent_app_org_cycle();

CREATE OR REPLACE FUNCTION prevent_app_district_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    has_cycle BOOLEAN;
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(current_database() || ':' || TG_TABLE_SCHEMA || ':' || TG_TABLE_NAME, 0)
    );

    WITH RECURSIVE ancestors(district_id, parent_id) AS (
        SELECT district_id, parent_id
        FROM app_district
        WHERE district_id = NEW.parent_id
        UNION
        SELECT parent.district_id, parent.parent_id
        FROM app_district parent
        JOIN ancestors child ON parent.district_id = child.parent_id
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE district_id = NEW.district_id)
    INTO has_cycle;

    IF has_cycle THEN
        RAISE EXCEPTION 'app_district hierarchy cycle is not allowed'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_app_district_prevent_cycle ON app_district;
CREATE TRIGGER trg_app_district_prevent_cycle
BEFORE INSERT OR UPDATE OF parent_id ON app_district
FOR EACH ROW
EXECUTE FUNCTION prevent_app_district_cycle();
