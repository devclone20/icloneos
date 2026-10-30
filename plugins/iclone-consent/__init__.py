"""iclone-consent — Hermes' microphone obeys the icloneOS consent switch (V3-FX FX-4), and Hermes never uploads
diagnostics or logs to a third party (ruling 47, noupload.py).

The app's voice input already refuses the microphone when the owner switched it off (Electron's session handler and
``hermes:requestMicrophoneAccess``). Hermes opens the microphone on its own too — the wake-word listener, voice mode,
``/voice`` — through PortAudio (``sounddevice``), which no Electron switch reaches. This plugin puts the same switch in
front of every ``sounddevice`` input stream (micgate.py).

Inert unless icloneOS started this Hermes (it always sets ``ICLONE_CONSENT_MICROPHONE``). The upstream tool modules
are not edited: the gate wraps ``sounddevice`` itself, the one door every capture path goes through.
"""

from __future__ import annotations

from . import micgate, noupload


def register(ctx) -> None:  # noqa: ARG001 — the plugin registers no tool or hook: it gates libraries
    if micgate.ACTIVE:
        micgate.install()
        # Ruling 47 (V3-FX M3): no diagnostics or log upload to any third party (noupload.py).
        noupload.install()
        # Ruling 57.4/63 (V3-FX r8): every child this process starts passes the env seal (spawn primitives wrapped).
        try:
            from hermes_cli.iclone_sinks import install_spawn_seal

            install_spawn_seal()
        except ImportError:  # an older runtime without the seam: its own reseal path installs nothing more
            pass
