import XLSX from 'xlsx';

const wb = XLSX.readFile('feilds_to_add_payload.xlsx');
console.log('Sheet names:', wb.SheetNames);

const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

console.log('\nFirst 10 rows:');
data.slice(0, 10).forEach((row, i) => {
  console.log(`Row ${i}:`, row);
});
