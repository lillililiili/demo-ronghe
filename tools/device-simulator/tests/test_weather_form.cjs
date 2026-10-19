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

test('explicit weather polygons validate independently of a plan or station', () => {
  for (const [x,y] of [[118.6,37.4],[119.1,36.8]]) {
    const polygon=[[x,y],[x+.01,y],[x+.01,y+.01],[x,y+.01],[x,y]];
    assert.deepEqual(WeatherForm.validatePolygon(polygon),polygon);
    assert.match(WeatherForm.coverage({area_name:'模拟区域',polygon}),/4.*顶点/);
    assert.throws(()=>WeatherForm.validatePolygon(polygon.slice(0,-1)),/闭合/);
    assert.throws(()=>WeatherForm.validatePolygon([[x,y],[x+.01,y+.01],[x,y+.01],[x+.01,y],[x,y]]),/自交|面积/);
  }
  assert.equal(WeatherForm.validatePolygon(null),null);
  assert.throws(()=>WeatherForm.validatePolygon([[0,0],[2,0],[1,0],[1,1],[0,0]]),/重叠/);
  assert.match(WeatherForm.coverage({area_name:'模拟区域'}),/边界未提供/);
});

test('rain intensity is optional and never inferred from probability', () => {
  const now=Date.now();
  const data={area_name:'模拟区域',published_at:now,periods:[{from:now,to:now+60000,summary:'小雨',temperature_c:20,wind_speed_ms:6,gust_ms:9,wind_direction_deg:90,precipitation_probability_pct:80,humidity_pct:75}]};
  assert.equal(WeatherForm.validate(data),data);
  data.periods[0].precipitation_rate_mm_h=2.1;
  assert.equal(WeatherForm.validate(data).periods[0].precipitation_rate_mm_h,2.1);
  data.periods[0].precipitation_rate_mm_h=-1;
  assert.throws(()=>WeatherForm.validate(data),/降雨/);
});
