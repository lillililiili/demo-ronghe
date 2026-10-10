"""Atomic local snapshots, including bounded Windows sharing-lock recovery."""
import json
import os
from pathlib import Path
import tempfile
import time

# Readers on Windows may briefly deny replacement. Never truncate the old snapshot.
REPLACE_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.8)


def atomic_json(path, value):
    path = Path(path)
    encoded = json.dumps(value, ensure_ascii=False, indent=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        # A private, same-directory file also prevents concurrent writers from
        # deleting or publishing one another's unfinished temporary snapshot.
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                         dir=path.parent, prefix=path.name + '.',
                                         suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(len(REPLACE_DELAYS) + 1):
            try:
                os.replace(temporary, path)
                return
            except OSError as error:
                # Permanent/other I/O errors must still fail visibly. A genuine
                # access denial also fails after this short bounded retry window.
                if (getattr(error, 'winerror', None) not in (5, 32, 33)
                        or attempt == len(REPLACE_DELAYS)):
                    raise
                time.sleep(REPLACE_DELAYS[attempt])
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass  # Preserve the original write error if cleanup is also denied.
