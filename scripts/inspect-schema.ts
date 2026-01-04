import XLSX from 'xlsx';

const wb = XLSX.readFile('nexsus_schema_v2_generated.xlsx');
console.log('Sheet names:', wb.SheetNames);

const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

console.log('\nFirst 5 rows:');
data.slice(0, 5).forEach((row, i) => {
  console.log(`Row ${i}:`, row);
});
