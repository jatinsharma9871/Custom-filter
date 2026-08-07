import handler from './api/filter.js';

function makeReq(query) {
  return { method: 'GET', query };
}

function makeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; console.log('RESPONSE', JSON.stringify(obj, null, 2)); return obj; }
  };
}

const collection = process.argv[2] || 'default-collection';
const minPrice = process.argv[3];
const maxPrice = process.argv[4];
const vendor = process.argv[5];

const query = { collection };
if (minPrice) query.minPrice = minPrice;
if (maxPrice) query.maxPrice = maxPrice;
if (vendor) query.vendor = vendor;

const req = makeReq(query);
const res = makeRes();

(async () => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error('Handler error', err);
  }
})();
