package com.uav.lowaltitude.modules.reporting.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.uav.lowaltitude.modules.reporting.application.ReportingService;
import com.uav.lowaltitude.modules.reporting.application.ReportingService.CsvExport;
import com.uav.lowaltitude.modules.reporting.application.ReportingService.OperationsReport;
import com.uav.lowaltitude.platform.api.ApiResponse;

@RestController
@RequestMapping("/api/v1/stats")
public class ReportingController {

    private final ReportingService service;

    public ReportingController(ReportingService service) {
        this.service = service;
    }

    @GetMapping("/operations")
    public ApiResponse<OperationsReport> operations(
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to) {
        return ApiResponse.ok(service.operations(from, to));
    }

    @GetMapping("/operations/export.csv")
    public void export(
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            HttpServletRequest request,
            HttpServletResponse response) throws IOException {
        CsvExport file = service.exportCsv(from, to, request.getRemoteAddr(), request.getHeader("User-Agent"));
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setContentType("text/csv;charset=UTF-8");
        response.setHeader("Content-Disposition", "attachment; filename=\"" + file.filename() + "\"");
        response.getWriter().write('\ufeff');
        response.getWriter().write(file.body());
    }
}
