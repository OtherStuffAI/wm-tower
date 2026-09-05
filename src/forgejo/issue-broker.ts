// Deliberately fail old boot commands before any network or provider mutation.
throw new Error('Retired: Forgejo owns accounts, permissions, Git and APIs. Stop this legacy worker; see docs/forgejo-native-auth-migration.md');
export {};
