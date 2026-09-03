package com.uav.lowaltitude.platform.storage;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.springframework.stereotype.Component;

import com.uav.lowaltitude.platform.config.AppProperties;

@Component
public class LocalObjectStorage implements ObjectStoragePort {

    private final Path root;

    public LocalObjectStorage(AppProperties properties) {
        this.root = Path.of(properties.getEvidenceDir()).toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.root);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public Path resolve(String relativePath) {
        Path resolved = root.resolve(relativePath).normalize();
        if (!resolved.startsWith(root)) {
            throw new IllegalArgumentException("path escapes evidence dir");
        }
        return resolved;
    }

    @Override
    public void save(String relativePath, InputStream content) {
        try {
            Path target = resolve(relativePath);
            Files.createDirectories(target.getParent());
            Files.copy(content, target);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
