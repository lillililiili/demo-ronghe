package com.uav.lowaltitude.platform.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public class AppProperties {

    private String sourceMode = "mock";
    private String evidenceDir = "./data/evidence";
    private final Login login = new Login();
    private final Session session = new Session();

    public String getSourceMode() {
        return sourceMode;
    }

    public void setSourceMode(String sourceMode) {
        this.sourceMode = sourceMode;
    }

    public String getEvidenceDir() {
        return evidenceDir;
    }

    public void setEvidenceDir(String evidenceDir) {
        this.evidenceDir = evidenceDir;
    }

    public Login getLogin() {
        return login;
    }

    public Session getSession() {
        return session;
    }

    public static class Login {
        private int failLimit = 5;
        private int lockMinutes = 30;

        public int getFailLimit() {
            return failLimit;
        }

        public void setFailLimit(int failLimit) {
            this.failLimit = failLimit;
        }

        public int getLockMinutes() {
            return lockMinutes;
        }

        public void setLockMinutes(int lockMinutes) {
            this.lockMinutes = lockMinutes;
        }
    }

    public static class Session {
        private int ttlHours = 8;

        public int getTtlHours() {
            return ttlHours;
        }

        public void setTtlHours(int ttlHours) {
            this.ttlHours = ttlHours;
        }
    }
}
