package com.uav.lowaltitude.integration.replay;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.fusion.domain.AlphaBetaFilter;

/**
 * 合成回放数据集（契约六场景）。固定随机种子与固定 T0：同一数据集每次生成的记录逐字节相同，回放回归才有意义。
 * 生成的是"来源观测"，不是结论：三路来源各按自己的 Demo 精度加噪，缺字段就不给（EO 无身份线索、TDOA 无类别），
 * 绝不为了让融合好看而补默认值。
 */
@Component
public class FusionReplayDatasetGenerator {
    public static final String DATASET_ID = "stage8-fusion-demo";
    public static final long T0_MILLIS = 1_757_073_600_000L; // 2026-09-05T12:00:00Z
    public static final long SEED = 20260905L;
    public static final long FRAME_INTERVAL_MS = 1000L;
    public static final String RADAR = "replay-radar-a", TDOA = "replay-tdoa-a", EO = "replay-eo-a";
    /** 六场景（契约 §回放数据集）。 */
    public static final List<String> SCENARIOS = List.of("three-source", "single-missing", "crossing", "split-merge", "late-out-of-order", "accuracy-gap");

    private static final double LON0 = 118.62, LAT0 = 37.42;
    private static final double RADAR_ACC = 15, TDOA_ACC = 60, EO_ACC = 25;
    private static final int FRAMES = 12;

    /** 一条回放记录：信封在 {@link FusionReplayRunner} 里组装，这里只给 frame 与真值。 */
    public record Record(long recordNo, String sourceCode, long observedAtMillis, long receivedAtMillis, List<Map<String, Object>> items, String scenario) { }
    public record GroundTruth(String scenario, long recordNo, String trueTargetKey, String sourceCode, String externalTargetId, long observedAtMillis) { }
    public record Dataset(String datasetId, List<Record> records, List<GroundTruth> groundTruth) { }

    public Dataset generate() {
        Random random = new Random(SEED);
        List<Record> records = new ArrayList<>();
        List<GroundTruth> truth = new ArrayList<>();
        long recordNo = 0;
        for (String scenario : SCENARIOS) recordNo = scenario(scenario, recordNo, random, records, truth);
        return new Dataset(DATASET_ID, List.copyOf(records), List.copyOf(truth));
    }

    private long scenario(String scenario, long startRecordNo, Random random, List<Record> records, List<GroundTruth> truth) {
        long recordNo = startRecordNo;
        long base = T0_MILLIS + SCENARIOS.indexOf(scenario) * 600_000L;
        double lonBase = LON0 + SCENARIOS.indexOf(scenario) * 0.05;
        for (int frame = 0; frame < FRAMES; frame++) {
            long observedAt = base + frame * FRAME_INTERVAL_MS;
            switch (scenario) {
                case "three-source" -> {
                    double[] p = along(lonBase, LAT0, frame, 10, 0);
                    recordNo = emitAll(scenario, recordNo, observedAt, p, random, records, truth, "T1", true, true, true, RADAR_ACC, TDOA_ACC, EO_ACC);
                }
                case "single-missing" -> {
                    // TDOA 在第 4–9 帧空窗（20 s 量级的缺失），雷达与光电继续；单源缺失不得让目标换 ID。
                    double[] p = along(lonBase, LAT0, frame, 8, 0.3);
                    boolean tdoa = frame < 4 || frame > 9;
                    recordNo = emitAll(scenario, recordNo, observedAt, p, random, records, truth, "T1", true, tdoa, true, RADAR_ACC, TDOA_ACC, EO_ACC);
                }
                case "crossing" -> {
                    // 两目标相向而行，最小间距约 40 m：交叉不得换 ID。
                    double[] a = along(lonBase, LAT0, frame, 12, 0);
                    double[] b = along(lonBase + 0.0012, LAT0 + 0.00036, FRAMES - 1 - frame, 12, 0);
                    List<Map<String, Object>> radarItems = List.of(item("R-A", a, RADAR_ACC, random, "UAV", null, null),
                            item("R-B", b, RADAR_ACC, random, "UAV", null, null));
                    records.add(new Record(recordNo++, RADAR, observedAt, observedAt, radarItems, scenario));
                    truth.add(new GroundTruth(scenario, recordNo - 1, scenario + ":TA", RADAR, "R-A", observedAt));
                    truth.add(new GroundTruth(scenario, recordNo - 1, scenario + ":TB", RADAR, "R-B", observedAt));
                }
                case "split-merge" -> {
                    // 前 6 帧一个回波，之后分成相距 ≥ split_min_separation_m 的两个。
                    List<Map<String, Object>> items = new ArrayList<>();
                    double[] a = along(lonBase, LAT0, frame, 10, 0);
                    items.add(item("R-M1", a, RADAR_ACC, random, "UAV", null, null));
                    if (frame >= 6) {
                        double[] b = AlphaBetaFilter.fromEnu(a[0], a[1], 150.0, 0);
                        items.add(item("R-M2", b, RADAR_ACC, random, "UAV", null, null));
                        truth.add(new GroundTruth(scenario, recordNo, scenario + ":TB", RADAR, "R-M2", observedAt));
                    }
                    truth.add(new GroundTruth(scenario, recordNo, scenario + ":TA", RADAR, "R-M1", observedAt));
                    records.add(new Record(recordNo++, RADAR, observedAt, observedAt, List.copyOf(items), scenario));
                }
                case "late-out-of-order" -> {
                    // EO 晚 2.5 s 到达且 record_no 倒序：迟到帧只补原始层，不得回退融合结果。
                    double[] p = along(lonBase, LAT0, frame, 9, 0);
                    records.add(new Record(recordNo++, RADAR, observedAt, observedAt, List.of(item("R-L", p, RADAR_ACC, random, "UAV", null, null)), scenario));
                    truth.add(new GroundTruth(scenario, recordNo - 1, scenario + ":TA", RADAR, "R-L", observedAt));
                    if (frame % 2 == 1) {
                        long lateObserved = observedAt - 1000;
                        double[] lp = along(lonBase, LAT0, frame - 1, 9, 0);
                        records.add(new Record(recordNo++, EO, lateObserved, observedAt + 2500, List.of(item("E-L", lp, EO_ACC, random, "UAV", 0.86, null)), scenario));
                        truth.add(new GroundTruth(scenario, recordNo - 1, scenario + ":TA", EO, "E-L", lateObserved));
                    }
                }
                case "accuracy-gap" -> {
                    // TDOA ±50 m 偏差、精度 60 m；融合位置应明显偏向雷达。
                    double[] p = along(lonBase, LAT0, frame, 7, 0);
                    records.add(new Record(recordNo++, RADAR, observedAt, observedAt, List.of(item("R-G", p, RADAR_ACC, random, "UAV", null, null)), scenario));
                    truth.add(new GroundTruth(scenario, recordNo - 1, scenario + ":TA", RADAR, "R-G", observedAt));
                    double[] biased = AlphaBetaFilter.fromEnu(p[0], p[1], 50.0, 0);
                    records.add(new Record(recordNo++, TDOA, observedAt, observedAt, List.of(item("D-G", biased, TDOA_ACC, random, null, null, "RF-0007")), scenario));
                    truth.add(new GroundTruth(scenario, recordNo - 1, scenario + ":TA", TDOA, "D-G", observedAt));
                }
                default -> throw new IllegalStateException("未知回放场景: " + scenario);
            }
        }
        return recordNo;
    }

    private long emitAll(String scenario, long recordNo, long observedAt, double[] p, Random random, List<Record> records, List<GroundTruth> truth,
            String key, boolean radar, boolean tdoa, boolean eo, double radarAcc, double tdoaAcc, double eoAcc) {
        long next = recordNo;
        if (radar) {
            records.add(new Record(next++, RADAR, observedAt, observedAt, List.of(item("R-" + key, p, radarAcc, random, "UAV", null, null)), scenario));
            truth.add(new GroundTruth(scenario, next - 1, scenario + ":" + key, RADAR, "R-" + key, observedAt));
        }
        if (tdoa) {
            records.add(new Record(next++, TDOA, observedAt, observedAt, List.of(item("D-" + key, p, tdoaAcc, random, null, null, "RF-0042")), scenario));
            truth.add(new GroundTruth(scenario, next - 1, scenario + ":" + key, TDOA, "D-" + key, observedAt));
        }
        if (eo) {
            records.add(new Record(next++, EO, observedAt, observedAt, List.of(item("E-" + key, p, eoAcc, random, "UAV", 0.91, null)), scenario));
            truth.add(new GroundTruth(scenario, next - 1, scenario + ":" + key, EO, "E-" + key, observedAt));
        }
        return next;
    }

    /** 以 (lon0, lat0) 为起点、向东 speed m/s、向北 northPerFrame m/frame 的匀速航迹。 */
    private static double[] along(double lon0, double lat0, int frame, double speedMps, double northPerFrame) {
        return AlphaBetaFilter.fromEnu(lon0, lat0, speedMps * frame, northPerFrame * frame);
    }

    private static Map<String, Object> item(String externalTargetId, double[] position, double accuracy, Random random, String classCode,
            Double classConfidence, String identityClue) {
        // 噪声幅度与该源精度成比例：精度差的源本来就该给出更散的点。
        double[] noisy = AlphaBetaFilter.fromEnu(position[0], position[1], random.nextGaussian() * accuracy / 3, random.nextGaussian() * accuracy / 3);
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("external_target_id", externalTargetId);
        item.put("lon", round(noisy[0]));
        item.put("lat", round(noisy[1]));
        item.put("position_accuracy_m", accuracy);
        if (classCode != null) item.put("class_code", classCode);
        if (classConfidence != null) item.put("class_confidence", classConfidence);
        if (identityClue != null) item.put("identity_clue", identityClue);
        return item;
    }

    private static double round(double value) { return Math.round(value * 1e7) / 1e7; }
}
