"""Command line interface."""

from __future__ import annotations

import argparse
import ipaddress
import logging
import os
import sys
from pathlib import Path

from . import __version__, crypto
from .config import ConfigError, DEFAULT_PORT, encode_key, load

DESCRIPTION = "An encrypted IP tunnel that carries real traffic to the internet."


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose, getattr(args, "quiet", False))
    try:
        return args.handler(args)
    except ConfigError as exc:
        parser.exit(2, f"configuration error: {exc}\n")
    except KeyboardInterrupt:
        return 130
    except (OSError, RuntimeError) as exc:
        parser.exit(1, f"error: {exc}\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pyvpn", description=DESCRIPTION)
    parser.add_argument("--version", action="version", version=f"pyvpn {__version__}")
    parser.add_argument(
        "-v", "--verbose", action="count", default=0, help="log more (repeat for debug)"
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    keygen = subcommands.add_parser("genkey", help="print a new private key")
    keygen.set_defaults(handler=_genkey)

    pubkey = subcommands.add_parser(
        "pubkey", help="read a private key on stdin and print its public key"
    )
    pubkey.set_defaults(handler=_pubkey)

    genpsk = subcommands.add_parser(
        "genpsk", help="print a new pre-shared key for extra hardening"
    )
    genpsk.set_defaults(handler=_genpsk)

    init = subcommands.add_parser(
        "init", help="generate a matched server and client configuration"
    )
    init.add_argument(
        "--endpoint",
        required=True,
        metavar="HOST[:PORT]",
        help="public address clients will dial, e.g. vpn.example.com:51820",
    )
    init.add_argument("--clients", type=int, default=1, help="how many clients to create")
    init.add_argument(
        "--subnet",
        default="10.9.0.0/24",
        help="private subnet for the tunnel (default: %(default)s)",
    )
    init.add_argument(
        "--output", type=Path, default=Path("./vpn-config"), help="directory to write into"
    )
    init.add_argument(
        "--dns", default="", help="comma-separated DNS servers for clients to use"
    )
    init.add_argument(
        "--no-psk", action="store_true", help="skip the extra pre-shared key layer"
    )
    init.set_defaults(handler=_init)

    server = subcommands.add_parser("server", help="run the tunnel server")
    server.add_argument("-c", "--config", required=True, type=Path)
    server.set_defaults(handler=_server)

    client = subcommands.add_parser("client", help="run the tunnel client")
    client.add_argument("-c", "--config", required=True, type=Path)
    client.set_defaults(handler=_client)

    show = subcommands.add_parser("show", help="summarise a configuration file")
    show.add_argument("-c", "--config", required=True, type=Path)
    show.set_defaults(handler=_show)

    selftest = subcommands.add_parser(
        "selftest", help="run two tunnel ends in this process and verify the datapath"
    )
    selftest.add_argument("--quiet", action="store_true")
    selftest.set_defaults(handler=_selftest)

    return parser


# --------------------------------------------------------------------------
# key handling
# --------------------------------------------------------------------------

def _genkey(_args) -> int:
    private, _ = crypto.generate_keypair()
    print(encode_key(private))
    return 0


def _pubkey(_args) -> int:
    from .config import decode_key

    data = sys.stdin.read().strip()
    if not data:
        raise RuntimeError("no private key on stdin")
    print(encode_key(crypto.public_from_private(decode_key(data, "private key"))))
    return 0


def _genpsk(_args) -> int:
    print(encode_key(crypto.random_bytes(32)))
    return 0


# --------------------------------------------------------------------------
# configuration generation
# --------------------------------------------------------------------------

def _init(args) -> int:
    host, _, port_text = args.endpoint.rpartition(":")
    if not host:
        host, port = args.endpoint, DEFAULT_PORT
    else:
        try:
            port = int(port_text)
        except ValueError as exc:
            raise ConfigError(f"endpoint port {port_text!r} is not a number") from exc

    if args.clients < 1:
        raise ConfigError("--clients must be at least 1")
    subnet = ipaddress.IPv4Network(args.subnet, strict=False)
    hosts = subnet.hosts()
    try:
        server_ip = next(hosts)
        client_ips = [next(hosts) for _ in range(args.clients)]
    except StopIteration as exc:
        raise ConfigError(
            f"{subnet} is too small for {args.clients} clients plus the server"
        ) from exc

    server_private, server_public = crypto.generate_keypair()
    clients = []
    for index, address in enumerate(client_ips, start=1):
        private, public = crypto.generate_keypair()
        clients.append(
            {
                "name": f"client{index}",
                "private": private,
                "public": public,
                "psk": None if args.no_psk else crypto.random_bytes(32),
                "address": address,
            }
        )

    output: Path = args.output
    output.mkdir(parents=True, exist_ok=True)
    os.chmod(output, 0o700)

    server_config = [
        "[Interface]",
        f"PrivateKey = {encode_key(server_private)}",
        f"Address = {server_ip}/{subnet.prefixlen}",
        f"ListenPort = {port}",
        "MTU = 1400",
        "NAT = on           # forward client traffic out to the internet",
        "# WanInterface = eth0   # set this if the default guess is wrong",
        "",
    ]
    for client in clients:
        server_config += [
            f"[Peer]   # {client['name']}",
            f"PublicKey = {encode_key(client['public'])}",
            f"AllowedIPs = {client['address']}/32",
        ]
        if client["psk"]:
            server_config.append(f"PresharedKey = {encode_key(client['psk'])}")
        server_config.append("")

    _write(output / "server.conf", "\n".join(server_config))

    for client in clients:
        lines = [
            "[Interface]",
            f"PrivateKey = {encode_key(client['private'])}",
            f"Address = {client['address']}/{subnet.prefixlen}",
            "MTU = 1400",
            "ListenPort = 0             # bind any free port",
        ]
        if args.dns:
            lines.append(f"DNS = {args.dns}")
        lines += [
            "",
            "[Peer]   # server",
            f"PublicKey = {encode_key(server_public)}",
            f"Endpoint = {host}:{port}",
            "AllowedIPs = 0.0.0.0/0     # send everything through the tunnel",
            "PersistentKeepalive = 25   # keep NAT mappings alive",
        ]
        if client["psk"]:
            lines.append(f"PresharedKey = {encode_key(client['psk'])}")
        lines.append("")
        _write(output / f"{client['name']}.conf", "\n".join(lines))

    names = ["server.conf"] + [f"{client['name']}.conf" for client in clients]
    width = max(len(name) for name in names) + 2
    print(f"Wrote configuration to {output}/")
    print(f"  {'server.conf':<{width}}run on {host}: sudo pyvpn server -c server.conf")
    for client in clients:
        print(
            f"  {client['name'] + '.conf':<{width}}tunnel address {client['address']}, "
            f"run with: sudo pyvpn client -c {client['name']}.conf"
        )
    print()
    print(f"Server public key: {encode_key(server_public)}")
    print(f"Open UDP port {port} on the server's firewall before connecting.")
    return 0


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o600)  # private keys live in here


# --------------------------------------------------------------------------
# running
# --------------------------------------------------------------------------

def _server(args) -> int:
    from . import server

    _require_root("server")
    server.run(load(args.config))
    return 0


def _client(args) -> int:
    from . import client

    _require_root("client")
    client.run(load(args.config))
    return 0


def _show(args) -> int:
    config = load(args.config)
    interface = config.interface
    print(f"interface {interface.name}")
    print(f"  address: {interface.address}")
    print(f"  public key: {encode_key(crypto.public_from_private(interface.private_key))}")
    print(f"  listen port: {interface.listen_port or 'any free port'}")
    print(f"  mtu: {interface.mtu}")
    if interface.nat:
        print(f"  nat: on (out of {interface.wan_interface or 'auto-detected interface'})")
    if interface.dns:
        print(f"  dns: {', '.join(interface.dns)}")
    for peer in config.peers:
        print()
        print(f"peer {encode_key(peer.public_key)}")
        print("  allowed ips: " + ", ".join(str(net) for net in peer.allowed_ips))
        if peer.endpoint:
            print(f"  endpoint: {peer.endpoint[0]}:{peer.endpoint[1]}")
        print(f"  preshared key: {'yes' if peer.preshared_key else 'no'}")
        if peer.persistent_keepalive:
            print(f"  persistent keepalive: {peer.persistent_keepalive}s")
    return 0


def _selftest(args) -> int:
    from .selftest import run_selftest

    return run_selftest(verbose=not args.quiet)


def _require_root(what: str) -> None:
    if os.geteuid() != 0:
        raise RuntimeError(
            f"the {what} needs root (or CAP_NET_ADMIN) to create a tunnel "
            f"interface; try: sudo pyvpn {what} ..."
        )


def _configure_logging(verbosity: int, quiet: bool) -> None:
    level = logging.WARNING if quiet else logging.INFO
    if verbosity >= 2:
        level = logging.DEBUG
    elif verbosity == 1:
        level = logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
