package com.uav.lowaltitude.modules.identity.api;

import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.uav.lowaltitude.modules.identity.application.AuthService;
import com.uav.lowaltitude.platform.api.ApiResponse;
import com.uav.lowaltitude.platform.security.AuthContext;
import com.uav.lowaltitude.platform.security.AuthUser;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/login")
    public ApiResponse<Map<String, Object>> login(@Valid @RequestBody LoginRequest req, HttpServletRequest http) {
        return ApiResponse.ok(authService.login(req.account(), req.password(), clientIp(http)));
    }

    @PostMapping("/logout")
    public ApiResponse<Map<String, Object>> logout(HttpServletRequest http) {
        AuthUser user = AuthContext.require();
        String sessionId = (String) http.getAttribute(BearerAuthFilter.SESSION_ATTR);
        authService.logout(sessionId, user, clientIp(http));
        return ApiResponse.ok(Map.of());
    }

    @GetMapping("/me")
    public ApiResponse<Map<String, Object>> me() {
        return ApiResponse.ok(authService.me(AuthContext.require()));
    }

    private static String clientIp(HttpServletRequest http) {
        String ip = http.getRemoteAddr();
        return ip == null ? "" : ip;
    }

    public record LoginRequest(@NotBlank String account, @NotBlank String password) {
    }
}
