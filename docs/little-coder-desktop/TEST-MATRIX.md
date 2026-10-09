# Test Matrix

## Lane A — repository/deterministic

Required for ordinary development.

No:

- network dependency
- API key
- GPU
- local model server

Uses:

- existing pi-gui repository checks
- unit/driver tests
- deterministic/synthetic runtime fixtures
- Electron verification where the changed user flow requires it

## Lane B — cloud live

Reference:

- OpenRouter or another supported provider

Purpose:

- prove real agent loop;
- compare strong-model behavior;
- diagnose GUI/scaffold/model failures.

Not part of ordinary credential-free CI.

## Lane C — local live

Reference hardware:

```text
RTX 5070 Laptop GPU
8 GB VRAM
```

Reference model class:

```text
Qwen3.5-9B quantized
```

Server:

- LM Studio
- llama.cpp
- Ollama

Purpose:

- small-model tool use;
- latency-sensitive UX;
- context constraints;
- local endpoint health.

## Lane D — remote-local live

Topology:

```text
pi-gui machine
        │
        │ trusted private connection
        ▼
GPU model-server machine
```

Purpose:

- prove endpoint configurability;
- catch localhost assumptions;
- test disconnect/recovery.

Security:

- trusted LAN, WireGuard/Tailscale, or SSH tunnel;
- no unauthenticated public exposure.

## Roadmap mapping

| Work package | Lane A | Lane B | Lane C | Lane D |
|---|---:|---:|---:|---:|
| WP-001 | required | no | no | no |
| WP-002 | required | no | no | no |
| WP-003 | required | no | no | no |
| WP-004 | required | required | optional | no |
| WP-005 | required | required | optional | no |
| WP-006 | required | required | optional | no |
| WP-007 | required | optional | optional | no |
| WP-008 | required | optional | required | optional |
| WP-009 | required | optional | required | no |
| WP-010 | required | optional | required | required |
