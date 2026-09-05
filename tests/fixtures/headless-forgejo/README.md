# Retired Tower authorization fixture

This historical fixture exercised the superseded Tower capability/permission
replica architecture. Do not use it for current acceptance or deployment.

Use [the stock native Forgejo fixture](../native-forgejo/README.md), which tests
Tower authentication only with the actual shipped Autopilot broker/helper.
See [migration](../../../docs/forgejo-native-auth-migration.md) for existing
provider/data preservation and writer shutdown requirements.
