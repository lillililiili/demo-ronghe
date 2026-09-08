-- 阶段 13：处置授权域的 PostgreSQL 专属约束（H2 测试不加载本目录）。
-- 可重复迁移（R__）：Flyway 在校验和变化时重跑，因此这里的每一条都必须可重复执行。

-- 事件流只增。一次反制/干扰的全过程是有法律后果的事实链：谁批的、几点执行的、设备回了什么，
-- 都可能成为处罚案件的证据。改一行等于改口供，所以在库层堵死，而不是只靠应用层自觉。
CREATE OR REPLACE FUNCTION prevent_stage13_disposal_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'disposal authorization events are append-only' USING ERRCODE = '23514';
END;
$$;

-- 守卫：升级回归会把库只迁到某个中间版本（如 Stage9PostgresTest 的 073.5/074 用例），
-- 此时 Flyway 仍会跑本 R__ 脚本，而 0102 的表尚不存在——表没到位就跳过，等下一次校验和变化或全量迁移再补。
DO $$
BEGIN
    IF to_regclass('disposal_authorization_event') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS trg_stage13_disposal_event_append_only ON disposal_authorization_event';
        EXECUTE 'CREATE TRIGGER trg_stage13_disposal_event_append_only
            BEFORE UPDATE OR DELETE ON disposal_authorization_event
            FOR EACH ROW EXECUTE FUNCTION prevent_stage13_disposal_event_mutation()';
    END IF;
END $$;

-- 零长度或倒挂的有效期说不清"哪段时间是被授权的"——对一个允许动手的授权来说，这是不能含糊的边界。
-- 迁移 0102 里两列可以同时为 NULL（尚未审批），因此这里只在两列都有值时校验。
DO $$
BEGIN
    IF to_regclass('disposal_authorization') IS NOT NULL THEN
        EXECUTE 'ALTER TABLE disposal_authorization DROP CONSTRAINT IF EXISTS ck_stage13_authorization_window';
        EXECUTE 'ALTER TABLE disposal_authorization ADD CONSTRAINT ck_stage13_authorization_window
            CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from)';
    END IF;
END $$;
