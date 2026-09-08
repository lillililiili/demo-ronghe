package com.uav.lowaltitude.integration.mock;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.modules.identity.domain.PermissionCode;

/** 本地第二账号（决策 15-3）：能登录、持有该有的行、重跑不重复。 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class LocalStage15DemoReviewerSeederTest {

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired LocalStage15DemoReviewerSeeder seeder;

    @Test
    void reviewerCanLogIn() throws Exception {
        // 这个账号存在的意义就是"复核人 ≠ 承办人"（14-27）能在本地被真的走一遍；登不上就等于没有。
        String body = "{\"account\":\"reviewer1\",\"password\":\"changeme\"}";
        mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk());
    }

    @Test
    void holdsEveryActionTheTwoPersonFlowsNeed() {
        // 逐码断言，且**引用枚举而不是抄字符串**：抄字符串的话，枚举改名后这里照样绿，
        // 而演示时才发现账号没有那项权限。
        assertThat(level(PermissionCode.PUNISHMENT_REVIEW.value())).isEqualTo("OP");
        assertThat(level(PermissionCode.PUNISHMENT_READ.value())).isEqualTo("READ");
        // 阶段 13 的两人审批链路：没有 disposal:approve，reviewer1 批授权就是 403——实跑撞到过。
        assertThat(level(PermissionCode.DISPOSAL_APPROVE.value())).isEqualTo("OP");
        assertThat(level(PermissionCode.DISPOSAL_EXECUTE.value())).isEqualTo("OP");
        assertThat(level(PermissionCode.DISPOSAL_STOP.value())).isEqualTo("OP");
        assertThat(level(PermissionCode.DISPOSAL_READ.value())).isEqualTo("READ");
        assertThat(level(PermissionCode.ALARM_READ.value())).isEqualTo("READ");
        assertThat(level(PermissionCode.TARGET_READ.value())).isEqualTo("READ");
        assertThat(level(PermissionCode.HANDOFF_READ.value())).isEqualTo("READ");
    }

    @Test
    void doesNotHoldSystemAdministration() {
        // 演示复核员不该顺手拿到用户/角色/审计——与 15-2 同一条红线。
        for (String forbidden : new String[]{"users", "roles", "audit"}) {
            assertThat(level(forbidden)).as(forbidden).isIn(null, "NONE");
        }
    }

    @Test
    void moduleMatrixIsComplete() {
        // 矩阵的语义是"每一项都有明确取值"。只插几行会让角色页打开是一片空白，
        // 而不是清清楚楚的"这些能看、那些不能"。
        long catalog = jdbc.queryForObject(
                "select count(*) from app_permission where permission_kind='MODULE'", Long.class);
        long granted = jdbc.queryForObject("select count(*) from app_role_permission p join app_permission a"
                + " on a.permission_code=p.permission_code where p.role_code=? and a.permission_kind='MODULE'",
                Long.class, LocalStage15DemoReviewerSeeder.ROLE);
        assertThat(granted).isEqualTo(catalog);
    }

    @Test
    void roleIsNotBuiltinSoItStaysEditable() {
        // 标成内置会让它落进 BUILTIN_ROLE_PROTECTED，反而没人能再调整这个演示角色。
        assertThat(jdbc.queryForObject("select builtin from app_role where role_code=?", Boolean.class,
                LocalStage15DemoReviewerSeeder.ROLE)).isFalse();
    }

    @Test
    void rerunIsIdempotent() {
        long usersBefore = count("select count(*) from app_user where account=?", LocalStage15DemoReviewerSeeder.ACCOUNT);
        long rowsBefore = count("select count(*) from app_role_permission where role_code=?",
                LocalStage15DemoReviewerSeeder.ROLE);
        seeder.run(new DefaultApplicationArguments());
        seeder.run(new DefaultApplicationArguments());
        assertThat(count("select count(*) from app_user where account=?", LocalStage15DemoReviewerSeeder.ACCOUNT))
                .isEqualTo(usersBefore);
        assertThat(count("select count(*) from app_role_permission where role_code=?",
                LocalStage15DemoReviewerSeeder.ROLE)).isEqualTo(rowsBefore);
    }

    private String level(String permissionCode) {
        return jdbc.query("select permission_level from app_role_permission where role_code=? and permission_code=?",
                rs -> rs.next() ? rs.getString(1) : null, LocalStage15DemoReviewerSeeder.ROLE, permissionCode);
    }

    private long count(String sql, Object arg) { return jdbc.queryForObject(sql, Long.class, arg); }
}
