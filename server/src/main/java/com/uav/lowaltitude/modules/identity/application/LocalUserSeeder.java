package com.uav.lowaltitude.modules.identity.application;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.identity.infrastructure.UserMapper;
import com.uav.lowaltitude.platform.config.AppProperties;

@Component
@ConditionalOnProperty(prefix = "app.dev-seed", name = "enabled", havingValue = "true")
public class LocalUserSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(LocalUserSeeder.class);

    private final UserMapper userMapper;
    private final JdbcTemplate jdbcTemplate;
    private final PasswordEncoder passwordEncoder;
    private final AppProperties appProperties;

    public LocalUserSeeder(
            UserMapper userMapper,
            JdbcTemplate jdbcTemplate,
            PasswordEncoder passwordEncoder,
            AppProperties appProperties) {
        this.userMapper = userMapper;
        this.jdbcTemplate = jdbcTemplate;
        this.passwordEncoder = passwordEncoder;
        this.appProperties = appProperties;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (userMapper.count() > 0) {
            return;
        }
        String password = appProperties.getDevSeed().getPassword();
        if (password == null || password.isBlank()) {
            throw new IllegalStateException("app.dev-seed.password must be set when development seed is enabled");
        }
        String hash = passwordEncoder.encode(password);
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
        log.info("seeded synthetic regulator accounts for an isolated development environment");
    }

    private static Object[] row(String account, String name, String role, String hash) {
        UUID userId = UUID.nameUUIDFromBytes(("demo-user:" + account).getBytes(StandardCharsets.UTF_8));
        return new Object[] {userId.toString(), account, name, role, hash};
    }
}
