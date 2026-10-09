import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import server


class AcceptanceFlowEndpointTest(unittest.TestCase):
    def test_prepare_acceptance_flows_returns_all_seven_importable_scenes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'simulator'
            output = root / 'scenarios' / server.ACCEPTANCE_FLOW_OUTPUT_NAME
            output.mkdir(parents=True)
            manifest_flows = []
            for flow in range(1, 8):
                filename = f'flow-{flow}.json'
                scene = {
                    'version': 1,
                    'name': f'流程 {flow}',
                    'fullchain': {'acceptanceFlow': flow, 'expectedChecks': [f'检查 {flow}']},
                }
                (output / filename).write_text(json.dumps(scene), encoding='utf-8')
                manifest_flows.append({'flow': flow, 'file': filename, 'name': scene['name']})
            # The production allowlist uses the real names; replace it only for
            # this adapter test so no arbitrary file can pass unnoticed.
            summary = {'output': str(output), 'filing_fields': []}
            manifest = {'flows': manifest_flows}
            (output / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            fake_script = root / 'scripts' / 'prepare.py'
            fake_script.parent.mkdir(parents=True)
            fake_script.write_text('# test stub\n', encoding='utf-8')
            with patch.object(server, 'ROOT', root), \
                    patch.object(server, 'ACCEPTANCE_FLOW_FILES', {f'flow-{flow}.json' for flow in range(1, 8)}), \
                    patch.object(server, 'acceptance_flow_script', return_value=fake_script), \
                    patch.object(server.subprocess, 'run', return_value=SimpleNamespace(
                        returncode=0, stdout=json.dumps(summary) + '\n', stderr='')) as run:
                result = server.prepare_acceptance_flows()
            self.assertEqual([1, 2, 3, 4, 5, 6, 7], [item['flow'] for item in result['flows']])
            self.assertEqual([], result['filing_fields'])
            args = run.call_args.args[0]
            self.assertIn('--install', args)
            self.assertIn('--force', args)
            self.assertIn('--simulator-root', args)


if __name__ == '__main__':
    unittest.main()
