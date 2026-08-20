"""Just enough rtnetlink to create a veth pair and move one end into a
network namespace.

This lives with the demo rather than in the package: the VPN itself never
needs it, but a realistic local test needs two separate network stacks, and
that means a veth pair.  ``ip link add ... type veth`` is what this
replaces.
"""

from __future__ import annotations

import os
import socket
import struct

NETLINK_ROUTE = 0
RTM_NEWLINK = 16
RTM_DELLINK = 17
NLMSG_ERROR = 2

NLM_F_REQUEST = 0x01
NLM_F_ACK = 0x04
NLM_F_EXCL = 0x200
NLM_F_CREATE = 0x400

IFLA_IFNAME = 3
IFLA_LINKINFO = 18
IFLA_NET_NS_FD = 28
IFLA_INFO_KIND = 1
IFLA_INFO_DATA = 2
VETH_INFO_PEER = 1

_IFINFOMSG = struct.Struct("=BBHiII")
_NLMSGHDR = struct.Struct("=IHHII")


class NetlinkError(OSError):
    pass


def _attribute(kind: int, payload: bytes) -> bytes:
    length = 4 + len(payload)
    return struct.pack("=HH", length, kind) + payload + b"\x00" * (-length % 4)


def _ifinfomsg(index: int = 0) -> bytes:
    return _IFINFOMSG.pack(0, 0, 0, index, 0, 0)


def _request(message_type: int, flags: int, body: bytes) -> None:
    sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_ROUTE)
    try:
        sock.bind((0, 0))
        header = _NLMSGHDR.pack(
            _NLMSGHDR.size + len(body), message_type, flags | NLM_F_REQUEST | NLM_F_ACK, 1, 0
        )
        sock.send(header + body)
        reply = sock.recv(8192)
        length, kind, _flags, _seq, _pid = _NLMSGHDR.unpack_from(reply)
        if kind == NLMSG_ERROR:
            (error,) = struct.unpack_from("=i", reply, _NLMSGHDR.size)
            if error != 0:
                raise NetlinkError(-error, os.strerror(-error))
    finally:
        sock.close()


def create_veth(name: str, peer: str) -> None:
    """Create a veth pair named ``name`` <-> ``peer`` in the current namespace."""
    peer_body = _ifinfomsg() + _attribute(IFLA_IFNAME, peer.encode() + b"\x00")
    link_info = _attribute(IFLA_INFO_KIND, b"veth\x00") + _attribute(
        IFLA_INFO_DATA, _attribute(VETH_INFO_PEER, peer_body)
    )
    body = (
        _ifinfomsg()
        + _attribute(IFLA_IFNAME, name.encode() + b"\x00")
        + _attribute(IFLA_LINKINFO, link_info)
    )
    _request(RTM_NEWLINK, NLM_F_CREATE | NLM_F_EXCL, body)


def move_to_namespace(name: str, namespace_fd: int) -> None:
    """Move interface ``name`` into the network namespace held by a file descriptor."""
    body = _ifinfomsg(socket.if_nametoindex(name)) + _attribute(
        IFLA_NET_NS_FD, struct.pack("=I", namespace_fd)
    )
    _request(RTM_NEWLINK, 0, body)


def delete_link(name: str) -> None:
    try:
        index = socket.if_nametoindex(name)
    except OSError:
        return
    _request(RTM_DELLINK, 0, _ifinfomsg(index))
