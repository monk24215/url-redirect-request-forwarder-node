import { RequestForwarder } from '../index.js';

const rf = new RequestForwarder('https://httpbin.org/post', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hello: 'world' }),
});

const resp = await rf.forward();

console.log('OK:', resp.ok);
console.log('Status:', resp.status);
console.log('Attempts:', resp.attempts);
console.log('Duration:', resp.durationMs + 'ms');
console.log('Body:', resp.body);
