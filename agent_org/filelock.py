"""A lock across every agent's process: a file that exists while someone holds it."""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

STALE = 300  # seconds after which a lock left by a process that died is taken over


@contextmanager
def file_lock(path: Path, timeout: float = 120, busy: str = "someone else is busy with this") -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > STALE:
                    path.unlink()
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                raise TimeoutError(f"{busy}; try again in a moment") from None
            time.sleep(0.2)
    try:
        yield
    finally:
        os.close(fd)
        path.unlink(missing_ok=True)
