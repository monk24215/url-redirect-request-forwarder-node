// Transparent proxy using only built-in node:http — zero dependencies.

import http from 'node:http';
import { RequestForwarder } from '../index.js';

const UPSTREAM = 'https://your-upstream.example.com';

const server = http.createServer(async (req, res) => {
  // Buffer the request body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  req.body = body.length ? body : null;

  const target = UPSTREAM + req.url;
  const rf = RequestForwarder.fromIncomingRequest(target, req, {
    sourceLabel: 'raw_http_proxy',
  });
  await rf.proxy(res);
});

server.listen(3000, () => console.log('Proxy listening on http://localhost:3000'));
