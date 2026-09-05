package com.uav.lowaltitude.modules.alarm.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.util.MultiValueMap;

import com.uav.lowaltitude.platform.api.ApiResponse;
import com.uav.lowaltitude.modules.alarm.api.AlarmDtos.AlarmDto;
import com.uav.lowaltitude.modules.alarm.api.AlarmDtos.PageDto;
import com.uav.lowaltitude.modules.alarm.application.AlarmReadService;

/** 来源告警只读；核实操作由独立 UAV event 资源承接，避免把设备事实误当作可编辑流程。 */
@RestController
@RequestMapping("/api/v1")
public class AlarmController {

    private final AlarmReadService service;

    public AlarmController(AlarmReadService service) { this.service = service; }

    @GetMapping("/alarms")
    public ApiResponse<PageDto<AlarmDto>> list(@RequestParam MultiValueMap<String, String> parameters) {
        return ApiResponse.ok(service.list(parameters));
    }

    @GetMapping("/alarms/{alarmId}")
    public ApiResponse<AlarmDto> detail(@PathVariable String alarmId) { return ApiResponse.ok(service.detail(alarmId)); }
}
