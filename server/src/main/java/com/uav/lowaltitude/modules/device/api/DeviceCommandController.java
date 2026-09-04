package com.uav.lowaltitude.modules.device.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.uav.lowaltitude.modules.device.application.DeviceService;
import com.uav.lowaltitude.platform.api.ApiResponse;

@RestController
@RequestMapping("/api/v1")
public class DeviceCommandController {

    private final DeviceService service;

    public DeviceCommandController(DeviceService service) {
        this.service = service;
    }

    @PostMapping("/devices/{deviceId}/commands/reboot")
    public ResponseEntity<ApiResponse<DeviceService.Command>> reboot(
            @PathVariable String deviceId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody RebootRequest request) {
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(ApiResponse.ok(service.createReboot(deviceId, idempotencyKey, request.reason())));
    }

    @GetMapping("/device-commands/{commandId}")
    public ApiResponse<DeviceService.Command> command(@PathVariable String commandId) {
        return ApiResponse.ok(service.command(commandId));
    }

    public record RebootRequest(@NotBlank String reason) { }
}
