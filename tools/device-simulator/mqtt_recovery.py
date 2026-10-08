"""Restore command subscriptions on every MQTT connection, without blocking callbacks."""
import threading
import time


class CommandSubscriptions:
    def __init__(self, topics):
        self.topics = sorted(set(topics))
        self.lock = threading.RLock()
        self.ready = threading.Event()
        self.connected = False
        self.pending_mid = None
        self.error = None

    def on_connect(self, client):
        with self.lock:
            self.ready.clear()
            self.connected = True
            self.pending_mid = None
            self.error = None
            if not self.topics:
                self.ready.set()
                return
            rc, mid = client.subscribe([(topic, 1) for topic in self.topics])
            if rc != 0:
                self.error = '设备指令主题订阅失败'
            else:
                self.pending_mid = mid

    def on_disconnect(self):
        with self.lock:
            self.connected = False
            self.pending_mid = None
            self.ready.clear()

    def on_subscribe(self, client, userdata, mid, codes, properties):
        with self.lock:
            if not self.connected or mid != self.pending_mid:
                return
            self.pending_mid = None
            if len(codes) != len(self.topics) or any(code.is_failure for code in codes):
                self.error = '设备指令主题订阅失败'
            else:
                self.ready.set()

    def wait_ready(self, cancelled, timeout=6):
        with self.lock:
            if cancelled.is_set() or not self.connected:
                return False
            if self.error:
                raise ValueError(self.error)
            if self.ready.is_set():
                return True
        deadline = time.monotonic() + timeout
        while not cancelled.is_set():
            with self.lock:
                if self.error:
                    raise ValueError(self.error)
                if not self.connected:
                    return False
                if self.ready.is_set():
                    return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('设备指令主题订阅确认超时')
            cancelled.wait(min(.05, remaining))
        return False
