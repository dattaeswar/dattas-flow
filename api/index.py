import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app_core import app  # noqa: E402

__all__ = ["app"]
