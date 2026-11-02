import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Execute the actual sync coverage expressions from all three paths.
const cases = [
  {opening:100, active:0, expected:100, missing:0},
  {opening:80, active:20, expected:100, missing:0},
  {opening:80, active:0, expected:100, missing:20},
  {opening:0, active:0, expected:100, missing:100},
  {opening:undefined, active:100, expected:100, missing:0},
  {opening:20.15, active:10.2, expected:30.35, missing:0},
];
for (const path of ['lib/syncEngine.js','app/api/sync/route.js','app/api/offline-sync/route.js']) {
 const text=fs.readFileSync(path,'utf8');
 assert.match(text,/select\('id,code,client_name,client_phone,status,price_total,data,finance_opening_paid_cash'\)/);
 const code=text.match(/const missingAmount = (roundMoney\(expectedPaid[^;]+);/)[1];
 assert.ok(code.includes('order.finance_opening_paid_cash'));
 for(const c of cases){
  const context={roundMoney:v=>Number((Number(v)||0).toFixed(2)),expectedPaid:c.expected,active:{sum:c.active},activeSum:c.active,order:{finance_opening_paid_cash:c.opening},patch:{finance_opening_paid_cash:999999}};
  assert.equal(vm.runInNewContext(code,context),c.missing,path);
 }
 console.log('PASS',path,'closed, mixed, new, legacy and rounding scenarios; queued patch cannot supply opening balance');
}
