package com.uav.lowaltitude.modules.identity.application;

import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.identity.infrastructure.UserMapper;

@Component
public class LocalUserSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(LocalUserSeeder.class);

    private final UserMapper userMapper;
    private final JdbcTemplate jdbcTemplate;
    private final PasswordEncoder passwordEncoder;

    public LocalUserSeeder(UserMapper userMapper, JdbcTemplate jdbcTemplate, PasswordEncoder passwordEncoder) {
        this.userMapper = userMapper;
        this.jdbcTemplate = jdbcTemplate;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (userMapper.count() > 0) {
            return;
        }
        String hash = passwordEncoder.encode("changeme");
        List<Object[]> rows = List.of(
                row("admin1", "系统管理员", "ROLE-ADMIN", hash),
                row("duty1", "值班员", "ROLE-DUTY", hash),
                row("judge1", "研判员", "ROLE-JUDGE", hash),
                row("auth1", "授权人甲", "ROLE-AUTH", hash),
                row("auth2", "授权人乙", "ROLE-AUTH", hash),
                row("ops1", "运维员", "ROLE-OPS", hash),
                row("audit1", "审计员", "ROLE-AUDIT", hash)
        );
        jdbcTemplate.batchUpdate(
                """
                INSERT INTO app_user (user_id, account, name, role_code, status, password_hash, fail_count)
                VALUES (?, ?, ?, ?, '正常', ?, 0)
                """,
                rows);
        log.info("seeded local regulator accounts; default password is only for local/dev");
    }

    private static Object[] row(String account, String name, String role, String hash) {
        return new Object[] {UUID.randomUUID().toString(), account, name, role, hash};
    }
}
