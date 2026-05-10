#!/usr/bin/env python3
"""
Merge Icarus public hostnames into a remotely-managed Cloudflare Tunnel ingress.

Requires CLOUDFLARE_API_TOKEN with permission to read/write Zero Trust tunnel
configuration (e.g. Account → Cloudflare Tunnel → Edit).

Usage:
  export CLOUDFLARE_API_TOKEN='...'
  python3 scripts/cloudflare_add_icarus_tunnel_routes.py

Optional env:
  ACCOUNT_ID   (default: decoded from Orin tunnel token file when present)
  TUNNEL_ID    (default: same)
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request

# Tunnel backing systemd cloudflared-tunnel on Orin (from TUNNEL_TOKEN payload).
DEFAULT_ACCOUNT_ID = "e5ca9d1cbd901078e5bbe1cbbff9151a"
DEFAULT_TUNNEL_ID = "d0efca3a-9127-47ea-a083-9461df4cb25d"

ICARUS_HOSTS = frozenset({"icarus.aerekos.com", "icarusapi.aerekos.com"})
ICARUS_RULES: list[dict] = [
    {"hostname": "icarusapi.aerekos.com", "service": "http://127.0.0.1:4000"},
    {"hostname": "icarus.aerekos.com", "service": "http://127.0.0.1:8081"},
]


def _catch_all(rule: dict) -> bool:
    svc = str(rule.get("service") or "")
    hn = rule.get("hostname")
    if hn in (None, ""):
        return True
    return svc.startswith("http_status:")


def merge_ingress(existing: list[dict]) -> list[dict]:
    filtered = [r for r in existing if r.get("hostname") not in ICARUS_HOSTS]
    non_catch = [r for r in filtered if not _catch_all(r)]
    catch = [r for r in filtered if _catch_all(r)]
    if not catch:
        catch = [{"service": "http_status:404"}]
    return [*ICARUS_RULES, *non_catch, *catch]


def main() -> int:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print(
            "Missing CLOUDFLARE_API_TOKEN.\n"
            "Create an API token with Zero Trust / Tunnel configuration edit scope, then:\n"
            "  export CLOUDFLARE_API_TOKEN='...'\n"
            "  python3 scripts/cloudflare_add_icarus_tunnel_routes.py",
            file=sys.stderr,
        )
        return 1

    account_id = os.environ.get("ACCOUNT_ID", DEFAULT_ACCOUNT_ID).strip()
    tunnel_id = os.environ.get("TUNNEL_ID", DEFAULT_TUNNEL_ID).strip()
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
        f"/cfd_tunnel/{tunnel_id}/configurations"
    )

    ctx = ssl.create_default_context()
    get_req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})

    try:
        with urllib.request.urlopen(get_req, context=ctx, timeout=60) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"GET failed: HTTP {e.code}\n{e.read().decode()}", file=sys.stderr)
        return 1

    if not payload.get("success"):
        print(json.dumps(payload, indent=2), file=sys.stderr)
        return 1

    result = payload["result"]
    config = dict(result.get("config") or {})
    ingress_in = list(config.get("ingress") or [])
    ingress_out = merge_ingress(ingress_in)
    config["ingress"] = ingress_out

    body = json.dumps({"config": config}).encode()
    put_req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PUT",
    )

    try:
        with urllib.request.urlopen(put_req, context=ctx, timeout=60) as resp:
            out = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"PUT failed: HTTP {e.code}\n{e.read().decode()}", file=sys.stderr)
        return 1

    if not out.get("success"):
        print(json.dumps(out, indent=2), file=sys.stderr)
        return 1

    print("Updated tunnel ingress. New hostnames:")
    for r in ICARUS_RULES:
        print(f"  {r['hostname']} -> {r['service']}")
    print("\nRestart cloudflared on the Orin if routes do not apply immediately:")
    print("  sudo systemctl restart cloudflared-tunnel")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
