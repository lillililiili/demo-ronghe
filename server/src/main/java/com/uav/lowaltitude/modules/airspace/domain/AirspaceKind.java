package com.uav.lowaltitude.modules.airspace.domain;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 空域种类字典（决策 9-3）。写接口只接受这五个规范值：页面的图层映射（禁飞 / 限高 / 适飞）依赖稳定字典，
 * 自由文本会让同一类空域在不同批次里有两三种写法，图层就画不出来。
 * 迁移 061 的 CHECK 另外容忍两个历史写法（HEIGHT_LIMIT / TEMPORARY），那是阶段 3/7 种子留下的存量数据，
 * 已由 061 归一；这里不接受它们，新数据一律用规范值。
 */
public final class AirspaceKind {
    public static final String PROHIBITED = "PROHIBITED";
    public static final String RESTRICTED = "RESTRICTED";
    public static final String ALTITUDE_LIMIT = "ALTITUDE_LIMIT";
    public static final String PERMITTED = "PERMITTED";
    public static final String TEMPORARY_CONTROL = "TEMPORARY_CONTROL";

    /** 保持声明顺序，便于错误信息里给出稳定的可选值列表。 */
    public static final Set<String> CODES = new LinkedHashSet<>(
            java.util.List.of(PROHIBITED, RESTRICTED, ALTITUDE_LIMIT, PERMITTED, TEMPORARY_CONTROL));

    private AirspaceKind() { }

    public static boolean supported(String kindCode) {
        return kindCode != null && CODES.contains(kindCode);
    }

    public static String options() {
        return String.join(" / ", CODES);
    }
}
