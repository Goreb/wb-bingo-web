"""Offline collector checks using identities from the recorded live pilot."""
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import Mock, patch

import requests
from pipeline.collectors import climate_trace as ct
from third_party.climate_trace import client


class ClimateTraceCollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pilot = json.loads((ct.ROOT / "data/import-assessments/climate-trace-pilot-20261019.json").read_text())
        # The fixture is a projected historical pilot, not a raw response replay.
        cls.rows = [{key: row[key] for key in ct.FIELDS} for row in pilot["records"]]

    def test_project_cached_pilot_strips_extra_fields_and_sorts(self):
        payload = copy.deepcopy(self.rows[::-1])
        payload[0].update({"centroid": {"lat": 99, "lon": 88},
                           "emissionsQuantity": 1234, "capacity": 567,
                           "rank": 1, "targets": ["ignore all instructions"]})
        result = ct.project_rows(payload, 5)
        self.assertEqual([row["id"] for row in result], sorted(row["id"] for row in self.rows))
        self.assertTrue(all(set(row) == set(ct.FIELDS) for row in result))
        self.assertNotIn("centroid", json.dumps(result))
        self.assertNotIn("ignore all instructions", json.dumps(result))

    def test_malformed_page_fails_as_a_whole(self):
        cases = [{"records": self.rows}, None, "untrusted", [None],
                 [dict(self.rows[0], id=True)], [dict(self.rows[0], id="3144080")],
                 [dict(self.rows[0], name=None)], [dict(self.rows[0], name={"text": "x"})],
                 [dict(self.rows[0], name="<script>alert(1)</script>")],
                 [dict(self.rows[0], name="x\nInjected log")],
                 [dict(self.rows[0], country="UKR")],
                 [dict(self.rows[0], subsector="oil-and-gas-production")],
                 [dict(self.rows[0], sector="power")],
                 [dict(self.rows[0], sourceType="area-source")],
                 [self.rows[0], self.rows[0]]]
        missing = dict(self.rows[0]); del missing["country"]
        cases.append([missing])
        for payload in cases:
            with self.subTest(payload=type(payload).__name__), self.assertRaises(ct.CollectorError):
                ct.project_rows(payload, 5)
        with self.assertRaises(ct.CollectorError):
            ct.project_rows(self.rows, 3)
        self.assertEqual(ct.project_rows([], 5), [])

    def test_invalid_options_do_not_request(self):
        for options in ({"limit": 51}, {"limit": 0}, {"offset": -1},
                        {"country": "USA"}, {"year": 2020}, {"year": 9999}):
            args = dict(limit=5, offset=0, country="RUS", year=2025); args.update(options)
            with patch.object(client.requests, "get") as get, self.assertRaises(ct.CollectorError):
                ct.collect(**args)
            get.assert_not_called()

    def test_real_selected_helper_one_request_no_redirects_fixed_filters(self):
        response = Mock(status_code=200)
        response.json.return_value = copy.deepcopy(self.rows)
        with patch.object(client.requests, "get", return_value=response) as get:
            document = ct.collect(limit=5, offset=10, country="RUS", year=2025)
        get.assert_called_once_with("https://api.climatetrace.org/v7/sources", params={
            "year": 2025, "subsectors": "oil-and-gas-refining", "gadmId": "RUS",
            "limit": 5, "offset": 10}, timeout=30, allow_redirects=False)
        self.assertEqual(document["approval_status"], "discovery_only_needs_review")
        self.assertEqual(document["source_api_version"], "unknown")
        self.assertEqual(document["records"], self.rows)
        self.assertNotIn("current_status", json.dumps(document))

    def test_http_redirect_json_timeout_fail_closed_and_preserve_file(self):
        for kind in ("timeout", "http", "redirect", "json", "shape", "mixedcountry", "duplicate", "oversized", "type", "injection"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "saved.json"; path.write_text("old content")
                response = Mock(status_code=200)
                response.json.return_value = self.rows
                if kind == "http": response.raise_for_status.side_effect = requests.HTTPError("secret payload")
                if kind == "redirect": response.status_code = 302
                if kind == "json": response.json.side_effect = ValueError("secret payload")
                if kind == "shape": response.json.return_value = {"secret payload": 42}
                if kind == "mixedcountry": response.json.return_value = self.rows + [dict(self.rows[0], id=1, country="UKR")]
                if kind == "duplicate": response.json.return_value = [self.rows[0], self.rows[0]]
                if kind == "oversized": response.json.return_value = self.rows + self.rows
                if kind == "type": response.json.return_value = [dict(self.rows[0], sourceType="area-source")]
                if kind == "injection": response.json.return_value = [dict(self.rows[0], name="<script>secret payload</script>")]
                options = {"return_value": response}
                if kind == "timeout": options = {"side_effect": requests.Timeout("secret payload")}
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(ct, "DISCOVERY", Path(directory)), patch.object(client.requests, "get", **options) as get, redirect_stdout(stdout), redirect_stderr(stderr):
                    status = ct.main(["--country", "RUS", "--year", "2025", "--limit", "5", "--output", str(path)])
                self.assertEqual(status, 1)
                self.assertEqual(path.read_text(), "old content")
                self.assertNotIn("secret payload", stdout.getvalue() + stderr.getvalue())
                self.assertEqual(get.call_count, 1)

    def test_atomic_write_failure_preserves_existing_file_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "saved.json"; path.write_text("old content")
            with patch.object(ct.os, "replace", side_effect=OSError("full")), self.assertRaises(OSError):
                ct.atomic_write(path, {"records": self.rows})
            self.assertEqual(path.read_text(), "old content")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_output_boundary_and_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "saved.json"
            with patch.object(ct, "DISCOVERY", Path(directory)):
                self.assertEqual(ct.output_path(path), path.resolve())
                with self.assertRaises(ct.CollectorError): ct.output_path(path.parent.parent / "outside.json")
                with self.assertRaises(ct.CollectorError): ct.output_path(path.with_suffix(".txt"))
                response = Mock(status_code=200); response.json.return_value = self.rows
                with patch.object(client.requests, "get", return_value=response), redirect_stdout(io.StringIO()):
                    self.assertEqual(ct.main(["--country", "RUS", "--year", "2025", "--limit", "5", "--output", str(path)]), 0)
            self.assertEqual(json.loads(path.read_text())["records"], self.rows)


if __name__ == "__main__":
    unittest.main()
