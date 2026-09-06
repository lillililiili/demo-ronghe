package com.uav.lowaltitude.modules.assessment.engine.checks;

import java.util.List;

import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.assessment.engine.RuleCodes;
import com.uav.lowaltitude.modules.assessment.engine.RuleContracts.EvaluationContext;
import com.uav.lowaltitude.modules.assessment.engine.RuleContracts.HitDetail;
import com.uav.lowaltitude.modules.assessment.engine.RuleContracts.ParamRef;
import com.uav.lowaltitude.modules.assessment.engine.RuleContracts.RuleCheck;
import com.uav.lowaltitude.modules.assessment.engine.RuleContracts.RuleParams;

/**
 * C02-6 超视距：飞手位置尚未接入，恒为 PILOT_POSITION_UNAVAILABLE；参数 vlos_m 保留并随明细输出，
 * 以便接入后不改契约。C03 默认通过 ignore_undetermined_rules 忽略本规则的未知。
 */
@Component
public class VisualLineOfSightCheck implements RuleCheck {
    static final String PARAM_VLOS_M = "vlos_m";

    @Override public String ruleCode() { return RuleCodes.C02_6; }
    @Override public int defaultPriority() { return RuleCodes.PRIORITY_C02_6; }

    @Override
    public HitDetail evaluate(EvaluationContext context, RuleParams params) {
        List<ParamRef> refs = List.of(CheckSupport.number(params, ruleCode(), PARAM_VLOS_M));
        return CheckSupport.undetermined(ruleCode(), RuleCodes.PILOT_POSITION_UNAVAILABLE, CheckSupport.facts(), refs, List.of(),
                "飞手位置尚未接入，无法判断是否超视距");
    }
}
