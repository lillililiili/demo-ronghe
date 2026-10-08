const assert = require('node:assert/strict');
const test = require('node:test');
const WeatherForm = require('../web/weather-form.js');

test('coverage leaves plan matching to the platform system', () => {
  const data = {area_name:'东营区北部空域'};
  const coverage = WeatherForm.coverage(data);
  assert.match(coverage, /平台系统按预报区域匹配/);
  assert.doesNotMatch(coverage, /当前区域内有|所选任务|任务时段|过期/);
});

test('area input stays visible in the forecast scope section', () => {
  assert.match(WeatherForm.areaField({area_name:'河口区'}), /data-weather-field="area_name"/);
  assert.match(WeatherForm.areaField({area_name:'河口区'}), /河口区/);
});
