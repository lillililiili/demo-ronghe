package com.uav.lowaltitude.platform.storage;

import java.io.InputStream;
import java.nio.file.Path;

public interface ObjectStoragePort {

    Path resolve(String relativePath);

    void save(String relativePath, InputStream content);
}
