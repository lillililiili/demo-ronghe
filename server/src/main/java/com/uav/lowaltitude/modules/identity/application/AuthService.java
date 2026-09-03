package com.uav.lowaltitude.modules.identity.application;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.uav.lowaltitude.modules.identity.domain.AppSession;
import com.uav.lowaltitude.modules.identity.domain.AppUser;
import com.uav.lowaltitude.modules.identity.infrastructure.SessionMapper;
import com.uav.lowaltitude.modules.identity.infrastructure.UserMapper;
import com.uav.lowaltitude.platform.api.ApiException;
import com.uav.lowaltitude.platform.audit.AuditService;
import com.uav.lowaltitude.platform.config.AppProperties;
import com.uav.lowaltitude.platform.security.AuthUser;
import com.uav.lowaltitude.platform.time.AppClock;

@Service
public class AuthService {

    private final UserMapper userMapper;
    private final SessionMapper sessionMapper;
    private final PasswordEncoder passwordEncoder;
    private final AuditService auditService;
    private final AppProperties appProperties;
    private final AppClock appClock;

    public AuthService(
            UserMapper userMapper,
            SessionMapper sessionMapper,
            PasswordEncoder passwordEncoder,
            AuditService auditService,
            AppProperties appProperties,
            AppClock appClock) {
        this.userMapper = userMapper;
        this.sessionMapper = sessionMapper;
        this.passwordEncoder = passwordEncoder;
        this.auditService = auditService;
        this.appProperties = appProperties;
        this.appClock = appClock;
    }

    @Transactional
    public Map<String, Object> login(String account, String password, String ip) {
        AppUser user = userMapper.findByAccount(account);
        if (user == null) {
            auditService.record(null, account, "login_fail", "user", account, "unknown_account", ip);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "账号或密码错误");
        }
        long now = appClock.nowMillis();
        if (user.getLockedUntil() != null && user.getLockedUntil() > now) {
            auditService.record(user.getUserId(), account, "login_fail", "user", user.getUserId(), "locked", ip);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "ACCOUNT_LOCKED", "账号已锁定");
        }
        if (!"正常".equals(user.getStatus())) {
            auditService.record(user.getUserId(), account, "login_fail", "user", user.getUserId(), "disabled", ip);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "ACCOUNT_DISABLED", "账号已停用");
        }
        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            int fails = user.getFailCount() + 1;
            Long lockedUntil = null;
            if (fails >= appProperties.getLogin().getFailLimit()) {
                lockedUntil = now + appProperties.getLogin().getLockMinutes() * 60_000L;
            }
            userMapper.updateLock(user.getUserId(), fails, lockedUntil);
            auditService.record(user.getUserId(), account, "login_fail", "user", user.getUserId(), "bad_password", ip);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "账号或密码错误");
        }
        userMapper.updateLock(user.getUserId(), 0, null);
        AppSession session = new AppSession();
        session.setSessionId(UUID.randomUUID().toString());
        session.setUserId(user.getUserId());
        session.setExpireAt(now + appProperties.getSession().getTtlHours() * 3600_000L);
        session.setIp(ip == null ? "" : ip);
        sessionMapper.insert(session);
        auditService.record(user.getUserId(), account, "login_success", "session", session.getSessionId(), null, ip);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("user_id", user.getUserId());
        data.put("account", user.getAccount());
        data.put("name", user.getName());
        data.put("role_code", user.getRoleCode());
        data.put("session_id", session.getSessionId());
        data.put("expire_at", session.getExpireAt());
        return data;
    }

    @Transactional
    public void logout(String sessionId, AuthUser current, String ip) {
        sessionMapper.expire(sessionId);
        auditService.record(current.userId(), current.account(), "logout", "session", sessionId, null, ip);
    }

    public Map<String, Object> me(AuthUser current) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("user_id", current.userId());
        data.put("account", current.account());
        data.put("name", current.name());
        data.put("role_code", current.roleCode());
        data.put("source_mode", appProperties.getSourceMode());
        return data;
    }

    public AuthUser resolve(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            return null;
        }
        AppSession session = sessionMapper.findById(sessionId);
        if (session == null || session.getExpireAt() <= appClock.nowMillis()) {
            return null;
        }
        AppUser user = userMapper.findById(session.getUserId());
        if (user == null || !"正常".equals(user.getStatus())) {
            return null;
        }
        return new AuthUser(user.getUserId(), user.getAccount(), user.getName(), user.getRoleCode());
    }
}
