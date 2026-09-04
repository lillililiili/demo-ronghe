package com.uav.lowaltitude.modules.alarm.api;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.uav.lowaltitude.platform.api.ApiResponse;
import com.uav.lowaltitude.modules.identity.application.AccessService;

@RestController
@RequestMapping("/api/v1/alarms")
public class AlarmController {

    private final AccessService accessService;

    public AlarmController(AccessService accessService) {
        this.accessService = accessService;
    }

    @GetMapping
    public ApiResponse<Map<String, Object>> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        accessService.requireBusinessData("alarms.read");
        int safeSize = Math.min(Math.max(size, 1), 100);
        int safePage = Math.max(page, 1);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("items", List.of());
        data.put("page", safePage);
        data.put("size", safeSize);
        data.put("total", 0);
        return ApiResponse.ok(data);
    }
}
