"""Infrastructure sampling rates reject malformed values without hiding unset defaults."""

import os
import traceback
import unittest
from unittest.mock import patch

from ludens_tools._sampling import env_sample_hz


class SamplingTests(unittest.TestCase):
    def test_environment_rate_boundaries(self):
        for name in ("LUDENS_PERCEPTION_SAMPLE_HZ", "LUDENS_ACTION_STEP_HZ"):
            with self.subTest(name=name), patch.dict(os.environ):
                os.environ.pop(name, None)
                self.assertEqual(env_sample_hz(name), 30.0)
                self.assertEqual(env_sample_hz(name, 12.5), 12.5)
                for raw, expected in ((" 12.5 ", 12.5), ("1e2", 100.0), ("0.01", 0.01)):
                    os.environ[name] = raw
                    self.assertEqual(env_sample_hz(name), expected)
                for raw in ("", " \t ", "invalid", "0", "-1", "nan", "inf", "-inf", "1e999"):
                    with self.subTest(raw=raw):
                        os.environ[name] = raw
                        try:
                            env_sample_hz(name)
                        except ValueError as error:
                            self.assertEqual(str(error), f"{name} must be a positive finite number")
                            self.assertNotIn("During handling", "".join(traceback.format_exception(error)))
                        else:
                            self.fail(f"accepted invalid rate {raw!r}")

    def test_unset_environment_validates_default(self):
        name = "LUDENS_PERCEPTION_SAMPLE_HZ"
        with patch.dict(os.environ):
            os.environ.pop(name, None)
            for default in (0, -1, float("nan"), float("inf"), True):
                with self.subTest(default=default), self.assertRaises(ValueError):
                    env_sample_hz(name, default)


if __name__ == "__main__":
    unittest.main()
