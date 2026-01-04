import XLSX from 'xlsx';

const wb = XLSX.readFile('data/exports/January_2025_Revenue.xlsx');
console.log('Sheet names:', wb.SheetNames);

const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

console.log('\nFirst 3 rows:');
data.slice(0, 3).forEach((row, i) => {
  console.log(`Row ${i}:`, JSON.stringify(row).substring(0, 200));
});

console.log('\nColumn headers (first 20):');
if (data.length > 0) {
  console.log(data[0].slice(0, 20));
}
