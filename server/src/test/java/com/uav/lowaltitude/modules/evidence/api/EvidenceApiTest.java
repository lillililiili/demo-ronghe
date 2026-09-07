package com.uav.lowaltitude.modules.evidence.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.platform.config.AppProperties;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Transactional
class EvidenceApiTest {
    private static final byte[] PAYLOAD = "evidence-bytes-v1".getBytes(StandardCharsets.UTF_8);

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired AppProperties properties;

    private String suffix, org, district, otherOrg, otherDistrict, targetId;

    @BeforeEach
    void fixture() {
        suffix = UUID.randomUUID().toString().substring(0, 8);
        org = "ev-org-" + suffix;
        district = "ev-dist-" + suffix;
        otherOrg = "ev-other-org-" + suffix;
        otherDistrict = "ev-other-dist-" + suffix;
        catalog(org, district);
        catalog(otherOrg, otherDistrict);
        targetId = "ev-target-" + suffix;
        jdbc.update("""
                insert into target (target_id,target_no,object_type_code,source_mode,owner_org_id,district_id,first_seen_at,last_seen_at,created_at,updated_at,version)
                values (?,?,'UAV','mock',?,?,?,?,?,?,0)
                """, targetId, "T-" + suffix, org, district, java.sql.Timestamp.from(java.time.Instant.now()),
                java.sql.Timestamp.from(java.time.Instant.now()), java.sql.Timestamp.from(java.time.Instant.now()),
                java.sql.Timestamp.from(java.time.Instant.now()));
    }

    @Test
    void unauthenticatedRequestIsRejected() throws Exception {
        mvc.perform(get("/api/v1/evidence-files"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"));
    }

    @Test
    void evidenceReadIsRequiredBeforeQueryIsInterpreted() throws Exception {
        String token = reader("ASSIGNED", org, district);
        grantAction(token, "target:read");
        mvc.perform(get("/api/v1/evidence-files?foo=1").header("Authorization", bearer(token)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
    }

    @Test
    void unknownQueryIsRejectedAfterEvidenceRead() throws Exception {
        String token = reader("ASSIGNED", org, district);
        grantAction(token, "evidence:read");
        mvc.perform(get("/api/v1/evidence-files?foo=1").header("Authorization", bearer(token)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void ingestComputesSha256AndHidesUnlinkedFromReaders() throws Exception {
        String ingest = reader("ASSIGNED", org, district);
        grantAction(ingest, "evidence:ingest", "evidence:read");
        String readOnly = reader("ASSIGNED", org, district);
        grantAction(readOnly, "evidence:read");
        JsonNode created = ingestFile(ingest, "shot.jpg", org, district, null, null);
        assertThat(created.get("status").asText()).isEqualTo("AVAILABLE");
        assertThat(created.get("sha256").asText()).isEqualTo(sha(PAYLOAD));
        assertThat(created.get("size_bytes").asLong()).isEqualTo(PAYLOAD.length);
        assertThat(created.has("object_key")).isFalse();

        mvc.perform(get("/api/v1/evidence-files").header("Authorization", bearer(readOnly)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(0));
        mvc.perform(get("/api/v1/evidence-files").header("Authorization", bearer(ingest)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(1));
    }

    @Test
    void assignedReaderSeesLinkedOwnTargetNotOtherOrg() throws Exception {
        String ingest = reader("ASSIGNED", org, district);
        grantAction(ingest, "evidence:ingest", "evidence:read", "evidence:link");
        JsonNode created = ingestFile(ingest, "own.jpg", org, district, "TARGET", targetId);
        String evidenceId = created.get("evidence_id").asText();
        mvc.perform(get("/api/v1/evidence-files").header("Authorization", bearer(ingest)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(1));

        String outsider = reader("ASSIGNED", otherOrg, otherDistrict);
        grantAction(outsider, "evidence:read", "evidence:ingest");
        mvc.perform(get("/api/v1/evidence-files").header("Authorization", bearer(outsider)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(0));
        mvc.perform(get("/api/v1/evidence-files/" + evidenceId).header("Authorization", bearer(outsider)))
                .andExpect(status().isNotFound());
    }

    @Test
    void downloadRequiresDownloadPermissionAndWritesAccessLog() throws Exception {
        String ingest = reader("ASSIGNED", org, district);
        grantAction(ingest, "evidence:ingest", "evidence:read", "evidence:link");
        String evidenceId = ingestFile(ingest, "clip.bin", org, district, "TARGET", targetId).get("evidence_id").asText();
        mvc.perform(get("/api/v1/evidence-files/" + evidenceId + "/content").header("Authorization", bearer(ingest)))
                .andExpect(status().isForbidden());

        grantAction(ingest, "evidence:download");
        byte[] body = mvc.perform(get("/api/v1/evidence-files/" + evidenceId + "/content")
                        .header("Authorization", bearer(ingest)))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsByteArray();
        assertThat(body).isEqualTo(PAYLOAD);
        assertThat(jdbc.queryForObject(
                "select count(*) from evidence_access_log where evidence_id=? and action='DOWNLOAD' and result='GRANTED'",
                Long.class, evidenceId)).isEqualTo(1L);
    }

    @Test
    void holdBlocksSecondHoldAndVerifyDetectsMissingObject() throws Exception {
        String ingest = reader("ASSIGNED", org, district);
        grantAction(ingest, "evidence:ingest", "evidence:read", "evidence:link", "evidence:hold");
        JsonNode created = ingestFile(ingest, "hold.bin", org, district, "TARGET", targetId);
        String evidenceId = created.get("evidence_id").asText();
        JsonNode hold = json.readTree(mvc.perform(post("/api/v1/evidence-files/" + evidenceId + "/holds")
                        .header("Authorization", bearer(ingest)).header("Idempotency-Key", "hold-" + suffix)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\"案件未结\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.reason").value("案件未结"))
                .andReturn().getResponse().getContentAsString()).get("data");
        mvc.perform(post("/api/v1/evidence-files/" + evidenceId + "/holds")
                        .header("Authorization", bearer(ingest)).header("Idempotency-Key", "hold2-" + suffix)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\"再次冻结\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("HOLD_ACTIVE"));

        Path stored = Path.of(properties.getEvidenceDir()).toAbsolutePath().normalize()
                .resolve(jdbc.queryForObject("select object_key from evidence_file where evidence_id=?", String.class, evidenceId));
        Files.deleteIfExists(stored);
        mvc.perform(post("/api/v1/evidence-files/" + evidenceId + "/verify")
                        .header("Authorization", bearer(ingest)).header("Idempotency-Key", "verify-" + suffix))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("MISSING"))
                .andExpect(jsonPath("$.data.matches").value(false));
        assertThat(hold.get("hold_id").asText()).isNotBlank();
    }

    private JsonNode ingestFile(String token, String filename, String orgId, String districtId,
            String subjectKind, String subjectId) throws Exception {
        var request = multipart("/api/v1/evidence-files")
                .file(new MockMultipartFile("file", filename, "application/octet-stream", PAYLOAD))
                .param("kind_code", "EO_STILL")
                .param("owner_org_id", orgId)
                .param("district_id", districtId)
                .header("Authorization", bearer(token))
                .header("Idempotency-Key", "ing-" + filename + "-" + suffix);
        if (subjectKind != null) {
            request.param("subject_kind", subjectKind).param("subject_id", subjectId);
        }
        String body = mvc.perform(request).andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        return json.readTree(body).get("data");
    }

    private void catalog(String orgId, String districtId) {
        jdbc.update("insert into app_org (org_id,org_code,name,enabled,created_at,updated_at,version) values (?,?,?,true,0,0,0)",
                orgId, orgId.toUpperCase(), orgId);
        jdbc.update("insert into app_district (district_id,district_code,name,enabled,created_at,updated_at,version) values (?,?,?,true,0,0,0)",
                districtId, districtId.toUpperCase(), districtId);
    }

    private String reader(String scope, String orgId, String districtId) {
        String id = UUID.randomUUID().toString().substring(0, 8);
        String role = "ROLE-EV-" + id;
        String user = UUID.randomUUID().toString();
        String token = UUID.randomUUID().toString();
        jdbc.update("insert into app_role (role_code,name,description,builtin,enabled,created_at,updated_at,version,system_role) values (?,?, '',false,true,0,0,0,false)", role, role);
        jdbc.update("insert into app_user (user_id,account,name,role_code,status,password_hash,fail_count,scope_mode,permission_version,created_at,updated_at,version) values (?,?,?,?,'ACTIVE','unused',0,?,0,0,0,0)", user, "ev-" + id, "ev-tester", role, scope);
        if ("ASSIGNED".equals(scope)) {
            jdbc.update("insert into app_user_data_scope (user_id,org_id,district_id) values (?,?,?)", user, orgId, districtId);
        }
        jdbc.update("insert into app_session (session_id,user_id,expire_at,ip,permission_version) values (?,?,?,'127.0.0.1',0)", token, user, System.currentTimeMillis() + 3_600_000);
        return token;
    }

    private void grantAction(String token, String... permissions) {
        for (String permission : permissions) {
            jdbc.update("insert into app_role_permission (role_code,permission_code,permission_level,menu_enabled,created_at) select u.role_code,?,'READ',false,current_timestamp from app_session s join app_user u on u.user_id=s.user_id where s.session_id=?", permission, token);
        }
    }

    private static String bearer(String token) { return "Bearer " + token; }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
