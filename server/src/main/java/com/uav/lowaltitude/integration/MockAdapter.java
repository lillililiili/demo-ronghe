package com.uav.lowaltitude.integration;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "app.source-mode", havingValue = "mock", matchIfMissing = true)
public class MockAdapter implements AdapterPort {

    @Override
    public SourceMode mode() {
        return SourceMode.mock;
    }
}
