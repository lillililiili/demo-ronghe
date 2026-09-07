package com.uav.lowaltitude.modules.flight.api;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.uav.lowaltitude.modules.flight.api.FlightActualsDtos.ActualsDto;
import com.uav.lowaltitude.modules.flight.api.FlightActualsDtos.AuthorizationsDto;
import com.uav.lowaltitude.modules.flight.api.FlightActualsDtos.RecordedAuthorizationDto;
import com.uav.lowaltitude.modules.flight.application.FlightActualsService;
import com.uav.lowaltitude.modules.flight.application.PlanAuthorizationService;
import com.uav.lowaltitude.platform.api.ApiResponse;

/** 飞行计划的对照聚合与外部授权登记；计划与航线的只读接口仍在 FlightReadController。 */
@RestController
@RequestMapping("/api/v1")
public class FlightActualsController {
    private final FlightActualsService actuals;
    private final PlanAuthorizationService authorizations;

    public FlightActualsController(FlightActualsService actuals, PlanAuthorizationService authorizations) {
        this.actuals = actuals; this.authorizations = authorizations;
    }

    @GetMapping("/flight-plans/{planId}/actuals")
    public ApiResponse<ActualsDto> actuals(@PathVariable String planId) {
        return ApiResponse.ok(actuals.actuals(planId));
    }

    @GetMapping("/flight-plans/{planId}/authorizations")
    public ApiResponse<AuthorizationsDto> authorizations(@PathVariable String planId) {
        return ApiResponse.ok(authorizations.list(planId));
    }

    @PostMapping("/flight-plans/{planId}/authorizations")
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<RecordedAuthorizationDto> record(@PathVariable String planId,
            @RequestBody(required = false) String request,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return ApiResponse.ok(authorizations.record(planId, request, idempotencyKey));
    }
}
