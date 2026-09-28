"""The role tree: who reports to whom, and what each role is for."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

HARNESSES = ("claude", "codex", "grok", "antigravity")
ROLE_KEYS = {"superior", "harness", "model", "effort", "duties", "write_scope"}
TEAM_KEYS = {"owner", "project_root", "database", "roles"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


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


class Team:
    """A validated tree rooted at the owner (you), with exactly one leader below it."""

    def __init__(self, owner: str, project_root: Path, database: Path, roles: dict[str, Role]):
        self.owner = owner
        self.project_root = project_root
        self.database = database
        self.roles = roles
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
        return cls(owner, project_root, database, roles)

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

    def tree_lines(self) -> list[str]:
        lines = [f"{self.owner} (owner)"]

        def walk(name: str, prefix: str) -> None:
            children = self._children[name]
            for i, child in enumerate(children):
                last = i == len(children) - 1
                role = self.roles[child]
                model = f" / {role.model}" if role.model else ""
                lines.append(f"{prefix}{'└── ' if last else '├── '}{child}  [{role.harness}{model}]")
                walk(child, prefix + ("    " if last else "│   "))

        walk(self.owner, "")
        return lines


def _parse_role(name: object, spec: object) -> Role:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise TeamError(f"invalid role name {name!r}: use letters, digits, '-' and '_'")
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
    )
