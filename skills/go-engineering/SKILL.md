---
name: go-engineering
description: Implement idiomatic Go services and tools with context propagation, interfaces, concurrency discipline, and tests.
---

# Go Engineering

- Pass context through network, process, and storage boundaries; honor cancellation.
- Own goroutine lifecycle and close channels only from the sending owner.
- Keep interfaces small and defined by consumers.
- Wrap errors with operation context while preserving `errors.Is/As` behavior.
- Use table tests for deterministic cases and integration tests for processes/protocols.
- Run gofmt, vet/staticcheck if configured, and tests with race detection where practical.
