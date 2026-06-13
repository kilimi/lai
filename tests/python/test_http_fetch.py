import ssl
from unittest.mock import patch

from lai.http_fetch import fetch_bytes, ssl_context


def test_ssl_context_prefers_certifi_when_available():
    with patch("certifi.where", return_value="/fake/ca.pem"):
        ctx = ssl_context()
    assert isinstance(ctx, ssl.SSLContext)


def test_fetch_bytes_uses_curl_on_ssl_error():
    with patch("lai.http_fetch.urllib.request.urlopen", side_effect=ssl.SSLError("bad")):
        with patch(
            "lai.http_fetch._fetch_bytes_curl",
            return_value=b"payload",
        ) as mock_curl:
            assert fetch_bytes("https://example.com/bundle.tar.gz", timeout=5) == b"payload"
    mock_curl.assert_called_once()
