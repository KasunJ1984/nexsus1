import XLSX from 'xlsx';

const wb = XLSX.readFile('data/exports/nexsus_export_res_partner_20251231_182551.xlsx');
console.log('Sheet names:', wb.SheetNames);

const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

console.log('\nFirst 3 rows:');
data.slice(0, 3).forEach((row, i) => {
  if (i === 0) {
    console.log(`Row ${i} (Headers):`, row);
  } else {
    console.log(`Row ${i}:`, JSON.stringify(row).substring(0, 300) + '...');
  }
});

console.log('\nTotal columns:', data[0]?.length || 0);
console.log('Total rows:', data.length);
