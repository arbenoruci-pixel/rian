import fs from 'node:fs';

const targetPath = 'app/transport/board/modules/gati.jsx';
const marker = 'TRANSPORT_GATI_BULK_DELIVERY_V1';
const wrongLine = "if (onBulkStatus) await onBulkStatus(ids, 'loaded');";
const fixedLine = "if (onBulkStatus) await onBulkStatus(ids, 'delivery'); // TRANSPORT_GATI_BULK_DELIVERY_V1";

const source = fs.readFileSync(targetPath, 'utf8');
let next = source;

if (source.includes(marker)) {
  if (source.includes(wrongLine)) {
    throw new Error('transport GATI bulk patch marker exists while the wrong loaded action is still present');
  }
  console.log('SKIP transport GATI bulk direction: already patched');
} else {
  const count = source.split(wrongLine).length - 1;
  if (count !== 1) {
    throw new Error(`transport GATI bulk direction: expected one wrong bulk loaded action, found ${count}`);
  }
  next = source.replace(wrongLine, fixedLine);
  fs.writeFileSync(targetPath, next, 'utf8');
  console.log('PATCH transport GATI bulk direction: loaded -> delivery');
}

const after = fs.readFileSync(targetPath, 'utf8');
if (after.includes(wrongLine)) {
  throw new Error('transport GATI bulk NGARKO still routes final-ready orders to the inbound loaded status');
}
if (!after.includes(fixedLine)) {
  throw new Error('transport GATI bulk delivery patch is missing');
}
if (!after.includes("onBulkStatus([toolsRow.id], 'delivery')")) {
  throw new Error('transport GATI single-order NGARKO no longer routes to delivery');
}

const routeStart = after.indexOf('const ids = routeItemsView.map((x) => x.id).filter(Boolean);');
if (routeStart < 0) {
  throw new Error('transport GATI bulk route block was not found');
}
const routeBlock = after.slice(routeStart, routeStart + 500);
if (!routeBlock.includes("onBulkStatus(ids, 'delivery')")) {
  throw new Error('transport GATI bulk route block does not use delivery status');
}

console.log('PASS transport GATI bulk NGARKO routes final-ready orders to client delivery');
