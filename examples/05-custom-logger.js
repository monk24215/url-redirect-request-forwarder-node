import { RequestForwarder } from '../index.js';

// Plug in any logging backend — pino, winston, Sentry, Datadog, etc.
class StderrLogger {
  async log(request, result) {
    process.stderr.write(
      `[${request.sourceLabel || '-'}] ${request.method} ${request.targetUrl} ` +
      `-> ${result.status} (${result.durationMs}ms, ${result.attempts} attempts)\n`
    );
  }
}

const rf = new RequestForwarder('https://httpbin.org/get', {}, new StderrLogger());
await rf.forward();
