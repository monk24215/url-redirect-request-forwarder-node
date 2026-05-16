import { RequestForwarder, FileLogger } from '../index.js';

const logger = new FileLogger('./logs/forwards.jsonl');

const rf = new RequestForwarder(
  'https://httpbin.org/get',
  { sourceLabel: 'health_check' },
  logger
);

const resp = await rf.forward();
console.log(resp.ok ? 'OK' : `FAIL: ${resp.error}`);
