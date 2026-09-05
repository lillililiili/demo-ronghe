package com.uav.lowaltitude.modules.flight.api;

import java.math.BigDecimal;
import java.util.List;

public final class FlightDtos {

    private FlightDtos() {
    }

    public record PageDto<T>(List<T> items, int page, int size, long total) {
    }

    public record FieldIssueDto(String field, String reasonCode) {
    }

    public record SourceDto(String sourceId, String sourceCode, String sourceMode) {
    }

    public record RouteReferenceDto(
            String routeVersionId, String routeId, String routeNo, String name, int versionNo) {
    }

    public record GeoJsonLineStringDto(
            String type, List<List<BigDecimal>> coordinates, String coordinateSystem) {
    }

    public record FlightPlanDto(
            String planId, String planNo, String statusCode, SourceDto source, String sourceMode, String uavSn,
            Long startAt, Long endAt, String ownerOrgId, String districtId, RouteReferenceDto route,
            List<FieldIssueDto> fieldIssues, long createdAt, long updatedAt, long version) {
    }

    public record RouteDto(
            String routeId, String routeNo, String name, boolean enabled, SourceDto source, String sourceMode,
            String ownerOrgId, String districtId, long createdAt, long updatedAt, long version) {
    }

    public record RouteVersionDto(
            String routeVersionId, String routeId, int versionNo, GeoJsonLineStringDto centerline,
            BigDecimal corridorWidthM, BigDecimal minAltitudeM, BigDecimal maxAltitudeM, String altitudeDatum,
            long validFrom, Long validTo, String changeReason, List<FieldIssueDto> fieldIssues, long createdAt) {
    }
}
