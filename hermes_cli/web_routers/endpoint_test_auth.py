"""Saved endpoint Test credentials are bound to one profile and destination.

No credential previews, persistence, key_cmd execution or ambient parent fallback.
Implements the saved-endpoint Test credential resolution for #108785 / #108786:
a blank key field probes with the credential saved for this profile and
destination, never with another profile's key or a different host's key.
"""
import re
from urllib.parse import urlsplit, unquote


def destination(value):
    """Normalize only benign URL spelling differences; reject ambiguous targets."""
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("Invalid endpoint URL.")
    if any(ord(c) < 33 or ord(c) == 127 for c in value) or "\\" in value:
        raise ValueError("Invalid endpoint URL.")
    try:
        parsed = urlsplit(value)
        port = parsed.port
        host = parsed.hostname
    except ValueError:
        raise ValueError("Invalid endpoint URL.") from None
    path = parsed.path.rstrip("/")
    if (parsed.scheme not in ("http", "https") or not host or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment or "%" in parsed.netloc
            or (port is not None and not 1 <= port <= 65535)
            or any(part in (".", "..") for part in unquote(path).split("/"))):
        raise ValueError("Invalid endpoint URL.")
    return parsed.scheme.lower(), host.lower(), port or (443 if parsed.scheme == "https" else 80), path


def probe_key(body, raw_config, secret_lookup):
    """Return (credential, borrowed). Caller has already installed native profile scope."""
    from hermes_cli.config import find_provider_entry
    from hermes_cli.config_providers import _custom_provider_entry_to_provider_config
    submitted = (body.api_key or "").strip()
    target = destination(body.base_url)
    # An actual new key is ephemeral and must not trigger any saved-secret lookup.
    reference = re.fullmatch(r"\$\{([A-Z][A-Z0-9_]*)\}", submitted)
    if submitted and not reference:
        if submitted.startswith(("${", "bws://", "op://")) or "…" in submitted:
            raise ValueError("Enter a new key or keep the saved credential reference.")
        return submitted, False
    endpoint_id = (body.id or "").strip()
    _key, entry = find_provider_entry(raw_config.get("providers"), endpoint_id)
    if entry is None:
        for legacy in raw_config.get("custom_providers", []):
            if isinstance(legacy, dict) and legacy.get("name") == endpoint_id:
                entry = _custom_provider_entry_to_provider_config(legacy, provider_key=endpoint_id)
                break
    if entry is None and endpoint_id == "custom":
        candidate = raw_config.get("model", {})
        if isinstance(candidate, dict) and candidate.get("provider") == "custom": entry = candidate
    if not isinstance(entry, dict):
        if reference: raise ValueError("No saved credential for this profile and endpoint.")
        return None, False
    if target != destination(entry.get("base_url", "")):
        raise ValueError("The URL changed. Enter a key for this destination; the saved key was not used.")
    name = str(entry.get("key_env") or entry.get("api_key_env") or "").strip()
    inline = str(entry.get("api_key") or "").strip()
    inline_reference = re.fullmatch(r"\$\{([A-Z][A-Z0-9_]*)\}", inline)
    allowed_name = name or (inline_reference.group(1) if inline_reference else "")
    if reference and reference.group(1) != allowed_name:
        raise ValueError("The credential reference does not match this saved endpoint.")
    if allowed_name and re.fullmatch(r"[A-Z][A-Z0-9_]*", allowed_name):
        value = secret_lookup(allowed_name)
        if value and not value.startswith(("${", "op://", "bws://")): return value, True
    if inline and not inline_reference and not inline.startswith(("op://", "bws://", "${")):
        return inline, True
    if name or inline or entry.get("key_cmd"):
        raise ValueError("The saved credential is unavailable in this profile.")
    return None, False
