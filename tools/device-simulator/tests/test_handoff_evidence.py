import hashlib
import unittest
from notification_inbox import open_handoff_evidence

class Platform:
    content=b"test-only-photo-bytes"
    def __init__(self, evidence="file-1", digest=None):
        self.evidence=evidence
        self.digest=digest or hashlib.sha256(self.content).hexdigest()
        self.opened=False
    def call(self, method, path):
        return {"source_mode":"replay", "availability":{"material":"AVAILABLE","evidence":"AVAILABLE"},
                "material":{"evidence_chain":[{"source_kind":"FILE","source_id":self.evidence,"sha256":self.digest}]}}
    def binary(self, path):
        self.opened=True
        return self.content,"image/jpeg"

class HandoffEvidenceTests(unittest.TestCase):
    def test_only_the_file_frozen_in_this_handoff_can_open(self):
        p=Platform()
        self.assertEqual(open_handoff_evidence(p,"handoff-1","file-1"),(p.content,"image/jpeg"))
        p=Platform(evidence="different-file")
        with self.assertRaises(ValueError): open_handoff_evidence(p,"handoff-1","file-1")
        self.assertFalse(p.opened)
    def test_changed_file_is_rejected(self):
        with self.assertRaises(ValueError): open_handoff_evidence(Platform(digest="a"*64),"handoff-1","file-1")
    def test_path_input_is_not_forwarded(self):
        with self.assertRaises(ValueError): open_handoff_evidence(Platform(),"../wrong","file-1")
if __name__ == "__main__": unittest.main()
