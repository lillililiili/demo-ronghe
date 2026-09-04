package com.uav.lowaltitude.platform.api;

import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import com.uav.lowaltitude.platform.audit.AuditService;
import com.uav.lowaltitude.platform.security.AuthContext;
import com.uav.lowaltitude.platform.security.AuthUser;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private final AuditService auditService;

    public GlobalExceptionHandler(AuditService auditService) {
        this.auditService = auditService;
    }

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiResponse<Void>> handleApi(ApiException ex, HttpServletRequest request) {
        auditFailure(request, ex.getCode(), ex.getMessage());
        return ResponseEntity.status(ex.getStatus())
                .body(ApiResponse.fail(ex.getCode(), ex.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValid(MethodArgumentNotValidException ex,
            HttpServletRequest request) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(error -> fieldMessage(error.getField(), error.getDefaultMessage()))
                .orElse("参数无效");
        auditFailure(request, "VALIDATION_ERROR", message);
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(ApiResponse.fail("VALIDATION_ERROR", message));
    }

    @ExceptionHandler(MissingRequestHeaderException.class)
    public ResponseEntity<ApiResponse<Void>> handleMissingHeader(MissingRequestHeaderException ex,
            HttpServletRequest request) {
        String message = "Idempotency-Key".equalsIgnoreCase(ex.getHeaderName())
                ? "系统管理写操作必须提供 Idempotency-Key"
                : "缺少请求头 " + ex.getHeaderName();
        auditFailure(request, "MISSING_REQUEST_HEADER", message);
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(ApiResponse.fail("MISSING_REQUEST_HEADER", message));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    public ResponseEntity<ApiResponse<Void>> handleMalformed(Exception ex, HttpServletRequest request) {
        auditFailure(request, "INVALID_REQUEST", "请求参数格式不正确");
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(ApiResponse.fail("INVALID_REQUEST", "请求参数格式不正确"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleUnknown(Exception ex, HttpServletRequest request) {
        log.error("Unhandled {} on {}", ex.getClass().getSimpleName(),
                request == null ? "" : request.getRequestURI(), ex);
        auditFailure(request, "INTERNAL_ERROR", "服务内部错误");
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.fail("INTERNAL_ERROR", "服务内部错误"));
    }

    private void auditFailure(HttpServletRequest request, String code, String message) {
        AuthUser actor = AuthContext.get();
        if (actor == null || request == null || !request.getRequestURI().startsWith("/api/")) return;
        try {
            String path = request.getRequestURI();
            String userAgent = request.getHeader("User-Agent");
            if (userAgent != null && userAgent.length() > 512) userAgent = userAgent.substring(0, 512);
            auditService.recordStandalone(actor.userId(), actor.account(), actor.roleCode(), module(path),
                    request.getMethod() + " " + path, "request", path,
                    "error_code=" + code + "; message=" + message, "FAILURE",
                    request.getRemoteAddr(), userAgent);
        } catch (RuntimeException ignored) {
            // 审计写入异常不能改变原业务错误的 HTTP 语义。
        }
    }

    private static final Map<String, String> FIELD_LABELS = Map.ofEntries(
            Map.entry("temporaryPassword", "临时密码"),
            Map.entry("temporary_password", "临时密码"),
            Map.entry("account", "登录账号"),
            Map.entry("name", "名称"),
            Map.entry("phone", "联系电话"),
            Map.entry("orgId", "所属组织"),
            Map.entry("org_id", "所属组织"),
            Map.entry("roleCode", "角色"),
            Map.entry("role_code", "角色"),
            Map.entry("reason", "操作原因"),
            Map.entry("orgCode", "组织编码"),
            Map.entry("org_code", "组织编码"),
            Map.entry("parentId", "上级组织"),
            Map.entry("parent_id", "上级组织"),
            Map.entry("districtCode", "区域编码"),
            Map.entry("district_code", "区域编码"),
            Map.entry("status", "状态"),
            Map.entry("description", "说明"),
            Map.entry("currentPassword", "当前密码"),
            Map.entry("current_password", "当前密码"),
            Map.entry("newPassword", "新密码"),
            Map.entry("new_password", "新密码"));

    private static String fieldMessage(String field, String defaultMessage) {
        String label = FIELD_LABELS.getOrDefault(field, field);
        String message = defaultMessage == null ? "" : defaultMessage.trim();
        if (message.isEmpty()) return label + "无效";
        if (message.contains(label)) return message;
        return label + " " + message.replace("个数必须", "长度必须");
    }

    private static String module(String path) {
        if (path.contains("/audit-logs")) return "audit";
        if (path.contains("/roles") || path.contains("/permissions") || path.contains("/access-change")) return "roles";
        if (path.contains("/users") || path.contains("/organizations") || path.contains("/districts")) return "users";
        if (path.contains("/device") || path.contains("/commission")) return "devices";
        if (path.contains("/alarms")) return "alarms";
        return "system";
    }
}
