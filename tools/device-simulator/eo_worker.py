"""One EO owner thread: slow media requests must not stall measured position publishing."""
import copy
import threading
import time


class EoWorker:
    def __init__(self, simulator):
        self.simulator = simulator
        simulator.enable_metadata_worker()
        self.bindings = simulator.bindings
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.thread = None
        self.accepting = True
        self.revision = 0
        self.unavailable = set()
        self.config = copy.deepcopy(simulator.config)
        self.state = simulator.snapshot()
        self.busy = set()
        self.failure = None
        self.heartbeat_metadata = {}
        self.heartbeat_snapshot_at = 0
        self._snapshot()

    def settle_leftovers(self):
        # Preparation completes before the background owner is started.
        self.simulator.settle_leftovers()
        self._snapshot()

    def enqueue(self, topic, payload, retained=False):
        if not self.stop.is_set():
            self.simulator.enqueue(topic, payload, retained)
            self.wake.set()

    def configure_video(self, config):
        with self.lock:
            if config == self.config:
                return
            self.config = copy.deepcopy(config)
        self.wake.set()

    def availability(self, unavailable):
        with self.lock:
            self.unavailable = set(unavailable)

    def suspend(self):
        with self.lock:
            self.accepting = False
            self.revision += 1
        self.wake.set()

    def resume(self):
        with self.lock:
            self.accepting = True
        self.wake.set()

    def heartbeat(self, payload):
        with self.lock:
            metadata = payload['metadata']
            metadata.pop('taskId', None)
            metadata.pop('cameraStatus', None)
            cached = copy.deepcopy(self.heartbeat_metadata.get(metadata['deviceId'], {}))
            if time.monotonic() - self.heartbeat_snapshot_at > 5:
                cached['workState'] = 0
                if 'cameraStatus' in cached:
                    original_stamp = cached['cameraStatus'].get('observedAt')
                    cached['cameraStatus'] = {'trackingState': 'UNKNOWN', 'calibrated': False}
                    if original_stamp is not None: cached['cameraStatus']['observedAt'] = original_stamp
            metadata.update(cached)
            metadata.setdefault('workState', 0)

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def tick(self):
        if self.failure is not None:
            raise RuntimeError('光电处理线程失败，模拟已停止；请查看运行记录') from self.failure
        if not self.bindings or self.stop.is_set():
            return
        if self.thread is None:
            self.thread = threading.Thread(target=self._run, name='simulator-eo', daemon=True)
            self.thread.start()

    def _snapshot(self):
        state = self.simulator.snapshot()
        busy = {a['binding']['external_id'] for a in self.simulator.active.values()}
        heartbeats = {}
        for binding in self.bindings.values():
            payload = {'metadata': {'deviceId': binding['external_id']}}
            self.simulator.heartbeat(payload)
            heartbeats[binding['external_id']] = payload['metadata']
        with self.lock:
            self.state, self.busy = state, busy
            self.heartbeat_metadata, self.heartbeat_snapshot_at = heartbeats, time.monotonic()

    def _run(self):
        revision = 0
        try:
            while not self.stop.is_set():
                with self.lock:
                    accepting, requested = self.accepting, self.revision
                    config, unavailable = copy.deepcopy(self.config), set(self.unavailable)
                # Even a quick pause/resume must retire the old task before resuming.
                if requested != revision or not accepting:
                    if self.simulator.accepting:
                        self.simulator.suspend()
                    revision = requested
                if self.stop.is_set():
                    break
                self.simulator.configure_video(config)
                self.simulator.availability(unavailable)
                if accepting:
                    if not self.simulator.accepting:
                        self.simulator.resume()
                    self.simulator.tick()
                self._snapshot()
                self.wake.wait(.1)
                self.wake.clear()
        except Exception as error:
            self.failure = error
        finally:
            try:
                self.simulator.suspend()
            except Exception as error:
                self.failure = self.failure or error
            self._snapshot()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread is not None:
            # Keep MQTT alive for final stop receipts; no next run reuses this worker.
            self.thread.join()
        else:
            self.simulator.suspend()
            self._snapshot()
        self.simulator.close_metadata()
