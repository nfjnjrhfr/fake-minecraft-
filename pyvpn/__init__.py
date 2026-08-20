"""pyvpn -- an encrypted IP tunnel that routes real traffic to the internet.

The pieces, roughly in the order a packet meets them:

    :mod:`pyvpn.tun`        the kernel interface packets arrive on
    :mod:`pyvpn.device`     the event loop that encrypts and routes them
    :mod:`pyvpn.noise`      the Noise_IKpsk2 handshake that establishes keys
    :mod:`pyvpn.crypto`     X25519, ChaCha20-Poly1305 and BLAKE2s
    :mod:`pyvpn.nat`        server-side forwarding out to the internet
    :mod:`pyvpn.routing`    client-side redirection of the host's traffic
"""

__version__ = "1.0.0"
__all__ = ["__version__"]
