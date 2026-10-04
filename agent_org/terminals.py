"""Agents' terminals inside the agent-org window.

Each agent runs in a pseudo-terminal that this process owns (Windows ConPTY, through
pywinpty), instead of a Windows Terminal tab. The page shows it with xterm.js: one long-poll
fetches the new output of all of them (`TerminalHost.read_many`: a browser allows only a few
connections at a time), and keystrokes (`write`) and sizes (`resize`) go back.

Agents started this way live as long as agent-org runs: closing the agent-org window ends them
(their conversations are kept, so the next start resumes them).
"""

from __future__ import annotations

import itertools
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

try:
    from winpty import PtyProcess
except ImportError:  # not Windows, or pywinpty missing: agents open in terminal tabs instead
    PtyProcess = None

KEEP = 400_000  # characters of output kept per terminal: what a page opened later still sees
_ids = itertools.count(1)
_ESCAPES = re.compile(r"\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO.|\x1b.")  # keys and replies, not text


def available() -> bool:
    return PtyProcess is not None and os.name == "nt"


# What a program started by Claude Code (or its desktop app) inherits. Inside an agent's
# terminal it would make that agent believe it is a sub-session of someone else's session.
_SESSION_VARS = ("CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_AGENT_SDK", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PREVIEW",
                 "MCP_CONNECTION_NONBLOCKING", "MCP_SERVER_CONNECTION_BATCH_SIZE")


# How agent-org reaches the internet: the agents need the same (a proxy can decide whether a
# service is available at all - Antigravity refuses some regions).
_NETWORK_VARS = {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
                 "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_USE_ENV_PROXY"}


def system_proxy() -> str | None:
    """Windows' own proxy setting (what a proxy app's "system proxy" mode sets), as a URL."""
    try:
        import winreg  # noqa: PLC0415 - Windows only

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as key:
            if not winreg.QueryValueEx(key, "ProxyEnable")[0]:
                return None
            server = str(winreg.QueryValueEx(key, "ProxyServer")[0]).strip()
    except (ImportError, OSError):
        return None
    if "=" in server:  # per protocol: "http=host:port;https=host:port"
        parts = dict(p.split("=", 1) for p in server.split(";") if "=" in p)
        server = parts.get("https") or parts.get("http") or ""
    if not server:
        return None
    return server if "://" in server else f"http://{server}"


def network_env(env: dict[str, str]) -> dict[str, str]:
    """`env` with agent-org's own proxy and certificate settings, or Windows' system proxy."""
    env = {k: v for k, v in env.items() if k.upper() not in _NETWORK_VARS}
    carried = {k: v for k, v in os.environ.items() if k.upper() in _NETWORK_VARS}
    env.update(carried)
    if not any(k.upper() in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY") for k in carried):
        proxy = system_proxy()
        if proxy:
            env.update({"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy})
            env.setdefault("NO_PROXY", "localhost,127.0.0.1,::1")
    return env


def fresh_env() -> dict[str, str]:
    """The environment a newly started program of this user gets (as a new Windows Terminal tab
    does), not agent-org's own - whatever started agent-org must not leak into its agents -
    but with agent-org's way to the internet (its proxy)."""
    return network_env(_user_env())


def _user_env() -> dict[str, str]:
    """This user's environment as Windows gives it to a new program."""
    try:
        import ctypes  # noqa: PLC0415 - Windows only
        from ctypes import wintypes  # noqa: PLC0415

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        userenv = ctypes.WinDLL("userenv", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        userenv.CreateEnvironmentBlock.argtypes = [ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.BOOL]
        userenv.DestroyEnvironmentBlock.argtypes = [ctypes.c_void_p]
        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008 | 0x0002, ctypes.byref(token)):
            raise OSError(ctypes.get_last_error())
        block = ctypes.c_void_p()
        try:
            if not userenv.CreateEnvironmentBlock(ctypes.byref(block), token, False):
                raise OSError(ctypes.get_last_error())
            env, at = {}, block.value
            while True:  # NUL-separated "NAME=value" strings, ending with an empty one
                entry = ctypes.wstring_at(at)
                if not entry:
                    break
                name, sep, value = entry.partition("=")
                if sep and name:
                    env[name] = value
                at += (len(entry) + 1) * ctypes.sizeof(ctypes.c_wchar)
            userenv.DestroyEnvironmentBlock(block)
        finally:
            kernel32.CloseHandle(token)
        if env.get("PATH") or env.get("Path"):
            return env
    except (OSError, AttributeError, ValueError):
        pass
    return {k: v for k, v in os.environ.items() if not k.upper().startswith(_SESSION_VARS)}


class Terminal:
    """One program in a pseudo-terminal, with its recent output."""

    def __init__(self, argv: list[str], cwd: Path, title: str = "", color: str = "",
                 cols: int = 120, rows: int = 32, notify=lambda: None) -> None:
        if PtyProcess is None:
            raise OSError("terminals in the window need pywinpty (pip install pywinpty)")
        exe = shutil.which(argv[0]) or argv[0]
        self.id = next(_ids)  # a new one for each start, so a page knows to clear its screen
        self.title, self.color = title, color
        self.cols, self.rows = cols, rows
        env = fresh_env()
        exe = shutil.which(argv[0], path=env.get("PATH") or env.get("Path")) or exe
        self.proc = PtyProcess.spawn([exe, *argv[1:]], cwd=str(cwd), env=env, dimensions=(rows, cols))
        self.started = time.time()
        self.last_output = self.started
        self.last_input = 0.0  # when the owner last typed text here (see typed)
        self._buf = ""
        self._start = 0  # where _buf begins in the whole output
        self._cond = threading.Condition()
        self._notify = notify  # tells the host that something changed
        self.alive = True
        threading.Thread(target=self._pump, name=f"term-{title}", daemon=True).start()

    @property
    def end(self) -> int:
        return self._start + len(self._buf)

    def _pump(self) -> None:
        while True:
            try:
                data = self.proc.read(65536)
            except EOFError:
                break
            except Exception:  # noqa: BLE001 - a broken pipe ends the terminal, never the server
                break
            if not data:
                if not self.proc.isalive():
                    break
                time.sleep(0.02)
                continue
            with self._cond:
                self._buf += data
                self.last_output = time.time()
                if len(self._buf) > KEEP:
                    cut = len(self._buf) - KEEP
                    self._buf, self._start = self._buf[cut:], self._start + cut
                self._cond.notify_all()
            self._notify()
        with self._cond:
            self.alive = False
            self._cond.notify_all()
        self._notify()

    def chunk(self, offset: int) -> dict[str, object]:
        """Output from `offset` on. An offset the terminal no longer has (too old, or from an
        earlier terminal) gets everything kept, with reset=True."""
        with self._cond:
            reset = not self._start <= offset <= self.end
            frm = self._start if reset else offset
            return {"id": self.id, "data": self._buf[frm - self._start:], "next": self.end,
                    "reset": reset, "alive": self.alive, "age": round(time.time() - self.started, 1)}

    def write(self, data: str) -> None:
        if self.alive:
            self.proc.write(data)

    def typed(self, data: str) -> None:
        """Input from the owner's keyboard. Text (not the page's own replies to the program's
        queries, arrow keys or Ctrl keys) counts as typing: agent-org then leaves the prompt alone."""
        if any(c >= " " for c in _ESCAPES.sub("", data)):
            self.last_input = time.time()
        self.write(data)

    def resize(self, cols: int, rows: int) -> None:
        cols, rows = max(10, min(int(cols), 500)), max(4, min(int(rows), 200))  # as small as a pane may be
        if self.alive and (cols, rows) != (self.cols, self.rows):
            self.cols, self.rows = cols, rows
            self.proc.setwinsize(rows, cols)

    def close(self) -> None:
        try:
            if self.proc.isalive():
                self.proc.terminate(force=True)
        except Exception:  # noqa: BLE001 - already gone
            pass


class TerminalHost:
    """The terminals of the open team, by role name."""

    def __init__(self, sizes_file: Path | None = None) -> None:
        self._terms: dict[str, Terminal] = {}
        self._lock = threading.Lock()
        self._changed = threading.Condition()
        # The size each pane last had: an agent starts at it, even after agent-org restarted (a program
        # started at another size and then resized can leave pieces of its old screen behind).
        self._sizes_file = sizes_file
        self._sizes: dict[str, tuple[int, int]] = {}
        try:
            saved = json.loads(sizes_file.read_text(encoding="utf-8")) if sizes_file else {}
            self._sizes = {str(k): (int(v[0]), int(v[1])) for k, v in saved.items()}
        except (OSError, ValueError, TypeError, IndexError, AttributeError):
            pass

    def _notify(self) -> None:
        with self._changed:
            self._changed.notify_all()

    def open(self, name: str, argv: list[str], cwd: Path, title: str = "", color: str = "") -> Terminal:
        """Start `argv` in a new terminal for `name`, closing the one it had."""
        cols, rows = self._sizes.get(name, (120, 32))
        term = Terminal(argv, cwd, title or name, color, cols=cols, rows=rows, notify=self._notify)
        with self._lock:
            old = self._terms.get(name)
            self._terms[name] = term
        if old is not None:
            old.close()
        return term

    def resize(self, name: str, cols: int, rows: int) -> None:
        term = self.get(name)
        if term is not None:
            term.resize(cols, rows)
            if self._sizes.get(name) != (term.cols, term.rows):
                self._sizes[name] = (term.cols, term.rows)
                self._save_sizes()

    def _save_sizes(self) -> None:
        if self._sizes_file is None:
            return
        try:
            self._sizes_file.parent.mkdir(parents=True, exist_ok=True)
            self._sizes_file.write_text(json.dumps(self._sizes), encoding="utf-8")
        except OSError:
            pass  # not remembered: the next start is resized once its pane reports

    def get(self, name: str) -> Terminal | None:
        with self._lock:
            return self._terms.get(name)

    def read_many(self, wants: dict[str, tuple[int, int]], wait: float = 15.0) -> dict[str, dict[str, object]]:
        """New output of several terminals: `wants` maps a name to (terminal id, offset) the page
        has. Returns as soon as any has something new (or is gone), else after `wait` seconds."""
        deadline = time.monotonic() + wait
        with self._changed:
            while True:
                out: dict[str, dict[str, object]] = {}
                for name, (term_id, offset) in wants.items():
                    term = self.get(name)
                    if term is None:
                        out[name] = {"none": True}
                    elif term_id != term.id or offset != term.end:
                        out[name] = term.chunk(offset if term_id == term.id else -1)
                if out:
                    return out
                left = deadline - time.monotonic()
                if left <= 0:
                    return {}
                self._changed.wait(left)

    def close(self, name: str) -> bool:
        with self._lock:
            term = self._terms.pop(name, None)
        if term is not None:
            term.close()
        return term is not None

    def close_all(self) -> None:
        with self._lock:
            terms, self._terms = list(self._terms.values()), {}
        for term in terms:
            term.close()

    def items(self) -> list[tuple[str, Terminal]]:
        with self._lock:
            return list(self._terms.items())

    def listing(self) -> dict[str, dict[str, object]]:
        with self._lock:
            terms = dict(self._terms)
        return {n: {"id": t.id, "alive": t.alive, "title": t.title, "color": t.color} for n, t in terms.items()}
