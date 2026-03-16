# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Sidearm, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/danscMax/Sidearm/security)
2. Click **"Report a vulnerability"**
3. Describe the issue with steps to reproduce

You will receive a response within 7 days.

## Scope

Sidearm interacts with:
- Windows low-level keyboard hooks (input interception)
- Clipboard (read/write via OLE)
- Process enumeration (foreground window detection)
- File system (config read/write in AppData)
- SendInput API (keystroke injection)

Security issues in any of these areas are in scope.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
