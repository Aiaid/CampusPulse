"""USB host trust preflight; no serial device or network is opened."""
import importlib.util
from pathlib import Path
import re
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('waveshare_run_small', ROOT / 'firmware/waveshare-v3/run_small.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
legacy_spec = importlib.util.spec_from_file_location('waveshare_run_trial', ROOT / 'firmware/waveshare-v3-trial/run_trial.py')
legacy = importlib.util.module_from_spec(legacy_spec)
legacy_spec.loader.exec_module(legacy)


class HostOrigin(unittest.TestCase):
    def backend(self, origin=None, **extra):
        origin=origin or runner.PRODUCTION_ORIGIN
        value=dict(endpoint=origin,tls='public_ca_bundle',uplink_transport='mqtt_tls' if origin==runner.PRODUCTION_ORIGIN else 'https')
        if value['uplink_transport']=='mqtt_tls':value.update(mqtt_uri=runner.MQTT_URI,mqtt_username='synthetic-user',mqtt_password='synthetic-password',mqtt_namespace='synthetic')
        value.update(extra);return value

    def test_production_constant_matches_firmware(self):
        settings = (ROOT / 'firmware/components/cp_settings/include/cp_settings.h').read_text()
        value = re.search(r'^#define CP_API_ORIGIN "([^"]+)"$', settings, re.MULTILINE)[1]
        self.assertEqual(runner.PRODUCTION_ORIGIN, value)
        broker = re.search(r'^#define CP_MQTT_PRODUCTION_URI "([^"]+)"$', settings, re.MULTILINE)[1]
        self.assertEqual(runner.MQTT_URI,broker)

    def test_production_requires_own_explicit_flag(self):
        for public in (False, True):
            with self.assertRaises(ValueError):
                runner.validate_backend(self.backend(), allow_public_test=public)
            self.assertEqual(runner.validate_backend(self.backend(), allow_production=True,
                                                     allow_public_test=public), runner.PRODUCTION_ORIGIN)

    def test_production_mqtt_required_without_https_fallback(self):
        for key in runner.MQTT_KEYS:
            value=self.backend();value.pop(key)
            with self.assertRaises(ValueError):runner.validate_backend(value,allow_production=True)
        for key,value in [('uplink_transport','https'),('mqtt_uri','mqtts://elsewhere.invalid:8883'),
                          ('mqtt_password','bad password'),('mqtt_namespace','bad/topic')]:
            backend=self.backend();backend[key]=value
            with self.assertRaises(ValueError):runner.validate_backend(backend,allow_production=True)
        backend=self.backend();backend.pop('uplink_transport')
        self.assertEqual(runner.validate_backend(backend,allow_production=True),runner.PRODUCTION_ORIGIN)
        for origin in ('https://192.168.1.2:8799','https://isolated.example'):
            backend=self.backend();backend['endpoint']=origin
            with self.assertRaises(ValueError):runner.validate_backend(backend,allow_production=True,allow_public_test=True)

    def test_production_rejects_aliases_ports_and_tls_overrides(self):
        bad = [runner.PRODUCTION_ORIGIN + suffix for suffix in (':443', ':8443', '/', '.', '?x=1', '#x')]
        bad += ['https://test.pulse.anend.net', 'https://PULSE.ANEND.NET',
                'http://pulse.anend.net', 'https://user@pulse.anend.net',
                'https://pulse.anend.net:0443', 'https://pulse.anend.net\r\nX:1']
        for origin in bad:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                runner.validate_backend(self.backend(origin), allow_production=True, allow_public_test=True)
        for ca in (None, '', 'synthetic-ca'):
            with self.assertRaises(ValueError):
                runner.validate_backend(self.backend(server_ca_pem=ca), allow_production=True)
        for tls in (None, '', 'insecure', 'test_ca'):
            backend = self.backend(); backend['tls'] = tls
            with self.assertRaises(ValueError):
                runner.validate_backend(backend, allow_production=True)

    def test_isolated_permissions_remain_separate(self):
        self.assertEqual(runner.validate_backend(self.backend('https://192.168.1.2:8799')),
                         'https://192.168.1.2:8799')
        for origin in ('https://isolated.example', 'https://8.8.8.8'):
            with self.assertRaises(ValueError):
                runner.validate_backend(self.backend(origin), allow_production=True)
            self.assertEqual(runner.validate_backend(self.backend(origin), allow_public_test=True), origin)
        for origin in ('https://127.0.0.1', 'https://169.254.1.2', 'https://example.',
                       'https://-bad.example', 'https://example.test:65536', 'https://example.test/path'):
            with self.assertRaises(ValueError):
                runner.validate_backend(self.backend(origin), allow_public_test=True)
        with self.assertRaises(ValueError):
            runner.validate_backend(self.backend('https://isolated.example', server_ca_pem=None), allow_public_test=True)

    def test_production_rejected_before_serial_open(self):
        with patch.object(runner, 'read_private', side_effect=[self.backend(), {}]), \
                patch.object(runner.os, 'chmod'), patch.object(runner.serial, 'Serial') as serial, \
                patch('sys.argv', ['run_small.py', '--port', 'synthetic', '--private-dir', '/tmp']):
            with self.assertRaises(ValueError):
                runner.main()
            serial.assert_not_called()

    def test_historical_feature_runner_stays_isolated(self):
        for origin in (runner.PRODUCTION_ORIGIN, runner.PRODUCTION_ORIGIN + ':443',
                       'https://test.' + runner.PRODUCTION_HOST):
            with self.assertRaises(ValueError):
                legacy.validate_trial_endpoint(self.backend(origin))
        legacy.validate_trial_endpoint(self.backend('https://isolated.example:8443'))
        with patch.object(legacy, 'read_private', side_effect=[self.backend(), {}]), \
                patch.object(legacy.os, 'chmod'), patch.object(legacy.serial, 'Serial') as serial, \
                patch('sys.argv', ['run_trial.py', '--port', 'synthetic', '--private-dir', '/tmp']):
            with self.assertRaises(ValueError):
                legacy.main()
            serial.assert_not_called()


if __name__ == '__main__':
    unittest.main()
