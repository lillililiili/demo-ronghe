package com.uav.lowaltitude.integration.mock;

import java.util.List;
import java.util.UUID;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.DependsOn;
import org.springframework.context.annotation.Profile;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.platform.config.AppProperties;

/**
 * 本地演示的第二账号 `reviewer1`（决策 15-3）。
 *
 * 为什么必须有第二个人：阶段 14 的复核要求"复核人 ≠ 承办人"（14-27/14-32），
 * 而本地只有 `admin1` 一个账号——于是复核这条路在演示环境里**根本走不到**，
 * 一点就是 409。这个种子存在的全部意义就是让那条路能被真的走一遍。
 *
 * 密码与 `LocalUserSeeder` 同源（`app.dev-seed.password`），不另开环境变量。
 * 双门禁（!production & (local|test) + app.dev-seed.enabled）；全部 `WHERE NOT EXISTS`，重跑幂等。
 */
@Component
@Profile("!production & (local | test)")
@ConditionalOnProperty(prefix = "app.dev-seed", name = "enabled", havingValue = "true")
@DependsOn("localUserSeeder")
@Order(120)
public class LocalStage15DemoReviewerSeeder implements ApplicationRunner {
    static final String ROLE = "ROLE-DEMO-REVIEWER";
    static final String ACCOUNT = "reviewer1";

    /** 模块矩阵：够看处置与处罚两条链，但不给用户/角色/审计——那是超管的事（与 15-2 同一条红线）。 */
    private static final List<String> MODULE_READ = List.of("monitoring", "alarms", "risks", "handoffs");

    /**
     * 动作权限。这个账号要撑起**两条**"必须两个人"的链路，缺一条演示环境里就走不通：
     * - 阶段 14 处罚复核：复核人 ≠ 承办人（14-27）→ `punishment:review`；
     * - 阶段 13 处置审批：审批人 ≠ 申请人（两人规则）→ `disposal:approve`，以及随后的执行与停止。
     * 用 `PermissionCode` 枚举而不是字符串字面量：谁改了枚举，这里在编译期就断，
     * 而不是等到某天演示时才发现某个码悄悄改了名、种子照样跑绿但账号没有那项权限。
     */
    private static final List<String[]> ACTIONS = List.of(
            new String[]{PermissionCode.PUNISHMENT_READ.value(), "READ"},
            new String[]{PermissionCode.PUNISHMENT_REVIEW.value(), "OP"},
            new String[]{PermissionCode.DISPOSAL_READ.value(), "READ"},
            new String[]{PermissionCode.DISPOSAL_APPROVE.value(), "OP"},
            new String[]{PermissionCode.DISPOSAL_EXECUTE.value(), "OP"},
            new String[]{PermissionCode.DISPOSAL_STOP.value(), "OP"},
            new String[]{PermissionCode.ALARM_READ.value(), "READ"},
            new String[]{PermissionCode.TARGET_READ.value(), "READ"},
            new String[]{PermissionCode.HANDOFF_READ.value(), "READ"});

    private final JdbcTemplate jdbc;
    private final PasswordEncoder passwordEncoder;
    private final AppProperties appProperties;

    public LocalStage15DemoReviewerSeeder(JdbcTemplate jdbc, PasswordEncoder passwordEncoder,
            AppProperties appProperties) {
        this.jdbc = jdbc; this.passwordEncoder = passwordEncoder; this.appProperties = appProperties;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        String password = appProperties.getDevSeed().getPassword();
        if (password == null || password.isBlank()) return;   // 与 LocalUserSeeder 同一来源；没有就不造账号。
        long now = System.currentTimeMillis();
        role(now);
        modulePermissions();
        actionPermissions();
        user(passwordEncoder.encode(password), now);
    }

    private void role(long now) {
        jdbc.update("INSERT INTO app_role (role_code,name,description,builtin,enabled,created_at,updated_at,version,"
                + "system_role) SELECT ?,'演示复核员','本地演示：处罚复核（决策 15-3）',FALSE,TRUE,?,?,0,FALSE"
                + " WHERE NOT EXISTS (SELECT 1 FROM app_role WHERE role_code=?)", ROLE, now, now, ROLE);
    }

    /**
     * 模块矩阵按目录整组落：矩阵的语义是"每一项都要有明确取值"，
     * 只插几行会让这个角色的矩阵不完整，页面上打开就是一片空白而不是"全部无权限"。
     */
    private void modulePermissions() {
        for (String code : jdbc.queryForList(
                "SELECT permission_code FROM app_permission WHERE permission_kind='MODULE'", String.class)) {
            String level = MODULE_READ.contains(code) ? "READ" : "NONE";
            boolean menu = MODULE_READ.contains(code);
            jdbc.update("INSERT INTO app_role_permission (role_code,permission_code,permission_level,menu_enabled,"
                    + "created_at) SELECT ?,?,?,?,CURRENT_TIMESTAMP WHERE NOT EXISTS"
                    + " (SELECT 1 FROM app_role_permission WHERE role_code=? AND permission_code=?)",
                    ROLE, code, level, menu, ROLE, code);
        }
    }

    private void actionPermissions() {
        for (String[] action : ACTIONS) {
            jdbc.update("INSERT INTO app_role_permission (role_code,permission_code,permission_level,menu_enabled,"
                    + "created_at) SELECT ?,?,?,FALSE,CURRENT_TIMESTAMP"
                    + " WHERE EXISTS (SELECT 1 FROM app_permission WHERE permission_code=? AND permission_kind='ACTION')"
                    + " AND NOT EXISTS (SELECT 1 FROM app_role_permission WHERE role_code=? AND permission_code=?)",
                    ROLE, action[0], action[1], action[0], ROLE, action[0]);
        }
    }

    /** 账号挂在 admin1 所在的组织上，`scope_mode=ALL`——演示复核不该被数据范围挡住。 */
    private void user(String hash, long now) {
        jdbc.update("INSERT INTO app_user (user_id,account,name,role_code,status,password_hash,fail_count,org_id,"
                + "scope_mode,must_change_password,permission_version,created_at,updated_at,version)"
                + " SELECT ?,?,'演示复核员',?,'ACTIVE',?,0,(SELECT org_id FROM app_user WHERE account='admin1'),"
                + "'ALL',FALSE,0,?,?,0"
                + " WHERE EXISTS (SELECT 1 FROM app_role WHERE role_code=?)"
                + " AND NOT EXISTS (SELECT 1 FROM app_user WHERE account=?)",
                UUID.randomUUID().toString(), ACCOUNT, ROLE, hash, now, now, ROLE, ACCOUNT);
    }
}
