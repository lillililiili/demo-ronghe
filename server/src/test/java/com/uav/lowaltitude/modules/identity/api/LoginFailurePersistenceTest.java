package com.uav.lowaltitude.modules.identity.api;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class LoginFailurePersistenceTest {

    @Autowired
    MockMvc mvc;

    @Autowired
    JdbcTemplate jdbc;

    @BeforeEach
    @AfterEach
    void resetDuty1() {
        jdbc.update("update app_user set fail_count = 0, locked_until = null where account = ?", "duty1");
        jdbc.update("delete from audit_log where account = ? and action = ?", "duty1", "login_fail");
    }

    @Test
    void wrongPasswordPersistsFailCountAndAudit() throws Exception {
        mvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"account\":\"duty1\",\"password\":\"wrong\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));

        Integer fails = jdbc.queryForObject(
                "select fail_count from app_user where account = ?", Integer.class, "duty1");
        Integer audits = jdbc.queryForObject(
                "select count(*) from audit_log where account = ? and action = ?",
                Integer.class, "duty1", "login_fail");
        assertThat(fails).isEqualTo(1);
        assertThat(audits).isEqualTo(1);
    }

    @Test
    void fifthWrongPasswordLocksAccount() throws Exception {
        for (int i = 0; i < 5; i++) {
            mvc.perform(post("/api/v1/auth/login")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"account\":\"duty1\",\"password\":\"wrong\"}"))
                    .andExpect(status().isUnauthorized());
        }
        mvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"account\":\"duty1\",\"password\":\"changeme\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("ACCOUNT_LOCKED"));
    }
}
