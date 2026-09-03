---
name: cpp-qt
description: Implement and debug modern C++ and Qt applications, including signals/slots, models, threading, CMake, rendering, and ownership.
---

# C++ and Qt

- Respect Qt object ownership, thread affinity, queued connections, event-loop lifecycle, and GUI-thread requirements.
- Prefer RAII, value semantics, smart pointers where ownership is non-Qt, and explicit parent ownership for QObjects.
- Do not block the UI thread; move work to controlled workers and marshal results back safely.
- Match the repository’s Qt5/Qt6 and C++ standard constraints.
- Update CMake/qmake sources, MOC-relevant declarations, resources, and tests.
- Build with warnings visible and test destruction, cancellation, high-rate updates, and shutdown.
