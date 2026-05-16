// Transparent proxy using Express. Requires: npm install express
//
// Every request to this server is relayed to UPSTREAM with full passthrough.

import express from 'express';
import { RequestForwarder } from '../index.js';

const UPSTREAM = 'https://your-upstream.example.com';
const app = express();

// Buffer body as raw Buffer so we forward it unchanged
app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.all('*', async (req, res) => {
  const target = UPSTREAM + req.path;
  const rf = RequestForwarder.fromIncomingRequest(target, req, {
    sourceLabel: 'express_proxy',
  });
  await rf.proxy(res);
});

app.listen(3000, () => console.log('Proxy listening on http://localhost:3000'));
