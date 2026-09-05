# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-09-05

### Changed
- Replaced the bookmarklet with a self-hosted OAuth redirect page for streamlined re-authorization.
- Updated callback domain to verified custom domain (hkattelu.com/MMM-FitbitAir/callback.html).
- Switched Node built-in imports in 
ode_helper.js to use 
ode: prefix.
- Fixed MagicMirror² keyword in package.json.
- Updated README.md with standard Update and Configuration sections conforming to MagicMirror best practices.

## [1.0.0] - 2026-08-06

### Added
- Initial release of MMM-FitbitAir.
- Support for Google Health API (health.googleapis.com) to display sleep sessions on MagicMirror².
- Donut chart with sleep stages breakdown (Deep, REM, Light, Awake) and total sleep time.
- Configurable guidance comparing stages against standard adult reference ranges.
- LAN-based OAuth authorization with QR code on expiry.
