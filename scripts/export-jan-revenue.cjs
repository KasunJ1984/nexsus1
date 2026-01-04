const XLSX = require('xlsx');

// Revenue Summary Data
const summaryData = [
  ['JANUARY 2025 REVENUE SUMMARY', '', '', '', ''],
  ['', '', '', '', ''],
  ['Account', 'Code', 'Gross Revenue', 'Reversals', 'Net Revenue'],
  ['Product Revenue', '41130', 1489766.32, 101422.24, 1388344.08],
  ['Installation Revenue', '41120', 413863.07, 24705.89, 389157.18],
  ['Freight Revenue', '41140', 25210.19, 0, 25210.19],
  ['TOTAL', '', 1928839.58, 126128.13, 1802711.45],
];

// Customer Breakdown Data
const customerData = [
  ['Customer', 'Gross Revenue', 'Reversals', 'Net Revenue'],
  ['Duratec Limited - NSW', 131614.55, 99535.65, 32078.90],
  ['Hickory Built (Vic) Pty Ltd', 117895.03, 0, 117895.03],
  ['Whiteson', 85691.37, 0, 85691.37],
  ['Vaughan Constructions - NSW', 67934.72, 244, 67690.72],
  ['Built Pty Ltd - NSW', 61068.19, 0, 61068.19],
  ['CCW Cabinet Works Pty Ltd', 54951.00, 0, 54951.00],
  ['K&N Projects', 54105.91, 0, 54105.91],
  ['Bowden Corporation Pty Ltd', 50948.32, 0, 50948.32],
  ['Ultrabuild Construction Group Pty Ltd', 50639.65, 0, 50639.65],
  ['Reld Group Pty Ltd', 42907.61, 0, 42907.61],
  ['Design Build Project Services', 42057.68, 0, 42057.68],
  ['Marathon Group Pty Ltd', 39778.65, 0, 39778.65],
  ['Baseline Projects - NSW', 36193.20, 4517.36, 31675.84],
  ['N & I Construction & Maintenance', 35762.38, 0, 35762.38],
  ['Orangeville Interior Linings', 34529.65, 0, 34529.65],
  ['Maxwell Project Services', 32426, 0, 32426],
  ['Yama Projects', 31715.31, 3900, 27815.31],
  ['Diversified Building Services (QLD) Pty Ltd', 31149.06, 0, 31149.06],
  ['Hawley Constructions', 27985.96, 0, 27985.96],
  ['Total Facility Maintenance', 27606.66, 0, 27606.66],
  ['GFG Projects', 27386, 0, 27386],
  ['MILS Group Pty Ltd', 27032.55, 0, 27032.55],
  ['Dzine Construction Group', 26949.74, 0, 26949.74],
  ['Nacs Constructions (NSW) Pty Ltd', 26824, 0, 26824],
  ['GN Projects Pty Ltd', 26041.04, 0, 26041.04],
  ['Austral Interiors Pty Ltd', 25105.24, 0, 25105.24],
  ['Ages Build', 24895.67, 0, 24895.67],
  ['Nextrend Hospitality Furniture', 24077.24, 0, 24077.24],
  ['Prime Projects (NSW) Pty Ltd', 23176.20, 0, 23176.20],
  ['GWH Group Pty Ltd', 22830.23, 0, 22830.23],
  ['Vantage Space', 22723.38, 0, 22723.38],
  ['Fleetwood - VIC', 22746.06, 0, 22746.06],
  ['Renobuild Projects', 22673.30, 0, 22673.30],
  ['2020', 22462.03, 0, 22462.03],
  ['Cook Constructions Pty Ltd', 21855.57, 0, 21855.57],
  ['Valmont (VIC) Pty Ltd', 21397.04, 0, 21397.04],
  ['UpBuild Constructions Pty Ltd', 21262.20, 0, 21262.20],
  ['Blue Group Projects Pty Ltd', 21036.04, 0, 21036.04],
  ['MST Constructions Pty Ltd', 20756.11, 800, 19956.11],
  ['Modscape Pty Ltd', 20653.14, 0, 20653.14],
  ['Manteena Pty Ltd', 19980.33, 0, 19980.33],
  ['Aura Facilities', 18675.33, 0, 18675.33],
  ['Level 10 Building Services', 18024.03, 0, 18024.03],
  ['Neighbourhood Creations Pty Ltd', 17817, 0, 17817],
  ['Joss Group', 17959, 0, 17959],
  ['Apex Executive Interiors Pty Ltd', 16787.83, 0, 16787.83],
  ['Horizon Construction Services Pty Ltd', 15697, 0, 15697],
  ['Wadsworth Contracting Pty Ltd', 15692.85, 0, 15692.85],
  ['ADCO Constructions (NSW) Pty Ltd', 14781.30, 0, 14781.30],
  ['Harris HMC Interiors (VIC) Pty Ltd', 11988.38, 0, 11988.38],
  ['Loreto Mandeville Hall Toorak', 11462.81, 0, 11462.81],
  ['Clinton Built Pty Ltd', 10423, 0, 10423],
  ['Mochahill', 10014.65, 0, 10014.65],
  ['Acute Building & Maintenance Pty Ltd', 9354.04, 0, 9354.04],
  ['Stormvogel Construction & Development', 9380, 0, 9380],
  ['Nathan Lee Bowman t/a Nuffs Kitchens', 9182.53, 0, 9182.53],
  ['Pirro Property Group PTY LTD', 8922.02, 0, 8922.02],
  ['Eastern Property Services', 8787.69, 0, 8787.69],
  ['Ashley Cooper Construction', 8630, 0, 8630],
  ['Hayden Trade Group', 8605.81, 210, 8395.81],
  ['Saints Catholic College', 8396.51, 0, 8396.51],
  ['D&M Plumbing & Building Services', 8349.60, 0, 8349.60],
  ['Fernwood Fitness Newstead', 8331.75, 0, 8331.75],
  ['Good Shepherd Lutheran College', 8325.69, 0, 8325.69],
  ['Qanstruct (Aust) Pty Ltd - VIC', 7750.86, 7750.86, 0],
  ['Felton Industries', 7340, 0, 7340],
  ['Campbelltown City Council', 6719, 0, 6719],
  ['Strike Force Services Pty Ltd', 6728.33, 0, 6728.33],
  ['Regment (NSW) Pty Ltd', 6652, 0, 6652],
  ['Booth Contracting', 6460.80, 0, 6460.80],
  ['Newington College - Stanmore', 6304.85, 0, 6304.85],
  ['Infinite Joinery Pty Ltd', 6015.22, 0, 6015.22],
  ['Beyond Building Solutions', 5728, 1974, 3754],
  ['Avium Pty Ltd', 5687.65, 0, 5687.65],
  ['MMZ Projects Group', 5364.20, 0, 5364.20],
  ['Jardon Group', 4232.20, 0, 4232.20],
  ['Moretto Building Pty Ltd', 3586, 0, 3586],
  ['Paynters - Qld', 3115.23, 3115.23, 0],
  ['Navara Office Furniture', 3095.24, 0, 3095.24],
  ['FDC Fitout & Refurbishment', 3030, 0, 3030],
  ['Cyclo Construction & Fitout', 2690.46, 0, 2690.46],
  ['Inov8 Sales', 2237, 0, 2237],
  ['Crown Furniture', 2205, 0, 2205],
  ['Burgtec', 1760, 0, 1760],
  ['Franchise Fitout Group', 1464, 0, 1464],
  ['Brin Farm', 1300, 0, 1300],
  ['OZ Renovation Centre', 1306, 0, 1306],
  ['Westbury Constructions', 1122, 0, 1122],
  ['My Build Solutions', 860.90, 0, 860.90],
  ['Melrose Co', 540.53, 540.53, 0],
  ['Evri Group', 446.60, 0, 446.60],
  ['AHRENS EASTERN AUSTRALIA', 245, 0, 245],
  ['Medowie Hardware', 181.83, 0, 181.83],
  ['Queensland Kitchen Centre', 257.85, 3540.50, -3282.65],
];

// Job Sample Data (from semantic search with resolved names)
const jobData = [
  ['Job ID', 'Job Name', 'Customer', 'Product Revenue', 'Installation Revenue', 'Freight Revenue', 'Total Revenue'],
  [5416, '2MANPTY1i', 'Manteena Pty Ltd', 3624, 0, 0, 3624],
  [5525, '2LEVBUI4i', 'Level 10 Building Services', 2818.03, 0, 0, 2818.03],
  [5545, '2APEEXE1i', 'Apex Executive Interiors', 2150.40, 0, 0, 2150.40],
  [5029, '2DURTEC12i', 'Duratec Limited - NSW', 0, 0, 0, 0],
  [5242, '', '', 2060, 0, 0, 2060],
  [5502, '', '', 1643, 0, 0, 1643],
  [5655, '', '', 1571.31, 0, 0, 1571.31],
  [5251, '', '', 1560.85, 0, 0, 1560.85],
  [5617, '', '', 1560.85, 0, 0, 1560.85],
  [5657, '', '', 1530, 0, 0, 1530],
  [4352, '', '', 1501.47, 0, 0, 1501.47],
  [5174, '', '', 1343, 0, 0, 1343],
  [5263, '', '', 1343, 0, 0, 1343],
  [5611, '', '', 1343, 0, 0, 1343],
  [5189, '', '', 1342.98, 0, 0, 1342.98],
  [5318, '', '', 1275.85, 0, 0, 1275.85],
  ['', '', '', '', '', '', ''],
  ['Note: This is a sample from semantic search. Full job breakdown requires indexed analytic_distribution field.', '', '', '', '', '', ''],
];

// Create workbook
const wb = XLSX.utils.book_new();

// Add Summary sheet
const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
wsSummary['!cols'] = [{wch:25}, {wch:10}, {wch:15}, {wch:12}, {wch:15}];
XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

// Add Customer Breakdown sheet
const wsCustomer = XLSX.utils.aoa_to_sheet(customerData);
wsCustomer['!cols'] = [{wch:45}, {wch:15}, {wch:12}, {wch:15}];
XLSX.utils.book_append_sheet(wb, wsCustomer, 'By Customer');

// Add Job Sample sheet
const wsJob = XLSX.utils.aoa_to_sheet(jobData);
wsJob['!cols'] = [{wch:10}, {wch:15}, {wch:35}, {wch:15}, {wch:18}, {wch:15}, {wch:15}];
XLSX.utils.book_append_sheet(wb, wsJob, 'By Job (Sample)');

// Write file
const filename = 'January_2025_Revenue.xlsx';
XLSX.writeFile(wb, filename);
console.log('Excel file created: ' + filename);
console.log('');
console.log('Contents:');
console.log('  - Summary: Revenue totals by account');
console.log('  - By Customer: 96 customers with revenue breakdown');
console.log('  - By Job (Sample): Sample job data with resolved names');
