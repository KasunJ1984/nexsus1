import XLSX from 'xlsx';

const wb = XLSX.readFile('samples/Nexsus1_schema.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws);

console.log('Total rows:', data.length);
console.log('\nRow 14-17 (around country_id field):');
data.slice(13, 17).forEach((r: any, i: number) => {
  console.log(`\nRow ${14 + i}:`);
  console.log(JSON.stringify(r, null, 2));
});
