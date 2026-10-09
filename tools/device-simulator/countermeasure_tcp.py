"""Local TCP simulation of the documented four-channel relay controller.

This module only models relay state. It never controls radio hardware.
Each TCP connection carries one request and, when applicable, one reply.
"""

from __future__ import annotations

import os
import select
import socket
import threading
import time
from typing import Any

_CHANNEL_BITS = frozenset((0x01, 0x02, 0x04, 0x08))
_SET_MASKS = frozenset((0x00, 0x01, 0x02, 0x04, 0x08, 0x0D, 0x0F))
_MODES = frozenset(('success', 'no_receipt', 'unchanged'))
_MAX_ASCII_BYTES = 64
_READ_TIMEOUT = 1.0
_TRAILING_BYTE_WAIT = 0.03


class CountermeasureSimulator:
    """A startable loopback TCP server with observable, simulated relay state."""

    def __init__(self, host: str = '127.0.0.1', port: int = 10006,
                 command_mode: str = 'success') -> None:
        if command_mode not in _MODES:
            raise ValueError('command_mode must be success, no_receipt or unchanged')
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError('port must be 1..65535')
        self.host = host
        self.port = port
        self.command_mode = command_mode
        self._lock = threading.RLock()
        self._listener: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._sessions: set[socket.socket] = set()
        self._handlers: set[threading.Thread] = set()
        self._running = False
        self._relay_mask = 0
        self._received = 0
        self._last_received_at: int | None = None
        self._error: str | None = None

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                if os.name != 'nt':
                    # Each reply is followed by our own close, so the port keeps
                    # TIME_WAIT entries for up to a minute; without this a quick
                    # stop/start fails as "address in use". A port that is still
                    # listening is refused as before. Not set on Windows, where
                    # the same option would let two listeners share the port.
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind((self.host, self.port))
                listener.listen(16)
                listener.settimeout(0.2)
            except OSError as exc:
                listener.close()
                self._error = str(exc)
                raise
            self._listener = listener
            self._relay_mask = 0  # A fresh simulation never resumes an active relay.
            self._received = 0
            self._last_received_at = None
            self._error = None
            self._running = True
            self._thread = threading.Thread(target=self._accept_loop,
                                            name='countermeasure-simulator', daemon=True)
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._running = False
            listener = self._listener
            self._listener = None
            sessions = tuple(self._sessions)
            thread = self._thread
            handlers = tuple(self._handlers)
        if listener is not None:
            listener.close()
        for session in sessions:
            try:
                session.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            session.close()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        for handler in handlers:
            if handler is not threading.current_thread():
                handler.join(timeout=1.0)
        with self._lock:
            self._thread = None
            self._handlers.difference_update(handlers)
            self._sessions.difference_update(sessions)
            self._relay_mask = 0

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                'listening': self._running and self._listener is not None,
                'port': self.port,
                'relay_mask': self._relay_mask,
                'received': self._received,
                'last_received_at': self._last_received_at,
                'error': self._error,
            }

    def _accept_loop(self) -> None:
        while True:
            with self._lock:
                if not self._running or self._listener is None:
                    return
                listener = self._listener
            try:
                session, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError as exc:
                with self._lock:
                    if self._running:
                        self._error = str(exc)
                return
            with self._lock:
                if not self._running:
                    session.close()
                    return
                self._sessions.add(session)
                handler = threading.Thread(target=self._handle, args=(session,),
                                           name='countermeasure-session', daemon=True)
                self._handlers.add(handler)
                handler.start()

    def _handle(self, session: socket.socket) -> None:
        try:
            with session:
                session.settimeout(_READ_TIMEOUT)
                read = self._read_request(session)
                if read is None:
                    return
                logical, encoding = read
                if not self._valid(logical):
                    return
                address, function, data = logical[1], logical[2], logical[6]
                with self._lock:
                    if not self._running:
                        return
                    self._received += 1
                    self._last_received_at = int(time.time() * 1000)
                    if function != 0x10:
                        if self.command_mode == 'no_receipt':
                            return  # A lost receipt never performs a command.
                        if self.command_mode == 'success':
                            if function == 0x11:
                                self._relay_mask &= ~data
                            elif function == 0x12:
                                self._relay_mask |= data
                            else:
                                self._relay_mask = data
                    mask = self._relay_mask
                response = bytes((0x22, address, function, 0, 0, 0, mask))
                response += bytes((sum(response) & 0xFF,))
                if encoding == 'raw':
                    wire = response
                elif encoding == 'spaced':
                    wire = (' '.join(f'{byte:02X}' for byte in response) + '\r\n').encode('ascii')
                else:
                    wire = (response.hex().upper() + '\r\n').encode('ascii')
                session.sendall(wire)
        except (OSError, socket.timeout):
            pass
        finally:
            with self._lock:
                self._sessions.discard(session)
                self._handlers.discard(threading.current_thread())

    @staticmethod
    def _read_request(session: socket.socket) -> tuple[bytes, str] | None:
        first = session.recv(1)
        if not first:
            return None
        if first == b'\x55':
            raw = bytearray(first)
            while len(raw) < 8:
                part = session.recv(8 - len(raw))
                if not part:
                    return None
                raw.extend(part)
            if select.select([session], [], [], _TRAILING_BYTE_WAIT)[0]:
                if session.recv(1):
                    return None
            return bytes(raw), 'raw'
        raw = bytearray(first)
        while not raw.endswith(b'\n'):
            if len(raw) >= _MAX_ASCII_BYTES:
                return None
            part = session.recv(1)
            if not part:
                return None
            raw.extend(part)
        if select.select([session], [], [], _TRAILING_BYTE_WAIT)[0]:
            if session.recv(1):
                return None
        try:
            text = raw.decode('ascii').strip()
            compact = text.replace(' ', '')
            if len(compact) != 16 or any(c not in '0123456789abcdefABCDEF' for c in compact):
                return None
            return bytes.fromhex(compact), 'spaced' if ' ' in text else 'compact'
        except (UnicodeDecodeError, ValueError):
            return None

    @staticmethod
    def _valid(frame: bytes) -> bool:
        if len(frame) != 8 or frame[0] != 0x55 or not 1 <= frame[1] <= 244:
            return False
        if frame[2] not in (0x10, 0x11, 0x12, 0x13):
            return False
        if frame[3:6] != b'\x00\x00\x00' or frame[7] != sum(frame[:7]) & 0xFF:
            return False
        data = frame[6]
        if frame[2] == 0x10:
            return data == 1
        if frame[2] in (0x11, 0x12):
            return data in _CHANNEL_BITS
        return data in _SET_MASKS


def is_address_in_use(error: OSError) -> bool:
    """Recognize the platform-specific bind conflict raised by socket.bind."""
    return (getattr(error, 'winerror', None) == 10048
            or getattr(error, 'errno', None) in (48, 98, 10048))
