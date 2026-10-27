const { readFileSync } = require('node:fs');
const path = require('node:path');
// Load the production flight-check rules; only the external API is substituted.
module.exports = function flightCheckTestHelpers(api = { check: async () => ({ level: 'CLEAR', aircraft: [] }) }) {
  const source = readFileSync(path.join(__dirname, '../src/ui/flightCheck.js'), 'utf8');
  const names = [...source.matchAll(/export function (\w+)/g)].map(row => row[1]);
  return new Function('flightAvoidanceApi', source.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '')
    + `; return { ${names.join(',')} };`)(api);
};
