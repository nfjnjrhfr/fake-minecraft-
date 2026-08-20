"""Configuration files.

The format is a small INI dialect close to wg-quick's, with one
``[Interface]`` section and any number of ``[Peer]`` sections.  Python's
``configparser`` cannot represent repeated sections, so this parses the file
directly -- which also lets us report the offending line number.
"""

from __future__ import annotations

import base64
import ipaddress
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PORT = 51820
DEFAULT_MTU = 1400


class ConfigError(ValueError):
    """Raised for a malformed or inconsistent configuration file."""


def decode_key(value: str, what: str) -> bytes:
    try:
        raw = base64.b64decode(value.strip(), validate=True)
    except Exception as exc:  # noqa: BLE001 - base64 raises several types
        raise ConfigError(f"{what} is not valid base64") from exc
    if len(raw) != 32:
        raise ConfigError(f"{what} must decode to 32 bytes, got {len(raw)}")
    return raw


def encode_key(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


@dataclass
class PeerConfig:
    public_key: bytes
    allowed_ips: list[ipaddress.IPv4Network] = field(default_factory=list)
    endpoint: tuple[str, int] | None = None
    preshared_key: bytes | None = None
    persistent_keepalive: int = 0

    @property
    def routes_everything(self) -> bool:
        return any(net.prefixlen == 0 for net in self.allowed_ips)


@dataclass
class InterfaceConfig:
    private_key: bytes
    address: ipaddress.IPv4Interface
    listen_port: int = DEFAULT_PORT
    name: str = "vpn0"
    mtu: int = DEFAULT_MTU
    nat: bool = False
    wan_interface: str | None = None
    dns: list[str] = field(default_factory=list)


@dataclass
class Config:
    interface: InterfaceConfig
    peers: list[PeerConfig] = field(default_factory=list)

    def validate(self) -> None:
        if not self.peers:
            raise ConfigError("configuration defines no peers")
        seen: set[bytes] = set()
        for peer in self.peers:
            if peer.public_key in seen:
                raise ConfigError(
                    f"duplicate peer public key {encode_key(peer.public_key)}"
                )
            seen.add(peer.public_key)
            if not peer.allowed_ips:
                raise ConfigError(
                    f"peer {encode_key(peer.public_key)} has no AllowedIPs, "
                    "so no traffic could ever be routed to it"
                )


def _parse_bool(value: str, key: str) -> bool:
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{key} must be a boolean, got {value!r}")


def _parse_endpoint(value: str) -> tuple[str, int]:
    text = value.strip()
    if text.startswith("["):  # bracketed literal, e.g. [2001:db8::1]:51820
        host, _, port = text[1:].partition("]:")
        if not port:
            raise ConfigError(f"Endpoint {value!r} is missing a port")
        return host, int(port)
    host, sep, port = text.rpartition(":")
    if not sep:
        return text, DEFAULT_PORT
    try:
        return host, int(port)
    except ValueError as exc:
        raise ConfigError(f"Endpoint {value!r} has a non-numeric port") from exc


def _parse_networks(value: str) -> list[ipaddress.IPv4Network]:
    networks = []
    for chunk in value.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            networks.append(ipaddress.IPv4Network(chunk, strict=False))
        except ValueError as exc:
            raise ConfigError(f"AllowedIPs entry {chunk!r} is not an IPv4 network: {exc}") from exc
    return networks


def parse(text: str) -> Config:
    interface_fields: dict[str, str] = {}
    peer_fields: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    in_interface = False

    for number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            if section == "interface":
                if in_interface:
                    raise ConfigError(f"line {number}: duplicate [Interface] section")
                in_interface = True
                current = interface_fields
            elif section == "peer":
                current = {}
                peer_fields.append(current)
            else:
                raise ConfigError(f"line {number}: unknown section [{section}]")
            continue
        if current is None:
            raise ConfigError(f"line {number}: setting outside of any section")
        key, sep, value = line.partition("=")
        key = key.strip()
        # A missing separator would otherwise be hidden by the '=' padding
        # that base64 keys end with, so require a single bare word.
        if not sep or not key or len(key.split()) != 1:
            raise ConfigError(f"line {number}: expected 'Key = Value'")
        current[key.lower()] = value.strip()

    if not in_interface:
        raise ConfigError("configuration has no [Interface] section")

    config = Config(
        interface=_build_interface(interface_fields),
        peers=[_build_peer(fields) for fields in peer_fields],
    )
    config.validate()
    return config


def _build_interface(fields: dict[str, str]) -> InterfaceConfig:
    for required in ("privatekey", "address"):
        if required not in fields:
            raise ConfigError(f"[Interface] is missing {required}")
    try:
        address = ipaddress.IPv4Interface(fields["address"])
    except ValueError as exc:
        raise ConfigError(f"Address {fields['address']!r} is not an IPv4 address/prefix") from exc
    if address.network.prefixlen == 32:
        raise ConfigError("Address needs a prefix covering the tunnel subnet, e.g. 10.9.0.2/24")

    listen_port = int(fields.get("listenport", DEFAULT_PORT))
    if not 0 <= listen_port <= 65535:
        raise ConfigError(f"ListenPort must be between 0 and 65535, got {listen_port}")

    return InterfaceConfig(
        private_key=decode_key(fields["privatekey"], "PrivateKey"),
        address=address,
        listen_port=listen_port,
        name=fields.get("interfacename", "vpn0"),
        mtu=int(fields.get("mtu", DEFAULT_MTU)),
        nat=_parse_bool(fields.get("nat", "false"), "NAT"),
        wan_interface=fields.get("waninterface"),
        dns=[part.strip() for part in fields.get("dns", "").split(",") if part.strip()],
    )


def _build_peer(fields: dict[str, str]) -> PeerConfig:
    if "publickey" not in fields:
        raise ConfigError("[Peer] is missing PublicKey")
    keepalive = int(fields.get("persistentkeepalive", 0))
    if not 0 <= keepalive <= 65535:
        raise ConfigError("PersistentKeepalive must be between 0 and 65535 seconds")
    return PeerConfig(
        public_key=decode_key(fields["publickey"], "PublicKey"),
        allowed_ips=_parse_networks(fields.get("allowedips", "")),
        endpoint=_parse_endpoint(fields["endpoint"]) if "endpoint" in fields else None,
        preshared_key=(
            decode_key(fields["presharedkey"], "PresharedKey")
            if "presharedkey" in fields
            else None
        ),
        persistent_keepalive=keepalive,
    )


def load(path: str | Path) -> Config:
    file = Path(path)
    try:
        text = file.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read {file}: {exc}") from exc
    try:
        return parse(text)
    except ConfigError as exc:
        raise ConfigError(f"{file}: {exc}") from exc
