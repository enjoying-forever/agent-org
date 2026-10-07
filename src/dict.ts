/**
 * Maps from names to values with nothing inherited. A plain object answers `'constructor' in obj` and
 * `obj.toString` from its prototype, so a role (or a message's recipient, a preset id, a command) named like one
 * would be found where there is none. Every map keyed by a name that comes from outside is made with `dict`.
 */

export function dict<T>(from: Iterable<readonly [string, T]> | Readonly<Record<string, T>> = []): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  const entries = Symbol.iterator in Object(from) ? (from as Iterable<readonly [string, T]>) : Object.entries(from as Record<string, T>);
  for (const [key, value] of entries) out[key] = value;
  return out;
}
