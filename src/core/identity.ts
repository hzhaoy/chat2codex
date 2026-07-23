export interface IdentityKey {
  kind: string;
  value: string;
}

/** Platform-neutral actor identity. */
export interface ActorIdentity {
  keys?: IdentityKey[];
}

/**
 * v0.6 compatibility input. New adapters must populate `keys`; these aliases are
 * normalized at the boundary and can be removed after persisted v0.6 inbox data expires.
 */
export interface SenderIdentity extends ActorIdentity {
  openId?: string;
  userId?: string;
  unionId?: string;
}

export function identityKeys(identity: SenderIdentity): IdentityKey[] {
  const keys = [...(identity.keys ?? [])];
  const append = (kind: string, value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized && !keys.some((key) => key.kind === kind && key.value === normalized)) {
      keys.push({ kind, value: normalized });
    }
  };
  append("open_id", identity.openId);
  append("user_id", identity.userId);
  append("union_id", identity.unionId);
  return keys;
}

export function identityValue(identity: SenderIdentity, kind: string): string | undefined {
  return identityKeys(identity).find((key) => key.kind === kind)?.value;
}

export function hasStableIdentity(identity: SenderIdentity): boolean {
  return identityKeys(identity).length > 0;
}

export function identitiesIntersect(left: SenderIdentity, right: SenderIdentity): boolean {
  const rightKeys = new Set(identityKeys(right).map((key) => `${key.kind}\u0000${key.value}`));
  return identityKeys(left).some((key) => rightKeys.has(`${key.kind}\u0000${key.value}`));
}

export function identityMatchesValues(identity: SenderIdentity, allowedValues: string[]): boolean {
  const allowed = new Set(allowedValues);
  return identityKeys(identity).some((key) => allowed.has(key.value));
}
