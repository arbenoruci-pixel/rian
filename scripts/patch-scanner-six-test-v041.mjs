import fs from 'node:fs';
import path from 'node:path';

const target = path.join(process.cwd(), 'tests/curved-boundary.test.mjs');
let source = fs.readFileSync(target, 'utf8');

const oldAssertion = 'assert.equal(boundaryHandles(boundary).length, 16);';
const newAssertion = 'assert.equal(boundaryHandles(boundary).length, 6);';
if (!source.includes(newAssertion)) {
  if (!source.includes(oldAssertion)) {
    throw new Error('Scanner 0.4.1 legacy boundary test target is missing.');
  }
  source = source.replace(oldAssertion, newAssertion);
}

source = source.replace(
  "test('16-point boundary model shares all four corners', () => {",
  "test('16-point internal boundary model keeps four corners with six visible handles', () => {",
);

fs.writeFileSync(target, source);
console.log('PASS — Legacy curved-boundary test now distinguishes six visible handles from 16 internal boundary points.');
