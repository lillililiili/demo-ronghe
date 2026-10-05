import { computed, onUnmounted, ref, watch } from 'vue';
import { riskApi } from '@/services/riskApi.js';
import { mapPool } from '@/services/apiClient.js';

// 同一风险版本复用已读取的范围；接口失败只留下未知，不回退到航线坐标。
export function useWeatherRiskFacts(rows) {
  const facts = ref(new Map());
  let sequence = 0;
  const weatherRows = computed(() => rows.value.filter(row => (row.risk_type || row.riskType) === 'WEATHER'));
  watch(() => weatherRows.value.map(row => [row.risk_id, row.version, row.weather_fact]), async () => {
    const current = ++sequence;
    const previous = facts.value;
    const next = new Map();
    for (const row of weatherRows.value) {
      const cached = previous.get(row.risk_id);
      if (Object.hasOwn(row, 'weather_fact')) next.set(row.risk_id, { version: row.version, fact: row.weather_fact,
        loading: row.weather_loading === true, error: row.weather_error === true });
      else if (cached && cached.version === row.version && !cached.error) next.set(row.risk_id, cached);
    }
    facts.value = next;
    const pending = weatherRows.value.filter(row => !next.has(row.risk_id));
    await mapPool(pending, 4, async row => {
      if (current !== sequence) return;
      let entry;
      try { entry = { version: row.version, fact: await riskApi.getWeatherFact(row.risk_id) }; }
      catch { entry = { version: row.version, fact: null, error: true }; }
      if (current !== sequence) return;
      facts.value = new Map(facts.value).set(row.risk_id, entry);
    });
  }, { immediate: true });
  onUnmounted(() => { sequence++; });
  return computed(() => weatherRows.value.map(row => ({ ...row,
    weather_fact: facts.value.get(row.risk_id)?.fact || null,
    weather_loading: !facts.value.has(row.risk_id) || facts.value.get(row.risk_id)?.loading === true,
    weather_error: facts.value.get(row.risk_id)?.error === true
  })));
}
