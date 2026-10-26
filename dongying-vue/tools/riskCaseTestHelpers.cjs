const { readFileSync } = require('node:fs');
const path = require('node:path');
const source = readFileSync(path.join(__dirname, '../src/services/riskCaseView.js'), 'utf8');
const names = [...source.matchAll(/export (?:const|function) (\w+)/g)].map(row => row[1]);
module.exports = new Function(source.replace(/\bexport /g, '') + `; return { ${names.join(',')} };`)();
