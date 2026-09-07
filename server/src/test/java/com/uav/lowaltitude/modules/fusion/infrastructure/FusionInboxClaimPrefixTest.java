package com.uav.lowaltitude.modules.fusion.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import com.uav.lowaltitude.modules.fusion.application.FusionProperties;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusionInboxRepository.InboxRow;

/**
 * 领取白名单：前缀取自已注册的映射器，实测雷达受 live-promotion 开关控制。
 *
 * 开关关闭时必须**连领都不领**：领了就会解析、丢弃并置为已处理，`fusion_attempts` 被推到上限后
 * 由 failExhausted 永久判成毒帧——一个纯配置开关不该有不可逆的数据后果，开关打开后这些帧还得能重放。
 */
@SpringBootTest(properties = "app.dev-seed.enabled=false")
@ActiveProfiles("test")
@Transactional
class FusionInboxClaimPrefixTest {

    @Autowired JdbcTemplate jdbc;
    @Autowired FusionInboxRepository inbox;
    @Autowired FusionProperties properties;

    @Test
    void liveRadarRowsAreLeftUntouchedWhileLivePromotionIsOff() {
        String sourceId = source();
        String liveRadar = row(sourceId, "live-radar:R-1");
        String lingyun = row(sourceId, "lingyun:tdoa:227");

        assertThat(properties.getLivePromotion().isEnabled()).isFalse();
        assertThat(inbox.claimablePrefixes()).doesNotContain("live-radar:").contains("lingyun:", "eo-edge:", "replay:");

        List<InboxRow> claimed = inbox.claim(System.currentTimeMillis(), 50, 30_000L);
        assertThat(claimed).extracting(InboxRow::inboxId).contains(lingyun).doesNotContain(liveRadar);
        // 没被领就不该被改动：状态与领取次数都要原封不动，开关打开后还能重放。
        assertThat(jdbc.queryForObject("select status from inbox_message where inbox_id=?", String.class, liveRadar)).isEqualTo("RECEIVED");
        assertThat(jdbc.queryForObject("select fusion_attempts from inbox_message where inbox_id=?", Integer.class, liveRadar)).isZero();
    }

    @Test
    void liveRadarRowsBecomeClaimableOnceLivePromotionIsOn() {
        String sourceId = source();
        String liveRadar = row(sourceId, "live-radar:R-2");
        properties.getLivePromotion().setEnabled(true);
        try {
            assertThat(inbox.claimablePrefixes()).contains("live-radar:");
            assertThat(inbox.claim(System.currentTimeMillis(), 50, 30_000L)).extracting(InboxRow::inboxId).contains(liveRadar);
        } finally {
            properties.getLivePromotion().setEnabled(false);
        }
    }

    @Test
    void opsDeviceRowsAreNeverClaimedByFusion() {
        String sourceId = source();
        String opsRow = row(sourceId, "live-device:D-1");
        // ops 的行由设备模块自己的 processing_status 处理，融合侧一概不碰。
        assertThat(inbox.claim(System.currentTimeMillis(), 50, 30_000L)).extracting(InboxRow::inboxId).doesNotContain(opsRow);
        assertThat(jdbc.queryForObject("select status from inbox_message where inbox_id=?", String.class, opsRow)).isEqualTo("RECEIVED");
    }

    private String source() {
        String sourceId = UUID.randomUUID().toString();
        jdbc.update("insert into integration_source (source_id,source_code,name,enabled,source_mode,source_type,created_at,updated_at,version)"
                + " values (?,?,?,true,'replay','RADAR',current_timestamp,current_timestamp,0)",
                sourceId, "SRC-CLAIM-" + sourceId.substring(0, 8), "领取白名单测试来源");
        return sourceId;
    }

    private String row(String sourceId, String source) {
        String inboxId = UUID.randomUUID().toString();
        jdbc.update("insert into inbox_message (inbox_id,source,source_msg_id,received_at,source_id,payload_hash,payload,status,fusion_attempts)"
                + " values (?,?,?,?,?,?,cast(? as json),'RECEIVED',0)",
                inboxId, source, UUID.randomUUID().toString(), System.currentTimeMillis(), sourceId,
                "0".repeat(64), "{\"items\":[]}");
        return inboxId;
    }
}
