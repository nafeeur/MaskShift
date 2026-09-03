---
name: performance
description: Profile and optimize latency, throughput, memory, context usage, and startup costs using measured bottlenecks.
---

# Performance Engineering

- Define the target metric, workload, baseline, and acceptable regression budget.
- Profile before optimizing; distinguish CPU, I/O, network, allocation, serialization, model latency, and context-size costs.
- Optimize the dominant path and preserve correctness under concurrency and cancellation.
- For agent systems, bound tool output, context injection, retries, and fan-out. Cache immutable discovery results.
- Add a benchmark or telemetry counter that prevents silent regression.
- Report measured before/after results and environmental limits.
