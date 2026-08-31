"""Interactive terminal chat.

You type normally.  Behind the scenes every message is converted into real
binary (UTF-8 bits) before it is sent to Claude; the bits are not shown unless
you pass ``--debug``.
"""

from __future__ import annotations

import argparse
import sys

import anthropic

from binary_ai.chat import DEFAULT_EFFORT, DEFAULT_MAX_TOKENS, MODEL, BinaryChat

BANNER = "Binary chat - type your message, /help for commands, /quit to exit."
HELP = """\
/help    show this help
/reset   start a new conversation
/quit    exit (Ctrl-D also works)\
"""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="binary-ai", description=__doc__)
    parser.add_argument("--model", default=MODEL, help=f"model id (default: {MODEL})")
    parser.add_argument(
        "--effort",
        default=DEFAULT_EFFORT,
        choices=["low", "medium", "high", "xhigh", "max"],
        help=f"reasoning effort (default: {DEFAULT_EFFORT})",
    )
    parser.add_argument(
        "--max-tokens", type=int, default=DEFAULT_MAX_TOKENS, help="reply length cap"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="print the transmitted bits to stderr (off by default)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    try:
        chat = BinaryChat(
            model=args.model, max_tokens=args.max_tokens, effort=args.effort
        )
    except anthropic.AnthropicError as exc:
        print(f"Could not start: {exc}", file=sys.stderr)
        return 1

    print(BANNER)
    while True:
        try:
            text = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if not text:
            continue
        if text in ("/quit", "/exit"):
            return 0
        if text == "/help":
            print(HELP)
            continue
        if text == "/reset":
            chat.reset()
            print("(conversation cleared)")
            continue

        if args.debug:
            print(f"[sent as] {chat.encode_message(text)}", file=sys.stderr)

        print("\nai> ", end="", flush=True)
        try:
            for chunk in chat.send(text):
                print(chunk, end="", flush=True)
            print()
        except KeyboardInterrupt:
            print("\n(interrupted)")
        except anthropic.AuthenticationError:
            print(
                "\n[error] no valid credentials - set ANTHROPIC_API_KEY or run"
                " `ant auth login`",
                file=sys.stderr,
            )
            return 1
        except anthropic.NotFoundError as exc:
            print(f"\n[error] unknown model {args.model!r}: {exc}", file=sys.stderr)
            return 1
        except anthropic.RateLimitError:
            print("\n[error] rate limited - wait a moment and try again", file=sys.stderr)
        except anthropic.APIStatusError as exc:
            print(f"\n[error] API returned {exc.status_code}: {exc.message}", file=sys.stderr)
        except anthropic.APIConnectionError as exc:
            print(f"\n[error] could not reach the API: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
