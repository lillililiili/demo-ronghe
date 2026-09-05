package com.uav.lowaltitude.integration.mock;

import java.sql.Timestamp;
import java.time.Instant;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.DependsOn;
import org.springframework.context.annotation.Profile;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/** Stage4 风险固定夹具只在显式 local/test 开关下存在；production 即使叠加 local 也不会注册。 */
@Component
@Profile("!production & (local | test)")
@ConditionalOnProperty(prefix="app.dev-seed",name="enabled",havingValue="true")
// 风险样例引用阶段 3 计划/航线版本，必须排在 LocalStage3PlanningSeeder(35) 之后、交接种子(60) 之前。
@Order(46)
@DependsOn("localStage3PlanningSeeder")
public class LocalStage4RiskSeeder implements ApplicationRunner {
    private final JdbcTemplate jdbc;
    private final LocalStage3PlanningSeeder planningSeeder;
    public LocalStage4RiskSeeder(JdbcTemplate jdbc,LocalStage3PlanningSeeder planningSeeder){this.jdbc=jdbc;this.planningSeeder=planningSeeder;}

    @Override @Transactional
    public void run(ApplicationArguments args){
        // Runner 的注册顺序不是数据依赖；先幂等确保 Stage3 计划存在，不能靠偶然启动顺序制造悬空风险。
        planningSeeder.run(args);
        Instant base=Instant.parse("2026-09-05T00:00:00Z");
        risk("seed-stage4-risk-pending","STAGE4-SEED-PENDING","seed-stage3-plan-legal","seed-stage3-rv-legal",
                "seed-stage3-org","seed-stage3-district","HIGH","PENDING_VERIFICATION","ROUTE_DEVIATION","已保存的计划偏离事实",base,null,null);
        risk("seed-stage4-risk-confirmed","STAGE4-SEED-CONFIRMED","seed-stage3-plan-illegal","seed-stage3-rv-illegal",
                "seed-stage3-org","seed-stage3-district","CRITICAL","PENDING_NOTIFICATION","AIRSPACE_CONFLICT","已核验，等待后续通知切片处理",base.plusSeconds(1),90d,"AMSL");
        // 计划本身缺高度基准；这里必须保留 UNKNOWN，不能默认成 AGL 或伪判安全。
        risk("seed-stage4-risk-unknown-height","STAGE4-SEED-UNKNOWN","seed-stage3-plan-undetermined","seed-stage3-rv-undetermined",
                "seed-stage3-org","seed-stage3-district","MEDIUM","PENDING_VERIFICATION","ALTITUDE_UNKNOWN","高度事实不可比",base.plusSeconds(2),null,null);
        risk("seed-stage4-risk-cross-scope","STAGE4-SEED-CROSS","seed-stage3-plan-cross-scope","seed-stage3-rv-cross-scope",
                "seed-stage3-other-org","seed-stage3-other-district","LOW","EXCLUDED","SOURCE_MISMATCH","跨范围反例，仅供范围测试",base.plusSeconds(3),null,null);
    }

    private void risk(String id,String sourceRisk,String plan,String route,String org,String district,String severity,String state,
            String reason,String text,Instant at,Double altitude,String datum){
        jdbc.update("INSERT INTO flight_risk (risk_id,source_id,source_risk_id,plan_id,route_version_id,risk_type,severity,state_code,"
                +"reason_code,reason_text,occurred_at,received_at,observed_altitude_m,observed_altitude_datum,height_relation,source_mode,"
                +"owner_org_id,district_id,created_at,updated_at,version) SELECT ?,'seed-stage3-source',?,?,?,'FLIGHT_OPERATION',?,?,?,?,?,?,?,?,"
                +"'UNKNOWN','mock',?,?,?,?,0 WHERE NOT EXISTS (SELECT 1 FROM flight_risk WHERE risk_id=?)",
                id,sourceRisk,plan,route,severity,state,reason,text,Timestamp.from(at),Timestamp.from(at.plusSeconds(5)),altitude,datum,
                org,district,Timestamp.from(at),Timestamp.from(at),id);
    }
}
