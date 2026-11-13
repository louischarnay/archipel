import type { Manifest } from '@archipel/manifest-schema';
import type { User } from '../types.js';

// A user's roles for an app: everyone signed in has `user`, the rest comes from the manifest's mapping.
export function rolesFor(user: User, manifest: Manifest) {
  const roles = new Set(['user']);
  for (const group of user.groups) roles.add(group);
  if (user.admin) roles.add('admin');
  for (const [role, groups] of Object.entries(manifest.roles ?? {})) {
    if (groups.some((group) => user.groups.includes(group))) roles.add(role);
  }
  return [...roles];
}
