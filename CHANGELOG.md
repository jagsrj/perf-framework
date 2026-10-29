# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- MCP server (`mcp/`, `npm run mcp`) so AI assistants can list and manage scenarios, upload scripts, start and abort runs, read live metrics, compare runs and check SLO targets. It wraps the existing REST API and adds guardrails (`MCP_MAX_USERS`, `MCP_MAX_DURATION_SECONDS`, `MCP_READ_ONLY`).
- Project-scoped `.mcp.json` for Claude Code.
- Documentation: `docs/MCP.md`, `docs/API.md`, `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md`, `docs/README.md`, `CONTRIBUTING.md`, `.env.example` and `LICENSE`.
- Unit and end-to-end tests for the MCP layer.

### Changed
- InfluxDB is published on `127.0.0.1:8086` so live metrics can be queried from the host.
- README reorganised into a quick start with links to detailed docs. Data-lifecycle details moved to `docs/ARCHITECTURE.md`.
- `package.json` description now reflects the local single-host design.

### Fixed
- The Ollama timeout test no longer gets cancelled because the event loop exits before the timer fires.

### Removed
- Committed `.DS_Store`, which is now ignored.

## [1.0.0]

- Web console for scenarios, versioned JMX uploads, Dockerised JMeter runs, Grafana live monitoring, PostgreSQL run history with automatic baselines, and optional local AI analysis with Ollama.
- Original CLI runner.
