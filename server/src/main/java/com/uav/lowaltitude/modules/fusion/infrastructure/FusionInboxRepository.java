package com.uav.lowaltitude.modules.fusion.infrastructure;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 融合摄取的 inbox 视图：只领取回放来源（source LIKE 'replay:%'）且带 source_id/payload 的行，
 * ops 的 live-device:* 行由设备模块自己的 processing_status/ops_lease_* 处理，这里一概不碰。
 * 领取是条件更新（RECEIVED → PROCESSING，租约到期的 PROCESSING 可被重新领取），外层 WHERE 再次校验状态，
 * PostgreSQL 会在行锁释放后按最新行版本重查，因此两个并发领取者不会拿到同一行。
 */
@Repository
public class FusionInboxRepository {
    public static final String REPLAY_SOURCE_PREFIX = "replay:";
    private final NamedParameterJdbcTemplate jdbc;

    public FusionInboxRepository(JdbcTemplate jdbcTemplate) { this.jdbc = new NamedParameterJdbcTemplate(jdbcTemplate); }

    public record InboxRow(String inboxId, String source, String sourceMsgId, String sourceId, long receivedAtMillis, String payloadJson) { }

    /** 兼容旧签名：不限次数（仅测试/种子直调使用）。 */
    public List<InboxRow> claim(long nowMillis, int batch, long leaseMillis) {
        return claim(nowMillis, batch, leaseMillis, Integer.MAX_VALUE);
    }

    /**
     * 领取时把 fusion_attempts 加一，且只领 fusion_attempts < maxAttempts 的行：
     * 租约过期的 PROCESSING 行可以被重领，但同一毒帧最多重领 maxAttempts 次，之后由 {@link #failExhausted} 置 FAILED。
     */
    public List<InboxRow> claim(long nowMillis, int batch, long leaseMillis, int maxAttempts) {
        String token = UUID.randomUUID().toString();
        Map<String, Object> p = new HashMap<>();
        p.put("token", token); p.put("until", nowMillis + leaseMillis); p.put("now", nowMillis); p.put("batch", batch); p.put("prefix", REPLAY_SOURCE_PREFIX + "%");
        p.put("max", maxAttempts);
        int claimed = jdbc.update("UPDATE inbox_message SET status='PROCESSING', lease_token=:token, lease_until=:until, fusion_attempts=fusion_attempts+1"
                + " WHERE inbox_id IN (SELECT inbox_id FROM inbox_message WHERE (status='RECEIVED' OR (status='PROCESSING' AND lease_until<:now))"
                + " AND fusion_attempts<:max AND source LIKE :prefix AND source_id IS NOT NULL AND payload IS NOT NULL ORDER BY received_at ASC, inbox_id ASC FETCH FIRST :batch ROWS ONLY)"
                + " AND (status='RECEIVED' OR (status='PROCESSING' AND lease_until<:now)) AND fusion_attempts<:max", p);
        if (claimed == 0) return List.of();
        return jdbc.query("SELECT inbox_id,source,source_msg_id,source_id,received_at,CAST(payload AS VARCHAR) AS payload_text FROM inbox_message WHERE lease_token=:token ORDER BY received_at ASC, inbox_id ASC",
                Map.of("token", token), (rs, i) -> new InboxRow(rs.getString("inbox_id"), rs.getString("source"), rs.getString("source_msg_id"), rs.getString("source_id"),
                        rs.getLong("received_at"), rs.getString("payload_text")));
    }

    /** 租约已过期且领取次数已耗尽的行统一置 FAILED（processed_at 必须同时写，见 ck_stage2_inbox_processed_at）。返回处理行数。 */
    public int failExhausted(long nowMillis, int maxAttempts) {
        Map<String, Object> p = new HashMap<>();
        p.put("now", nowMillis); p.put("max", maxAttempts); p.put("prefix", REPLAY_SOURCE_PREFIX + "%");
        p.put("error", "超过最大领取次数 " + maxAttempts + "，帧已放弃");
        return jdbc.update("UPDATE inbox_message SET status='FAILED', processed_at=:now, last_error=:error, lease_token=NULL, lease_until=NULL"
                + " WHERE status='PROCESSING' AND lease_until<:now AND fusion_attempts>=:max AND source LIKE :prefix", p);
    }

    public void done(String inboxId, long nowMillis) {
        jdbc.update("UPDATE inbox_message SET status='DONE', processed_at=:now, last_error=NULL, lease_token=NULL, lease_until=NULL WHERE inbox_id=:id",
                Map.of("id", inboxId, "now", nowMillis));
    }

    public void fail(String inboxId, long nowMillis, String error) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", inboxId); p.put("now", nowMillis); p.put("error", error);
        jdbc.update("UPDATE inbox_message SET status='FAILED', processed_at=:now, last_error=:error, lease_token=NULL, lease_until=NULL WHERE inbox_id=:id", p);
    }

    /** 回放信封入库：同键同哈希幂等（返回 false），同键不同哈希是来源冲突（SOURCE_MESSAGE_CONFLICT）。 */
    public boolean insertReplay(String source, String sourceMsgId, long receivedAtMillis, String sourceId, String payloadHash, String payloadJson) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", UUID.randomUUID().toString()); p.put("source", source); p.put("msg", sourceMsgId); p.put("received", receivedAtMillis);
        p.put("source_id", sourceId); p.put("hash", payloadHash); p.put("payload", payloadJson);
        // 条件插入而不是 catch 重复键：调用方（种子、批量导入）往往在同一事务里连续写多条，
        // 重复键异常会让 PostgreSQL 事务进入 aborted 状态，后面的查重 SELECT 只会拿到 25P02。
        // 用 WHERE NOT EXISTS 而不是 ON CONFLICT：后者在 H2 的 PostgreSQL 兼容模式下不解析，
        // 而摄取路径必须在 H2 单测与 PostgreSQL 生产库上跑同一条语句（唯一约束仍是最终保障）。
        int inserted = jdbc.update("INSERT INTO inbox_message (inbox_id,source,source_msg_id,received_at,source_id,payload_hash,payload,status)"
                + " SELECT :id,:source,:msg,:received,:source_id,:hash,CAST(:payload AS JSON),'RECEIVED'"
                + " WHERE NOT EXISTS (SELECT 1 FROM inbox_message WHERE source=:source AND source_msg_id=:msg)", p);
        if (inserted == 1) return true;
        String existing = jdbc.queryForObject("SELECT payload_hash FROM inbox_message WHERE source=:source AND source_msg_id=:msg", p, String.class);
        if (payloadHash.equals(existing)) return false;
        throw new IllegalStateException("SOURCE_MESSAGE_CONFLICT: " + source + "#" + sourceMsgId + " 已存在且哈希不同");
    }

    public long countBySourcePrefix(String sourcePrefix) {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM inbox_message WHERE source LIKE :prefix", Map.of("prefix", sourcePrefix + "%"), Long.class);
        return count == null ? 0 : count;
    }

    public long countPending() {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM inbox_message WHERE status='RECEIVED' AND source LIKE :prefix AND source_id IS NOT NULL AND payload IS NOT NULL",
                Map.of("prefix", REPLAY_SOURCE_PREFIX + "%"), Long.class);
        return count == null ? 0 : count;
    }
}
