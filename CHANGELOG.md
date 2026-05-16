# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-16
### Notes
- Initial implementation developed in collaboration with Claude (Anthropic).
### Added
- Initial release
- `RequestForwarder` core class using built-in `fetch` and `AbortController`
- Exponential-backoff retry on 5xx and network errors (4xx not retried)
- Zero runtime dependencies
- Pluggable logger interface with `NullLogger`, `FileLogger` (JSONL), and `SqlLogger` (driver-agnostic)
- `fromIncomingRequest()` factory for transparent proxy/webhook scenarios (works with raw http, Express, Fastify)
- `proxy(res)` method to relay upstream response to a Node http.ServerResponse
- Multiple `Set-Cookie` headers preserved as arrays in the response
- Hop-by-hop header stripping per RFC 7230 §6.1
- Optional SQL schema for `SqlLogger`
- Test suite using built-in `node:test` against a local HTTP server
- GitHub Actions CI workflow (Node 18.x, 20.x, 22.x)

