"""The role tree: who reports to whom, and what each role is for."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

HARNESSES = ("claude", "codex", "grok", "antigravity", "deepseek")
ROLE_KEYS = {"superior", "harness", "model", "effort", "duties", "instructions", "write_scope"}
TIER_KEYS = {"harness", "model", "effort", "use_for", "max_active"}
CHECK_KEYS = {"name", "run", "when", "timeout"}
TEAM_KEYS = {"owner", "project_root", "database", "roles", "consultants", "checks",
             "autostart", "max_running", "commit_on_accept", "isolation", "team_changes",
             "guard_commands", "scan_secrets", "max_agents"}
ISOLATION = ("leases", "branches")  # one writer per file, or every agent on its own git branch
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
CONSULTANT_PREFIX = "consultant-"  # names of temporary consultant roles: consultant-1, consultant-2, ...


class TeamError(ValueError):
    """team.yaml is malformed or describes an invalid tree."""


@dataclass(frozen=True)
class Role:
    name: str
    superior: str
    harness: str
    model: str | None = None
    effort: str | None = None
    duties: str = ""
    write_scope: tuple[str, ...] = ()
    tier: str | None = None  # set for temporary consultants
    instructions: str = ""  # the role's own prompt: how to work, what to check (beyond its duties)

    @property
    def is_consultant(self) -> bool:
        return self.tier is not None


@dataclass(frozen=True)
class Tier:
    """A kind of consultant a superior can summon for a subordinate's help request."""

    name: str
    harness: str
    model: str | None
    effort: str | None
    use_for: str
    max_active: int

    def describe(self) -> str:
        model = " / ".join(x for x in (self.harness, self.model) if x)
        effort = f", {self.effort} effort" if self.effort else ""
        return f"{self.name} ({model}{effort}, up to {self.max_active} at once)"


@dataclass(frozen=True)
class CheckSpec:
    """A command that must pass before a task may be closed as done (a verification gate)."""

    name: str
    run: str
    when: tuple[str, ...] = ()  # only if the task changed a file matching one of these
    timeout: int = 300


@dataclass(frozen=True)
class Settings:
    autostart: bool = False       # start an agent by itself when it has work and is not running
    max_running: int = 0          # most agents running at once (0: no limit)
    commit_on_accept: bool = True  # commit a task's files when its result is accepted
    isolation: str = "leases"     # "branches": each agent works in its own git worktree
    team_changes: bool = True     # managers may hire, change and let go of the agents below them
    guard_commands: bool = True   # refuse shell commands that publish, wipe shared work or delete outside
    scan_secrets: bool = True     # keep private keys and API tokens out of git history
    max_agents: int = 12          # most roles the team may grow to by hiring

    @property
    def branches(self) -> bool:
        return self.isolation == "branches"


class Team:
    """A validated tree rooted at the owner (you), with exactly one leader below it."""

    def __init__(self, owner: str, project_root: Path, database: Path, roles: dict[str, Role],
                 tiers: dict[str, Tier] | None = None, checks: tuple[CheckSpec, ...] = (),
                 settings: Settings | None = None):
        self.owner = owner
        self.project_root = project_root
        self.database = database
        self.roles = roles
        self.tiers = tiers or {}
        self.checks = checks
        self.settings = settings or Settings()
        self._children: dict[str, list[str]] = {owner: [], **{name: [] for name in roles}}
        for role in roles.values():
            if role.superior not in self._children:
                raise TeamError(f"{role.name}: superior '{role.superior}' is not a role or the owner")
            if role.superior == role.name:
                raise TeamError(f"{role.name}: a role cannot be its own superior")
            self._children[role.superior].append(role.name)
        self._validate()

    @classmethod
    def load(cls, path: str | Path) -> Team:
        path = Path(path)
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as e:
            raise TeamError(f"cannot read {path}: {e}") from e
        return cls.from_dict(data, base_dir=path.parent)

    @classmethod
    def from_dict(cls, data: object, base_dir: Path) -> Team:
        if not isinstance(data, dict):
            raise TeamError("team file must be a mapping")
        unknown = set(data) - TEAM_KEYS
        if unknown:
            raise TeamError(f"unknown team keys: {sorted(unknown)}")

        owner = data.get("owner")
        if not isinstance(owner, str) or not NAME_RE.match(owner):
            raise TeamError("'owner' must be a simple name, e.g. 'you'")
        if "project_root" not in data:
            raise TeamError("'project_root' is required (the folder the agents work in)")
        project_root = (base_dir / str(data["project_root"])).resolve()
        database = (base_dir / str(data.get("database", ".agent-org/hub.db"))).resolve()

        raw_roles = data.get("roles")
        if not isinstance(raw_roles, dict) or not raw_roles:
            raise TeamError("'roles' must be a non-empty mapping")
        roles = {name: _parse_role(name, spec) for name, spec in raw_roles.items()}
        if owner in roles:
            raise TeamError(f"'{owner}' is the owner and cannot also be a role")

        raw_tiers = data.get("consultants") or {}
        if not isinstance(raw_tiers, dict):
            raise TeamError("'consultants' must be a mapping of tier name to settings")
        tiers = {name: _parse_tier(name, spec) for name, spec in raw_tiers.items()}
        raw_checks = data.get("checks") or []
        if not isinstance(raw_checks, list):
            raise TeamError("'checks' must be a list of {name, run} entries")
        checks = tuple(_parse_check(i, spec) for i, spec in enumerate(raw_checks, 1))
        max_running = data.get("max_running", 0)
        if not isinstance(max_running, int) or isinstance(max_running, bool) or max_running < 0:
            raise TeamError("'max_running' must be a whole number (0 means no limit)")
        isolation = data.get("isolation", "leases")
        if isolation not in ISOLATION:
            raise TeamError(f"'isolation' must be one of {list(ISOLATION)}")
        settings = Settings(autostart=bool(data.get("autostart", False)), max_running=max_running,
                            commit_on_accept=bool(data.get("commit_on_accept", True)), isolation=isolation,
                            team_changes=bool(data.get("team_changes", True)),
                            guard_commands=bool(data.get("guard_commands", True)),
                            scan_secrets=bool(data.get("scan_secrets", True)),
                            max_agents=_whole(data, "max_agents", 12))
        return cls(owner, project_root, database, roles, tiers, checks, settings)

    def with_roles(self, extra: list[Role]) -> Team:
        """This team plus some temporary roles (the active consultants)."""
        return Team(self.owner, self.project_root, self.database,
                    {**self.roles, **{r.name: r for r in extra}}, self.tiers, self.checks, self.settings)

    def _validate(self) -> None:
        for name in self.roles:
            seen = {name}
            current = self.roles[name].superior
            while current != self.owner:
                if current in seen:
                    raise TeamError(f"{name}: the chain of superiors loops back on itself")
                seen.add(current)
                current = self.roles[current].superior
        top = self._children[self.owner]
        if len(top) != 1:
            raise TeamError(
                f"exactly one role must report to the owner (the leader); found {len(top)}: {top}"
            )

    @property
    def leader(self) -> str:
        return self._children[self.owner][0]

    def is_member(self, name: str) -> bool:
        return name == self.owner or name in self.roles

    def superior_of(self, name: str) -> str | None:
        return None if name == self.owner else self.roles[name].superior

    def subordinates_of(self, name: str) -> list[str]:
        return list(self._children[name])

    def subtree_of(self, name: str) -> list[str]:
        """Everyone below `name`, nearest first."""
        found: list[str] = []
        queue = list(self._children[name])
        while queue:
            current = queue.pop(0)
            found.append(current)
            queue.extend(self._children[current])
        return found

    def chain_of(self, name: str) -> list[str]:
        """Everyone above `name`, from its direct superior up to the owner."""
        chain: list[str] = []
        current = self.superior_of(name)
        while current is not None:
            chain.append(current)
            current = self.superior_of(current)
        return chain

    def is_above(self, upper: str, lower: str) -> bool:
        return upper in self.chain_of(lower)

    def can_summon(self, name: str) -> bool:
        """Consultants can be summoned by the owner and by anyone with a regular subordinate.

        A consultant is never helped by another consultant, so a role whose only
        subordinates are its consultants has no one to summon for.
        """
        if not self.tiers:
            return False
        return name == self.owner or any(
            not self.roles[s].is_consultant for s in self._children[name])

    def tree_lines(self) -> list[str]:
        lines = [f"{self.owner} (owner)"]

        def walk(name: str, prefix: str) -> None:
            children = self._children[name]
            for i, child in enumerate(children):
                last = i == len(children) - 1
                role = self.roles[child]
                model = f" / {role.model}" if role.model else ""
                temp = f"  (consultant, {role.tier})" if role.is_consultant else ""
                lines.append(f"{prefix}{'└── ' if last else '├── '}{child}  [{role.harness}{model}]{temp}")
                walk(child, prefix + ("    " if last else "│   "))

        walk(self.owner, "")
        return lines


def _whole(data: dict, key: str, default: int) -> int:
    value = data.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise TeamError(f"'{key}' must be a whole number of at least 1")
    return value


def _parse_check(number: int, spec: object) -> CheckSpec:
    if not isinstance(spec, dict):
        raise TeamError(f"check {number}: must be a mapping with 'name' and 'run'")
    unknown = set(spec) - CHECK_KEYS
    if unknown:
        raise TeamError(f"check {number}: unknown keys {sorted(unknown)}")
    run = spec.get("run")
    if not isinstance(run, str) or not run.strip():
        raise TeamError(f"check {number}: 'run' must be the command to run")
    when = spec.get("when", [])
    if isinstance(when, str):
        when = [when]
    if not isinstance(when, list) or not all(isinstance(w, str) for w in when):
        raise TeamError(f"check {number}: 'when' must be a pattern or a list of patterns")
    timeout = spec.get("timeout", 300)
    if not isinstance(timeout, int) or timeout < 1:
        raise TeamError(f"check {number}: 'timeout' must be a number of seconds")
    return CheckSpec(str(spec.get("name") or run.split()[0]), run.strip(), tuple(when), timeout)


def _parse_tier(name: object, spec: object) -> Tier:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise TeamError(f"invalid consultant tier name {name!r}: use letters, digits, '-' and '_'")
    if not isinstance(spec, dict):
        raise TeamError(f"consultant tier {name}: must be a mapping")
    unknown = set(spec) - TIER_KEYS
    if unknown:
        raise TeamError(f"consultant tier {name}: unknown keys {sorted(unknown)}")
    harness = spec.get("harness")
    if harness not in HARNESSES:
        raise TeamError(f"consultant tier {name}: 'harness' must be one of {list(HARNESSES)}")
    max_active = spec.get("max_active", 1)
    if not isinstance(max_active, int) or isinstance(max_active, bool) or max_active < 1:
        raise TeamError(f"consultant tier {name}: 'max_active' must be a whole number of at least 1")
    model, effort = spec.get("model"), spec.get("effort")
    return Tier(
        name=name,
        harness=harness,
        model=None if model is None else str(model),
        effort=None if effort is None else str(effort),
        use_for=str(spec.get("use_for", "")).strip(),
        max_active=max_active,
    )


def _parse_role(name: object, spec: object) -> Role:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise TeamError(f"invalid role name {name!r}: use letters, digits, '-' and '_'")
    if name.startswith(CONSULTANT_PREFIX):
        raise TeamError(f"{name}: names starting with '{CONSULTANT_PREFIX}' are kept for consultants")
    if not isinstance(spec, dict):
        raise TeamError(f"{name}: role must be a mapping")
    unknown = set(spec) - ROLE_KEYS
    if unknown:
        raise TeamError(f"{name}: unknown keys {sorted(unknown)}")
    superior = spec.get("superior")
    if not isinstance(superior, str):
        raise TeamError(f"{name}: 'superior' is required")
    harness = spec.get("harness")
    if harness not in HARNESSES:
        raise TeamError(f"{name}: 'harness' must be one of {list(HARNESSES)}")
    scope = spec.get("write_scope", [])
    if not isinstance(scope, list) or not all(isinstance(p, str) for p in scope):
        raise TeamError(f"{name}: 'write_scope' must be a list of path patterns")
    model, effort = spec.get("model"), spec.get("effort")
    return Role(
        name=name,
        superior=superior,
        harness=harness,
        model=None if model is None else str(model),
        effort=None if effort is None else str(effort),
        duties=str(spec.get("duties", "")).strip(),
        write_scope=tuple(scope),
        instructions=str(spec.get("instructions") or "").strip()[:8000],
    )
