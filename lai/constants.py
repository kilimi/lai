"""Default source for the app distribution bundle when installed from PyPI."""

from __future__ import annotations

import os


def default_bundle_tarball_url() -> str:
    """
    Slim compose-only release bundle (preferred for end users).

    Override with LAI_BUNDLE_URL. Developers can force the full source archive:
      export LAI_BUNDLE_URL=https://codeload.github.com/lulu/lai/tar.gz/main
    """
    from lai.registry import default_bundle_url

    return os.environ.get("LAI_BUNDLE_URL", "").strip() or default_bundle_url()


# Resolved at import time for lai.bundle (override via LAI_BUNDLE_URL before import if needed).
DEFAULT_BUNDLE_TARBALL = default_bundle_tarball_url()
